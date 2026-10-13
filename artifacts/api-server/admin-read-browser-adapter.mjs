/**
 * Isolated browser fixture only. Actual proof verifiers and case routes run;
 * provider identities/MFA are fixtures, not claims of real provider sign-in.
 */
import { createHmac, randomUUID } from "node:crypto";
import { AsyncResource } from "node:async_hooks";

export async function installAdminReadBrowserAdapter(app, { dbPackage, sessions, ownedIdentities }) {
  if (process.env.ONBOARDING_E2E_TEST !== "true" || process.env.ADMIN_READ_E2E_TEST !== "true" ||
      process.env.NODE_ENV === "production") throw new Error("Isolated admin harness only.");
  const scope = (await dbPackage.pool.query("SELECT current_schema() s, current_schemas(false)::text[] scopes")).rows[0];
  if (!/^browser_regression_[0-9]+_[a-f0-9]+$/.test(scope.s) || scope.scopes.length !== 1)
    throw new Error("Admin fixture requires its owned disposable schema, without a shared fallback");
  const { db, organizationsTable, organizationMembershipsTable, onbCases, onbDocuments,
    onbCommunications, accessNamedGrants, employeeVaultProducts, onbSettings, DEMO_ORGANIZATION_ID } = dbPackage;
  const { and, eq } = await import("drizzle-orm");
  const { demoPrincipalSettingKey } = await import("./src/lib/demo-principal.ts");
  const { createDevelopmentAdminContext } = await import("./src/lib/development-super-admin.ts");
  const { createPlatformAdminContext, bindPlatformSuperAdminTenant, signAdminGrant,
    ADMIN_APPROVAL_KEY, ADMIN_COOKIE, ADMIN_LIFETIME_MS } = await import("./src/lib/private-platform-admin.ts");
  const { resolveSensitiveAccess } = await import("./src/lib/onboarding/sensitive-access.ts");
  const { hasCurrentAuthorityScope } = await import("./src/lib/onboarding/decision-authority.ts");
  const background = new AsyncResource("unprivileged-admin-read-fixture");
  const org = `admin-read-${randomUUID()}`;
  const frontlineOrg = `frontline-admin-${randomUUID()}`;
  const actor = `named-admin-read-${randomUUID()}`;
  ownedIdentities?.set(actor, { firstName: "Isolated", lastName: "Administrator", email: "admin@example.invalid" });
  const secret = randomUUID() + randomUUID();
  process.env.NODE_ENV = "development";
  process.env.DEV_SUPER_ADMIN_PASSWORD = secret;
  process.env.SESSION_SECRET = secret;
  await db.insert(organizationsTable).values({
    id: org, name: "Isolated administrative viewing", slug: org,
    joinCodeHash: randomUUID(), createdByUserId: actor,
  });
  await db.insert(organizationMembershipsTable).values({ organizationId: org, clerkUserId: actor, role: "member" });
  // The edit journey does not exercise employee-owned consent/reuse. Enabling
  // it mounts a separate write-fenced Vault read, outside this test's scope.
  await db.insert(employeeVaultProducts).values({
    organizationId: org, enabled: process.env.ADMIN_EDIT_E2E_TEST !== "true", version: 1, updatedBy: actor,
  });
  // Frontline records are separate from the existing enabled-Vault fixtures.
  await db.insert(organizationsTable).values({
    id: frontlineOrg, name: "Isolated Frontline administration", slug: frontlineOrg,
    joinCodeHash: randomUUID(), createdByUserId: actor,
  });
  await db.insert(organizationMembershipsTable).values({ organizationId: frontlineOrg, clerkUserId: actor, role: "member" });
  const [c] = await db.insert(onbCases).values({
    organizationId: org, workerName: "Confidential Read Fixture", workerEmail: "fixture@example.invalid",
    workerPhone: "+15550000000", managerName: "Fixture Manager", recruiterName: "Fixture Recruiter",
    hireType: "external-fte", workerCategory: "employee", role: "Engineer", department: "Test",
    geography: "US", legalEntity: "Fixture", joiningDate: "2030-01-01",
    lifecycleStage: "complete", orchestrationStatus: "completed", notes: "Private client narrative",
    workforceContext: { workCountry: "US" }, createdByUserId: actor,
  }).returning();
  const { seedApprovedSensitiveLifecyclePolicies } = await import("./src/test-utils/sensitive-lifecycle-fixtures.ts");
  await seedApprovedSensitiveLifecyclePolicies(org);
  await seedApprovedSensitiveLifecyclePolicies(frontlineOrg);
  const frontlinePolicy = { processPolicy: { frontline: {
    schemaVersion: "frontline-operations/v1", age: { minimumYears: 18 },
    fulfillment: { requiredItems: ["badge"] }, statutory: { requirements: [] },
    exceptions: { policyReference: "TEST-POLICY", reviewReference: "TEST-REVIEW", permitted: [] },
  } } };
  const frontline = {};
  for (const state of ["active", "retained", "office"]) {
    const [record] = await db.insert(onbCases).values({
      organizationId: frontlineOrg, workerName: `Frontline ${state} fixture`, workerEmail: `${state}@example.invalid`,
      managerName: "Fixture Manager", recruiterName: "Fixture Recruiter",
      hireType: "external-fte", workerCategory: "employee", role: "Operator", department: "Test",
      geography: "US", legalEntity: "Fixture", joiningDate: "2030-01-01",
      lifecycleStage: "preboarding", orchestrationStatus: "waiting-approval", createdByUserId: actor,
      controllerRetired: state === "retained",
      workforceContext: { workCountry: "US", workEnvironment: state === "office" ? "office" : "site" },
      processPolicySnapshot: frontlinePolicy,
    }).returning();
    frontline[state] = record.id;
  }
  for (const key of ["flow.case.read", "data.case.profile.read", "data.case.notes.read",
    "data.documents.read", "data.case.readiness.read", "flow.document-review.read"]) {
    await db.insert(accessNamedGrants).values([org, frontlineOrg].map(organizationId => ({
      organizationId, principalType: "human", principalId: actor,
      resourceType: key.startsWith("flow") ? "flow" : "field", resourceKey: key,
      effect: "allow", scope: "tenant", source: "named", createdByUserId: actor,
    })));
  }
  await db.insert(onbDocuments).values({
    organizationId: org, caseId: c.id, key: "id-proof",
    label: "Government photo ID (passport / national ID)", category: "identity",
    required: true, status: "pending", note: "Private document note",
  });
  await db.insert(onbCommunications).values({
    organizationId: org, caseId: c.id, channel: "email", direction: "inbound", audience: "internal",
    toAddress: "fixture@example.invalid", subject: "Private client message", body: "Private message body", status: "received",
  });
  const editFixture = process.env.ADMIN_EDIT_E2E_TEST === "true"
    ? await (await import("./admin-edit-browser-fixture.mjs")).installAdminEditFixture(app, { dbPackage, sessions, org, actor })
    : null;
  const states = new Map();
  let approvalGeneration = "fixture";
  const cookie = (req, name) => req.cookies?.[name];
  app.get("/api/platform-admin/session", (_req, res) => res.json({
    eligible: false, userId: actor, primaryEmailId: "fixture-email",
    primaryEmailVerified: true, mfaEnrolled: true, mfaRequired: true, lifetimeMinutes: 15,
  }));
  app.delete("/api/platform-admin/session", (req, res) => {
    const id = cookie(req, "browser_e2e_session");
    if (id) {
      const state = states.get(id);
      if (state) state.status = "revoked";
      sessions.delete(id);
    }
    res.clearCookie(ADMIN_COOKIE, { path: "/" });
    res.clearCookie("hro_dev_super_admin", { path: "/" });
    res.json({ active: false });
  });
  app.post("/api/test/admin-read/session", async (req, res) => {
    const sessionId = cookie(req, "browser_e2e_session");
    if (!sessionId || !sessions.has(sessionId)) { res.sendStatus(401); return; }
    // Model the public Demo Administrator identity independently of its proof.
    // The caller cannot select identities or touch any non-owned database.
    if (req.body?.sharedDemo) {
      await db.insert(onbSettings).values({ organizationId: DEMO_ORGANIZATION_ID,
        key: demoPrincipalSettingKey(actor), value: "administrator" })
        .onConflictDoUpdate({ target: [onbSettings.organizationId, onbSettings.key], set: { value: "administrator" } });
    } else {
      await db.delete(onbSettings).where(and(eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
        eq(onbSettings.key, demoPrincipalSettingKey(actor))));
    }
    sessions.set(sessionId, actor);
    const mode = req.body?.mode || "ordinary";
    process.env.NODE_ENV = mode === "private" ? "production" : "development";
    const issuedAt = Date.now() - (req.body?.expired ? ADMIN_LIFETIME_MS + 1000 :
      req.body?.short ? ADMIN_LIFETIME_MS - 5000 : 0);
    const state = { mode, status: req.body?.revoked ? "revoked" : "active",
      generation: req.body?.rotated ? "rotated" : "fixture", issuedAt };
    states.set(sessionId, state);
    approvalGeneration = state.generation;
    res.clearCookie(ADMIN_COOKIE, { path: "/" });
    res.clearCookie("hro_dev_super_admin", { path: "/" });
    const proofSession = req.body?.wrongSession ? "wrong-session" : sessionId;
    if (mode === "private") {
      const value = signAdminGrant({
        userId: actor, sessionId: proofSession, environment: "production", generation: "fixture",
        issuedAt, expiresAt: issuedAt + ADMIN_LIFETIME_MS,
      }, secret);
      res.cookie(ADMIN_COOKIE, req.body?.invalid ? "invalid" : value, { httpOnly: true, path: "/", sameSite: "lax" });
    } else if (mode === "development") {
      const devIssuedAt = req.body?.expired ? Date.now() - 4 * 60 * 60_000 - 1000 :
        req.body?.short ? Date.now() - 4 * 60 * 60_000 + 5000 : Date.now();
      const payload = Buffer.from(JSON.stringify({
        userId: actor, sessionId: proofSession, issuedAt: devIssuedAt, expiresAt: devIssuedAt + 4 * 60 * 60_000,
      })).toString("base64url");
      const value = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
      res.cookie("hro_dev_super_admin", req.body?.invalid ? "invalid" : value, { httpOnly: true, path: "/", sameSite: "lax" });
    }
    res.json({ caseId: c.id, actorUserId: actor, ...editFixture?.[mode],
      organizationId: req.body?.frontline ? frontlineOrg : org, frontline });
  });
  const privateContext = createPlatformAdminContext({
    getUser: async () => ({
      id: actor, primaryEmailAddressId: "fixture-email", twoFactorEnabled: true,
      emailAddresses: [{ id: "fixture-email", verification: { status: "verified" } }],
      privateMetadata: { [ADMIN_APPROVAL_KEY]: { userId: actor, primaryEmailId: "fixture-email",
        environment: "production", generation: approvalGeneration, decisionRef: "fixture" } },
    }),
    getSession: async id => ({ userId: actor, status: states.get(id)?.status || "revoked" }),
    isDemo: async () => false,
  });
  const developmentContext = createDevelopmentAdminContext({
    getSession: async id => ({ userId: actor, status: states.get(id)?.status || "revoked", createdAt: Date.now() + 1000 }),
  });
  app.use("/api", async (req, res, next) => {
    const sessionId = cookie(req, "browser_e2e_session");
    // Also model signed-out Clerk requests: the real guard should return 401,
    // not throw because this isolated server has no provider middleware.
    req.auth = Object.assign(() => ({
      userId: sessions.get(sessionId) || null, sessionId: sessions.has(sessionId) ? sessionId : null,
      sessionClaims: { fva: [0, 0] }, tokenType: "session_token",
    }), { [Symbol.for("@clerk/express.auth")]: true });
    if (sessions.get(sessionId) !== actor) { next(); return; }
    const state = states.get(sessionId);
    const enter = state?.mode === "development" ? developmentContext : privateContext;
    await enter(req, res, () => {
      // A rejected development proof has already been checked with the fixture
      // provider. Do not recheck it via the live provider in the nested guard.
      if (state?.mode === "development" && !req.developmentSuperAdmin) {
        req.headers.cookie = req.headers.cookie?.split(";")
          .filter(value => !value.trim().startsWith("hro_dev_super_admin=")).join(";");
      }
      // Production tenant middleware independently verifies the selected tenant.
      next();
    });
  });
  app.get("/api/test/admin-read/boundaries", async (req, res) => {
    bindPlatformSuperAdminTenant(org);
    const access = await resolveSensitiveAccess({ organizationId: org, caseId: c.id, actorUserId: actor });
    const wrongCase = await resolveSensitiveAccess({ organizationId: org, caseId: c.id + 999999, actorUserId: actor });
    const wrongTenant = await resolveSensitiveAccess({ organizationId: "other-tenant", caseId: c.id, actorUserId: actor });
    const wrongActor = await resolveSensitiveAccess({ organizationId: org, caseId: c.id, actorUserId: "other-actor" });
    // This legacy function now evaluates named human decision permissions.
    // It does not attest professional qualifications.
    const humanDecisionPermission = await db.transaction(tx => hasCurrentAuthorityScope(tx, {
      organizationId: org, actorUserId: actor, scope: "hr-compliance-approve", caseId: c.id,
    }));
    // This read-only probe validates projections, not mutation persistence.
    // Active administrative writes have their own isolated regression suite.
    res.json({ access, wrongCase, wrongTenant, wrongActor, humanDecisionPermission });
  });
  // No request ALS context: background work must not inherit an admin identity.
  app.get("/api/test/admin-read/background", async (_req, res) => {
    const result = await background.runInAsyncScope(() => resolveSensitiveAccess({
      organizationId: org, caseId: c.id, actorUserId: actor,
    }));
    res.json(result);
  });
}
