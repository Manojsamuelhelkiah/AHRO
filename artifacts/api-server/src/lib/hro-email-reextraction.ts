import { and, eq } from "drizzle-orm";
import { db, hroEmailRequests, hroEmailSources, hroMailboxIngress, onbSystemChecks } from "@workspace/db";
import { header, type GmailMessage } from "./onboarding/inbound-email";
import { boundedEmailContent, connectedIntakeMailbox, emailHasOtherOwnership, intakeMessageReserved, type EmailProvider } from "./hro-email-ingestion";
import { classifyEmail } from "./hro-email-registry";
import { canonicalIntakeHash, findHroTemplate } from "./onboarding/hro-batch-templates";
import { configuredMalwareScanner } from "./onboarding/malware-scanner";
import { withSensitiveLifecycleFence, evaluateCaseDerivedLifecycleGateInTransaction } from "./onboarding/sensitive-lifecycle";
import { emailRouteReceiptCurrent } from "./hro-email-authorization";
import { loadRequest, requestView, requireReview } from "./hro-email-service";
import { object, SeparationError } from "./offboarding/model";
import { audit } from "./offboarding/service";
import { mailboxTokens } from "./hro-mailbox-ingress";
import { AsyncLocalStorage } from "node:async_hooks";

const controlledScan = new AsyncLocalStorage<(bytes: Buffer) => Promise<string>>();
/** Process-local dependency for the isolated browser harness; never admitted by HTTP input. */
export function withControlledEmailExtractionScan<T>(scan: (bytes: Buffer) => Promise<string>, action: () => T): T {
  if (process.env.NODE_ENV !== "test" || process.env.ONBOARDING_E2E_TEST !== "true") throw new Error("Controlled source scanner is test-only.");
  return controlledScan.run(scan, action);
}

/** Preview retains no source bytes or suggestions. Apply rechecks the same source,
 * live permissions, route and version; digest is a comparison, never authority.
 */
export async function retryEmailExtraction(org: string, actor: string, id: string, raw: unknown,
  provider?: EmailProvider, dependencies: { scan?: (bytes: Buffer) => Promise<string> } = {}) {
  const input = object(raw);
  if (!Number.isInteger(input.expectedVersion) || !["preview", "apply"].includes(String(input.action)))
    throw new SeparationError("Choose preview or apply with the current request version.", 400);
  // Reject before any provider read, then repeat after the asynchronous boundary.
  await withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    const row = await loadRequest(tx, org, id);
    await requireReview(tx, org, actor, true, row);
    if (row.version !== input.expectedVersion) throw new SeparationError("Request changed. Reload before retrying extraction.", 409);
    if (["converted", "rejected"].includes(row.status)) throw new SeparationError("Final requests cannot be re-extracted.", 409);
  }));
  // Obtain the controlled provider via the same context as all intake reads.
  const p = provider ?? (await import("./hro-email-ingestion")).intakeEmailProvider();
  const mailbox = await connectedIntakeMailbox(p);
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    const row = await loadRequest(tx, org, id);
    await requireReview(tx, org, actor, true, row);
    if (row.version !== input.expectedVersion || ["converted", "rejected"].includes(row.status))
      throw new SeparationError("Request changed or is final. Reload before retrying extraction.", 409);
    const [route] = await tx.select().from(hroMailboxIngress).where(and(eq(hroMailboxIngress.id, row.ingressId!), eq(hroMailboxIngress.organizationId, org))).for("update");
    if (!mailbox || mailbox !== row.mailboxAddress || !route?.enabled || route.retiredAt || !route.activatedAt ||
      route.mailboxAddress !== mailbox || route.revision !== row.routeRevision || !await emailRouteReceiptCurrent(tx, org, route.approval, ""))
      throw new SeparationError("Current exact-mailbox route approval is unavailable or changed. Review routing before retrying.", 409);
    const sources = await tx.select().from(hroEmailSources).where(and(eq(hroEmailSources.organizationId, org), eq(hroEmailSources.requestId, id)));
    if (sources.some(s => ["minimized", "infected", "malicious", "quarantined-limit"].includes(s.state)))
      throw new SeparationError("Private source is minimized or quarantined. Use approved secure collection; saved fields are unchanged.", 409);
    if (await emailHasOtherOwnership(row.providerMessageId)) throw new SeparationError("Message belongs to another operational channel.", 409);
    let msg: GmailMessage;
    try {
      const response = await p.get(`/gmail/v1/users/me/messages/${encodeURIComponent(row.providerMessageId)}?format=full`);
      if (!response.ok) throw new Error();
      msg = await response.json() as GmailMessage;
    } catch { throw new SeparationError("Original provider message is unavailable. Restore mailbox access and retry; saved fields are unchanged.", 409); }
    if (msg.id !== row.providerMessageId) throw new SeparationError("Original provider message identity did not match.", 409);
    const subject = header(msg, "Subject").slice(0, 1000);
    const [original] = await tx.select().from(hroMailboxIngress).where(and(eq(hroMailboxIngress.id, row.originalIngressId ?? route.id), eq(hroMailboxIngress.organizationId, org)));
    const tokens = mailboxTokens(subject);
    const sentAt = Number(msg.internalDate);
    if (!original || tokens.length !== 1 || tokens[0] !== original.token || !Number.isFinite(sentAt) ||
      !original.backfillFrom || sentAt < original.backfillFrom.getTime() || sentAt > Date.now() + 1000)
      throw new SeparationError("Original source marker or admission interval is no longer verifiable.", 409);
    const content = boundedEmailContent(msg);
    const refs = await tx.select({ ref: onbSystemChecks.externalRef }).from(onbSystemChecks);
    if (content.blocked || intakeMessageReserved(msg, `${content.body}\n${content.structure.htmlText}`, refs.map(r => r.ref ?? "")))
      throw new SeparationError("Source is unsafe, exceeds limits or belongs to an operational reply channel.", 409);
    const bytes = Buffer.from(content.scanContent);
    try {
      const scanner = configuredMalwareScanner();
      let verdict = "unavailable";
      const scan = dependencies.scan ?? controlledScan.getStore();
      try { verdict = scan ? await scan(bytes) : scanner ? await scanner.scan(bytes, AbortSignal.timeout(30_000)) : "unavailable"; } catch { /* fail closed */ }
      if (verdict !== "clean") throw new SeparationError("Private source scan is unavailable or unsafe. Restore a clean scan and retry; saved fields are unchanged.", 409);
    } finally { bytes.fill(0); }
    const classified = classifyEmail(subject, content.body, content.structure);
    if (classified.blockedReason?.startsWith("Potential sensitive"))
      throw new SeparationError(classified.blockedReason, 409);
    const country = classified.fields.work_country || row.fields.work_country || "unknown";
    for (const jurisdiction of new Set([country, row.fields.work_country].filter(Boolean))) {
      const gate = await evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId: org, jurisdiction });
      if (!gate.allowed) throw new SeparationError("Current source collection policy review is required; saved fields are unchanged.", 409);
    }
    await requireReview(tx, org, actor, true, { ...row, fields: { ...row.fields, work_country: country } });
    const preservedFields = Object.keys(row.fields).filter(k => row.fieldSources[k] === "reviewer");
    // A human-reviewed template is never changed by machine extraction.
    const templateId = row.reviewedBy || preservedFields.length ? row.templateId : classified.templateId;
    if (templateId && classified.templateId !== templateId)
      throw new SeparationError("Source template differs from reviewer-authored classification. Resolve classification manually; saved fields are unchanged.", 409);
    const allowed = new Set(findHroTemplate(templateId)?.columns.map(c => c.key) ?? []);
    const fields = Object.fromEntries(Object.entries(classified.fields).filter(([k]) => allowed.has(k)));
    for (const key of preservedFields) if (allowed.has(key)) fields[key] = row.fields[key];
    const metadata = { issues: classified.issues, provenance: { ...classified.provenance,
      ...Object.fromEntries(preservedFields.filter(k => allowed.has(k)).map(k => [k, ["reviewer-preserved"]])) } };
    const previewDigest = canonicalIntakeHash({ org, actor, id, version: row.version, route: route.revision,
      source: content.scanContent, subject, internalDate: msg.internalDate,
      attachments: content.attachments, templateId, fields, metadata });
    const result = { version: row.version, templateId, fields, metadata, previewDigest, preservedFields };
    if (input.action === "preview") return result;
    if (input.previewDigest !== previewDigest) throw new SeparationError("Extraction preview or source changed. Preview again before adopting.", 409);
    await requireReview(tx, org, actor, true, row);
    const [updated] = await tx.update(hroEmailRequests).set({
      templateId, fields, fieldSources: Object.fromEntries(Object.keys(fields).map(k => [k, preservedFields.includes(k) ? "reviewer" as const : "email" as const])),
      extraction: metadata, reviewedBy: null, status: "needs-review", reason: "Source suggestions adopted. A fresh human review is required before conversion.",
      automationState: row.automationState ? "manual" : null, automationReason: null,
      version: row.version + 1, updatedAt: new Date(),
    }).where(eq(hroEmailRequests.id, id)).returning();
    await audit(tx, org, actor, "email-intake-extraction-adopted", id, updated.version);
    return { ...result, request: await requestView(tx, org, updated) };
  }));
}
