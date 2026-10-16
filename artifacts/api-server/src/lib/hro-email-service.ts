import { bindNewCaseInTransaction } from "./flow-manager/manager";
import { templateOriginalIntent } from "./onboarding/original-intent";
import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, hroEmailRequests, hroEmailScan, hroMailboxIngress, onbCases, onbEvents, onbJobProfiles, agentInvocationAudit, agentCatalogueBindings } from "@workspace/db";
import { access, confidentialRead, type Tx } from "./offboarding/authority";
import { requireEmailIntakeRead, requireEmailRouteAdministrator, emailRouteReceiptCurrent as currentReceipt, emailRouteReceipt as receipt } from "./hro-email-authorization";
import { SeparationError, object, text } from "./offboarding/model";
import { audit, createSeparationInTransaction } from "./offboarding/service";
import { connectedIntakeMailbox, emailHasOtherOwnership, type EmailProvider } from "./hro-email-ingestion";
import { HRO_EMAIL_TEMPLATES, emailExample, missingEmailFields, validateEmailReview } from "./hro-email-registry";
import { findHroTemplate, hroRequestForRow } from "./onboarding/hro-batch-templates";
import { getInboundEmailMonitorStatus } from "./onboarding/inbound-email";
import { isPlatformSuperAdmin } from "./private-platform-admin";
import { assertGovernanceMutationAllowed } from "./onboarding/governance-dispatch";
import { governanceSnapshotForNewCase, withGovernanceDecisionSnapshot } from "./onboarding/governance-runtime";
import { evaluateCaseDerivedLifecycleGateInTransaction, withSensitiveLifecycleFence } from "./onboarding/sensitive-lifecycle";
import { resolveEffectiveWorkforcePolicyInTransaction } from "./onboarding/checklist-profiles";
import { normalizedWorkforceContext } from "./onboarding/workforce-policies";
import { readinessFromChecklist } from "./onboarding/settings";
import { resolveEffectiveAccessInTransaction } from "./access-governance";
import { registeredDemoProfile } from "./demo-principal";
import { emailReviewTurnaround } from "./hro-email-turnaround";
import { resolveIntakeConversion, requireIntakeConversion, type IntakeConversionContext } from "./intake-conversion-authorization";
import { appendProtectedAuditInTransaction } from "./onboarding/protected-audit";

type RequestRow = typeof hroEmailRequests.$inferSelect;
type RouteRow = typeof hroMailboxIngress.$inferSelect;
export function emailRouteView(row: RouteRow) {
  return { id: row.id, mailboxAddress: row.mailboxAddress, enabled: row.enabled === 1, version: row.revision,
    subjectMarker: `[HRO-INTAKE:${row.token}]`, activatedAt: row.activatedAt?.toISOString() ?? null,
    backfillFrom: row.backfillFrom?.toISOString() ?? null,
    retiredAt: row.retiredAt?.toISOString() ?? null, replacementOfId: row.replacementOfId,
    reviewRequired: !row.approval?.authorization || Boolean(row.replacementOfId && !row.activatedAt) };
}
export async function requireReview(tx: Tx, org: string, actor: string, write: boolean, row?: RequestRow) {
  await access(tx, org, actor, write, row?.caseId ?? undefined);
  await confidentialRead(tx, org, actor, row?.fields.work_country, row?.caseId ?? undefined);
  if (write) {
    const grants = await resolveEffectiveAccessInTransaction(tx, {
      organizationId: org, principalType: "human", principalId: actor, caseId: row?.caseId ?? undefined, purpose: "hro-email-review",
    });
    if (!grants.allows.includes("data.case.notes.edit")) throw new SeparationError("Explicit case-notes edit access is required for email request review.", 403);
  }
}
export async function emailIntakeReadiness(org: string, actor: string, provider?: EmailProvider) {
  // Reject restricted sessions before any connected-provider lookup. Recheck
  // after that asynchronous boundary; a slow provider cannot preserve expiry.
  await db.transaction(tx => requireEmailIntakeRead(tx, org, actor));
  const mailboxAddress = await connectedIntakeMailbox(provider);
  const monitor = await getInboundEmailMonitorStatus(org);
  // Raw provider error strings must not cross into this surface.
  monitor.lastError = monitor.lastError ? "Inbox monitoring failed. Check connected provider access and heartbeat." : null;
  return db.transaction(async tx => {
    await requireEmailIntakeRead(tx, org, actor);
    let canConfigure = false, canReview = false;
    try {
      await requireEmailRouteAdministrator(tx, org, actor);
      canConfigure = true;
    } catch (e) { if (!(e instanceof SeparationError)) throw e; }
    try { await requireReview(tx, org, actor, true); canReview = true; }
    catch (e) { if (!(e instanceof SeparationError)) throw e; }
    const routes = await tx.select().from(hroMailboxIngress).where(eq(hroMailboxIngress.organizationId, org));
    const [scan] = mailboxAddress ? await tx.select().from(hroEmailScan).where(eq(hroEmailScan.mailboxAddress, mailboxAddress)) : [];
    const [counts] = await tx.select({
      backlog: sql<number>`count(*) filter (where ${hroEmailRequests.status} in ('received','needs-review','blocked'))::integer`,
      blocked: sql<number>`count(*) filter (where ${hroEmailRequests.status} = 'blocked')::integer`,
    }).from(hroEmailRequests).where(eq(hroEmailRequests.organizationId, org));
    let liveRoute = false;
    for (const route of routes) if (route.enabled === 1 && route.mailboxAddress === mailboxAddress &&
      route.activatedAt && await currentReceipt(tx, org, route.approval, "")) liveRoute = true;
    const result = {
      automation: await emailAutomationView(tx, org),
      mailboxAddress, ready: Boolean(liveRoute && scan?.lastSuccessAt && Date.now() - scan.lastSuccessAt.getTime() < 180_000 && !scan.lastError),
      routes: canConfigure ? routes.map(emailRouteView) : routes.filter(r => r.enabled === 1).map(emailRouteView),
      templates: HRO_EMAIL_TEMPLATES.map(template => ({ template, example: emailExample(template) })),
      monitor, lastSuccessAt: scan?.lastSuccessAt?.toISOString() ?? null,
      lastError: !mailboxAddress ? "Connected Gmail profile unavailable; no route can be verified." :
        routes.some(r => r.enabled === 1) && !routes.some(r => r.enabled === 1 && r.mailboxAddress === mailboxAddress && r.activatedAt)
          ? "Enabled routes need explicit review against the current connected Gmail address." : scan?.lastError ?? null,
      backlog: counts?.backlog ?? 0, blocked: counts?.blocked ?? 0, paginationPending: Boolean(scan?.pageToken),
      turnaround: await emailReviewTurnaround(tx, org),
      attachmentPolicy: "Bounded source content is retained in private storage only after current collection-policy checks. Attachments remain quarantined and are never accepted as evidence by intake. Unavailable or unsafe malware scans block source access and evidence use. Use separately approved secure collection for bank, medical and identity values.",
      canConfigure, canReview, canTriage: isPlatformSuperAdmin(actor, org),
    };
    await requireEmailIntakeRead(tx, org, actor);
    return result;
  });
}
export async function configureEmailIntake(org: string, actor: string, raw: unknown, provider?: EmailProvider) {
  const input = object(raw);
  const reference = text(input.reference, "Independent reviewed mailbox routing reference", 240);
  if (!Number.isInteger(input.backfillHours) || Number(input.backfillHours) < 0 || Number(input.backfillHours) > 48)
    throw new SeparationError("Choose an activation backfill of 0–48 hours.", 400);
  const mailbox = await connectedIntakeMailbox(provider);
  if (!mailbox) throw new SeparationError("The connected Gmail address could not be verified. No route was enabled.", 409);
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await access(tx, org, actor, true); await requireEmailRouteAdministrator(tx, org, actor);
    await assertGovernanceMutationAllowed(tx, org);
    const approval = await receipt(tx, { organizationId: org, actor, reference, generation: 1 });
    const now = new Date();
    if (input.routeId !== undefined) {
      const [old] = await tx.select().from(hroMailboxIngress).where(and(eq(hroMailboxIngress.organizationId, org), eq(hroMailboxIngress.id, text(input.routeId, "routeId")))).for("update");
      if (!old) throw new SeparationError("Route not found in this client.", 404);
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== old.revision) throw new SeparationError("Route changed. Reload before independently reviewing it.", 409);
      if (old.retiredAt) throw new SeparationError("This marker is permanently retired and cannot be reopened.", 409);
      if (old.replacementOfId) {
        const [parent] = await tx.select().from(hroMailboxIngress).where(and(eq(hroMailboxIngress.organizationId, org), eq(hroMailboxIngress.id, old.replacementOfId)));
        if (!parent?.retiredAt || parent.mailboxAddress !== mailbox || old.mailboxAddress !== mailbox)
          throw new SeparationError("Replacement review requires the same verified Gmail primary mailbox.", 409);
        if (actor === old.createdBy)
          throw new SeparationError("A different verified reviewer must independently approve the replacement binding.", 403);
        if (input.backfillHours !== 0) throw new SeparationError("Replacement markers admit future mail only. Held requests require explicit re-admission.", 409);
      }
      const [row] = await tx.update(hroMailboxIngress).set({ approval, enabled: 1, mailboxAddress: mailbox, activatedAt: now,
        backfillFrom: new Date(now.getTime() - Number(input.backfillHours) * 3_600_000), revision: old.revision + 1,
      }).where(eq(hroMailboxIngress.id, old.id)).returning();
      await audit(tx, org, actor, "universal-mailbox-route-reverified", row.id, row.revision);
      return emailRouteView(row);
    }
    const [row] = await tx.insert(hroMailboxIngress).values({
      id: randomUUID(), organizationId: org, token: randomBytes(24).toString("hex"), allowedSenders: [],
      approval, createdBy: actor, enabled: 1, mailboxAddress: mailbox, activatedAt: now,
      backfillFrom: new Date(now.getTime() - Number(input.backfillHours) * 3_600_000),
    }).returning();
    await audit(tx, org, actor, "universal-mailbox-route-reviewed", row.id, row.revision);
    return emailRouteView(row);
  }));
}
export async function updateEmailRoute(org: string, actor: string, id: string, raw: unknown, provider?: EmailProvider) {
  const input = object(raw);
  const mailbox = input.enabled === true ? await connectedIntakeMailbox(provider) : null;
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await access(tx, org, actor, true); await requireEmailRouteAdministrator(tx, org, actor);
    const [route] = await tx.select().from(hroMailboxIngress).where(and(eq(hroMailboxIngress.id, id), eq(hroMailboxIngress.organizationId, org))).for("update");
    if (!route) throw new SeparationError("Route not found.", 404);
    if (route.revision !== input.expectedVersion) throw new SeparationError("Route changed. Reload before updating.", 409);
    if (route.retiredAt) throw new SeparationError("This marker is permanently retired and cannot be reopened.", 409);
    if (route.replacementOfId && !route.activatedAt) throw new SeparationError("Independently review the staged replacement before enabling it.", 409);
    if (typeof input.enabled !== "boolean") throw new SeparationError("Choose enable or pause.", 400);
    if (input.enabled && (!mailbox || mailbox !== route.mailboxAddress || !await currentReceipt(tx, org, route.approval, "")))
      throw new SeparationError("Mailbox or independent routing approval changed. Create a freshly reviewed route.", 409);
    const [updated] = await tx.update(hroMailboxIngress).set({ enabled: input.enabled ? 1 : 0, revision: route.revision + 1,
      ...(input.enabled ? { activatedAt: new Date(), backfillFrom: new Date() } : {}),
    })
      .where(eq(hroMailboxIngress.id, id)).returning();
    await audit(tx, org, actor, input.enabled ? "mailbox-route-reactivated" : "mailbox-route-paused", id, updated.revision);
    return emailRouteView(updated);
  }));
}
export async function loadRequest(tx: Tx, org: string, id: string) {
  const [row] = await tx.select().from(hroEmailRequests).where(and(eq(hroEmailRequests.organizationId, org), eq(hroEmailRequests.id, id))).for("update");
  if (!row) throw new SeparationError("Email request not found in this client.", 404);
  return row;
}
async function duplicateCount(tx: Tx, org: string, row: RequestRow) {
  if (!row.templateId || !row.fields.request_id) return 0;
  const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(hroEmailRequests).where(and(
    eq(hroEmailRequests.organizationId, org), eq(hroEmailRequests.templateId, row.templateId),
    sql`${hroEmailRequests.id} <> ${row.id}`,
    sql`(${hroEmailRequests.fields}->>'request_id' = ${row.fields.request_id}
      OR (${hroEmailRequests.fields}->>'worker_email' = ${row.fields.worker_email ?? ""}
        AND coalesce(${hroEmailRequests.fields}->>'effective_date', ${hroEmailRequests.fields}->>'joining_date', '') =
          ${row.fields.effective_date || row.fields.joining_date || ""}
        AND coalesce(${hroEmailRequests.fields}->>'employee_id', '') = ${row.fields.employee_id ?? ""}))`,
    sql`${hroEmailRequests.status} <> 'rejected'`,
  ));
  return count?.count ?? 0;
}
export async function requestView(tx: Tx, org: string, row: RequestRow) {
  return {
    id: row.id, templateId: row.templateId, family: findHroTemplate(row.templateId)?.family ?? null,
    status: row.status, reason: row.reason, fields: row.fields, fieldSources: row.fieldSources,
    extraction: row.extraction,
    missingFields: row.templateId ? missingEmailFields(row.templateId, row.fields) : ["template_id"],
    version: row.version, receivedAt: row.createdAt.toISOString(), attachments: row.attachments,
    caseId: row.caseId, caseKind: row.caseKind, sourceUrl: `/email-intake/${row.id}`,
    reviewed: Boolean(row.reviewedBy),
    conversionOrigin: row.conversionOrigin ?? (row.status === "converted" ? "manual" : null),
    conversionAgentId: row.conversionAgentId, conversionOwnerUserId: row.conversionOwnerUserId,
    automationState: row.automationState, automationReason: row.automationReason,
    potentialDuplicates: await duplicateCount(tx, org, row),
  };
}
export async function listEmailRequests(org: string, actor: string, before?: string) {
  let cursor: { date: Date; id: string } | undefined;
  if (before) {
    const [at, id] = before.split("|"), date = new Date(at);
    if (!Number.isFinite(date.getTime()) || !/^[a-f0-9-]{36}$/.test(id ?? "")) throw new SeparationError("Invalid queue cursor.", 400);
    cursor = { date, id };
  }
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await requireReview(tx, org, actor, false);
    const rows = await tx.select().from(hroEmailRequests).where(and(eq(hroEmailRequests.organizationId, org),
      cursor ? sql`(date_trunc('milliseconds', ${hroEmailRequests.createdAt}), ${hroEmailRequests.id}) < (${cursor.date.toISOString()}::timestamptz, ${cursor.id})` : undefined,
    )).orderBy(desc(sql`date_trunc('milliseconds', ${hroEmailRequests.createdAt})`), desc(hroEmailRequests.id)).limit(100);
    const visible = [];
    for (const row of rows) {
      try { await requireReview(tx, org, actor, false, row); visible.push(await requestView(tx, org, row)); }
      catch (e) { if (!(e instanceof SeparationError) || ![403, 404].includes(e.status)) throw e; }
    }
    return visible;
  }));
}
export async function getEmailRequest(org: string, actor: string, id: string) {
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await requireReview(tx, org, actor, false);
    const row = await loadRequest(tx, org, id);
    await requireReview(tx, org, actor, false, row);
    return requestView(tx, org, row);
  }));
}
export async function reviewEmailRequest(org: string, actor: string, id: string, raw: unknown) {
  const b = object(raw);
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await requireReview(tx, org, actor, true);
    const row = await loadRequest(tx, org, id);
    await requireReview(tx, org, actor, true, row);
    if (row.version !== b.expectedVersion) throw new SeparationError("Request changed. Reload before saving.", 409);
    if (["converted", "rejected"].includes(row.status)) throw new SeparationError("This request is final; it cannot be edited.", 409);
    if (b.action === "reject") {
      const [updated] = await tx.update(hroEmailRequests).set({ status: "rejected", automationState: row.automationState ? "manual" : null, version: row.version + 1, reviewedBy: actor, updatedAt: new Date(), reason: "Rejected by an authorized reviewer." }).where(eq(hroEmailRequests.id, id)).returning();
      await audit(tx, org, actor, "email-intake-rejected", id, updated.version);
      return requestView(tx, org, updated);
    }
    if (b.action !== "save" || typeof b.templateId !== "string") throw new SeparationError("Choose save or reject and a supported template.", 400);
    let result;
    try { result = validateEmailReview(b.templateId, b.fields); }
    catch { throw new SeparationError("Unsupported or sensitive fields. Use this template's allowed fields and secure collection references.", 400); }
    const nonMissing = result.issues.filter(i => !i.message.endsWith("is required."));
    if (nonMissing.length) throw new SeparationError("Correct field types, dates, choices and template version before saving.", 400);
    const fields = result.rows[0] ?? {};
    const country = fields.work_country;
    if (!country) throw new SeparationError("A country is required before retaining reviewer-supplied employee fields.", 409);
    const gate = await evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId: org, jurisdiction: country });
    if (!gate.allowed) throw new SeparationError("Country collection policy review is required before retaining fields.", 409);
    const [route] = await tx.select().from(hroMailboxIngress).where(and(eq(hroMailboxIngress.organizationId, org), eq(hroMailboxIngress.id, row.ingressId!))).for("update");
    if (!route?.enabled || route.retiredAt || !route.activatedAt || !await currentReceipt(tx, org, route.approval, "")) throw new SeparationError("The route must have current independent approval before review can be saved.", 409);
    const [updated] = await tx.update(hroEmailRequests).set({
      templateId: b.templateId, fields, fieldSources: Object.fromEntries(Object.keys(fields).map(k => [k,
        row.fields[k] === fields[k] && row.fieldSources[k] === "email" ? "email" as const : "reviewer" as const])),
      status: "needs-review", reason: result.valid ? "Reviewed fields complete; explicit conversion still required." : "Required fields remain missing.",
      automationState: row.automationState ? "manual" : null, automationReason: null,
      version: row.version + 1, routeRevision: route.revision, reviewedBy: actor, updatedAt: new Date(),
    }).where(eq(hroEmailRequests.id, id)).returning();
    await audit(tx, org, actor, "email-intake-reviewed", id, updated.version);
    return requestView(tx, org, updated);
  }));
}
export async function convertEmailRequest(org: string, actor: string, id: string, raw: unknown, provider?: EmailProvider) {
  const b = object(raw);
  const mailbox = await connectedIntakeMailbox(provider);
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await requireReview(tx, org, actor, true);
    const row = await loadRequest(tx, org, id);
    await requireReview(tx, org, actor, true, row);
    return convertEmailRequestInTransaction(tx, org, actor, row, b, mailbox);
  }));
}

/** Same typed creator for both entry points; only the authority and explicit
 * human acknowledgements differ. The tenant lock is held through final link. */
export async function convertEmailRequestInTransaction(tx: Tx, org: string, actor: string, row: RequestRow,
  b: Record<string, unknown>, mailbox: string | null, automation?: IntakeConversionContext) {
    const id = row.id;
    if (row.status === "converted" && row.caseId) return requestView(tx, org, row);
    if (automation) {
      await requireIntakeConversion(tx, automation);
      if (row.automationGeneration !== automation.generation || row.automationState !== "pending" ||
          row.createdAt < automation.activatedAt)
        throw new SeparationError("This request is outside the current registration boundary. Manual review is required.", 409);
      if (row.reviewedBy || Object.values(row.fieldSources).some(source => source !== "email") ||
          row.extraction.issues?.length || !row.fields.template_id || row.fields.template_id !== row.templateId)
        throw new SeparationError("Source classification or fields need human review; automation does not acknowledge source exceptions.", 409);
    }
    if (row.version !== b.expectedVersion) throw new SeparationError("Request changed. Reload before converting.", 409);
    if (row.status !== "needs-review" || (!automation && !row.reviewedBy) || !row.templateId)
      throw new SeparationError(automation ? row.reason || "Classification requires human review." : "Save reviewed classification and fields before conversion.", 409);
    if (await emailHasOtherOwnership(row.providerMessageId, tx)) throw new SeparationError("This provider message belongs to an existing reply, approval, status or legacy intake consumer. It cannot create another case.", 409);
    const [route] = await tx.select().from(hroMailboxIngress).where(and(eq(hroMailboxIngress.id, row.ingressId!), eq(hroMailboxIngress.organizationId, org))).for("update");
    if (!route?.enabled || route.retiredAt || !route.activatedAt || route.revision !== row.routeRevision || route.mailboxAddress !== mailbox || !await currentReceipt(tx, org, route.approval, ""))
      throw new SeparationError("Mailbox routing is paused, revoked or changed. A fresh route review is required.", 409);
    // Informational attachments are never read, imported or promoted by either
    // path. Any required evidence reference remains a held-case human decision.
    if (!automation && row.attachments.length && b.attachmentsAcknowledged !== true) throw new SeparationError("Acknowledge that private attachments remain quarantined and are not evidence.", 409);
    if (await duplicateCount(tx, org, row) && (automation || b.duplicateAcknowledged !== true)) throw new SeparationError("Potential independent duplicate requests need explicit review; no requests are automatically merged.", 409);
    let validated;
    try { validated = validateEmailReview(row.templateId, row.fields); }
    catch { throw new SeparationError("Allowed fields require correction.", 400); }
    if (!validated.valid) throw new SeparationError("Complete required fields using the current template before converting.", 400);
    await assertGovernanceMutationAllowed(tx, org);
    const fields = validated.rows[0], definition = findHroTemplate(row.templateId)!;
    const gate = await evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId: org, jurisdiction: fields.work_country });
    if (!gate.allowed) throw new SeparationError("Current sensitive lifecycle admission blocks conversion.", 409);
    if (definition.family === "Mobility") {
      const destinationGate = await evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId: org, jurisdiction: fields.destination_country });
      if (!destinationGate.allowed) throw new SeparationError("Destination-country policy review is required. This request is not an operational workforce transfer admission.", 409);
    }
    let caseId: number, caseKind: string;
    if (definition.id === "offboarding-separation") {
      const result = await createSeparationInTransaction(tx, org, actor, {
        employeeId: fields.employee_id, workerName: fields.worker_name, exitType: fields.separation_type, exitReason: fields.exit_reason,
        lastWorkingDay: fields.last_working_date, terminationDate: fields.termination_date, timeZone: fields.time_zone,
        role: fields.role, department: fields.department, country: fields.work_country, legalEntity: fields.legal_entity,
        workerCategory: fields.worker_category, manager: fields.manager_name,
      }, "mailbox", `email:${row.id}`, undefined, automation);
      caseId = result.caseId; caseKind = "separation";
      const [envelope] = await tx.select({ policy: onbCases.processPolicySnapshot }).from(onbCases).where(and(eq(onbCases.organizationId, org), eq(onbCases.id, caseId)));
      await tx.update(onbCases).set({ processPolicySnapshot: { ...envelope.policy,
        batchIntake: hroRequestForRow(definition, fields), emailIntake: { requestId: row.id, source: "Email" },
      } }).where(and(eq(onbCases.organizationId, org), eq(onbCases.id, caseId)));
    } else {
      const specialist = !definition.hireType;
      const [jobProfile] = fields.job_profile_id ? await tx.select().from(onbJobProfiles).where(and(
        eq(onbJobProfiles.organizationId, org), eq(onbJobProfiles.profileId, fields.job_profile_id), eq(onbJobProfiles.enabled, true),
      )).orderBy(desc(onbJobProfiles.version)).limit(1) : [];
      if (fields.job_profile_id && !jobProfile) throw new SeparationError("Selected client job profile is no longer enabled.", 409);
      const context = normalizedWorkforceContext({
        ...jobProfile?.context, workCountry: fields.work_country, legalEntity: fields.legal_entity, department: fields.department,
        workerCategory: fields.worker_category || undefined, workEnvironment: fields.work_environment as "office" | undefined,
        site: fields.site || undefined,
        ...Object.fromEntries(["site_exposure", "safety_critical", "assisted_intake"].map((key, i) =>
          [["siteExposure", "safetyCritical", "assistedIntake"][i], fields[key] === "yes" ? true : fields[key] === "no" ? false : undefined])),
      });
      const person = { hireType: definition.hireType ?? "service-request", workerCategory: fields.worker_category || "unspecified",
        role: fields.role || "", department: fields.department, geography: fields.work_country, legalEntity: fields.legal_entity };
      const policy = specialist ? {
        profile: { profileId: `hro-intake:${definition.id}`, profileVersion: definition.version, templateVersion: definition.version,
          profileName: `${definition.name} — intake review`, matchedCriteria: {}, explanation: "Input schema only; no execution authority.", processPolicy: {} },
        classification: null,
        effectiveItems: [{ id: "hro-specialist-request-review", label: "Authorized specialist review of submitted request", order: 0, enabled: true,
          mandatory: true, evidenceRequired: true, enforcementStage: "before-workstreams" as const, executor: "human-task" as const,
          completionAuthority: "designated-human" as const, responsibleRole: "Designated specialist" }],
      } : await resolveEffectiveWorkforcePolicyInTransaction(tx, org, context, person);
      const governance = await governanceSnapshotForNewCase(org, new Date(), tx);
      const [created] = await tx.insert(onbCases).values({
        originalIntent: templateOriginalIntent(definition.id, automation ? "automatic-email-intake" : "reviewed-email-intake"),
        organizationId: org, workerName: fields.worker_name, workerEmail: fields.worker_email, ...person,
        managerName: fields.manager_name || "", recruiterName: fields.recruiter_name || "",
        // No fabricated onboarding date for service requests; effective_date stays in its typed request.
        joiningDate: specialist ? "" : fields.joining_date, notes: null,
        workforceContext: context, workforceClassification: policy.classification,
        checklistSnapshot: policy.effectiveItems, checklistTemplateVersion: policy.profile.templateVersion,
        checklistProfileId: policy.profile.profileId, checklistProfileVersion: policy.profile.profileVersion,
        checklistProfileName: policy.profile.profileName, checklistMatchedCriteria: policy.profile.matchedCriteria,
        checklistMatchExplanation: policy.profile.explanation, jobProfileId: jobProfile?.profileId ?? null, jobProfileVersion: jobProfile?.version ?? null,
        processPolicySnapshot: withGovernanceDecisionSnapshot({
          profileId: policy.profile.profileId, profileVersion: policy.profile.profileVersion, templateVersion: policy.profile.templateVersion,
          processPolicy: policy.profile.processPolicy ?? {}, classification: policy.classification,
          batchIntake: hroRequestForRow(definition, fields), specialistReviewOnly: specialist,
          emailIntake: { requestId: row.id, source: "Email" },
        }, governance),
        readiness: readinessFromChecklist(policy.effectiveItems), workstreams: [], lifecycleStage: "trigger-received",
        orchestrationStatus: specialist ? "hro-request-pending-review" : "batch-intake-pending-review", createdByUserId: actor,
      }).returning();
      if (automation) await requireIntakeConversion(tx, automation, created.id);
      else await requireReview(tx, org, actor, true, { ...row, caseId: created.id });
      if (!specialist) await bindNewCaseInTransaction(tx, org, created.id, "onboarding");
      caseId = created.id; caseKind = specialist ? "service-request" : "onboarding";
    }
    await tx.insert(onbEvents).values({
      organizationId: org, caseId, agent: automation ? automation.agentId : "email-intake", engine: automation ? "rules" : "human", hitlPattern: "human-review-required",
      title: "Email request converted to held case", detail: automation
        ? "The registered Intake Conversion Agent converted validated source fields under the administrator's standing instruction. No human review was recorded. Attachments remain quarantined; evidence decisions and all operational work remain held."
        : "An authorized reviewer converted a reviewed request. Email content is unverified; no contact, evidence approval or operational release was authorized.",
      idempotencyKey: `email-intake:${row.id}:converted`,
    }).onConflictDoNothing();
    if (automation) await requireIntakeConversion(tx, automation, caseId);
    const [updated] = await tx.update(hroEmailRequests).set({ status: "converted", caseId, caseKind,
      reason: "Converted into a held case. Required human evidence decisions, approvals and operational work remain separate.",
      conversionOrigin: automation ? "automatic" : "manual", conversionAgentId: automation?.agentId ?? null,
      conversionOwnerUserId: automation?.ownerUserId ?? null,
      automationState: automation ? "converted" : row.automationState ? "manual" : null, automationReason: null,
      version: row.version + 1, updatedAt: new Date() })
      .where(eq(hroEmailRequests.id, id)).returning();
    if (automation) {
      await tx.insert(agentInvocationAudit).values({
        organizationId: org, agentId: automation.agentId, agentVersion: automation.agentVersion,
        initiatingUserId: automation.ownerUserId, runId: `intake:${id}`, correlationId: id,
        delegatedScope: ["intake-conversion/v1"], caseId, purpose: "Administrator standing intake conversion instruction",
        toolKey: "intake-conversion/v1", action: "intake.convert-held", outcome: "success",
      });
      await appendProtectedAuditInTransaction(tx, {
        organizationId: org, actorId: automation.agentId, actorKind: "system", actorAuthority: "registered-intake-conversion",
        action: "email-intake.automatically-converted-held", outcome: "success", objectType: "email-intake", objectId: id,
        source: "intake-conversion", correlationId: id, reviewedRevision: automation.generation,
        payload: { safeStatus: "held", humanReview: false },
      });
    } else await audit(tx, org, actor, "email-intake-converted-held", id, updated.version);
    return requestView(tx, org, updated);
}
export async function emailAutomationView(tx: Tx, org: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${org}))`);
  const active = await resolveIntakeConversion(tx, org);
  const [binding] = await tx.select().from(agentCatalogueBindings).where(and(
    eq(agentCatalogueBindings.organizationId, org), eq(agentCatalogueBindings.catalogueKey, "intake-conversion"),
  ));
  return { state: active ? "enabled" : binding ? "paused" : "manual",
    activatedAt: active?.activatedAt.toISOString() ?? null,
    notice: active
      ? "New complete explicit email templates convert automatically into held cases. Exceptions require human review. Informational attachments stay quarantined; required evidence decisions remain human."
      : binding ? "Automatic conversion is paused because registration or owner eligibility is no longer current. Existing requests remain available for manual review; re-registration admits only new mail."
      : "Conversion is manual. An administrator can register an Intake Conversion Agent in AI Agents to authorize automatic conversion of new valid email templates." };
}
function triageView(row: RequestRow) {
  return { id: row.id, status: row.status, reason: row.reason, receivedAt: row.createdAt.toISOString(), version: row.version };
}
function requireTriage(actor: string) {
  if (!isPlatformSuperAdmin(actor)) throw new SeparationError("Fresh verified platform administrator access is required for unbound mailbox triage.", 403);
}
export async function listEmailTriage(actor: string) {
  requireTriage(actor);
  const rows = await db.select().from(hroEmailRequests).where(and(sql`${hroEmailRequests.organizationId} is null`, eq(hroEmailRequests.status, "blocked"))).orderBy(sql`${hroEmailRequests.createdAt} asc`, sql`${hroEmailRequests.id} asc`).limit(100);
  requireTriage(actor);
  return rows.map(triageView);
}
export async function resolveEmailTriage(actor: string, id: string, raw: unknown) {
  requireTriage(actor);
  if (await registeredDemoProfile(actor)) throw new SeparationError("Demo identities cannot attribute real mail.", 403);
  const b = object(raw);
  return db.transaction(async tx => {
    requireTriage(actor);
    const [row] = await tx.select().from(hroEmailRequests).where(and(eq(hroEmailRequests.id, id), sql`${hroEmailRequests.organizationId} is null`)).for("update");
    if (!row) throw new SeparationError("Unbound request not found.", 404);
    if (row.version !== b.expectedVersion || row.status === "rejected") throw new SeparationError("Triage record changed. Reload.", 409);
    if (b.action === "reject") {
      const [updated] = await tx.update(hroEmailRequests).set({ status: "rejected", reason: "Rejected by platform triage.", version: row.version + 1, updatedAt: new Date() }).where(eq(hroEmailRequests.id, id)).returning();
      return triageView(updated);
    }
    if (b.action !== "assign") throw new SeparationError("Choose assign or reject.", 400);
    if (row.reason?.startsWith("Operational-reference ownership is uncertain.")) throw new SeparationError("Operational references must be resolved in the existing reply/status/approval channel, not converted into a new case.", 409);
    if (row.reason?.startsWith("Permanently retired marker.")) throw new SeparationError("New mail using a retired marker cannot be assigned to a replacement.", 409);
    text(b.reference, "Independently reviewed attribution reference", 240);
    const [route] = await tx.select().from(hroMailboxIngress).where(eq(hroMailboxIngress.id, text(b.routeId, "routeId"))).for("update");
    if (!route?.enabled || route.retiredAt || !route.activatedAt || route.mailboxAddress !== row.mailboxAddress || !await currentReceipt(tx, route.organizationId, route.approval, ""))
      throw new SeparationError("A current reviewed route for this exact connected mailbox is required.", 409);
    requireTriage(actor);
    // No provider body is copied by assignment; tenant reviewers supply facts after live collection gates.
    const [updated] = await tx.update(hroEmailRequests).set({
      organizationId: route.organizationId, ingressId: route.id, routeRevision: route.revision,
      originalIngressId: route.id, originalRouteRevision: route.revision,
      status: "needs-review", reason: "Explicit platform attribution recorded; classification and complete fields require tenant review.",
      reviewedBy: null, version: row.version + 1, updatedAt: new Date(),
    }).where(eq(hroEmailRequests.id, id)).returning();
    await audit(tx, route.organizationId, actor, "mailbox-platform-attribution", id, updated.version);
    return triageView(updated);
  });
}
