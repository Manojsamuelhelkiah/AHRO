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
import { AsyncLocalStorage } from "node:async_hooks";
import express from "express";
import cookieParser from "cookie-parser";
import { and, eq, inArray } from "drizzle-orm";
import { createIsolatedTestDatabase } from "./isolated-test-database.mjs";
import { installBrowserIdentityReader } from "./browser-regression-identities.mjs";
import { clerkClient } from "@clerk/express";

if (process.env.ONBOARDING_E2E_TEST !== "true" || process.env.NODE_ENV !== "test") {
  throw new Error("browser-regression-server.mjs requires NODE_ENV=test and ONBOARDING_E2E_TEST=true");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the durable browser regression");
}

const port = Number(process.env.PORT || 4178);
assert(Number.isInteger(port) && port > 0);
const suffix = `${process.pid}-${randomUUID()}`;
let isolatedSchema;
let ownedDatabase;
const originalDatabaseUrl = process.env.DATABASE_URL;
const administrator = `browser-e2e-admin-${suffix}`;
const reviewer = `browser-e2e-reviewer-${suffix}`;
const fixtureCaseIds = new Set();
const issuedTickets = new Map();
const sessions = new Map();
const ownedPolicyRevisions = new Set();
let server;
let dbPackage;
let schemaCreated = false;
let shuttingDown = false;

async function initializeIsolatedDatabase() {
  ownedDatabase = await createIsolatedTestDatabase(originalDatabaseUrl, "browser_regression");
  isolatedSchema = ownedDatabase.schema;
  schemaCreated = true;
  process.env.DATABASE_URL = ownedDatabase.connectionString;
  dbPackage = await import("@workspace/db");

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
  if (!schemaCreated || !ownedDatabase) return;
  await ownedDatabase.dispose();
  schemaCreated = false;
}

async function abandonStartup() {
  await closeDatabasePools();
  await dropOwnedSchema();
}

try {
  await initializeIsolatedDatabase();
} catch (error) {
  await abandonStartup();
  throw error;
}

// Install before later fixture imports/adapter setup can fail. A startup
// exception must not strand a migrated schema (including its workspace rows).
process.once("uncaughtException", async error => {
  console.error("Isolated browser startup failed:", error);
  try { await abandonStartup(); } finally { process.exit(1); }
});
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

const {
  DEMO_ORGANIZATION_ID,
  db,
  onbAuthorityAssignments,
  onbCases,
  accessNamedGrants,
  onbCommunications,
  onbEffectJournal,
  onbEvents,
  onbGovernanceAuthorityAssignments,
  onbGovernanceDecisions,
  onbSensitiveLifecyclePolicies,
  onbSettings,
  organizationMembershipsTable,
  organizationsTable,
} = dbPackage;
let runWithProviderDeny;
let SENSITIVE_DATA_CLASSES;
let demoPrincipalSettingKey;
let router;
let errorHandler;
let setOnboardingConnectorProxyForTests;
const ownedIdentities = new Map([
  [administrator, { firstName: "Demo", lastName: "Administrator", email: "demo.admin@example.com" }],
  [reviewer, { firstName: "Demo", lastName: "Reviewer", email: "demo.reviewer@example.com" }],
]);
installBrowserIdentityReader(clerkClient, ownedIdentities);
try {
  ({ runWithProviderDeny } = await import("./src/lib/onboarding/provider-policy.ts"));
  ({ setOnboardingConnectorProxyForTests } = await import("./src/lib/onboarding/channels.ts"));
  ({ SENSITIVE_DATA_CLASSES } = await import("./src/lib/onboarding/sensitive-lifecycle.ts"));
  ({ demoPrincipalSettingKey } = await import("./src/lib/demo-principal.ts"));
  ({ default: router } = await import("./src/routes/index.ts"));
  ({ errorHandler } = await import("./src/middlewares/error-handler.ts"));
} catch (error) {
  await abandonStartup();
  throw error;
}

setOnboardingConnectorProxyForTests(async (service, path) => {
  throw new Error(`External delivery is forbidden in browser regression: ${service} ${path}`);
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
      name: "Demo Organization",
      slug: "development-demo",
      joinCodeHash: `browser-regression-${suffix}`,
      createdByUserId: administrator,
    });
  } else {
    // This schema belongs exclusively to this harness; migrations may seed an
    // older display name. Keep the fixture consistent with its browser checks.
    await db.update(organizationsTable).set({ name: "Demo Organization" })
      .where(eq(organizationsTable.id, DEMO_ORGANIZATION_ID));
  }

  await db.insert(organizationMembershipsTable).values([
    { organizationId: DEMO_ORGANIZATION_ID, clerkUserId: administrator, role: "member" },
    { organizationId: DEMO_ORGANIZATION_ID, clerkUserId: reviewer, role: "member" },
  ]);
  const policyReviewer = `browser-permission-policy-reviewer-${suffix}`;
  await db.insert(organizationMembershipsTable).values({
    organizationId: DEMO_ORGANIZATION_ID, clerkUserId: policyReviewer, role: "member",
  });
  await db.insert(accessNamedGrants).values({
    organizationId: DEMO_ORGANIZATION_ID, principalType: "human", principalId: policyReviewer,
    resourceKey: "tool.policy.manage", resourceType: "tool", scope: "tenant", effect: "allow", status: "active",
    source: "named", createdByUserId: administrator, approvedByUserId: administrator, approvedAt: new Date(),
  });
  const { recordHumanPermissionDecision } = await import("./src/lib/human-permissions.ts");
  // These approvals exist only in the disposable test schema, and authorize
  // only the in-process fake provider behind the existing network deny fence.
  const { ensureGovernanceSeeded, reviewGovernanceDecision } =
    await import("./src/lib/onboarding/governance.ts");
  await ensureGovernanceSeeded(DEMO_ORGANIZATION_ID);
  for (const key of ["GD-10", "GD-11"]) {
    const [decision] = await db.select().from(onbGovernanceDecisions).where(and(
      eq(onbGovernanceDecisions.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbGovernanceDecisions.key, key),
      eq(onbGovernanceDecisions.isCurrent, true),
    ));
    if (!decision) throw new Error(`Missing browser-regression governance decision ${key}`);
    await reviewGovernanceDecision(DEMO_ORGANIZATION_ID, { userId: policyReviewer, role: "member" }, key, {
      revision: 1,
      outcome: "approved",
      reason: "Disposable browser fixture approval for fake controlled Demo email only.",
      verificationReference: `browser-regression:${suffix}:${key}`,
    });
  }
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
    const privacyReviewer = await db.transaction(tx => recordHumanPermissionDecision(tx, {
      organizationId: DEMO_ORGANIZATION_ID, actorUserId: policyReviewer, requiredKeys: ["tool.policy.manage"],
      reviewedRevision: revision, decision: "policy-approved",
    }));
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
      approvedByUserId: policyReviewer,
      approvedAuthorityAssignmentId: privacyReviewer.id,
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
const { seedOffboardingBrowserFixture } = await import("./offboarding-browser-fixture.mjs");
const offboardingFixture = await seedOffboardingBrowserFixture(dbPackage, suffix);
for (const [id, label] of [
  [offboardingFixture.actor, "Operator"], [offboardingFixture.legal, "Legal"], [offboardingFixture.viewer, "Viewer"],
]) {
  ownedIdentities.set(id, { firstName: "Separation", lastName: `Test ${label}`, email: `${label.toLowerCase()}@example.invalid` });
}
const { withControlledEmailIntakeProvider, receiveIntakeMessage } = await import("./src/lib/hro-email-ingestion.ts");
const { HRO_EMAIL_TEMPLATES, emailExample } = await import("./src/lib/hro-email-registry.ts");
const controlledMailbox = `email-intake-${suffix}@example.invalid`;
const intakeProvider = { get: async path => {
  assert.equal(path, "/gmail/v1/users/me/profile", "No real inbox may be fetched in browser tests");
  return { ok: true, json: async () => ({ emailAddress: controlledMailbox }) };
}};
// Admit the test dependency while this process is still in test mode.
// The admin-proof adapter later models development/production semantics.
// Bind both scopes together: capturing only the provider would discard the
// request's separate provider-deny ALS fence when restoring the snapshot.
const enterControlledRequest = runWithProviderDeny(() =>
  withControlledEmailIntakeProvider(intakeProvider, () => AsyncLocalStorage.bind(next => next())));
await db.insert(accessNamedGrants).values(["data.case.notes.read", "data.case.notes.edit"].map(resourceKey => ({
  organizationId: offboardingFixture.org, principalType: "human", principalId: offboardingFixture.actor,
  resourceKey, scope: "tenant", resourceType: "field", effect: "allow", source: "named", status: "active",
  createdByUserId: "fixture-independent-grantor", approvedByUserId: "fixture-independent-approver", approvedAt: new Date(),
}))).onConflictDoNothing();
app.post("/api/test/email-intake-message", async (req, res, next) => {
  try {
    const user = sessions.get(cookieValue(req, "browser_e2e_session"));
    if (user !== offboardingFixture.actor) return res.status(403).json({ error: "Controlled operator required" });
    const { hroMailboxIngress, hroEmailRequests } = dbPackage;
    const [route] = await db.select().from(hroMailboxIngress).where(and(eq(hroMailboxIngress.organizationId, offboardingFixture.org), eq(hroMailboxIngress.enabled, 1)));
    if (!route) return res.status(409).json({ error: "Configure a reviewed route first" });
    const template = HRO_EMAIL_TEMPLATES.find(t => t.id === req.body.templateId);
    if (!template) return res.status(400).json({ error: "Unknown controlled template" });
    const id = `controlled-email-${randomUUID()}`;
    await receiveIntakeMessage(controlledMailbox, { id, internalDate: String(Date.now()), payload: {
      mimeType: "text/plain", headers: [{ name: "From", value: "requester@example.invalid" }, { name: "Subject", value: `[HRO-INTAKE:${route.token}] Controlled request` }],
      body: { data: Buffer.from(emailExample(template)).toString("base64url") },
    }}, [], intakeProvider, { storage: { save: async () => {}, read: async () => Buffer.alloc(0), delete: async () => {} },
      scan: async () => "unavailable" });
    const [row] = await db.select().from(hroEmailRequests).where(eq(hroEmailRequests.providerMessageId, id));
    res.json({ id: row.id, templateId: row.templateId });
  } catch (error) { next(error); }
});
app.post("/api/test/offboarding-session", (req, res) => {
  const profile = req.body?.profile;
  const user = { "offboarding-operator": offboardingFixture.actor, "offboarding-legal": offboardingFixture.legal, "offboarding-viewer": offboardingFixture.viewer }[profile];
  if (!user) { res.status(403).json({ message: "Unknown isolated offboarding fixture" }); return; }
  const session = `${suffix}.${randomUUID()}`;
  sessions.set(session, user);
  res.cookie("browser_e2e_session", session, { httpOnly: true, sameSite: "lax", secure: false, path: "/" });
  res.json({ profile, organizationId: offboardingFixture.org, userId: user, providerBoundary: "deny-external-providers" });
});

app.get("/api/test/ready", (_req, res) => {
  res.json({ ready: true, providerBoundary: "deny-external-providers" });
});

// An ordinary named member in the disposable schema, with no specialist rows.
// This seam creates only a held review; it never initializes an engine/provider.
app.post("/api/test/permission-approval", async (req, res, next) => {
  try {
    if (sessions.get(cookieValue(req, "browser_e2e_session")) !== offboardingFixture.actor)
      return res.status(403).json({ message: "Controlled operator required" });
    const [c] = await db.insert(onbCases).values({
      organizationId: offboardingFixture.org, workerName: "Permission browser fixture",
      workerEmail: `permission-${randomUUID()}@example.invalid`, hireType: "external-fte",
      workerCategory: "employee", role: "Engineer", department: "Testing", geography: "US",
      workforceContext: { workCountry: "US" }, legalEntity: "Fixture US", managerName: "Manager",
      recruiterName: "Requester", joiningDate: "2031-01-01", createdByUserId: offboardingFixture.legal,
      lifecycleStage: "preboarding", orchestrationStatus: "waiting-approval", orchestrationCheckpoint: "waiting:manual-review",
    }).returning();
    const [approval] = await db.insert(dbPackage.onbApprovals).values({
      organizationId: offboardingFixture.org, caseId: c.id, agent: "human-review",
      ruleRef: "Permission browser review", hitlPattern: "approve-before-act", recommendation: "Review the current version",
      rationale: "Disposable provider-blocked fixture only", resumeAction: "none",
      requestedByUserId: offboardingFixture.legal, authorityScope: "legal-approve",
    }).returning();
    res.json({ caseId: c.id, approvalId: approval.id, version: approval.version });
  } catch (error) { next(error); }
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
  enterControlledRequest(next);
});

// The browser regression is allowed to inspect owned fixture state, but only
// through this process-local route and never by replacing production API
// responses. This also gives the test a durable provider-effect assertion.
app.post("/api/test/historical-case", async (req, res, next) => {
  try {
    const userId = sessions.get(cookieValue(req, "browser_e2e_session"));
    if (userId !== administrator) { res.status(403).end(); return; }
    // Developer fixture only, in the verified disposable schema. No runtime
    // seed, workflow initialization, token issuance or provider is invoked.
    const [row] = await db.insert(onbCases).values({
      organizationId: DEMO_ORGANIZATION_ID, workerName: "Fictional Demo Hire — Retained History",
      workerEmail: "fictional-demo-deadbeef@example.invalid", joiningDate: "2035-01-01",
      workerCategory: "employee", role: "History fixture", department: "Testing", geography: "US",
      legalEntity: "Demo", managerName: "Fixture manager", recruiterName: "Fixture recruiter",
      hireType: "external-fte", syntheticProvenance: "onboarding-demo-fictional",
      notes: "[synthetic-offline-reset:v1]", orchestrationStatus: "paused",
    }).returning();
    fixtureCaseIds.add(row.id);
    await db.insert(accessNamedGrants).values(["data.case.profile.read", "data.case.notes.read", "flow.case.read"].map(resourceKey => ({
      organizationId: DEMO_ORGANIZATION_ID, principalType: "human", principalId: administrator,
      scope: "case", caseId: row.id, resourceType: resourceKey.startsWith("flow") ? "flow" : "field",
      resourceKey, source: "named", effect: "allow", createdByUserId: administrator,
      approvedByUserId: "browser-independent-reviewer", approvedAt: new Date(),
    })));
    await db.insert(onbEvents).values({
      organizationId: DEMO_ORGANIZATION_ID, caseId: row.id, agent: "onboarding", engine: "historical-evidence",
      title: "[SIMULATED] Retained historical observation", detail: "Developer fixture of retained evidence, not a current operation.",
    });
    await db.insert(onbCommunications).values({
      organizationId: DEMO_ORGANIZATION_ID, caseId: row.id, channel: "email",
      direction: "outbound", toAddress: row.workerEmail, body: "[SIMULATED] Retained historical evidence",
      status: "logged-only",
    });
    res.json({ caseId: row.id, workerName: row.workerName });
  } catch (error) { next(error); }
});
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

// Opt-in isolated UAT harness: does not change the existing Control Tower pass.
if (process.env.ADMIN_READ_E2E_TEST === "true") {
  const { installAdminReadBrowserAdapter } = await import("./admin-read-browser-adapter.mjs");
  await installAdminReadBrowserAdapter(app, { dbPackage, sessions });
}
if (process.env.UAT_E2E_TEST === "true") {
  const { installUatBrowserAdapter } = await import("./uat-browser-adapter.mjs");
  await installUatBrowserAdapter(app, { dbPackage, sessions, userId: reviewer });
}
app.use("/api", router);
app.use((error, req, _res, next) => {
  console.error("Isolated browser request failed:", req.method, req.path, error.name, error.message);
  next(error);
});
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
  }
  process.exit(exitCode);
}
