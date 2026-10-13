import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, hroMailboxIngress, hroMailboxRequests } from "@workspace/db";
import { withSensitiveLifecycleFence, evaluateCaseDerivedLifecycleGateInTransaction } from "./onboarding/sensitive-lifecycle";
import { access, confidentialRead, receipt, currentReceipt, authority } from "./offboarding/authority";
import { FACT_FIELDS, facts, object, text, SeparationError } from "./offboarding/model";
import { createSeparationInTransaction, audit, load } from "./offboarding/service";
import { emailChannelInfo } from "./onboarding/channels";
import { getInboundEmailMonitorStatus, type GmailMessage } from "./onboarding/inbound-email";
export function mailboxTokens(subject: string): string[] {
  return [...new Set([...subject.matchAll(/\[HRO-INTAKE:([a-f0-9]{48})\]/g)].map(m => m[1]))];
}
export function extractMailboxFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z]+)\s*:\s*(.{1,2000})$/);
    if (match && FACT_FIELDS.includes(match[1] as typeof FACT_FIELDS[number])) {
      if (fields[match[1]]) throw new SeparationError("Repeated mailbox fields require manual review.");
      fields[match[1]] = match[2].trim();
    }
  }
  return fields;
}
/** Returns true for owned or malformed ingress tokens: never falls through to reply/status consumers. */
export async function ingestHroMailboxMessage(msg: GmailMessage, sender: string, subject: string, body: string): Promise<boolean> {
  if (!subject.includes("[HRO-INTAKE:")) return false;
  if (/\b(?:CR-[a-f0-9]{32}|AP-\d+|SIM-REPLY-TOKEN|SIM-THREAD|SYS-)\b/i.test(`${subject}\n${body}`)) return true;
  const tokens = mailboxTokens(subject);
  if (tokens.length !== 1) return true;
  const [ingress] = await db.select().from(hroMailboxIngress).where(and(eq(hroMailboxIngress.token, tokens[0]), eq(hroMailboxIngress.enabled, 1)));
  if (ingress?.activatedAt && ingress.mailboxAddress) {
    const { receiveIntakeMessage, connectedIntakeMailbox } = await import("./hro-email-ingestion");
    const connected = await connectedIntakeMailbox();
    if (!connected || connected !== ingress.mailboxAddress) return true;
    const { onbSystemChecks } = await import("@workspace/db");
    const refs = await db.select({ ref: onbSystemChecks.externalRef }).from(onbSystemChecks);
    await receiveIntakeMessage(connected, msg, refs.flatMap(r => r.ref ? [r.ref] : []));
    return true;
  }
  if (!ingress || !ingress.allowedSenders.includes(sender.toLowerCase())) return true;
  await withSensitiveLifecycleFence(ingress.organizationId, () => db.transaction(async tx => {
    const [live] = await tx.select().from(hroMailboxIngress).where(eq(hroMailboxIngress.id, ingress.id)).for("update");
    if (!live || !live.enabled || !live.allowedSenders.includes(sender.toLowerCase()) || !await currentReceipt(tx, live.organizationId, live.approval, "")) return;
    let fields: Record<string, string>;
    try { fields = extractMailboxFields(body); } catch { fields = {}; }
    const gate = await evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId: live.organizationId, jurisdiction: fields.country || "unknown" });
    // Missing/unapproved jurisdiction must remain discoverable for review, but
    // does not authorize storing opaque employee content. Keep only the
    // reviewed-ingress correlation; staff consult the private provider mailbox
    // and supply complete facts after country collection approval.
    if (!gate.allowed) fields = {};
    const attachments: Array<{ name: string; status: "quarantined-not-imported" }> = [];
    const walk = (part: GmailMessage["payload"]) => {
      const raw = part as { filename?: string; parts?: GmailMessage["payload"][] } | undefined;
      if (raw?.filename) attachments.push({ name: gate.allowed ? raw.filename.slice(0, 160) : "Provider attachment — jurisdiction review pending", status: "quarantined-not-imported" });
      raw?.parts?.forEach(walk);
    };
    walk(msg.payload);
    await tx.insert(hroMailboxRequests).values({ id: randomUUID(), organizationId: live.organizationId, ingressId: live.id, providerMessageId: msg.id, sender, fields, attachments, status: gate.allowed ? "review" : "collection-review-required" }).onConflictDoNothing();
  })).catch(() => { throw new SeparationError("Shared HRO mailbox ingestion was not applied; private provider content remains unreconciled.", 503); });
  return true;
}
export async function mailboxReadiness(org: string, actor: string) {
  return db.transaction(async tx => {
    await access(tx, org, actor, false); await authority(tx, org, actor, "hr-compliance-approve"); await authority(tx, org, actor, "legal-approve");
    const configurations = await tx.select().from(hroMailboxIngress).where(eq(hroMailboxIngress.organizationId, org));
    return { configurations, channel: await emailChannelInfo(), monitor: await getInboundEmailMonitorStatus(org), attachmentPolicy: "Attachments stay quarantined in the provider mailbox, are never opened or imported automatically. Use approved private evidence storage after scanning.", provenance: "Mailbox content is unverified HRIS evidence; conversion creates a held separation only." };
  });
}
export async function configureMailbox(org: string, actor: string, raw: unknown) {
  const b = object(raw);
  if (!Array.isArray(b.allowedSenders) || !b.allowedSenders.length || b.allowedSenders.length > 100) throw new SeparationError("Provide 1–100 reviewed allowed sender addresses.", 400);
  const senders = b.allowedSenders.map(v => text(v, "sender", 254).toLowerCase());
  if (senders.some(s => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))) throw new SeparationError("Allowed senders must be email addresses.", 400);
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await access(tx, org, actor, true); await authority(tx, org, actor, "hr-compliance-approve");
    const approval = await receipt(tx, { organizationId: org, actor, scope: "legal-approve", reference: text(b.reference, "reviewed mailbox ingress reference"), generation: 1 });
    const [row] = await tx.insert(hroMailboxIngress).values({ id: randomUUID(), organizationId: org, token: randomBytes(24).toString("hex"), allowedSenders: [...new Set(senders)], approval, createdBy: actor }).returning();
    await audit(tx, org, actor, "mailbox-ingress-reviewed", row.id, 1);
    return row;
  }));
}
export async function reviewMailbox(org: string, actor: string) {
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await confidentialRead(tx, org, actor);
    await access(tx, org, actor, false); await authority(tx, org, actor, "hr-compliance-approve"); await authority(tx, org, actor, "legal-approve");
    const rows = await tx.select().from(hroMailboxRequests).where(eq(hroMailboxRequests.organizationId, org)).orderBy(desc(hroMailboxRequests.createdAt)).limit(100);
    const visible = [];
    for (const r of rows) {
      if (r.caseId) {
        try {
          const linked = await load(tx, org, actor, r.caseId);
          await confidentialRead(tx, org, actor, linked.facts.country, linked.id);
        } catch (error) {
          if (error instanceof SeparationError && [403, 404].includes(error.status)) continue;
          throw error;
        }
      }
      visible.push({ ...r, missingFields: FACT_FIELDS.filter(k => !r.fields[k]) });
    }
    return visible;
  }));
}
export async function convertMailbox(org: string, actor: string, id: string, raw: unknown) {
  const b = object(raw);
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await confidentialRead(tx, org, actor);
    await access(tx, org, actor, true); await authority(tx, org, actor, "hr-compliance-approve"); await authority(tx, org, actor, "legal-approve");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mailbox-convert:${org}:${id}`}, 0))`);
    const [request] = await tx.select().from(hroMailboxRequests).where(and(eq(hroMailboxRequests.organizationId, org), eq(hroMailboxRequests.id, id))).for("update");
    if (!request) throw new SeparationError("Mailbox request not found.", 404);
    if (request.attachments.length && b.attachmentsReviewed !== true) throw new SeparationError("Acknowledge that attachments remain quarantined in the provider and are not imported.");
    if (request.caseId) {
      const linked = await load(tx, org, actor, request.caseId, true);
      await confidentialRead(tx, org, actor, linked.facts.country, linked.id);
      const retry = await createSeparationInTransaction(tx, org, actor, facts(b.facts), "mailbox", request.providerMessageId);
      return { ...retry, status: "deduplicated" };
    }
    const [ingress] = await tx.select().from(hroMailboxIngress).where(eq(hroMailboxIngress.id, request.ingressId));
    if (!ingress?.enabled || !await currentReceipt(tx, org, ingress.approval, "")) throw new SeparationError("Mailbox admission review is no longer current.");
    const verified = facts(b.facts);
    const result = await createSeparationInTransaction(tx, org, actor, verified, "mailbox", request.providerMessageId);
    await tx.update(hroMailboxRequests).set({ status: "converted-held", caseId: result.caseId }).where(eq(hroMailboxRequests.id, id));
    return result;
  }));
}
