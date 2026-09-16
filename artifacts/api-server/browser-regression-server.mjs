/**
 * Standalone server for the durable browser regression.
 *
 * This process deliberately mounts the production API router rather than
 * returning fixture-shaped responses. Its only test boundary is:
 *   - a one-time, allow-listed demo ticket endpoint;
 *   - an HttpOnly test session adapter in front of the real auth/tenant guards;
 *   - an AsyncLocalStorage provider-deny fence around every request.
 *
 * It must never be used as a production server. The process refuses to start
 * unless ONBOARDING_E2E_TEST=true and creates a disposable migrated schema
 * before importing the router.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { and, eq, inArray } from "drizzle-orm";

if (process.env.ONBOARDING_E2E_TEST !== "true") {
  throw new Error("browser-regression-server.mjs is test-only; set ONBOARDING_E2E_TEST=true");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the durable browser regression");
}

const port = Number(process.env.PORT || 4178);
assert(Number.isInteger(port) && port > 0);
const suffix = `${process.pid}-${randomUUID()}`;
const isolatedSchema = `browser_regression_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const originalDatabaseUrl = process.env.DATABASE_URL;
const administrator = `browser-e2e-admin-${suffix}`;
const reviewer = `browser-e2e-reviewer-${suffix}`;
const fixtureCaseIds = new Set();
const issuedTickets = new Map();
const sessions = new Map();
const ownedPolicyRevisions = new Set();
let server;
let rootPool;
let dbPackage;
let schemaCreated = false;
let shuttingDown = false;

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function scopedDatabaseUrl(connectionString, schema) {
  const url = new URL(connectionString);
  // Do not include public as a fallback. Some historical migrations contain
  // unqualified DROP INDEX statements; if the disposable schema does not yet
  // have that index, PostgreSQL would otherwise resolve and remove the shared
  // development index from public.
  url.searchParams.set(
    "options",
    `-c search_path=${quoteIdentifier(schema)}`,
  );
  return url.toString();
}

async function initializeIsolatedDatabase() {
  const { Pool } = await import("pg");
  rootPool = new Pool({ connectionString: originalDatabaseUrl });
  await rootPool.query(`CREATE SCHEMA ${quoteIdentifier(isolatedSchema)}`);
  schemaCreated = true;

  // pgcrypto is database-scoped and may already be installed in public.
  // Keep the migration search_path isolated while exposing only the digest
  // overload used by the checked-in custody migration through a local shim.
  // This avoids reintroducing public as a fallback just for an extension
  // function.
  const pgcrypto = await rootPool.query(`
    SELECT namespace_record.nspname AS schema_name
    FROM pg_extension extension_record
    JOIN pg_namespace namespace_record
      ON namespace_record.oid = extension_record.extnamespace
    WHERE extension_record.extname = 'pgcrypto'
  `);
  const pgcryptoSchema = pgcrypto.rows[0]?.schema_name;
  if (pgcryptoSchema) {
    await rootPool.query(`
      CREATE FUNCTION ${quoteIdentifier(isolatedSchema)}."digest"(text, text)
      RETURNS bytea
      LANGUAGE sql
      IMMUTABLE
      STRICT
      AS $browser_regression$
        SELECT ${quoteIdentifier(pgcryptoSchema)}."digest"($1, $2)
      $browser_regression$
    `);
  }

  process.env.DATABASE_URL = scopedDatabaseUrl(originalDatabaseUrl, isolatedSchema);
  dbPackage = await import("@workspace/db");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  await migrate(dbPackage.db, {
    migrationsFolder: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../lib/db/drizzle",
    ),
    migrationsSchema: isolatedSchema,
  });

  const relationCheck = await dbPackage.pool.query(`
    SELECT
      current_schema() AS current_schema,
      current_schemas(false) AS current_schemas,
      to_regclass($1)::text AS organizations,
      to_regclass($2)::text AS onb_cases,
      to_regclass($3)::text AS onb_events,
      to_regclass($4)::text AS onb_communications
  `, [
    `${isolatedSchema}.organizations`,
    `${isolatedSchema}.onb_cases`,
    `${isolatedSchema}.onb_events`,
    `${isolatedSchema}.onb_communications`,
  ]);
  const relations = relationCheck.rows[0];
  const isolatedTables = await dbPackage.pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
    [isolatedSchema],
  );
  const requiredTableNames = new Set(
    isolatedTables.rows.map(({ table_name }) => table_name),
  );
  if (
    relations.current_schema !== isolatedSchema ||
    !String(relations.current_schemas).includes(isolatedSchema) ||
    !["organizations", "onb_cases", "onb_events", "onb_communications"]
      .every((tableName) => requiredTableNames.has(tableName))
  ) {
    throw new Error(
      `Browser regression refused to start: database relations are not isolated in ${isolatedSchema}: ${JSON.stringify(relations)} tables=${JSON.stringify(isolatedTables.rows.slice(0, 12))}.`,
    );
  }
}

async function closeDatabasePools() {
  if (!dbPackage) return;
  await Promise.allSettled([
    dbPackage.pool?.end(),
    dbPackage.bgvNotificationLockPool?.end(),
  ]);
}

async function dropOwnedSchema() {
  if (!schemaCreated || !rootPool) return;
  await rootPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(isolatedSchema)} CASCADE`);
  schemaCreated = false;
}

async function abandonStartup() {
  await closeDatabasePools();
  if (rootPool) {
    await dropOwnedSchema().catch(() => {});
    await rootPool.end().catch(() => {});
    rootPool = undefined;
  }
}

try {
  await initializeIsolatedDatabase();
} catch (error) {
  await abandonStartup();
  throw error;
}

const {
  DEMO_ORGANIZATION_ID,
  db,
  onbAuthorityAssignments,
  onbCases,
  onbCommunications,
  onbEffectJournal,
  onbEvents,
  onbSensitiveLifecyclePolicies,
  onbSettings,
  organizationMembershipsTable,
  organizationsTable,
} = dbPackage;
let runWithProviderDeny;
let runWithControlledDemoEmailTest;
let SENSITIVE_DATA_CLASSES;
let demoPrincipalSettingKey;
let router;
let errorHandler;
let setOnboardingConnectorProxyForTests;
try {
  ({ runWithProviderDeny, runWithControlledDemoEmailTest } = await import("./src/lib/onboarding/provider-policy.ts"));
  ({ setOnboardingConnectorProxyForTests } = await import("./src/lib/onboarding/channels.ts"));
  ({ SENSITIVE_DATA_CLASSES } = await import("./src/lib/onboarding/sensitive-lifecycle.ts"));
  ({ demoPrincipalSettingKey } = await import("./src/lib/demo-principal.ts"));
  ({ default: router } = await import("./src/routes/index.ts"));
  ({ errorHandler } = await import("./src/middlewares/error-handler.ts"));
} catch (error) {
  await abandonStartup();
  throw error;
}

let controlledEmailProviderMode = "sent";
let controlledEmailProviderCalls = 0;
let delayedControlledEmailRelease;

setOnboardingConnectorProxyForTests(async (service, path, options) => {
  if (service !== "google-mail") {
    throw new Error(`Unexpected browser-regression provider: ${service}`);
  }
  if (path.endsWith("/profile")) {
    return new Response(JSON.stringify({ emailAddress: "browser-regression@example.invalid" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (path.endsWith("/messages/send")) {
    controlledEmailProviderCalls += 1;
    if (controlledEmailProviderMode === "ambiguous") {
      throw new Error("browser-regression simulated provider timeout");
    }
    if (controlledEmailProviderMode === "delayed") {
      await new Promise((resolve) => {
        delayedControlledEmailRelease = resolve;
      });
    }
    return new Response(JSON.stringify({ id: `browser-regression-message-${controlledEmailProviderCalls}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected browser-regression Gmail path: ${path}`);
});

function cookieValue(req, name) {
  return req.cookies?.[name] || null;
}

async function ensureFixture() {
  const [organization] = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, DEMO_ORGANIZATION_ID))
    .limit(1);
  if (!organization) {
    await db.insert(organizationsTable).values({
      id: DEMO_ORGANIZATION_ID,
      name: "Development Demo",
      slug: "development-demo",
      joinCodeHash: `browser-regression-${suffix}`,
      createdByUserId: administrator,
    });
  }

  await db.insert(organizationMembershipsTable).values([
    { organizationId: DEMO_ORGANIZATION_ID, clerkUserId: administrator, role: "member" },
    { organizationId: DEMO_ORGANIZATION_ID, clerkUserId: reviewer, role: "member" },
  ]);
  await db.insert(onbSettings).values([
    {
      organizationId: DEMO_ORGANIZATION_ID,
      key: demoPrincipalSettingKey(administrator),
      value: "administrator",
    },
    {
      organizationId: DEMO_ORGANIZATION_ID,
      key: demoPrincipalSettingKey(reviewer),
      value: "reviewer",
    },
    {
      organizationId: DEMO_ORGANIZATION_ID,
      key: "demo_volunteers",
      value: JSON.stringify([{
        name: "Browser Regression Volunteer",
        email: "browser-regression-volunteer@example.invalid",
        phone: "",
        channelPreference: "email",
        persona: "standard-fte",
        role: "Demo Engineer",
        department: "Quality",
        geography: "United States",
        hireType: "external",
        workerCategory: "full-time",
        managerName: "Demo Manager",
        recruiterName: "Demo Recruiter",
        joiningDate: "2035-01-01",
        notes: "Synthetic browser regression volunteer.",
      }]),
    },
  ]);

  const currentPolicies = await db
    .select({ dataClass: onbSensitiveLifecyclePolicies.dataClass })
    .from(onbSensitiveLifecyclePolicies)
    .where(and(
      eq(onbSensitiveLifecyclePolicies.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbSensitiveLifecyclePolicies.jurisdiction, "US"),
      eq(onbSensitiveLifecyclePolicies.isCurrent, true),
    ));
  const existingClasses = new Set(currentPolicies.map((row) => row.dataClass));
  const missingClasses = SENSITIVE_DATA_CLASSES.filter((dataClass) => !existingClasses.has(dataClass));
  if (missingClasses.length > 0) {
    const revision = 1_000_000 + Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 6), 16);
    ownedPolicyRevisions.add(revision);
    await db.insert(onbSensitiveLifecyclePolicies).values(missingClasses.map((dataClass) => ({
      organizationId: DEMO_ORGANIZATION_ID,
      dataClass,
      jurisdiction: "US",
      revision,
      purpose: "Browser regression synthetic lifecycle policy",
      lawfulBasis: "Browser regression synthetic lifecycle basis",
      retentionDays: 1,
      // The only provider exception in this harness is the in-process Gmail
      // fake used by the controlled Demo email regression. The final
      // communication fence evaluates every sensitive class for an opaque
      // email payload, so the local fixture must authorize the same fake
      // identifier for each class. No network provider is reachable here.
      providerSharingApproved: true,
      permittedProviders: ["gmail"],
      policyReference: `browser-regression:${suffix}:${dataClass}`,
      approvalReference: `browser-regression:${suffix}:${dataClass}`,
      approvedByUserId: administrator,
      approvedAuthorityAssignmentId: 1,
      isCurrent: true,
    })));
  }
}

async function cleanupFixture() {
  const ids = [...fixtureCaseIds];
  if (ids.length > 0) {
    await db.delete(onbAuthorityAssignments).where(and(
      inArray(onbAuthorityAssignments.caseId, ids),
      inArray(onbAuthorityAssignments.personUserId, [administrator, reviewer]),
    ));
    await db.delete(onbEvents).where(inArray(onbEvents.caseId, ids));
    await db.delete(onbCommunications).where(inArray(onbCommunications.caseId, ids));
    await db.delete(onbEffectJournal).where(inArray(onbEffectJournal.caseId, ids));
    await db.delete(onbCases).where(inArray(onbCases.id, ids));
  }
  await db.delete(onbSettings).where(and(
    eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
    inArray(onbSettings.key, [
      demoPrincipalSettingKey(administrator),
      demoPrincipalSettingKey(reviewer),
      "demo_volunteers",
    ]),
  ));
  await db.delete(organizationMembershipsTable).where(and(
    eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
    inArray(organizationMembershipsTable.clerkUserId, [administrator, reviewer]),
  ));
  if (ownedPolicyRevisions.size > 0) {
    await db.delete(onbSensitiveLifecyclePolicies).where(and(
      eq(onbSensitiveLifecyclePolicies.organizationId, DEMO_ORGANIZATION_ID),
      inArray(onbSensitiveLifecyclePolicies.revision, [...ownedPolicyRevisions]),
    ));
  }
}

try {
  await ensureFixture();
} catch (error) {
  await abandonStartup();
  throw error;
}

const app = express();
app.use(cookieParser());
app.use(express.json());

app.get("/api/test/ready", (_req, res) => {
  res.json({ ready: true, providerBoundary: "deny-external-providers", controlledEmailTransport: "in-process-only" });
});

app.post("/api/test/controlled-email/:mode", (req, res) => {
  const mode = String(req.params.mode);
  if (!["sent", "ambiguous", "delayed"].includes(mode) && mode !== "release") {
    res.status(400).json({ error: "Unsupported controlled email test mode." });
    return;
  }
  if (mode === "release") {
    delayedControlledEmailRelease?.();
    delayedControlledEmailRelease = undefined;
  } else {
    controlledEmailProviderMode = mode;
  }
  res.json({ mode: controlledEmailProviderMode, providerCalls: controlledEmailProviderCalls });
});

app.get("/api/test/controlled-email", (_req, res) => {
  res.json({ mode: controlledEmailProviderMode, providerCalls: controlledEmailProviderCalls });
});

app.post("/api/onboarding/demo-login", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const profile = email === "demo.admin@example.com"
    ? "administrator"
    : email === "demo.reviewer@example.com"
      ? "reviewer"
      : null;
  if (!profile) {
    res.status(403).json({ message: "Only the two allow-listed demo identities are available in the browser harness." });
    return;
  }
  const ticket = `${suffix}.${randomUUID()}`;
  issuedTickets.set(ticket, profile);
  res.json({ ticket });
});

app.post("/api/test/auth/finalize", (req, res) => {
  const ticket = String(req.body?.ticket || "");
  const profile = issuedTickets.get(ticket);
  if (!profile) {
    res.status(401).json({ message: "The one-time browser test ticket is invalid or expired." });
    return;
  }
  issuedTickets.delete(ticket);
  const userId = profile === "administrator" ? administrator : reviewer;
  const session = `${suffix}.${randomUUID()}`;
  sessions.set(session, userId);
  res.cookie("browser_e2e_session", session, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
  });
  res.json({ profile });
});

app.post("/api/test/auth/logout", (req, res) => {
  const session = cookieValue(req, "browser_e2e_session");
  if (session) sessions.delete(session);
  res.clearCookie("browser_e2e_session", { path: "/" });
  res.status(204).end();
});

// This is the server-side safety boundary. Provider-policy is AsyncLocalStorage
// based, so it remains active through all awaited route work and cannot be
// reopened by browser headers or a mocked response.
app.use((req, _res, next) => {
  const session = cookieValue(req, "browser_e2e_session");
  const userId = session ? sessions.get(session) : null;
  if (userId) req.authUserId = userId;
  const controlledEmailSend = req.method === "POST" &&
    /^\/api\/onboarding\/cases\/\d+\/simulation\/send-email$/.test(req.path);
  (controlledEmailSend ? runWithControlledDemoEmailTest : runWithProviderDeny)(() => next());
});

// The browser regression is allowed to inspect owned fixture state, but only
// through this process-local route and never by replacing production API
// responses. This also gives the test a durable provider-effect assertion.
app.get("/api/test/fixture-state/:caseId", async (req, res, next) => {
  try {
    const caseId = Number(req.params.caseId);
    if (!fixtureCaseIds.has(caseId)) {
      res.status(404).json({ message: "Unknown browser fixture." });
      return;
    }
    const [events, communications, effects] = await Promise.all([
      db.select().from(onbEvents).where(eq(onbEvents.caseId, caseId)),
      db.select().from(onbCommunications).where(eq(onbCommunications.caseId, caseId)),
      db.select().from(onbEffectJournal).where(eq(onbEffectJournal.caseId, caseId)),
    ]);
    res.json({
      caseId,
      simulatedEvents: events.filter((event) => event.title.startsWith("[SIMULATED]")).length,
      simulatedCommunications: communications.filter((communication) => communication.status === "logged-only").length,
      providerEffects: effects.length,
      providerBoundary: "deny-external-providers",
    });
  } catch (error) {
    next(error);
  }
});

// Record the ID created by the real route without changing that route's
// response. The route itself remains responsible for all authorization and
// persistence; this middleware only observes its JSON response in the test
// harness.
app.use("/api", (req, res, next) => {
  if (req.method !== "POST" || req.path !== "/onboarding/cases") {
    next();
    return;
  }
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 201 && Number.isSafeInteger(body?.id)) fixtureCaseIds.add(body.id);
    return originalJson(body);
  };
  next();
});

app.use("/api", router);
app.use(errorHandler);

try {
  server = await new Promise((resolve, reject) => {
    const candidate = app.listen(port, "127.0.0.1");
    candidate.once("listening", () => resolve(candidate));
    candidate.once("error", reject);
  });
  process.stdout.write(`browser-regression-api-ready:${port}\n`);
} catch (error) {
  await abandonStartup();
  throw error;
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  let exitCode = 0;
  try {
    if (server) await new Promise((resolve) => server.close(resolve));
    await cleanupFixture();
  } catch (error) {
    exitCode = 1;
    console.error("Browser regression fixture cleanup failed:", error);
  } finally {
    await closeDatabasePools();
    await dropOwnedSchema();
    if (rootPool) {
      await rootPool.end();
      rootPool = undefined;
    }
  }
  process.exit(exitCode);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);