import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, pool, onbCases, onbSettings, onbAuditLifecycles, onbEvents } from "@workspace/db";
import { isFictionalOfflineExampleCase } from "../lib/onboarding/offline-example-display";
import { isSyntheticOfflineCase } from "../lib/onboarding/synthetic-offline";
import { acquireCaseDispatchMutationLock } from "../lib/onboarding/dispatch-guard";
import { withSensitiveLifecycleFence, sensitiveLifecycleCaseDeletionBlockedInTransaction } from "../lib/onboarding/sensitive-lifecycle";
import { appendProtectedAuditInTransaction } from "../lib/onboarding/protected-audit";
import { deletedSourceDigest, HRO_CLEANUP_RECEIPT_KEY } from "../lib/offboarding/deleted-source";

// Frozen inventory: never expands to newly created cases and never runs on Publish.
const approvedIds = [10,154,356,357,535,2521,2522,2523,2524,2525,2526,2734,2735,2736,
  3374,3375,3406,3477,3695,3696,3697];
const organizationId = "demo";
const execute = process.argv.includes("--execute");
const confirm = process.argv.includes("--confirm-main-development-demo");
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function rows(tx: Tx, query: ReturnType<typeof sql>) {
  return (await tx.execute(query)).rows as Record<string, any>[];
}
function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function sample(row: typeof onbCases.$inferSelect) {
  // The authorized administrator's profile-readable case projection.
  if (row.operationalActivation !== null) throw new Error("Inventory activation changed; refusing cleanup");
  return isFictionalOfflineExampleCase(row) && isSyntheticOfflineCase(row);
}
const idsSql = sql.join(approvedIds.map(id => sql`${id}`), sql`,`);

async function run() {
  if (process.env.NODE_ENV !== "development" || (execute && !confirm)) {
    throw new Error("Only the explicitly confirmed main development Demo cleanup is supported");
  }
  return withSensitiveLifecycleFence(organizationId, () => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '90s'`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('maintenance-demo-hro-cleanup'))`);
    for (const id of approvedIds) await acquireCaseDispatchMutationLock(tx, organizationId, id);
    const [existingReceipt] = await tx.select().from(onbSettings).where(and(
      eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, HRO_CLEANUP_RECEIPT_KEY),
    )).for("update");
    if (existingReceipt) {
      const receipt = JSON.parse(existingReceipt.value);
      if (receipt.organizationId !== organizationId || receipt.version !== 1 ||
          JSON.stringify(receipt.deletedCaseIds) !== JSON.stringify(approvedIds)) throw new Error("Unexpected receipt");
      const remaining = await tx.select({ id: onbCases.id }).from(onbCases).where(and(
        eq(onbCases.organizationId, organizationId), inArray(onbCases.id, approvedIds),
      ));
      if (remaining.length) throw new Error("Completed deletion receipt disagrees with live inventory");
      return { status: "already-completed", deletedCount: receipt.deletedCaseIds.length, preservedCount: receipt.preservedCount };
    }
    const all = await tx.select().from(onbCases).where(eq(onbCases.organizationId, organizationId)).for("update");
    const candidates = all.filter(row => !sample(row));
    if (JSON.stringify(candidates.map(r => r.id).sort((a,b) => a-b)) !== JSON.stringify(approvedIds)) {
      throw new Error(`Displayed-reference inventory changed; refusing deletion. Current IDs: ${candidates.map(r => r.id).sort((a,b) => a-b).join(",")}; preserved: ${all.length-candidates.length}`);
    }
    // Claim token is a persistent numeric fencing generation, not an active lease.
    if (candidates.some(r => r.orchestrationClaimOwner ||
        (r.orchestrationClaimUntil && r.orchestrationClaimUntil.getTime() > Date.now()) ||
        ["running","processing","starting","awaiting-callback"].includes(r.orchestrationStatus))) {
      throw new Error("An active orchestration claim blocks cleanup");
    }
    const [auditLifecycle] = await tx.select().from(onbAuditLifecycles)
      .where(eq(onbAuditLifecycles.organizationId, organizationId)).for("update");
    if (auditLifecycle?.legalHoldActive ||
        await sensitiveLifecycleCaseDeletionBlockedInTransaction(tx, organizationId, approvedIds)) {
      throw new Error("A legal hold or unfinished private upload blocks cleanup");
    }
    // Retain evidence in an existing tenant-bound private setting, never in a
    // downloadable file. Auth sessions/tokens and case source rows are NOT backed up.
    const retainedEvidence: Record<string, unknown[]> = {};
    const evidenceTables = ["onb_events", "onb_guardrail_events", "onb_communications",
      "onb_system_checks", "onb_approvals", "onb_approval_notifications",
      "onb_readiness_sla_outbox", "onb_candidate_uploads", "offb_checkpoints", "offb_exchange_pilots"];
    // Locks exclude new claims while we inspect and remove this exact inventory.
    for (const table of [...evidenceTables, "offb_sources", "offb_cases", "onb_effect_journal",
      "onb_voice_sessions", "onb_candidate_upload_reservations", "hro_email_requests", "hro_mailbox_requests",
      "employee_vault_requests", "employee_vault_receipts", "onb_intake_batch_people",
      "onb_standard_provider_source_records", "case_list_visibility", "case_list_visibility_changes"]) {
      await tx.execute(sql`LOCK TABLE ${sql.identifier(table)} IN SHARE ROW EXCLUSIVE MODE`);
    }
    const effects = await rows(tx, sql`SELECT status FROM onb_effect_journal
      WHERE organization_id=${organizationId} AND case_id IN (${idsSql})`);
    if (effects.some(r => !["confirmed","definitive_failure"].includes(r.status))) {
      throw new Error("An unresolved provider effect blocks cleanup");
    }
    const voices = await rows(tx, sql`SELECT finalized, call_sid FROM onb_voice_sessions
      WHERE organization_id=${organizationId} AND case_id IN (${idsSql})`);
    if (voices.some(r => !r.finalized && r.call_sid)) throw new Error("A live voice callback blocks cleanup");
    for (const table of evidenceTables) {
      const data = await rows(tx, sql`SELECT * FROM ${sql.identifier(table)}
        WHERE organization_id=${organizationId} AND case_id IN (${idsSql})`);
      retainedEvidence[table] = data;
      const terminal: Record<string, string[]> = {
        onb_communications: ["sent","received","failed","completed","logged-only","simulated","blocked","cancelled"],
        onb_system_checks: ["done","failed","blocked","completed","simulated","logged-only"],
        onb_approval_notifications: ["sent","failed","blocked","cancelled","logged-only"],
        onb_readiness_sla_outbox: ["sent","failed","blocked","cancelled","logged-only"],
      };
      if (terminal[table] && data.some(r => !terminal[table].includes(r.status))) {
        throw new Error(`Unfinished ${table} work blocks cleanup`);
      }
      if (table === "onb_candidate_uploads" &&
          data.some(r => r.validation_claim_owner || r.malware_scan_state === "scanning")) {
        throw new Error("An unfinished private-file validation blocks cleanup");
      }
    }
    // These have non-case ownership or separate deduplication requirements.
    // The approved inventory has none; refuse rather than cascade new ones.
    for (const table of ["employee_vault_requests","employee_vault_receipts",
      "hro_email_requests","hro_mailbox_requests","onb_intake_batch_people","onb_standard_provider_source_records"]) {
      if ((await rows(tx, sql`SELECT 1 FROM ${sql.identifier(table)} WHERE case_id IN (${idsSql}) LIMIT 1`)).length) {
        throw new Error(`New ${table} dependencies require review`);
      }
    }
    const sources = await rows(tx, sql`SELECT organization_id,channel,source_reference,fingerprint,case_id
      FROM offb_sources WHERE organization_id=${organizationId} AND case_id IN (${idsSql})`);
    const effectIdentity = await rows(tx, sql`SELECT logical_operation_key,case_id,status,external_effect_id
      FROM onb_effect_journal WHERE organization_id=${organizationId} AND case_id IN (${idsSql})`);
    const otherBefore = await rows(tx, sql`SELECT organization_id,count(*)::integer AS count
      FROM onb_cases WHERE organization_id<>${organizationId} GROUP BY organization_id ORDER BY organization_id`);
    const preserved = all.filter(row => sample(row));
    const preservedDigest = hash(preserved);
    const inventoryRevision = hash({ candidates, sources, retainedEvidence, effectIdentity });
    const expectedRevision = process.argv.find(arg => arg.startsWith("--revision="))?.slice(11);
    if (execute && expectedRevision !== inventoryRevision) throw new Error("Dry-run revision changed; refusing cleanup");
    const summary = { status: execute ? "completed" : "ready", environment: "main-development",
      organizationId, candidateCount: candidates.length, preservedCount: preserved.length,
      offboardingCount: sources.length, revision: inventoryRevision };
    if (!execute) return summary;

    const receipt = {
      version: 1, organizationId, environment: "main-development", completedAt: new Date().toISOString(),
      authorization: "Explicit user confirmation of main-development Demo HRO-prefixed deletion",
      deletedCaseIds: approvedIds, preservedCount: preserved.length, preservedDigest,
      inventoryRevision, offboardingSourceTombstones: sources.map(s =>
        deletedSourceDigest(organizationId, s.channel, s.source_reference)),
      retainedSourceFingerprints: sources.map(({ case_id, fingerprint }) => ({ caseId: case_id, fingerprint })),
      retainedEffectIdentity: effectIdentity, retainedEvidence,
    };
    await tx.insert(onbSettings).values({
      organizationId, key: HRO_CLEANUP_RECEIPT_KEY, value: JSON.stringify(receipt), updatedAt: new Date(),
    });
    for (const table of ["case_list_visibility_changes","case_list_visibility",
      "offb_checkpoints","offb_exchange_pilots","offb_sources"]) {
      await tx.execute(sql`DELETE FROM ${sql.identifier(table)}
        WHERE organization_id=${organizationId} AND case_id IN (${idsSql})`);
    }
    await tx.execute(sql`DELETE FROM offb_cases WHERE organization_id=${organizationId} AND id IN (${idsSql})`);
    // SET NULL retains the durable journal; record original case bindings in the receipt.
    await tx.execute(sql`UPDATE onb_effect_journal SET case_id=NULL
      WHERE organization_id=${organizationId} AND case_id IN (${idsSql})`);
    const deleted = await tx.delete(onbCases).where(and(
      eq(onbCases.organizationId, organizationId), inArray(onbCases.id, approvedIds),
    )).returning({ id: onbCases.id });
    if (deleted.length !== approvedIds.length) throw new Error("Deletion count changed");
    for (const { id } of deleted) await appendProtectedAuditInTransaction(tx, {
      organizationId, actorId: "user-confirmed-development-maintenance", actorKind: "system",
      actorAuthority: "explicit-user-authorized-one-time-maintenance",
      action: "onboarding.case.deleted", outcome: "success", objectType: "case", objectId: String(id),
      caseReference: `case:${id}`, source: "development-hro-cleanup", correlationId: inventoryRevision,
      payload: { referencePrefix: "HRO", replacementCasesCreated: 0 },
    });
    await tx.insert(onbEvents).values({
      organizationId, caseId: null, agent: "human", engine: "human", hitlPattern: "approve-before-act",
      ruleRef: "USERCONFIRMED main-development Demo HRO case deletion",
      title: "HRO-prefixed cases permanently deleted",
      detail: `${deleted.length} case records removed; ${preserved.length} S-prefixed examples preserved. No replacement cases, external messages or file deletions.`,
    });
    const remaining = await tx.select().from(onbCases).where(eq(onbCases.organizationId, organizationId));
    if (hash(remaining.filter(row => sample(row)).sort((a,b) => a.id-b.id)) !==
        hash(preserved.sort((a,b) => a.id-b.id)) || remaining.some(row => approvedIds.includes(row.id))) {
      throw new Error("Preserved example verification failed");
    }
    const otherAfter = await rows(tx, sql`SELECT organization_id,count(*)::integer AS count
      FROM onb_cases WHERE organization_id<>${organizationId} GROUP BY organization_id ORDER BY organization_id`);
    if (hash(otherBefore) !== hash(otherAfter)) throw new Error("Other-client counts changed during cleanup");
    return { ...summary, deletedCount: deleted.length };
  }));
}

run().then(result => console.log(JSON.stringify(result)))
  .catch(error => {
    // Do not expose SQL parameters, private evidence, or credential-bearing errors.
    const safe = error instanceof Error && !("query" in error) ? error.message : "Cleanup transaction failed and was rolled back";
    console.error(JSON.stringify({ status: "blocked", message: safe }));
    process.exitCode = 1;
  }).finally(() => pool.end());
