import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { externalProviderDispatchDenied } from "./onboarding/provider-policy";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { and, eq, sql } from "drizzle-orm";
import { db, hroEmailRequests, hroEmailScan, hroMailboxIngress, hroMailboxRequests, onbCommunications, onbWatchEmails, onbSystemChecks } from "@workspace/db";
import { header, type GmailMessage } from "./onboarding/inbound-email";
import { mailboxTokens } from "./hro-mailbox-ingress";
import { classifyEmail } from "./hro-email-registry";
import { currentReceipt } from "./offboarding/authority";
import { withSensitiveLifecycleFence, evaluateCaseDerivedLifecycleGateInTransaction } from "./onboarding/sensitive-lifecycle";

const connectors = new ReplitConnectors();
export type EmailProvider = { get: (path: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }> };
const provider: EmailProvider = { get: path => {
  if (externalProviderDispatchDenied()) throw new Error("Real Gmail reads are forbidden in controlled provider context.");
  return connectors.proxy("google-mail", path, { method: "GET" });
}};
const controlledProvider = new AsyncLocalStorage<EmailProvider>();
/** Read-only test dependency; inaccessible from browser headers and forbidden outside the isolated harness. */
export function withControlledEmailIntakeProvider<T>(p: EmailProvider, action: () => T): T {
  if (process.env.NODE_ENV !== "test" || process.env.ONBOARDING_E2E_TEST !== "true") throw new Error("Controlled mailbox provider is test-only.");
  return controlledProvider.run(p, action);
}
export async function connectedIntakeMailbox(p?: EmailProvider): Promise<string | null> {
  try {
    const r = await (p ?? controlledProvider.getStore() ?? provider).get("/gmail/v1/users/me/profile");
    if (!r.ok) return null;
    const value = (await r.json()) as { emailAddress?: unknown };
    return typeof value.emailAddress === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.emailAddress) ? value.emailAddress.toLowerCase() : null;
  } catch { return null; }
}
export const MAX_EMAIL_BYTES = 32_768;
/** Never recurse into attached message/rfc822 or fetch remote URLs. Reject MIME bombs before decoding. */
export function boundedEmailContent(msg: GmailMessage): { body: string; attachments: Array<{ name: string; status: string }>; blocked: boolean } {
  let nodes = 0, bytes = 0, blocked = false;
  const plain: string[] = [], html: string[] = [], attachments: Array<{ name: string; status: string }> = [];
  function walk(part: GmailMessage["payload"], depth: number) {
    if (!part || blocked) return;
    if (++nodes > 100 || depth > 12) { blocked = true; return; }
    if (part.filename || part.mimeType === "message/rfc822") {
      if (attachments.length >= 10) { blocked = true; return; }
      attachments.push({ name: "Private provider attachment", status: "quarantined-not-imported" });
      return;
    }
    if (part.body?.data && (part.mimeType === "text/plain" || part.mimeType === "text/html" || !part.mimeType)) {
      if (part.body.data.length > MAX_EMAIL_BYTES * 1.4) { blocked = true; return; }
      const b = Buffer.from(part.body.data, "base64url");
      bytes += b.length;
      if (bytes > MAX_EMAIL_BYTES) { b.fill(0); blocked = true; return; }
      const text = b.toString("utf8"); b.fill(0);
      if (part.mimeType === "text/html") html.push(text); else plain.push(text);
    }
    for (const child of part.parts ?? []) walk(child, depth + 1);
  }
  walk(msg.payload, 0);
  const body = plain.length ? plain.join("\n") : html.join("\n")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(?:p|div|li)>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return { body: blocked ? "" : body.replace(/\u0000/g, "").slice(0, MAX_EMAIL_BYTES), attachments, blocked };
}
export function intakeMessageReserved(msg: GmailMessage, body: string, refs: string[] = []): boolean {
  const subject = header(msg, "Subject"), input = `${subject}\n${body}`;
  if ((msg as GmailMessage & { labelIds?: string[] }).labelIds?.some(l => ["SENT", "DRAFT"].includes(l))) return true;
  if (/\b(?:CR-[a-f0-9]{32}|AP-\d+(?:-V\d+)?|SIM-REPLY-TOKEN|SIM-THREAD|SYS-)\b/i.test(input)) return true;
  if (/\[(?:CR|AP|SIM-REPLY|SYS-REPLY):/i.test(input)) return true;
  if (header(msg, "Auto-Submitted") && header(msg, "Auto-Submitted").toLowerCase() !== "no") return true;
  if (/^(?:bulk|list|junk)$/i.test(header(msg, "Precedence"))) return true;
  if (/\b(?:no-?reply|mailer-daemon|postmaster)@/i.test(header(msg, "From"))) return true;
  return refs.some(ref => {
    if (!ref) return false;
    return new RegExp(`(^|[^A-Z0-9])${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Z0-9])`, "i").test(input);
  });
}
export function resolveEmailRoute(
  subject: string, mailbox: string, sentAt: Date,
  routes: Array<typeof hroMailboxIngress.$inferSelect>,
) {
  const tokens = mailboxTokens(subject);
  if (tokens.length !== 1) return null;
  const matches = routes.filter(r => r.token === tokens[0] && r.enabled === 1 && r.mailboxAddress === mailbox &&
    r.activatedAt !== null && r.backfillFrom !== null && sentAt >= r.backfillFrom && sentAt.getTime() <= Date.now() + 1000);
  return matches.length === 1 ? matches[0] : null;
}
export async function emailHasOtherOwnership(id: string) {
  const results = await Promise.all([
    db.select({ id: onbCommunications.id }).from(onbCommunications).where(eq(onbCommunications.externalMessageId, id)).limit(1),
    db.select({ id: onbWatchEmails.id }).from(onbWatchEmails).where(eq(onbWatchEmails.gmailMessageId, id)).limit(1),
    db.select({ id: hroMailboxRequests.id }).from(hroMailboxRequests).where(eq(hroMailboxRequests.providerMessageId, id)).limit(1),
  ]);
  return results.some(rows => rows.length);
}
async function alreadyOwned(id: string) {
  if (await emailHasOtherOwnership(id)) return true;
  return Boolean((await db.select({ id: hroEmailRequests.id }).from(hroEmailRequests).where(eq(hroEmailRequests.providerMessageId, id)).limit(1)).length);
}
export async function receiveIntakeMessage(mailbox: string, msg: GmailMessage, refs: string[] = [], privateProvider: EmailProvider = provider,
  sourceDependencies: Parameters<typeof import("./hro-email-private-source").retainEmailSources>[3] = {}) {
  const content = boundedEmailContent(msg);
  if (intakeMessageReserved(msg, content.body, refs)) {
    const automatic = (msg.labelIds ?? []).some(l => l === "SENT" || l === "DRAFT") ||
      /auto-generated|auto-replied/i.test(header(msg, "Auto-Submitted")) || /bulk|list|junk/i.test(header(msg, "Precedence")) ||
      /no-?reply|mailer-daemon|postmaster/i.test(header(msg, "From"));
    if (!automatic && !await emailHasOtherOwnership(msg.id)) await db.insert(hroEmailRequests).values({
      id: randomUUID(), organizationId: null, ingressId: null, mailboxAddress: mailbox, providerMessageId: msg.id,
      fields: {}, status: "blocked", reason: "Operational-reference ownership is uncertain. Resolve through the existing reply/status/approval channel; this is not a new-case request.",
    }).onConflictDoNothing();
    return;
  }
  if (await alreadyOwned(msg.id)) {
    const [existing] = await db.select().from(hroEmailRequests).where(and(eq(hroEmailRequests.mailboxAddress, mailbox), eq(hroEmailRequests.providerMessageId, msg.id)));
    if (existing?.organizationId) await (await import("./hro-email-private-source")).retainEmailSources(existing.id, msg, privateProvider, sourceDependencies);
    return;
  }
  const subject = header(msg, "Subject").slice(0, 1000);
  const timestamp = Number((msg as GmailMessage & { internalDate?: string }).internalDate);
  const sentAt = new Date(timestamp);
  const routes = await db.select().from(hroMailboxIngress);
  const route = Number.isFinite(timestamp) ? resolveEmailRoute(subject, mailbox, sentAt, routes) : null;
  if (!route) {
    // No sender, subject, body, filename or guessed tenant in platform triage.
    await db.insert(hroEmailRequests).values({
      id: randomUUID(), mailboxAddress: mailbox, providerMessageId: msg.id,
      status: "blocked", reason: "Explicit reviewed route unresolved or conflicting. Platform triage required.",
    }).onConflictDoNothing();
    return;
  }
  await withSensitiveLifecycleFence(route.organizationId, () => db.transaction(async tx => {
    const [live] = await tx.select().from(hroMailboxIngress).where(eq(hroMailboxIngress.id, route.id)).for("update");
    if (!live || !resolveEmailRoute(subject, mailbox, sentAt, [live]) || live.revision !== route.revision ||
      !await currentReceipt(tx, live.organizationId, live.approval, "")) {
      await tx.insert(hroEmailRequests).values({
        id: randomUUID(), mailboxAddress: mailbox, providerMessageId: msg.id,
        status: "blocked", reason: "Route approval is unavailable or changed during processing. Platform triage required.",
      }).onConflictDoNothing();
      return;
    }
    const classified = classifyEmail(subject, content.body);
    const gate = await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
      organizationId: live.organizationId, jurisdiction: classified.fields.work_country || "unknown",
    });
    const fields = gate.allowed && !content.blocked ? classified.fields : {};
    await tx.insert(hroEmailRequests).values({
      id: randomUUID(), organizationId: live.organizationId, ingressId: live.id, routeRevision: live.revision,
      mailboxAddress: mailbox, providerMessageId: msg.id, templateId: classified.templateId,
      fields, fieldSources: Object.fromEntries(Object.keys(fields).map(k => [k, "email" as const])),
      attachments: content.attachments,
      status: !gate.allowed || content.blocked || classified.blockedReason ? "blocked" : "needs-review",
      reason: content.blocked ? "MIME content exceeds safe processing limits." : !gate.allowed
        ? "Country collection review required; no employee content has been retained." : classified.blockedReason ?? classified.uncertainty,
    }).onConflictDoNothing();
  }));
  const [request] = await db.select().from(hroEmailRequests).where(and(eq(hroEmailRequests.mailboxAddress, mailbox), eq(hroEmailRequests.providerMessageId, msg.id)));
  if (request?.organizationId) await (await import("./hro-email-private-source")).retainEmailSources(request.id, msg, privateProvider, sourceDependencies);
}
/** Called only by the existing inbound tick (interval and production heartbeat). No outbound API here. */
export async function runHroEmailIntakeScan(p: EmailProvider = provider,
  sourceDependencies: Parameters<typeof import("./hro-email-private-source").retainEmailSources>[3] = {}) {
  const enabled = await db.select().from(hroMailboxIngress).where(eq(hroMailboxIngress.enabled, 1));
  if (!enabled.some(r => r.activatedAt && r.backfillFrom && r.mailboxAddress)) return;
  const mailbox = await connectedIntakeMailbox(p);
  if (!mailbox) throw new Error("Connected Gmail profile unavailable; email intake is not ready.");
  await db.transaction(async tx => {
    const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended('hro-email-intake-global', 0)) as acquired`);
    if (!(lock.rows[0] as { acquired?: boolean })?.acquired) return;
    const active = enabled.filter(r => r.mailboxAddress === mailbox && r.backfillFrom);
    // A mismatched route is a client-specific readiness failure, not an outage
    // of every candidate/approval/status consumer on the connected mailbox.
    if (!active.length) return;
    const from = Math.min(...active.map(r => r.backfillFrom!.getTime()));
    const routesRevision = createHash("sha256").update(active.map(r => `${r.id}:${r.revision}:${r.backfillFrom!.toISOString()}`).sort().join("|")).digest("hex");
    const now = new Date();
    let [scan] = await tx.select().from(hroEmailScan).where(eq(hroEmailScan.mailboxAddress, mailbox)).for("update");
    if (!scan?.pageToken || scan.routesRevision !== routesRevision) {
      // Fixed provider time interval during pagination. Always replay within
      // activation window; durable ownership makes the overlap safe.
      const after = scan?.watermarkAt
        ? Math.min(...active.map(r => r.activatedAt && r.activatedAt < scan.watermarkAt!
          ? Math.max(r.backfillFrom!.getTime(), scan.watermarkAt!.getTime() - 1000) : r.backfillFrom!.getTime()))
        : from;
      const query = `in:inbox after:${Math.floor(after / 1000)} before:${Math.ceil(now.getTime() / 1000)}`;
      const values = { query, cycleUntil: now, pageToken: null, routesRevision };
      if (!scan) [scan] = await tx.insert(hroEmailScan).values({ mailboxAddress: mailbox, ...values }).returning();
      else [scan] = await tx.update(hroEmailScan).set(values).where(eq(hroEmailScan.mailboxAddress, mailbox)).returning();
    }
    const checks = await tx.select({ ref: onbSystemChecks.externalRef }).from(onbSystemChecks);
    await (await import("./hro-email-private-source")).recoverEmailPrivateSources(mailbox, p, sourceDependencies);
    // One bounded page per heartbeat. Continuation is persisted, never silently dropped.
    const response = await p.get(`/gmail/v1/users/me/messages?q=${encodeURIComponent(scan.query)}&maxResults=25${scan.pageToken ? `&pageToken=${encodeURIComponent(scan.pageToken)}` : ""}`);
    if (!response.ok) throw new Error("Email intake search unavailable; the saved page will be retried.");
    const page = (await response.json()) as { messages?: Array<{ id: string }>; nextPageToken?: string };
    if ((page.messages !== undefined && (!Array.isArray(page.messages) || page.messages.length > 25 ||
      page.messages.some(m => !m || typeof m.id !== "string" || !m.id || m.id.length > 240))) ||
      (page.nextPageToken !== undefined && (typeof page.nextPageToken !== "string" || page.nextPageToken.length > 2048 || page.nextPageToken === scan.pageToken))) {
      throw new Error("Gmail returned an invalid or non-advancing page; the saved page is retained for safe recovery.");
    }
    for (const ref of page.messages ?? []) {
      const [existing] = await tx.select({ id: hroEmailRequests.id }).from(hroEmailRequests).where(and(eq(hroEmailRequests.mailboxAddress, mailbox), eq(hroEmailRequests.providerMessageId, ref.id)));
      if (!existing && await alreadyOwned(ref.id)) continue;
      const detail = await p.get(`/gmail/v1/users/me/messages/${encodeURIComponent(ref.id)}?format=full`);
      if (!detail.ok) throw new Error("Email intake detail unavailable; the saved page will be retried.");
      const msg = (await detail.json()) as GmailMessage;
      if (msg.id !== ref.id) throw new Error("Email intake provider identity mismatch.");
      await receiveIntakeMessage(mailbox, msg, checks.map(c => c.ref ?? ""), p, sourceDependencies);
    }
    await tx.update(hroEmailScan).set({
      pageToken: page.nextPageToken ?? null, lastSuccessAt: now, lastError: null,
      processed: sql`${hroEmailScan.processed} + ${(page.messages ?? []).length}`,
      watermarkAt: page.nextPageToken ? scan.watermarkAt : scan.cycleUntil,
    }).where(eq(hroEmailScan.mailboxAddress, mailbox));
  }).catch(async () => {
    const lastError = "Gmail intake scan failed. Check provider access, route review and heartbeat. Saved page will retry.";
    await db.insert(hroEmailScan).values({ mailboxAddress: mailbox, query: "", cycleUntil: new Date(), lastError })
      .onConflictDoUpdate({ target: hroEmailScan.mailboxAddress, set: { lastError } });
    throw new Error("Email intake scan failed; private provider details withheld.");
  });
}
