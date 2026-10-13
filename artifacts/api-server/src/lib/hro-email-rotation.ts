import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, hroEmailRequests, hroMailboxIngress } from "@workspace/db";
import { access, authority, currentReceipt, type Tx } from "./offboarding/authority";
import { SeparationError, object, text } from "./offboarding/model";
import { audit } from "./offboarding/service";
import { withSensitiveLifecycleFence } from "./onboarding/sensitive-lifecycle";
import { assertGovernanceMutationAllowed } from "./onboarding/governance-dispatch";
import { connectedIntakeMailbox, emailHasOtherOwnership, type EmailProvider } from "./hro-email-ingestion";
import { emailRouteView, requireReview } from "./hro-email-service";

type Route = typeof hroMailboxIngress.$inferSelect;
type Request = typeof hroEmailRequests.$inferSelect;
const heldStatuses = ["received", "needs-review", "blocked"];

export function rotationRequestEligible(row: Request, route: Route) {
  return row.organizationId === route.organizationId && row.ingressId === route.id &&
    row.mailboxAddress === route.mailboxAddress && row.caseId === null &&
    heldStatuses.includes(row.status) && (!route.retiredAt || row.createdAt <= route.retiredAt);
}
async function configureAuthority(tx: Tx, org: string, actor: string) {
  await access(tx, org, actor, true);
  await authority(tx, org, actor, "hr-compliance-approve");
  await authority(tx, org, actor, "legal-approve");
}
async function routeFor(tx: Tx, org: string, id: string) {
  const [route] = await tx.select().from(hroMailboxIngress).where(and(
    eq(hroMailboxIngress.organizationId, org), eq(hroMailboxIngress.id, id),
  )).for("update");
  if (!route) throw new SeparationError("Route not found in this client.", 404);
  return route;
}
function expected(actual: number, value: unknown) {
  if (!Number.isInteger(value) || value !== actual) throw new SeparationError("Routing or request version changed. Reload the preview and review again.", 409);
}
async function preview(tx: Tx, org: string, actor: string, route: Route, before?: string) {
  let cursor: { date: Date; id: string } | undefined;
  if (before) {
    const [at, id] = before.split("|"), date = new Date(at);
    if (!Number.isFinite(date.getTime()) || !/^[a-f0-9-]{36}$/.test(id ?? "")) throw new SeparationError("Invalid preview cursor.", 400);
    cursor = { date, id };
  }
  const [replacement] = await tx.select().from(hroMailboxIngress).where(and(
    eq(hroMailboxIngress.organizationId, org), eq(hroMailboxIngress.replacementOfId, route.id),
  ));
  const rows = await tx.select({
    id: hroEmailRequests.id, version: hroEmailRequests.version, status: hroEmailRequests.status,
    createdAt: hroEmailRequests.createdAt, caseId: hroEmailRequests.caseId,
  }).from(hroEmailRequests).where(and(
    eq(hroEmailRequests.organizationId, org), eq(hroEmailRequests.ingressId, route.id),
    eq(hroEmailRequests.mailboxAddress, route.mailboxAddress ?? ""),
    sql`${hroEmailRequests.caseId} is null`,
    sql`${hroEmailRequests.status} in ('received', 'needs-review', 'blocked')`,
    route.retiredAt ? sql`${hroEmailRequests.createdAt} <= ${route.retiredAt.toISOString()}::timestamptz` : undefined,
    cursor ? sql`(date_trunc('milliseconds', ${hroEmailRequests.createdAt}), ${hroEmailRequests.id}) < (${cursor.date.toISOString()}::timestamptz, ${cursor.id})` : undefined,
  )).orderBy(desc(sql`date_trunc('milliseconds', ${hroEmailRequests.createdAt})`), desc(hroEmailRequests.id)).limit(101);
  const visible = [];
  for (const row of rows.slice(0, 100)) {
    try {
      await access(tx, org, actor, false, row.caseId ?? undefined);
      // Never expose fields, filenames, reasons, sender, provider ids or raw source.
      visible.push({ id: row.id, version: row.version, status: row.status, receivedAt: row.createdAt.toISOString() });
    } catch (e) { if (!(e instanceof SeparationError) || ![403, 404].includes(e.status)) throw e; }
  }
  const last = rows[99];
  return { route: emailRouteView(route), replacement: replacement ? emailRouteView(replacement) : null,
    requests: visible, nextBefore: rows.length > 100 ? `${last.createdAt.toISOString()}|${last.id}` : null };
}
export async function getEmailRotation(org: string, actor: string, id: string, before?: string) {
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await configureAuthority(tx, org, actor);
    return preview(tx, org, actor, await routeFor(tx, org, id), before);
  }));
}
export async function stageEmailRotation(org: string, actor: string, id: string, raw: unknown, provider?: EmailProvider) {
  const b = object(raw), reference = text(b.reference, "Marker retirement review reference", 240);
  if (b.retirementAcknowledged !== true) throw new SeparationError("Acknowledge that the old marker will be permanently retired.", 400);
  const mailbox = await connectedIntakeMailbox(provider);
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await configureAuthority(tx, org, actor);
    await assertGovernanceMutationAllowed(tx, org);
    const route = await routeFor(tx, org, id);
    expected(route.revision, b.expectedVersion);
    if (route.retiredAt || !route.activatedAt || !mailbox || route.mailboxAddress !== mailbox ||
      !await currentReceipt(tx, org, route.approval, ""))
      throw new SeparationError("Rotation requires a non-retired, reviewed route on the same verified Gmail primary mailbox.", 409);
    if (route.replacementOfId) {
      const parent = await routeFor(tx, org, route.replacementOfId);
      const [earlierHeld] = await tx.select({ id: hroEmailRequests.id }).from(hroEmailRequests).where(and(
        eq(hroEmailRequests.organizationId, org), eq(hroEmailRequests.ingressId, parent.id),
        eq(hroEmailRequests.mailboxAddress, mailbox), sql`${hroEmailRequests.caseId} is null`,
        sql`${hroEmailRequests.status} in ('received', 'needs-review', 'blocked')`,
        parent.retiredAt ? sql`${hroEmailRequests.createdAt} <= ${parent.retiredAt.toISOString()}::timestamptz` : undefined,
      )).limit(1);
      if (earlierHeld) throw new SeparationError("Re-admit or reject the predecessor's held requests before rotating this replacement. Their recovery path must remain available.", 409);
    }
    const now = new Date();
    const [retired] = await tx.update(hroMailboxIngress).set({
      enabled: 0, retiredAt: now, revision: route.revision + 1,
    }).where(eq(hroMailboxIngress.id, route.id)).returning();
    const [replacement] = await tx.insert(hroMailboxIngress).values({
      id: randomUUID(), organizationId: org, token: randomBytes(24).toString("hex"), allowedSenders: [],
      // Historical receipt is not replacement approval: activation is null and every enable path denies it.
      approval: route.approval, createdBy: actor, enabled: 0, mailboxAddress: mailbox,
      replacementOfId: route.id, rotationReference: reference,
    }).returning();
    await audit(tx, org, actor, "email-marker-permanently-retired", retired.id, retired.revision);
    await audit(tx, org, actor, "email-marker-replacement-staged", replacement.id, replacement.revision);
    return preview(tx, org, actor, retired);
  }));
}
export async function readmitEmailRequests(org: string, actor: string, id: string, raw: unknown, provider?: EmailProvider) {
  const b = object(raw), reference = text(b.reference, "Held-request re-admission review reference", 240);
  if (!Array.isArray(b.requests) || b.requests.length < 1 || b.requests.length > 100)
    throw new SeparationError("Select 1–100 held requests from the current preview.", 400);
  const selections = b.requests.map(v => { const s = object(v); return { id: text(s.id, "Request id"), version: s.expectedVersion }; });
  if (new Set(selections.map(s => s.id)).size !== selections.length) throw new SeparationError("Select each request only once.", 400);
  const mailbox = await connectedIntakeMailbox(provider);
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await configureAuthority(tx, org, actor);
    await assertGovernanceMutationAllowed(tx, org);
    const route = await routeFor(tx, org, id);
    expected(route.revision, b.expectedVersion);
    const [replacementRow] = await tx.select().from(hroMailboxIngress).where(and(eq(hroMailboxIngress.organizationId, org), eq(hroMailboxIngress.replacementOfId, route.id))).for("update");
    if (!route.retiredAt || route.enabled || !replacementRow) throw new SeparationError("Stage permanent marker retirement first.", 409);
    const replacement = replacementRow;
    expected(replacement.revision, b.expectedReplacementVersion);
    if (!mailbox || route.mailboxAddress !== mailbox || replacement.mailboxAddress !== mailbox ||
      !replacement.enabled || !replacement.activatedAt || replacement.retiredAt ||
      replacement.approval.actor === replacement.createdBy || !await currentReceipt(tx, org, replacement.approval, ""))
      throw new SeparationError("The replacement needs current independent review on the same verified Gmail primary mailbox.", 409);
    // One transaction: a stale selection or ownership conflict rolls back the whole batch.
    for (const selection of selections.sort((a, b) => a.id.localeCompare(b.id))) {
      const [row] = await tx.select().from(hroEmailRequests).where(and(eq(hroEmailRequests.organizationId, org), eq(hroEmailRequests.id, selection.id))).for("update");
      if (!row || !rotationRequestEligible(row, route)) throw new SeparationError("A selected request is no longer held under this retired route.", 409);
      expected(row.version, selection.version);
      await requireReview(tx, org, actor, true, row);
      if (await emailHasOtherOwnership(row.providerMessageId)) throw new SeparationError("A selected message belongs to another reply, approval or status consumer.", 409);
      const [updated] = await tx.update(hroEmailRequests).set({
        ingressId: replacement.id, routeRevision: replacement.revision,
        originalIngressId: row.originalIngressId ?? row.ingressId,
        originalRouteRevision: row.originalRouteRevision ?? row.routeRevision,
        routingAdmissions: [...row.routingAdmissions, { fromId: route.id, fromRevision: row.routeRevision ?? route.revision,
          toId: replacement.id, toRevision: replacement.revision, requestVersion: row.version, actor, reference, admittedAt: new Date().toISOString() }],
        // Keep all source/retention/collection blocks, content and provenance unchanged.
        status: row.status === "blocked" ? "blocked" : "needs-review",
        reason: row.status === "blocked" ? row.reason : "Re-admitted under independently reviewed replacement; fresh field review required. No effects authorized.",
        reviewedBy: null, version: row.version + 1, updatedAt: new Date(),
      }).where(eq(hroEmailRequests.id, row.id)).returning();
      await audit(tx, org, actor, "email-held-request-readmitted-for-review", row.id, updated.version);
    }
    return preview(tx, org, actor, route);
  }));
}
