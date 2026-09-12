/**
 * Privileged operator-only governance approval recorder.
 *
 * This deliberately has no HTTP route and no reusable bearer token: execution
 * requires an interactive, deployment-authorized shell plus an explicit
 * confirmation and a recorded external governance decision reference.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const organizationId = option("--organization");
const decisionRef = option("--decision-ref");
const source = option("--source");
const operatorUserId = option("--operator-user-id");
const bootstrapAdmin = option("--bootstrap-authority-admin");
if (
  !process.stdin.isTTY ||
  option("--confirm") !== "I_HAVE_REVIEWED_GOVERNANCE" ||
  !organizationId || !decisionRef || !source || !operatorUserId
) {
  throw new Error(
    "Usage from an authorized interactive operator shell: node approve-authority-governance.mjs --organization <tenant> --operator-user-id <authenticated-operator> --decision-ref <external-record> --source <auditable-system> [--bootstrap-authority-admin <different-member-user-id>] --confirm I_HAVE_REVIEWED_GOVERNANCE",
  );
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for protected operator execution.");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const member = bootstrapAdmin
    ? await client.query(
      `SELECT 1 FROM organization_memberships WHERE organization_id = $1 AND clerk_user_id = $2`,
      [organizationId, bootstrapAdmin],
    )
    : { rowCount: 1 };
  if (!member.rowCount) throw new Error("Bootstrap authority administrator must be an existing tenant member.");

  const governance = await client.query(
    `INSERT INTO onb_authority_governance
       (organization_id, status, approved_by_user_id, approved_at, governance_source, revision)
     VALUES ($1, 'governance-approved', $3, now(), $2, 1)
     ON CONFLICT (organization_id) DO UPDATE SET
       status = 'governance-approved',
        approved_by_user_id = EXCLUDED.approved_by_user_id,
       approved_at = now(),
       governance_source = EXCLUDED.governance_source,
       revision = onb_authority_governance.revision + 1,
       updated_at = now()
     RETURNING revision`,
    [organizationId, `${source}:${decisionRef}`, operatorUserId],
  );
  if (bootstrapAdmin) {
    const existing = await client.query(
       `SELECT 1 FROM onb_authority_assignments a
       WHERE a.organization_id = $1 AND a.person_user_id = $2 AND a.status = 'active'
          AND a.authority_role = 'governance'
          AND a.scopes @> '["authority-administration"]'::jsonb
          AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now())
          AND EXISTS (SELECT 1 FROM organization_memberships m
                      WHERE m.organization_id = a.organization_id AND m.clerk_user_id = a.person_user_id)`,
      [organizationId, bootstrapAdmin],
    );
    if (!existing.rowCount) {
      await client.query(
        `INSERT INTO onb_authority_assignments
          (id, organization_id, person_user_id, email_responder_authorized, authority_role, scopes,
           valid_from, status, revision, grantor_user_id, source, governance_decision_ref)
         VALUES ($1, $2, $3, false, 'governance', '["authority-administration"]'::jsonb,
                  now(), 'active', 1, $4, 'protected-operator-cli', $5)`,
         [randomUUID(), organizationId, bootstrapAdmin, operatorUserId, decisionRef],
      );
    }
  }
  await client.query(
    `INSERT INTO onb_authority_audit (organization_id, actor_user_id, action, detail)
     VALUES ($1, $2, 'governance-approved',
        jsonb_build_object('source', $3, 'governanceDecisionRef', $4, 'bootstrapAuthorityAdminUserId', $5))`,
    [organizationId, operatorUserId, source, decisionRef, bootstrapAdmin ?? null],
  );
  await client.query("COMMIT");
  console.log(`Governance approval recorded for ${organizationId} (revision ${governance.rows[0].revision}).`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}