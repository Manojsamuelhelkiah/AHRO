import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, hroEmailRequests, hroEmailSources, hroMailboxIngress, onbSensitiveLifecycleHolds } from "@workspace/db";
import { getPrivateFile } from "./objectStorage";
import { configuredMalwareScanner } from "./onboarding/malware-scanner";
import { confidentialRead, currentReceipt } from "./offboarding/authority";
import { evaluateCaseDerivedLifecycleGateInTransaction, withSensitiveLifecycleFence } from "./onboarding/sensitive-lifecycle";
import { SeparationError } from "./offboarding/model";
import { boundedEmailContent, type EmailProvider } from "./hro-email-ingestion";
import { header, type GmailMessage } from "./onboarding/inbound-email";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export type PrivateSourceStorage = {
  save: (path: string, bytes: Buffer) => Promise<void>;
  read: (path: string) => Promise<Buffer>;
  delete: (path: string) => Promise<void>;
};
const storage: PrivateSourceStorage = {
  save: async (path, bytes) => { await getPrivateFile(path).save(bytes, { resumable: false, metadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" } }); },
  read: async path => (await getPrivateFile(path).download())[0],
  delete: async path => { await getPrivateFile(path).delete({ ignoreNotFound: true }); },
};
/** Durable reservations precede file writes. Source paths are never exposed by any generic object route. */
export async function retainEmailSources(
  requestId: string, msg: GmailMessage, provider: EmailProvider,
  dependencies: { storage?: PrivateSourceStorage; scan?: (bytes: Buffer) => Promise<string> } = {},
) {
  const [request] = await db.select().from(hroEmailRequests).where(eq(hroEmailRequests.id, requestId));
  if (!request?.organizationId || !request.ingressId || !request.fields.work_country) return;
  const org = request.organizationId, files = dependencies.storage ?? storage;
  const content = boundedEmailContent(msg);
  if (content.blocked) return;
  const items: Array<{ kind: string; data?: string; attachmentId?: string; size?: number }> = [
    { kind: "body", data: Buffer.from(JSON.stringify({ subject: header(msg, "Subject").slice(0, 1000), body: content.body })).toString("base64url") },
  ];
  const existingSources = await db.select().from(hroEmailSources).where(eq(hroEmailSources.requestId, request.id));
  let total = existingSources.filter(s => !["reserved", "unavailable", "timeout", "indeterminate"].includes(s.state)).reduce((n, s) => n + (s.byteSize ?? 0), 0), nodes = 0;
  const walk = (part: GmailMessage["payload"], depth = 0) => {
    if (!part || ++nodes > 100 || depth > 12 || items.length > 10) return;
    const body = part.body as { data?: string; attachmentId?: string; size?: number } | undefined;
    if (part.filename || part.mimeType === "message/rfc822") {
      items.push({ kind: `attachment-${items.length}`, data: body?.data, attachmentId: body?.attachmentId, size: body?.size });
      return;
    }
    for (const child of part.parts ?? []) walk(child, depth + 1);
  };
  walk(msg.payload);
  const deadline = Date.now() + 20_000;
  for (const item of items) {
    if (Date.now() > deadline) break;
    const source = await withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
      const [live] = await tx.select().from(hroEmailRequests).where(and(eq(hroEmailRequests.id, request.id), eq(hroEmailRequests.organizationId, org))).for("update");
      if (!live || live.status === "rejected") return null;
      const [route] = await tx.select().from(hroMailboxIngress).where(eq(hroMailboxIngress.id, request.ingressId!));
      if (!route?.enabled || route.revision !== live.routeRevision || !await currentReceipt(tx, org, route.approval, "")) return null;
      const gate = await evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId: org, jurisdiction: live.fields.work_country });
      if (!gate.allowed) return null;
      const id = createHash("sha256").update(`${request.id}:${item.kind}`).digest("hex");
      const path = `/objects/hro-email-intake/${request.id}/${id}`;
      await tx.insert(hroEmailSources).values({ id, organizationId: org, requestId: request.id, kind: item.kind, objectPath: path }).onConflictDoNothing();
      const [row] = await tx.select().from(hroEmailSources).where(eq(hroEmailSources.id, id));
      return row;
    }));
    if (!source || !["reserved", "unavailable", "timeout", "indeterminate"].includes(source.state)) continue;
    // The whole write/scan shares policy and hold serialization. A restart can
    // re-fetch provider bytes and overwrite only this reserved deterministic path.
    await withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
      const [live] = await tx.select().from(hroEmailRequests).where(and(eq(hroEmailRequests.id, request.id), eq(hroEmailRequests.organizationId, org))).for("update");
      const [owned] = await tx.select().from(hroEmailSources).where(eq(hroEmailSources.id, source.id)).for("update");
      if (!live || !owned || !["reserved", "unavailable", "timeout", "indeterminate"].includes(owned.state) || live.status === "rejected") return;
      const [route] = await tx.select().from(hroMailboxIngress).where(eq(hroMailboxIngress.id, request.ingressId!));
      const gate = await evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId: org, jurisdiction: live.fields.work_country });
      if (!gate.allowed || !route?.enabled || route.revision !== live.routeRevision || !await currentReceipt(tx, org, route.approval, "")) return;
      let encoded = item.data;
      if (!encoded && item.attachmentId && item.size && item.size <= MAX_ATTACHMENT_BYTES) {
        const response = await provider.get(`/gmail/v1/users/me/messages/${encodeURIComponent(msg.id)}/attachments/${encodeURIComponent(item.attachmentId)}`);
        if (!response.ok) throw new Error("Private attachment fetch unavailable.");
        const data = (await response.json()) as { data?: string; size?: number };
        if (data.size && data.size > MAX_ATTACHMENT_BYTES) encoded = undefined;
        else encoded = data.data;
      }
      if (!encoded || encoded.length > MAX_ATTACHMENT_BYTES * 1.4) {
        await tx.update(hroEmailSources).set({ state: "quarantined-limit" }).where(eq(hroEmailSources.id, source.id)); return;
      }
      const bytes = Buffer.from(encoded, "base64url");
      total += bytes.length;
      try {
        if (bytes.length > MAX_ATTACHMENT_BYTES || total > MAX_ATTACHMENT_BYTES) {
          await tx.update(hroEmailSources).set({ state: "quarantined-limit" }).where(eq(hroEmailSources.id, source.id)); return;
        }
        await files.save(source.objectPath, bytes);
        const scanner = configuredMalwareScanner();
        let verdict = "unavailable";
        try { verdict = dependencies.scan ? await dependencies.scan(bytes) : scanner ? await scanner.scan(bytes, AbortSignal.timeout(30_000)) : "unavailable"; }
        catch { verdict = "indeterminate"; }
        await tx.update(hroEmailSources).set({ state: verdict, checksum: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length }).where(eq(hroEmailSources.id, source.id));
      } finally { bytes.fill(0); }
    }));
  }
}
export async function recoverEmailPrivateSources(mailbox: string, provider: EmailProvider,
  dependencies: Parameters<typeof retainEmailSources>[3] = {}) {
  const requests = await db.select().from(hroEmailRequests).where(and(
    eq(hroEmailRequests.mailboxAddress, mailbox),
    sql`${hroEmailRequests.organizationId} is not null`,
    sql`${hroEmailRequests.status} <> 'rejected'`,
    sql`${hroEmailRequests.fields} ? 'work_country'`,
    sql`(exists (select 1 from ${hroEmailSources} where ${hroEmailSources.requestId} = ${hroEmailRequests.id}
      and ${hroEmailSources.state} in ('reserved','unavailable','timeout','indeterminate'))
      or (select count(*) from ${hroEmailSources} where ${hroEmailSources.requestId} = ${hroEmailRequests.id}) < jsonb_array_length(${hroEmailRequests.attachments}) + 1)`,
  )).orderBy(asc(hroEmailRequests.updatedAt)).limit(2);
  for (const request of requests) {
    const result = await provider.get(`/gmail/v1/users/me/messages/${encodeURIComponent(request.providerMessageId)}?format=full`);
    // Rotate bounded retry work without extending the original retention clock.
    await db.update(hroEmailRequests).set({ updatedAt: new Date() }).where(eq(hroEmailRequests.id, request.id));
    if (!result.ok) continue; // Metadata remains visible; this private source stays quarantined.
    const msg = await result.json() as GmailMessage;
    if (msg.id !== request.providerMessageId) throw new Error("Private source provider identity mismatch.");
    await retainEmailSources(request.id, msg, provider, dependencies);
  }
}
/** Clean bytes only, and never an evidence approval. No attachment download route exists. */
export async function readEmailPrivateBody(org: string, actor: string, requestId: string) {
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await confidentialRead(tx, org, actor);
    const [request] = await tx.select().from(hroEmailRequests).where(and(eq(hroEmailRequests.organizationId, org), eq(hroEmailRequests.id, requestId))).for("update");
    if (!request) throw new SeparationError("Request not found.", 404);
    await confidentialRead(tx, org, actor, request.fields.work_country, request.caseId ?? undefined);
    const gate = await evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId: org, jurisdiction: request.fields.work_country });
    if (!gate.allowed) throw new SeparationError("Private source collection and access policy review is required.", 409);
    const [source] = await tx.select().from(hroEmailSources).where(and(eq(hroEmailSources.organizationId, org), eq(hroEmailSources.requestId, requestId), eq(hroEmailSources.kind, "body")));
    if (!source || source.state !== "clean") return { state: source?.state ?? "provider-only", body: null, subject: null };
    const bytes = await storage.read(source.objectPath);
    try {
      if (bytes.length > 36_000 || createHash("sha256").update(bytes).digest("hex") !== source.checksum) throw new SeparationError("Private source integrity could not be verified.", 409);
      const value = JSON.parse(bytes.toString("utf8")) as { subject: string; body: string };
      return { state: "clean", subject: value.subject, body: value.body };
    } finally { bytes.fill(0); }
  }));
}
/** Before-case subjects have no independently proven scope: any active tenant hold blocks deletion. */
export async function runEmailIntakeRetention() {
  const rows = await db.select().from(hroEmailRequests).where(sql`${hroEmailRequests.organizationId} is not null and ${hroEmailRequests.fields} <> '{}'::jsonb`)
    .orderBy(asc(hroEmailRequests.updatedAt)).limit(25);
  for (const candidate of rows) await withSensitiveLifecycleFence(candidate.organizationId!, () => db.transaction(async tx => {
    const [row] = await tx.select().from(hroEmailRequests).where(eq(hroEmailRequests.id, candidate.id)).for("update");
    if (!row?.organizationId || !row.fields.work_country) return;
    // Held/young records must not permanently starve later due records.
    await tx.update(hroEmailRequests).set({ updatedAt: new Date() }).where(eq(hroEmailRequests.id, row.id));
    const gate = await evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId: row.organizationId, jurisdiction: row.fields.work_country });
    if (!gate.allowed) return;
    const retention = Math.min(...Object.values(gate.policies).map(p => p.retentionDays));
    if (!Number.isFinite(retention) || Date.now() - row.createdAt.getTime() < retention * 86_400_000) return;
    const [hold] = await tx.select({ id: onbSensitiveLifecycleHolds.id }).from(onbSensitiveLifecycleHolds).where(and(eq(onbSensitiveLifecycleHolds.organizationId, row.organizationId), eq(onbSensitiveLifecycleHolds.active, true))).limit(1);
    if (hold) return;
    const sources = await tx.select().from(hroEmailSources).where(and(eq(hroEmailSources.organizationId, row.organizationId), eq(hroEmailSources.requestId, row.id))).for("update");
    for (const source of sources) {
      await storage.delete(source.objectPath);
      await tx.update(hroEmailSources).set({ state: "minimized", checksum: null, byteSize: null }).where(eq(hroEmailSources.id, source.id));
    }
    await tx.update(hroEmailRequests).set({ fields: {}, fieldSources: {}, attachments: [],
      status: row.status === "converted" ? "converted" : "rejected", reason: "Private intake content minimized under approved retention; provider identity retained as a deduplication tombstone.",
    }).where(eq(hroEmailRequests.id, row.id));
  }));
}
