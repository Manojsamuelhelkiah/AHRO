import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHmac, randomBytes } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { onbCases, onbSettings } from "@workspace/db/schema";
import { createDevelopmentAdminContext, bindDevelopmentSuperAdminTenant } from "./development-super-admin";
import { hasHumanPermissions, isSharedDemoPrincipalInTransaction } from "./human-permissions";
import type { Request, Response } from "express";
import type { OnboardingDbTransaction } from "./onboarding/settings";
import { resolveSensitiveAccessInTransaction, NO_SENSITIVE_ACCESS } from "./onboarding/sensitive-access";

test("verified Demo Administrator permissions are session- and tenant-bound, not public persona rights", async () => {
  const oldMode = process.env.NODE_ENV;
  const oldPassword = process.env.DEV_SUPER_ADMIN_PASSWORD;
  const signingKey = randomBytes(32).toString("hex");
  const actor = "fixture_demo_admin";
  const organizationId = "fixture_admin_client";
  const dialect = new PgDialect();
  // Query-only fixture: no shared database writes or client records.
  const tx = {
    select() {
      return { from(table: unknown) {
        let rows: unknown[] = [];
        const chain = {
          where(expression: Parameters<PgDialect["sqlToQuery"]>[0]) {
            const values = dialect.sqlToQuery(expression).params;
            rows = table === onbSettings ? [{ value: "administrator" }]
              : table === onbCases && values.includes(101) && values.includes(organizationId)
                ? [{ id: 101 }] : [];
            return chain;
          },
          async limit() { return rows; },
        };
        return chain;
      } };
    },
  } as unknown as OnboardingDbTransaction;
  const input = {
    actorUserId: actor, organizationId, caseId: 101,
    requiredKeys: ["data.case.profile.edit", "data.case.notes.edit"] as const,
  };
  try {
    process.env.NODE_ENV = "development";
    process.env.DEV_SUPER_ADMIN_PASSWORD = signingKey;
    assert.equal(await isSharedDemoPrincipalInTransaction(tx, actor), true);
    assert.equal(await hasHumanPermissions(tx, input), false, "Public Demo shortcut must not gain private admin rights");
    const issuedAt = Date.now() - 10;
    const sessionId = "fixture_admin_session";
    const payload = Buffer.from(JSON.stringify({
      userId: actor, sessionId, issuedAt, expiresAt: issuedAt + 4 * 60 * 60 * 1000,
    })).toString("base64url");
    const signature = createHmac("sha256", signingKey).update(payload).digest("base64url");
    const req = {
      authUserId: actor, method: "GET",
      headers: { cookie: `hro_dev_super_admin=${payload}.${signature}` },
      auth: Object.assign(() => ({ userId: actor, sessionId, tokenType: "session_token" }),
        { [Symbol.for("@clerk/express.auth")]: true }),
    } as unknown as Request;
    const res = Object.assign(new EventEmitter(), {
      writableEnded: false, destroyed: false,
      setHeader() {},
      status() { throw new Error("Fixture administrator admission failed"); },
    }) as unknown as Response;
    const middleware = createDevelopmentAdminContext({
      getSession: async () => ({ userId: actor, status: "active", createdAt: issuedAt + 1 }),
    });
    let work: Promise<void> | undefined;
    await middleware(req, res, () => {
      work = (async () => {
        bindDevelopmentSuperAdminTenant(organizationId);
        assert.equal(await hasHumanPermissions(tx, input), true);
        assert.equal(await hasHumanPermissions(tx, { ...input, ownerAdminRequired: true }), true);
        const sensitive = await resolveSensitiveAccessInTransaction(tx, {
          organizationId, caseId: 101, actorUserId: actor,
        });
        for (const classification of ["identity", "medical", "payroll", "bgv"] as const) {
          assert.equal(sensitive[classification], true);
          assert.equal(sensitive.edit?.[classification], true);
        }
        assert.equal(await hasHumanPermissions(tx, { ...input, caseId: 202 }), false, "Unknown case denied");
        assert.equal(await hasHumanPermissions(tx, { ...input, organizationId: "different_client" }), false);
        res.emit("finish");
        assert.equal(await hasHumanPermissions(tx, input), false, "An ended private session cannot keep administrative rights");
        assert.deepEqual(await resolveSensitiveAccessInTransaction(tx, {
          organizationId, caseId: 101, actorUserId: actor,
        }), NO_SENSITIVE_ACCESS);
      })();
    });
    assert.ok(work, "Verified administrator request must reach the scoped handler");
    await work;
  } finally {
    if (oldMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldMode;
    if (oldPassword === undefined) delete process.env.DEV_SUPER_ADMIN_PASSWORD;
    else process.env.DEV_SUPER_ADMIN_PASSWORD = oldPassword;
  }
});
