import type { OnbActionCenter, OnbCase, WorkforceInsights, ControlTowerExamples } from '@workspace/api-client-react';
import { CASE_TYPES, caseTypeOf, statusOf, caseIsActive } from '../pages/cases/case-presentation';
import { pendingActionReviews } from '../components/workforce-insights/action-review-projection';

export const FAMILIES = CASE_TYPES.filter((t) => t !== 'All Cases');
export const UNRESOLVED_NOTIFICATION = new Set(['open', 'pending', 'failed', 'blocked', 'overdue', 'unknown_effect_manual_repair', 'needs-review', 'unresolved', 'exception']);
const CLOSED_WORK = new Set(['resolved', 'closed', 'completed', 'cancelled', 'dismissed']);

export type AttentionKind = 'approval' | 'document' | 'work-item' | 'notification' | 'opportunity' | 'record' | 'review';
export interface AttentionItem {
  key: string; kind: AttentionKind; title: string; caseId: number | null; href: string;
  createdAt: string | null; owner: string | null; priority: string | null; due: string | null;
}
export interface AttentionProjection {
  items: AttentionItem[]; total: number; historicalNotifications: number;
  unit: string; incomplete: boolean; byKind: Record<AttentionKind, number>;
}
export const ATTENTION_UNIT = 'outstanding work items (pending approvals, document follow-ups, open work items, unresolved notifications, opportunities, attention records, early-warning reviews)';

export function approvalHref(approvalId: number, caseId: number) {
  return `/approvals?tab=approvals&approvalId=${approvalId}&caseId=${caseId}`;
}
export const reviewHref = (id: string) => `/analytics#review-${id}`;

/** Shared by dashboard and Action Center. Dedups by stable source id. Missing fields stay null (unknown). */
const LIMIT = 200;
function retainedOffline(a: any, data: OnbActionCenter | undefined) {
  const c = a.case ?? {};
  return c.pausedOffline === true || c.offlineSample === true || c.controllerRetired === true;
}
/** approval:ID:vN and approval:ID are the same approval; check ids only when explicit. */
export function opportunityKey(o: { id: string; caseId?: number; evidence?: { [k: string]: unknown } }) {
  const m = /^approval:(\d+)(?::v\d+)?$/.exec(o.id);
  if (m) return `approval:${m[1]}`;
  const document = /^document(?:-review)?:(\d+):(\d+)$/.exec(o.id);
  if (document) return `doc:${document[1]}:${document[2]}`;
  const bgv = /^bgv:(\d+):(\d+)$/.exec(o.id);
  if (bgv) return `check:${bgv[2]}`;
  const check = o.evidence?.checkId;
  if (typeof check === 'string' || typeof check === 'number') return `check:${check}`;
  return `opp:${o.id}`;
}
export function notificationKey(id: string) {
  const m = /^(?:check|system-check):(.+)$/.exec(id);
  return m ? `check:${m[1]}` : `event:${id.replace(/^event:/, '')}`;
}

export interface SourceDisclosure { label: string; shown: number; available: number | null; capped: boolean }
/** Counts can exceed the bounded arrays; never claim completeness. */
export function sourceDisclosures(data: OnbActionCenter | undefined): SourceDisclosure[] {
  if (!data) return [];
  const rows: [string, number, number][] = [
    ['Approvals', data.approvals.length, data.counts.pendingApprovals], ['Notifications', data.notifications.length, data.counts.notifications],
    ['Document follow-ups', data.documentFollowups.length, data.counts.missingDocuments], ['Work items', data.workItems.length, data.counts.openWorkItems],
    ['Completed', data.completed.length, data.counts.completed], ['Opportunities', data.opportunities.length, data.counts.opportunities]];
  return rows.map(([label, shown, available]) => ({ label, shown, available, capped: shown >= LIMIT || available > shown }));
}

export function projectAttention(data: OnbActionCenter | undefined, reviews: WorkforceInsights | undefined): AttentionProjection {
  const map = new Map<string, AttentionItem>();
  const add = (i: AttentionItem) => { if (!map.has(i.key)) map.set(i.key, i); };
  let historical = 0;
  for (const a of data?.approvals ?? []) if (a.status === 'pending' && !retainedOffline(a, data)) add({ key: `approval:${a.id}`, kind: 'approval', title: a.recommendation, caseId: a.caseId, href: approvalHref(a.id, a.caseId), createdAt: a.createdAt || null, owner: null, priority: a.hitlPattern === 'hard-block' ? 'high' : null, due: null });
  for (const d of data?.documentFollowups ?? []) add({ key: `doc:${d.caseId}:${d.documentId}`, kind: 'document', title: `${d.action === 'review' ? 'Review' : 'Missing'}: ${d.label}`, caseId: d.caseId, href: d.caseHref, createdAt: null, owner: null, priority: null, due: null });
  for (const w of data?.workItems ?? []) if (!CLOSED_WORK.has(String(w.status))) add({ key: `work:${w.id}`, kind: 'work-item', title: `${w.kind}${w.reason ? ` — ${w.reason}` : ''}`, caseId: w.caseId, href: w.caseHref, createdAt: w.createdAt || null, owner: w.assignee || w.owner || null, priority: null, due: null });
  for (const n of data?.notifications ?? []) {
    if (UNRESOLVED_NOTIFICATION.has(String(n.status).toLowerCase())) add({ key: notificationKey(n.id), kind: 'notification', title: n.title, caseId: n.caseId, href: n.caseHref, createdAt: n.createdAt || null, owner: null, priority: null, due: null });
    else historical++;
  }
  const retainedApprovals = new Set((data?.approvals ?? []).filter(a => retainedOffline(a, data)).map(a => `approval:${a.id}`));
  for (const o of data?.opportunities ?? []) if (!retainedApprovals.has(opportunityKey(o))) add({ key: opportunityKey(o), kind: 'opportunity', title: o.title, caseId: o.caseId, href: o.caseHref, createdAt: null, owner: null, priority: o.priority, due: null });
  for (const r of data?.domainRecords ?? []) if (r.category === 'attention') add({ key: `record:${r.id}`, kind: 'record', title: r.title, caseId: r.caseId, href: r.caseHref, createdAt: r.createdAt ?? null, owner: r.owner ?? null, priority: null, due: r.dueAt ?? null });
  for (const r of pendingActionReviews(reviews)) add({ key: `review:${r.id}`, kind: 'review', title: `${r.reference}: ${r.reason}`, caseId: r.caseId, href: reviewHref(r.id), createdAt: r.createdAt || null, owner: reviews?.owners?.find(o => o.userId === r.ownerUserId)?.label ?? null, priority: r.priority, due: r.dueDate || null });
  const priority = (value: string | null) => ({ critical: 0, high: 1, medium: 2, low: 3 }[value ?? ''] ?? 4);
  const items = [...map.values()].sort((a, b) => priority(a.priority) - priority(b.priority) ||
    (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.key.localeCompare(b.key));
  const byKind = { approval: 0, document: 0, 'work-item': 0, notification: 0, opportunity: 0, record: 0, review: 0 } as Record<AttentionKind, number>;
  items.forEach((i) => byKind[i.kind]++);
  return { items, total: items.length, historicalNotifications: historical, unit: ATTENTION_UNIT,
    incomplete: !data || !reviews || (data.offboardingSource !== undefined && data.offboardingSource !== 'available') ||
      sourceDisclosures(data).some(s => s.label !== 'Completed' && s.capped), byKind };
}

/** Collapse onboarding rows and separate domain summaries describing the same case. Summaries win. */
export function caseIdentity(href: string | undefined, id: number) {
  const m = href?.match(/\/cases\/(?:separations\/)?(\d+)/);
  return m ? Number(m[1]) : id;
}
export interface FamilyRow { family: string; total: number; active: number; completed: number; href: string; activeHref: string }
export function familyWorkload(cases: OnbCase[], summaries: NonNullable<OnbActionCenter['caseSummaries']> = []): FamilyRow[] {
  const seen = new Map<number, { family: string; done: boolean; completed: boolean }>();
  for (const s of summaries) if (s.caseHref.includes('/separations/')) seen.set(caseIdentity(s.caseHref, s.caseId),
    { family: s.caseType, done: ['complete', 'completed', 'closed', 'done', 'cancelled', 'transfer-review', 'rejected'].includes(s.status.toLowerCase()),
      completed: ['complete', 'completed', 'closed', 'done'].includes(s.status.toLowerCase()) });
  for (const c of cases) {
    const id = caseIdentity(undefined, c.id);
    if (seen.has(id)) continue;
    seen.set(id, { family: caseTypeOf(c), done: !caseIsActive(c), completed: statusOf(c) === 'Completed' });
  }
  return FAMILIES.map((family) => {
    const rows = [...seen.values()].filter((r) => r.family === family);
    return { family, total: rows.length, active: rows.filter((r) => !r.done).length,
      completed: rows.filter(r => r.completed).length, href: `/cases?caseType=${encodeURIComponent(family)}`, activeHref: `/cases?caseType=${encodeURIComponent(family)}&activeOnly=1` };
  });
}

/** No contract attests whole-case verified outcomes: everything completed is UNKNOWN. */
export function executionEvidence(completedAuthorized: number) {
  return { verifiedAutonomous: 0, verifiedHumanAssisted: 0, unknown: completedAuthorized, denominator: completedAuthorized,
    headline: 'Not assessed', note: 'Record-level actions are not whole-case verified success. Outcomes stay unknown until real execution evidence exists.' };
}

export function examplesAggregate(e: ControlTowerExamples | undefined) {
  if (!e) return null;
  return { inventory: e.inventorySize, shown: e.items.length, answerSamples: e.answerSamples, answerMatches: e.answerMatches,
    note: `Authored examples only: ${e.answerMatches} of ${e.answerSamples} sampled answers matched. This is not production accuracy.` };
}
export const exampleDetailHref = (caseHref: string) => (caseHref.includes('#') ? caseHref : `${caseHref}#operational-reliability`);

export function activityHref(caseId: number | null | undefined, sep = false) {
  return caseId == null ? null : `${sep ? '/cases/separations' : '/cases'}/${caseId}?tab=progress&section=history`;
}

/* ------------------------------ recorded activity ------------------------------ */
export interface ActivityItem { key: string; title: string; detail: string; caseId: number | null; href: string | null; createdAt: string | null; actor: string | null; label: string; source: string; family?: string; reference?: string }
const stripHash = (h: string) => h.split('#')[0];
function tabHref(caseHref: string | undefined, caseId: number | null, tab: 'history' | 'communications') {
  if (caseHref) {
    const base = stripHash(caseHref);
    if (base.includes('/separations/')) return base;
    return `${base}${base.includes('?') ? '&' : '?'}tab=${tab === 'history' ? 'progress&section=history' : 'communications'}`;
  }
  if (caseId == null) return null;
  return `/cases/${caseId}?tab=${tab === 'history' ? 'progress&section=history' : 'communications'}`;
}
export function composeActivity(events: { id: number | string; caseId?: number | null; title: string; detail: string; agent?: string; createdAt?: string }[] | undefined, data: OnbActionCenter | undefined, cases: OnbCase[] = []): ActivityItem[] {
  const map = new Map<string, ActivityItem>();
  const add = (i: ActivityItem) => { if (!map.has(i.key)) map.set(i.key, i); };
  for (const e of events ?? []) add({ key: `event:${e.id}`, title: e.title, detail: e.detail, caseId: e.caseId ?? null, href: tabHref(undefined, e.caseId ?? null, 'history'), createdAt: e.createdAt || null, actor: e.agent || null, label: 'Recorded event', source: 'dashboard events' });
  for (const n of data?.notifications ?? []) {
    const sim = ['simulated', 'simulation'].includes(n.provenance) || n.status === 'simulated' || n.deliveryLabel === 'Simulated';
    add({ key: notificationKey(n.id), title: n.title, detail: n.detail, caseId: n.caseId, href: tabHref(n.caseHref, n.caseId, n.source === 'persisted-communication' ? 'communications' : 'history'), createdAt: n.createdAt || null, actor: n.initiator || null,
      label: sim ? 'Simulated' : n.status === 'sending' ? 'Request in progress — delivery unknown' : `Recorded ${n.status}`, source: n.source });
  }
  for (const c of data?.completed ?? []) add({ key: `completed:${c.id}`, title: c.summary, detail: `Recorded action ${c.status}`, caseId: c.caseId, href: tabHref(c.caseHref, c.caseId, 'history'), createdAt: c.createdAt || null, actor: c.actor || null, label: 'Recorded action (not whole-case success)', source: 'action center completed' });
  for (const r of data?.domainRecords ?? []) {
    if (r.category === 'attention') continue;
    add({ key: `record:${r.id}`, title: r.title, detail: r.detail, caseId: r.caseId, href: tabHref(r.caseHref, r.caseId, r.category === 'communication' ? 'communications' : 'history'), createdAt: r.createdAt ?? null, actor: r.actor ?? null, label: r.category === 'activity' ? 'Recorded checkpoint' : 'Recorded record', source: 'domain records' });
  }
  const summaries = new Map((data?.caseSummaries ?? []).map(s => [s.caseId, s]));
  return [...map.values()].map(item => {
    const summary = summaries.get(item.caseId ?? -1);
    const c = cases.find(c => c.id === item.caseId);
    const reference = c?.fictionalOfflineIdentity ? `S${c.id}` : summary?.label ?? (item.caseId ? `Case #${item.caseId}` : 'System');
    return { ...item, family: summary?.caseType ?? (c ? caseTypeOf(c) : 'Domain not available'), reference,
      href: summary?.caseHref.includes('/separations/') ? summary.caseHref : item.href };
  }).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/* --------------------------- live reliability (typed) --------------------------- */
export interface Reliability {
  technicalFailures: number; unknownEffectManualRepair: number; systemChecksPending: number; systemChecksOverdue: number;
  failedActions: number; humanWaits: number; policyBlocks: number; excluded: number; quality: 'Not assessed';
  items: ReliabilityItem[]; provenanceKnown: boolean;
}
export interface ReliabilityItem {
  key: string; caseId: number; reference: string; href: string; title: string;
  source: string; actor: string; status: string; impact: string; owner: string | null; nextStep: string;
}
/** Typed sources only. Fictional cases, simulations and unknown-provenance cases are excluded from live claims. */
export function liveReliability(data: OnbActionCenter | undefined, cases?: OnbCase[]): Reliability | null {
  if (!data) return null;
  const r: Reliability = { technicalFailures: 0, unknownEffectManualRepair: 0, systemChecksPending: 0, systemChecksOverdue: 0, failedActions: 0, humanWaits: 0, policyBlocks: 0, excluded: 0, quality: 'Not assessed', items: [], provenanceKnown: cases !== undefined };
  if (!cases) return r; // provenance unknown: no live claims
  const known = new Set(cases.map(c => c.id));
  const fictional = new Set(cases.filter(c => c.offlineSample || c.fictionalOfflineIdentity).map(c => c.id));
  const summaries = new Map((data.caseSummaries ?? []).map(s => [s.caseId, s]));
  for (const s of data.caseSummaries ?? []) { if (/^S\d+$/.test(s.label)) fictional.add(s.caseId); known.add(s.caseId); }
  const live = (caseId: number, prov?: string) => {
    const ok = known.has(caseId) && !fictional.has(caseId) && prov !== 'simulated' && prov !== 'simulation';
    if (!ok) r.excluded++;
    return ok;
  };
  const ref = (id: number) => summaries.get(id)?.label ?? `Case #${id}`;
  const seen = new Set<string>();
  const push = (i: Omit<ReliabilityItem, 'reference'>) => { if (!seen.has(i.key)) { seen.add(i.key); r.items.push({ ...i, reference: ref(i.caseId) }); } };
  for (const n of data.notifications) {
    if (!live(n.caseId, n.provenance)) continue;
    const st = String(n.status);
    const base = { key: notificationKey(n.id), caseId: n.caseId, href: n.caseHref, title: n.title, source: String(n.source), actor: n.initiator || 'actor not recorded', owner: null as string | null };
    if (n.source === 'persisted-communication') {
      if (st === 'failed') { r.technicalFailures++; push({ ...base, status: 'Failed', impact: 'Message not delivered per recorded status', nextStep: 'Review the communication on the case' }); }
      else if (st === 'sending') { r.unknownEffectManualRepair++; push({ ...base, status: 'In progress — outcome unknown (not a proven timeout)', impact: 'Delivery outcome not yet recorded', nextStep: 'Wait for a recorded outcome' }); }
      else if (st === 'unknown_effect_manual_repair') { r.unknownEffectManualRepair++; push({ ...base, status: 'Unknown effect — manual repair', impact: 'Effect on the recipient cannot be confirmed', nextStep: 'Manual repair on the case' }); }
    } else if (n.source === 'recorded-system-check') {
      if (st === 'pending') { r.systemChecksPending++; push({ ...base, status: 'Awaiting provider (not a technical failure)', impact: 'Check result not yet recorded', nextStep: 'Await recorded provider result' }); }
      else if (st === 'overdue') { r.systemChecksOverdue++; push({ ...base, status: 'Check overdue', impact: 'Recorded check past its due time', nextStep: 'Follow up on the check' }); }
    }
  }
  for (const c of data.completed) {
    if (c.status !== 'failed' || !live(c.caseId)) continue;
    // Same explicit identity as an already-listed communication: do not double count.
    if (seen.has(notificationKey(c.id))) continue;
    r.failedActions++;
    push({ key: `completed:${c.id}`, caseId: c.caseId, href: c.caseHref, title: c.summary, source: 'completed action', actor: c.actor || 'actor not recorded', status: 'Action failed (record-level)', impact: 'Not a whole-case outcome', owner: null, nextStep: 'Open case history' });
  }
  for (const a of data.approvals) {
    if (a.status !== 'pending' || retainedOffline(a, data) || !live(a.caseId)) continue;
    const hard = a.hitlPattern === 'hard-block';
    if (hard) r.policyBlocks++; else r.humanWaits++;
    push({ key: `approval:${a.id}`, caseId: a.caseId, href: approvalHref(a.id, a.caseId), title: a.recommendation, source: 'pending approval', actor: a.agent, status: hard ? 'Policy block (not a technical failure)' : 'Waiting on a human (not a technical failure)', impact: 'Work paused by design', owner: null, nextStep: 'Decision in Action Center' });
  }
  return r;
}
