import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db, employeeVaultDocuments as docs, employeeVaultRequests as requests, employeeVaultChecks as checks, employeeVaultReceipts as receipts, onbSensitiveLifecycleHolds as holds } from "@workspace/db";
import { configuredMalwareScanner, type MalwareScanner } from "../onboarding/malware-scanner";
import { getPrivateFile } from "../objectStorage";
import { auditVault, liveVaultPolicy, vaultWrite, invalidateDocumentChecks, invalidateVaultReuse } from "./core";
import { VAULT_MAX_BYTES } from "./policy";
import { evaluateVaultReuse } from "./reuse";
import { onbCases } from "@workspace/db";
import { runExpiryNoticeTick } from "./expiry-notices";

/** Durable queue driven by the existing supported heartbeat, not a new timer. */
export async function runEmployeeVaultTick(options: {
  profileId?: string; scanner?: MalwareScanner;
  readBytes?: (d: typeof docs.$inferSelect) => Promise<Buffer>;
  deleteBytes?: (d: typeof docs.$inferSelect) => Promise<void>;
} = {}) {
  if (options.scanner || options.readBytes || options.deleteBytes) {
    if (!options.profileId) throw new Error("Synthetic worker adapters require an isolated employee profile.");
    const { employeeVaultProfiles } = await import("@workspace/db");
    const [p] = await db.select().from(employeeVaultProfiles).where(eq(employeeVaultProfiles.id, options.profileId));
    if (!p?.userId.startsWith("vault-test-employee-")) throw new Error("Synthetic worker adapters are restricted to explicitly named test-only profiles.");
  }
  const now = new Date();
  await runExpiryNoticeTick(options.profileId);
  const scope = options.profileId ? eq(docs.profileId, options.profileId) : undefined;
  const expiredRequests = await db.select().from(requests).where(and(
    options.profileId ? eq(requests.profileId, options.profileId) : undefined,
    inArray(requests.state, ["pending", "approved"]), lte(requests.expiresAt, now),
  )).limit(20);
  for (const r of expiredRequests) await vaultWrite({ requestId: r.id, withdrawal: true }, async tx => {
    await tx.update(requests).set({ state: "expired", version: r.version + 1, documentIds: [], checkIds: [] })
      .where(and(eq(requests.id, r.id), lte(requests.expiresAt, new Date()), inArray(requests.state, ["pending", "approved"])));
    await invalidateVaultReuse(tx, { requestId: r.id });
  });
  const expiredChecks = await db.select().from(checks).where(and(
    options.profileId ? eq(checks.profileId, options.profileId) : undefined,
    eq(checks.state, "clear"), lte(checks.expiresAt, now),
  )).limit(20);
  for (const c of expiredChecks) await vaultWrite({ profileId: c.profileId, withdrawal: true }, async tx => {
    await tx.update(checks).set({ state: "expired" }).where(and(eq(checks.id, c.id), eq(checks.state, "clear"), lte(checks.expiresAt, new Date())));
    await invalidateVaultReuse(tx, { profileId: c.profileId });
  });
  const stranded = await db.select().from(docs).where(and(scope,
    or(and(eq(docs.state, "reserved"), lte(docs.leaseUntil, now)), and(eq(docs.state, "scanning"), lte(docs.leaseUntil, now))),
  )).limit(20);
  for (const d of stranded) await vaultWrite({ profileId: d.profileId, withdrawal: true }, async tx => {
    const [current] = await tx.select().from(docs).where(eq(docs.id, d.id));
    if (!current?.leaseUntil || current.leaseUntil > new Date()) return;
    await tx.update(docs).set({
      state: current.state === "reserved" ? "delete-pending" : "timeout",
      scanSha256: null, scanId: null, leaseUntil: null, updatedAt: new Date(),
    }).where(eq(docs.id, d.id));
  });
  // Retry unavailable infrastructure with bounded backoff; an infected file
  // never becomes clean merely because configuration changed.
  if (configuredMalwareScanner() || options.scanner) {
    const retry = await db.select().from(docs).where(and(scope,
      inArray(docs.state, ["unavailable", "timeout", "indeterminate"]), lte(docs.updatedAt, new Date(Date.now() - 10 * 60000)),
    )).limit(5);
    for (const d of retry) await vaultWrite({ profileId: d.profileId, withdrawal: true }, async tx => {
      try { await liveVaultPolicy(tx, { storage: true, scanner: true, jurisdiction: d.jurisdiction }); } catch { return; }
      await tx.update(docs).set({ state: "pending", updatedAt: new Date() }).where(and(eq(docs.id, d.id), inArray(docs.state, ["unavailable", "timeout", "indeterminate"])));
    });
  }
  const pending = await db.select().from(docs).where(and(scope, eq(docs.state, "pending"))).limit(5);
  await Promise.all(pending.map(async initial => {
    const scanId = randomUUID();
    const claimed = await vaultWrite({ profileId: initial.profileId }, async tx => {
      const [d] = await tx.select().from(docs).where(eq(docs.id, initial.id));
      if (!d || d.state !== "pending") return null;
      try { const p = await liveVaultPolicy(tx, { storage: true, scanner: true, jurisdiction: d.jurisdiction });
        if (d.policyRevision !== p.revision) throw new Error("Processing approval changed");
      } catch {
        await tx.update(docs).set({ state: "unavailable", updatedAt: new Date() }).where(eq(docs.id, d.id)); return null;
      }
      await tx.update(docs).set({ state: "scanning", scanId, leaseUntil: new Date(Date.now() + 30000), updatedAt: new Date() }).where(eq(docs.id, d.id));
      return d;
    });
    if (!claimed) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let verdict: string = "unavailable", checksum: string | null = null;
    try {
      const scanner = options.scanner ?? configuredMalwareScanner();
      if (scanner) {
        const bytes = options.readBytes ? await options.readBytes(claimed) :
          (await getPrivateFile(claimed.objectPath).download({ start: 0, end: VAULT_MAX_BYTES }))[0];
        checksum = createHash("sha256").update(bytes).digest("hex");
        // Storage I/O can outlive a claim or employee withdrawal. Recheck the
        // live reservation and processing authority before scanner disclosure.
        const authorized = await vaultWrite({ profileId: claimed.profileId, withdrawal: true }, async tx => {
          const [d] = await tx.select().from(docs).where(eq(docs.id, claimed.id));
          if (!d || d.state !== "scanning" || d.scanId !== scanId || !d.leaseUntil ||
              d.leaseUntil <= new Date() || d.revision !== claimed.revision || d.sha256 !== checksum) return false;
          try { const p = await liveVaultPolicy(tx, { storage: true, scanner: true, jurisdiction: d.jurisdiction }); return d.policyRevision === p.revision; }
          catch { return false; }
        });
        verdict = !authorized || controller.signal.aborted || !bytes.length || bytes.length !== claimed.sizeBytes || bytes.length > VAULT_MAX_BYTES || checksum !== claimed.sha256
          ? "indeterminate" : await scanner.scan(bytes, controller.signal);
      }
    } catch { verdict = controller.signal.aborted ? "timeout" : "unavailable"; }
    finally { clearTimeout(timer); controller.abort(); }
    await vaultWrite({ profileId: claimed.profileId, withdrawal: true }, async tx => {
      const [d] = await tx.select().from(docs).where(eq(docs.id, claimed.id));
      if (!d || d.state !== "scanning" || d.scanId !== scanId) return;
      if (!d.leaseUntil || d.leaseUntil <= new Date()) verdict = "timeout";
      try { const p = await liveVaultPolicy(tx, { storage: true, scanner: true, jurisdiction: d.jurisdiction }); if (d.policyRevision !== p.revision) verdict = "unavailable"; } catch { verdict = "unavailable"; }
      if (verdict === "clean" && (!checksum || checksum !== d.sha256)) verdict = "indeterminate";
      await tx.update(docs).set({ state: verdict, scanSha256: verdict === "clean" ? checksum : null, scanId: null, leaseUntil: null, updatedAt: new Date() }).where(eq(docs.id, d.id));
      if (verdict !== "clean") await invalidateDocumentChecks(tx, d.profileId, d.id);
      await auditVault(tx, d.profileId, "private-scanner", `malware-${verdict}`, d.id);
    });
  }));
  // Retain inventory even after deletion: late storage writes from interrupted
  // uploads are never readable and can be deleted again in future sweeps.
  const cleanup = await db.select().from(docs).where(and(scope, inArray(docs.state, ["delete-pending", "superseded", "deleted"]),
    or(isNull(docs.holdUntil), lte(docs.holdUntil, new Date())),
  )).orderBy(docs.updatedAt).limit(20);
  for (const initial of cleanup) await vaultWrite({ profileId: initial.profileId, withdrawal: true }, async tx => {
    const [d] = await tx.select().from(docs).where(eq(docs.id, initial.id));
    if (!d || (d.holdUntil && d.holdUntil > new Date())) return;
    await liveVaultPolicy(tx, { storage: true });
    if (options.deleteBytes) await options.deleteBytes(d);
    else await getPrivateFile(d.objectPath).delete({ ignoreNotFound: true });
    await tx.update(docs).set({ state: "deleted", name: "Deleted document", sha256: null, scanSha256: null, updatedAt: new Date() }).where(eq(docs.id, d.id));
  });
  let policy;
  try { policy = await liveVaultPolicy(db, { storage: true }); } catch { policy = null; }
  if (policy) {
  const retention = await db.select().from(docs).where(and(scope,
    inArray(docs.state, ["clean", "infected", "unavailable", "timeout", "indeterminate", "pending"]),
    lte(docs.createdAt, new Date(Date.now() - policy.retentionDays * 86400000)),
    or(isNull(docs.holdUntil), lte(docs.holdUntil, new Date())),
  )).limit(20);
  for (const d of retention) await vaultWrite({ profileId: d.profileId, withdrawal: true }, async tx => {
    const [current] = await tx.select().from(docs).where(eq(docs.id, d.id));
    const policy = await liveVaultPolicy(tx, { storage: true });
    if (!current || current.createdAt.getTime() > Date.now() - policy.retentionDays * 86400000 || (current.holdUntil && current.holdUntil > new Date())) return;
    await tx.update(docs).set({ state: "delete-pending", scanSha256: null, updatedAt: new Date() }).where(eq(docs.id, d.id));
    await invalidateDocumentChecks(tx, d.profileId, d.id);
  });
  }
  // Minimal receipts are not active authorization. No case data is embedded.
  const ownedRequests = options.profileId ? await db.select({ id: requests.id }).from(requests).where(eq(requests.profileId, options.profileId)) : null;
  const activeReceipts = await db.select().from(receipts).where(and(isNull(receipts.invalidatedAt),
    ownedRequests ? inArray(receipts.requestId, ownedRequests.map(r => r.id)) : undefined,
  )).orderBy(receipts.lastEvaluatedAt).limit(20);
  for (const receipt of activeReceipts) await vaultWrite({ requestId: receipt.requestId, withdrawal: true }, async tx => {
    await tx.update(receipts).set({ lastEvaluatedAt: new Date() }).where(eq(receipts.id, receipt.id));
    const [c] = await tx.select().from(onbCases).where(and(eq(onbCases.organizationId, receipt.organizationId), eq(onbCases.id, receipt.caseId)));
    if (!c || c.lifecycleStage === "complete") return;
    const evaluation = await evaluateVaultReuse(tx, c, receipt.requestId);
    if (!evaluation.matchedRequest || !evaluation.requirements ||
      receipt.requestVersion !== evaluation.matchedRequest.version || receipt.requirementsDigest !== evaluation.requirements.digest ||
      !receipt.satisfied.every(k => evaluation.reused.includes(k)) || receipt.retainUntil <= new Date()) {
      await invalidateVaultReuse(tx, { requestId: receipt.requestId });
    }
  });
  if (!policy) return; // Authorization withdrawal above must not depend on new processing approval.
  const overdue = await db.select().from(receipts).where(and(
    lte(receipts.retainUntil, new Date()),
    sql`(jsonb_array_length(${receipts.checkIds}) > 0 or jsonb_array_length(${receipts.satisfied}) > 0)`,
    ownedRequests ? inArray(receipts.requestId, ownedRequests.map(r => r.id)) : undefined,
  )).orderBy(receipts.lastEvaluatedAt).limit(20);
  for (const r of overdue) await vaultWrite({ organizationId: r.organizationId, withdrawal: true }, async tx => {
    await tx.update(receipts).set({ lastEvaluatedAt: new Date() }).where(eq(receipts.id, r.id));
    const activeHolds = await tx.select({ id: holds.id }).from(holds).where(and(
      eq(holds.organizationId, r.organizationId), eq(holds.active, true),
      or(isNull(holds.caseId), eq(holds.caseId, r.caseId)), or(isNull(holds.dataClass),
        inArray(holds.dataClass, ["bgv", "identity", "medical", "payroll", "candidate-document"])),
    ));
    if (activeHolds.length) return;
    await tx.update(receipts).set({ invalidatedAt: new Date(), checkIds: [], satisfied: [] }).where(and(eq(receipts.id, r.id), lte(receipts.retainUntil, new Date())));
  });
}
