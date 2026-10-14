import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';
import { Button, Badge, IconTile, LoadingBlock, PageHeader, cn } from '@/components/ui-shared';
import { useOrganizationRole } from '@/hooks/use-organization-role';
import { listTenantMembers, type TenantMember } from '@/lib/workforce-policy-api';
import { AlertTriangle, Check, FlaskConical, RefreshCw, ShieldCheck, X } from 'lucide-react';

type LearningPolicy = {
  schemaVersion?: 'workforce-step-runtime/v1';
  timing: { anchor: 'joining-date'; offsetDays: number };
  sequence?: string[];
  steps?: Array<{
    id: string;
    label: string;
    responsibleRole?: string;
    assignedTo?: string | null;
    mandatory?: boolean;
    evidenceRequired?: boolean;
    nonblocking?: boolean;
    prerequisites?: string[];
    parallelGroup?: string | null;
    permittedChannels?: Array<'manager-led'>;
    timing?: {
      anchor?: 'joining-date';
      notBeforeOffsetDays?: number;
      dueOffsetDays?: number;
      escalation?: { offsetDays: number; responsibleRole: string; assignedTo?: string | null };
    };
  }>;
  channel: 'manager-led';
  ownership: string;
};
type Recommendation = {
  id: number;
  status: 'proposed' | 'accepted' | 'rejected';
  recommendation: {
    type: 'cohort-learning-default';
    target: { profileId: string; expectedProfileVersion: number; profileName: string; priority: number };
    learning: LearningPolicy;
    rationale: string;
  };
  evidenceSnapshot: {
    methodologyVersion: string;
    cohortDefinition: string;
    outcomeDefinition: string;
    window: { startedAt: string; endedAt: string; days: number };
    sample: { candidateCases: number; verifiedOutcomes: number; excludedDemoOrSimulation: number; missingOutcomeEvidence: number };
    outcome: { meanDaysToVerifiedReadiness: number; uncertainty95PercentDays: { low: number; high: number } | null; observedOutcomeDates: string[]; caseReferences: number[] };
    missingness: string[];
    uncertainty: string;
    evidenceFingerprint: string;
  };
  decisionNote: string | null;
  decidedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
};
type BroaderCompatibleCohortEvidence = {
  scope: 'same-tenant-compatible-profile';
  status: 'descriptive-only';
  notEligibleForPublication: true;
  target: { profileId: string; profileName: string; currentProfileVersion: number; exactCohortVerifiedOutcomes: number };
  cohortDefinition: string;
  compatibilityDefinition: string;
  outcomeDefinition: string;
  window: { startedAt: string; endedAt: string; days: number };
  sample: { candidateCases: number; verifiedOutcomes: number; excludedDemoOrSimulation: number; missingOutcomeEvidence: number };
  outcome: { meanDaysToVerifiedReadiness: number | null; uncertainty95PercentDays: { low: number; high: number } | null; observedOutcomeDates: string[]; caseReferences: number[] };
  missingness: string[];
  uncertainty: string;
};
type RecommendationsResponse = {
  asOf: string;
  methodologyVersion: string;
  window: { startedAt: string; endedAt: string; days: number };
  recommendations: Recommendation[];
  fallback: {
    status: 'insufficient-evidence';
    message: string;
    candidateCases: number;
    verifiedOutcomes: number;
    excludedDemoOrSimulation: number;
    missingOutcomeEvidence: number;
    broaderEvidence: BroaderCompatibleCohortEvidence[];
  } | null;
};

const key = (days: number) => ['onboarding', 'policy-recommendations', days] as const;
const input = 'mt-1 h-8 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-2 text-[var(--text-xs)] outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

function EvidenceCard({ recommendation }: { recommendation: Recommendation }) {
  const evidence = recommendation.evidenceSnapshot;
  const interval = evidence.outcome.uncertainty95PercentDays;
  return (
    <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-[var(--text-xs)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-[var(--text-primary)]">Verified, dated outcome evidence</p>
        <Badge className="bg-[var(--surface-soft)] text-[var(--text-secondary)] shadow-none">{evidence.methodologyVersion}</Badge>
      </div>
      <p className="mt-1 text-[var(--text-muted)]">{evidence.cohortDefinition}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        <Metric label="Verified outcomes" value={`${evidence.sample.verifiedOutcomes} / ${evidence.sample.candidateCases}`} />
        <Metric label="Excluded non-operational records" value={String(evidence.sample.excludedDemoOrSimulation)} />
        <Metric label="Missing outcome evidence" value={String(evidence.sample.missingOutcomeEvidence)} />
        <Metric label="Mean to verified readiness" value={`${evidence.outcome.meanDaysToVerifiedReadiness} days`} />
      </div>
      <p className="mt-3 text-[var(--text-muted)]">
        {interval ? `95% descriptive interval: ${interval.low}–${interval.high} days. ` : 'Too few observations to calculate an uncertainty interval. '}
        Outcome dates: {evidence.outcome.observedOutcomeDates.map((date) => new Date(date).toLocaleDateString()).join(', ')}.
      </p>
      <p className="mt-2 text-[var(--text-muted)]">{evidence.uncertainty}</p>
      <ul className="mt-2 list-disc space-y-1 pl-4 text-[var(--text-muted)]">
        {evidence.missingness.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded border border-[var(--border)] bg-[var(--surface)] p-2">
    <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
    <p className="mt-0.5 font-semibold text-[var(--text-primary)]">{value}</p>
  </div>;
}

function BroaderEvidenceCard({ evidence }: { evidence: BroaderCompatibleCohortEvidence }) {
  const interval = evidence.outcome.uncertainty95PercentDays;
  return <section className="mt-4 rounded-[var(--radius-md)] border border-[var(--status-amber)]/40 bg-[var(--surface)] p-3 text-[var(--text-xs)] text-[var(--text-secondary)]">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="font-semibold text-[var(--text-primary)]">Wider compatible cohort — descriptive only</p>
      <Badge className="bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] shadow-none">Not eligible for publication</Badge>
    </div>
    <p className="mt-1">{evidence.cohortDefinition}</p>
    <p className="mt-1 text-[var(--text-muted)]">{evidence.compatibilityDefinition}</p>
    <p className="mt-1 text-[var(--text-muted)]">Window: {new Date(evidence.window.startedAt).toLocaleDateString()}–{new Date(evidence.window.endedAt).toLocaleDateString()} ({evidence.window.days} days). Exact current v{evidence.target.currentProfileVersion} cohort: {evidence.target.exactCohortVerifiedOutcomes} verified outcomes.</p>
    <div className="mt-3 grid gap-2 sm:grid-cols-4">
      <Metric label="Verified outcomes" value={`${evidence.sample.verifiedOutcomes} / ${evidence.sample.candidateCases}`} />
      <Metric label="Excluded non-operational records" value={String(evidence.sample.excludedDemoOrSimulation)} />
      <Metric label="Missing outcome evidence" value={String(evidence.sample.missingOutcomeEvidence)} />
      <Metric label="Mean to verified readiness" value={evidence.outcome.meanDaysToVerifiedReadiness === null ? 'Not available' : `${evidence.outcome.meanDaysToVerifiedReadiness} days`} />
    </div>
    <p className="mt-3 text-[var(--text-muted)]">{interval ? `95% descriptive interval: ${interval.low}–${interval.high} days. ` : 'Too few observations to calculate an uncertainty interval. '}{evidence.uncertainty}</p>
    <ul className="mt-2 list-disc space-y-1 pl-4 text-[var(--text-muted)]">
      {evidence.missingness.map((item) => <li key={item}>{item}</li>)}
    </ul>
  </section>;
}

function RecommendationRow({ recommendation, canReview, members, onDecision }: {
  recommendation: Recommendation;
  canReview: boolean;
  members: TenantMember[];
  onDecision: (id: number, payload: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const [draft, setDraft] = useState<LearningPolicy>(recommendation.recommendation.learning);
  const isProposed = recommendation.status === 'proposed';
  const valid = Number.isInteger(draft.timing.offsetDays) && draft.timing.offsetDays >= -90 && draft.timing.offsetDays <= 180 &&
    ((draft.sequence !== undefined && draft.sequence.length > 0 && draft.sequence.every((step) => step.trim())) ||
      (draft.steps !== undefined && draft.steps.length > 0)) &&
    Boolean(draft.ownership.trim());
  const policy = editing ? draft : recommendation.recommendation.learning;
  const updateStep = (index: number, patch: Partial<NonNullable<LearningPolicy['steps']>[number]>) =>
    setDraft((current) => ({ ...current, steps: (current.steps ?? []).map((step, position) => position === index ? { ...step, ...patch } : step) }));
  const tone = recommendation.status === 'accepted'
    ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]'
    : recommendation.status === 'rejected'
      ? 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)]'
      : 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]';

  return <article className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-[var(--text-base)] text-[var(--text-primary)]">Learning default for {recommendation.recommendation.target.profileName}</h2>
          <Badge className={cn('shadow-none capitalize', tone)}>{recommendation.status}</Badge>
        </div>
        <p className="mt-1 text-[var(--text-xs)] text-[var(--text-muted)]">
          Profile v{recommendation.recommendation.target.expectedProfileVersion} · priority {recommendation.recommendation.target.priority} · proposed {new Date(recommendation.createdAt).toLocaleString()}
        </p>
        <p className="mt-2 text-[var(--text-sm)] text-[var(--text-secondary)]">{recommendation.recommendation.rationale}</p>
      </div>
      {isProposed && canReview && <Button size="sm" variant="secondary" onClick={() => setEditing((open) => !open)}>
        {editing ? 'Use proposed values' : 'Edit before accepting'}
      </Button>}
    </div>
    <div className="mt-4 grid gap-3 md:grid-cols-4">
      <PolicyField label="Timing anchor">
        <p>Joining date</p>
      </PolicyField>
      <PolicyField label="Deadline offset days">
        {editing ? <input className={input} type="number" min={-90} max={180} value={draft.timing.offsetDays} onChange={(e) => setDraft({ ...draft, timing: { ...draft.timing, offsetDays: Number(e.target.value) } })} /> : <p>{policy.timing.offsetDays}</p>}
      </PolicyField>
      <PolicyField label="Channel">
        <p>Manager-led</p>
      </PolicyField>
      <PolicyField label="Ownership">
        {editing ? <input className={input} value={draft.ownership} maxLength={120} onChange={(e) => setDraft({ ...draft, ownership: e.target.value })} /> : <p>{policy.ownership}</p>}
      </PolicyField>
    </div>
    <PolicyField label={policy.steps ? 'Executable human tasks' : 'Sequence'} className="mt-3">
      {editing && draft.sequence !== undefined ? <input className={input} value={draft.sequence.join(', ')} maxLength={1200} onChange={(e) => setDraft({ ...draft, sequence: e.target.value.split(',').map((step) => step.trim()).filter(Boolean) })} />
        : policy.sequence ? <ol className="mt-1 list-decimal pl-4 text-[var(--text-xs)] text-[var(--text-secondary)]">{policy.sequence.map((step) => <li key={step}>{step}</li>)}</ol>
          : <ol className="mt-1 list-decimal space-y-3 pl-4 text-[var(--text-xs)] text-[var(--text-secondary)]">{policy.steps?.map((step, index) => <li key={step.id}><span className="font-medium">{step.label}</span>{!editing ? <>{step.responsibleRole ? ` · ${step.responsibleRole}` : ''}{step.assignedTo ? ` · assigned to ${step.assignedTo}` : ''}{step.prerequisites?.length ? ` · after ${step.prerequisites.join(', ')}` : ''}{step.parallelGroup ? ` · parallel group ${step.parallelGroup}` : ''}{step.timing?.dueOffsetDays !== undefined ? ` · due day ${step.timing.dueOffsetDays}` : ''}</> : <div className="mt-2 grid grid-cols-1 gap-2 rounded border border-[var(--border)] bg-[var(--surface-alt)] p-2 sm:grid-cols-3">
            <input className={input} value={step.responsibleRole ?? ''} placeholder="Responsible role" onChange={(e) => updateStep(index, { responsibleRole: e.target.value || undefined })} />
            <select className={input} value={step.assignedTo ?? ''} onChange={(e) => updateStep(index, { assignedTo: e.target.value || null })}><option value="">Unassigned specialist</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.userId} · {member.role}</option>)}</select>
            <input className={input} value={(step.prerequisites ?? []).join(', ')} placeholder="Prerequisite IDs" onChange={(e) => updateStep(index, { prerequisites: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })} />
            <input className={input} value={step.parallelGroup ?? ''} placeholder="Parallel group" onChange={(e) => updateStep(index, { parallelGroup: e.target.value || null })} />
            <input className={input} type="number" value={step.timing?.notBeforeOffsetDays ?? ''} placeholder="Not before day" onChange={(e) => updateStep(index, { timing: { ...step.timing, anchor: 'joining-date', notBeforeOffsetDays: e.target.value === '' ? undefined : Number(e.target.value) } })} />
            <input className={input} type="number" value={step.timing?.dueOffsetDays ?? ''} placeholder="Due day" onChange={(e) => updateStep(index, { timing: { ...step.timing, anchor: 'joining-date', dueOffsetDays: e.target.value === '' ? undefined : Number(e.target.value) } })} />
            <input className={input} type="number" value={step.timing?.escalation?.offsetDays ?? ''} placeholder="Escalate day" onChange={(e) => updateStep(index, { timing: { ...step.timing, escalation: e.target.value === '' ? undefined : { offsetDays: Number(e.target.value), responsibleRole: step.timing?.escalation?.responsibleRole || step.responsibleRole || '' } } })} />
            <input className={input} value={step.timing?.escalation?.responsibleRole ?? ''} placeholder="Escalation role" onChange={(e) => updateStep(index, { timing: { ...step.timing, escalation: { offsetDays: step.timing?.escalation?.offsetDays ?? 0, responsibleRole: e.target.value, assignedTo: step.timing?.escalation?.assignedTo } } })} />
            <select className={input} value={step.timing?.escalation?.assignedTo ?? ''} onChange={(e) => updateStep(index, { timing: { ...step.timing, escalation: step.timing?.escalation ? { ...step.timing.escalation, assignedTo: e.target.value || null } : undefined } })}><option value="">Escalation assignee</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.userId}</option>)}</select>
            <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(step.mandatory)} onChange={(e) => updateStep(index, { mandatory: e.target.checked })} /> Mandatory</label><label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(step.evidenceRequired)} onChange={(e) => updateStep(index, { evidenceRequired: e.target.checked })} /> Evidence note</label><label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(step.nonblocking)} onChange={(e) => updateStep(index, { nonblocking: e.target.checked })} /> Nonblocking</label>
          </div>}</li>)}</ol>}
    </PolicyField>
    <EvidenceCard recommendation={recommendation} />
    {isProposed && canReview && <div className="mt-4 border-t border-[var(--border)] pt-4">
      <label className="text-[var(--text-xs)] font-semibold text-[var(--text-secondary)]">Review note (optional)</label>
      <textarea className="mt-1 min-h-16 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-2 text-[var(--text-xs)] outline-none focus:border-[var(--primary)]" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={!valid} onClick={() => onDecision(recommendation.id, {
          decision: 'accepted', decisionNote: note, expectedEvidenceFingerprint: recommendation.evidenceSnapshot.evidenceFingerprint,
          ...(editing ? { learning: draft } : {}),
        })} className="gap-1.5"><Check className="h-3.5 w-3.5" /> Accept & publish for future cases</Button>
        <Button size="sm" variant="outline" onClick={() => onDecision(recommendation.id, {
          decision: 'rejected', decisionNote: note, expectedEvidenceFingerprint: recommendation.evidenceSnapshot.evidenceFingerprint,
        })} className="gap-1.5 text-[var(--status-red)]"><X className="h-3.5 w-3.5" /> Reject</Button>
      </div>
      <p className="mt-2 text-[10px] text-[var(--text-muted)]">Only the connected manager-led workforce-step runtime is available. Accepting compiles these values into accountable human tasks for future matching cases; it cannot change open or completed cases or waive checklist controls.</p>
    </div>}
    {!isProposed && <p className="mt-4 border-t border-[var(--border)] pt-3 text-[var(--text-xs)] text-[var(--text-muted)]">
      Immutable decision {recommendation.decidedAt ? `recorded ${new Date(recommendation.decidedAt).toLocaleString()}` : 'recorded'}. {recommendation.decisionNote}
    </p>}
  </article>;
}

function PolicyField({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={className}><p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{label}</p><div className="text-[var(--text-xs)] text-[var(--text-primary)]">{children}</div></div>;
}

export function RecommendationsPage() {
  const [windowDays, setWindowDays] = useState(90);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const queryClient = useQueryClient();
  const { role, loading: roleLoading } = useOrganizationRole();
  const canReview = role === 'owner' || role === 'admin';
  const members = useQuery({ queryKey: ['onboarding', 'members'], queryFn: listTenantMembers, enabled: canReview });
  const query = useQuery({
    queryKey: key(windowDays),
    queryFn: () => customFetch<RecommendationsResponse>(`/api/onboarding/policy-recommendations?windowDays=${windowDays}`, { responseType: 'json', credentials: 'include' }),
  });
  const refresh = useMutation({
    mutationFn: () => customFetch<{ message: string }>('/api/onboarding/policy-recommendations/refresh', { method: 'POST', body: JSON.stringify({ windowDays }), responseType: 'json', credentials: 'include' }),
    onSuccess: (response) => { setNotice({ ok: true, message: response.message }); queryClient.invalidateQueries({ queryKey: key(windowDays) }); },
    onError: (error) => setNotice({ ok: false, message: errorMessage(error) }),
  });
  const decide = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Record<string, unknown> }) => customFetch(`/api/onboarding/policy-recommendations/${id}/decision`, { method: 'POST', body: JSON.stringify(payload), responseType: 'json', credentials: 'include' }),
    onSuccess: () => { setNotice({ ok: true, message: 'Decision recorded. Accepted values were published only as a future-case profile version.' }); queryClient.invalidateQueries({ queryKey: key(windowDays) }); },
    onError: (error) => setNotice({ ok: false, message: errorMessage(error) }),
  });
  const rows = useMemo(() => query.data?.recommendations ?? [], [query.data]);

  return <div className="mx-auto max-w-6xl space-y-6 pb-12">
    <PageHeader title="Learning Recommendations" subtitle="Cohort evidence is descriptive, reviewed by a human, and compiles only into future-case workforce tasks." />
    <section className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)]">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <IconTile icon={FlaskConical} className="bg-[var(--primary-light)] text-[var(--primary)] border-transparent" />
          <div><h2 className="font-semibold text-[var(--text-sm)] text-[var(--text-primary)]">Evidence window</h2><p className="mt-1 text-[var(--text-xs)] text-[var(--text-muted)]">Only non-demo cases with a dated, human-recorded final readiness outcome can enter analysis.</p></div>
        </div>
        <div className="flex items-center gap-2">
          <select aria-label="Evidence window" className="h-8 rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-[var(--text-xs)]" value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}>
            {[30, 90, 180, 365].map((days) => <option key={days} value={days}>Last {days} days</option>)}
          </select>
          {canReview && <Button size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending} className="gap-1.5"><RefreshCw className="h-3.5 w-3.5" /> {refresh.isPending ? 'Analyzing…' : 'Refresh evidence'}</Button>}
        </div>
      </div>
      {!roleLoading && !canReview && <p className="mt-3 text-[var(--text-xs)] text-[var(--text-muted)]">View only. An organization owner or admin must create and decide recommendations.</p>}
      {notice && <div role="status" className={cn('mt-3 flex gap-2 rounded p-3 text-[var(--text-xs)]', notice.ok ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]' : 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)]')}>
        {notice.ok ? <Check className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}<p>{notice.message}</p>
      </div>}
    </section>
    <section className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-alt)] p-4 text-[var(--text-xs)] text-[var(--text-secondary)]">
      <div className="flex gap-2"><ShieldCheck className="h-4 w-4 shrink-0 text-[var(--status-green)]" /><p><strong>Expert-authored starter guidance is separate.</strong> It is available in Policy Studio and is not presented as measured cohort evidence. This screen requires verified dates, reports missingness and uncertainty, and fails closed when evidence is sparse.</p></div>
    </section>
    {query.isLoading ? <LoadingBlock>Loading cohort evidence…</LoadingBlock> : query.isError ? <div role="alert" className="rounded border border-[var(--status-red)] bg-[var(--status-red-bg)] p-4 text-sm text-[var(--status-red-fg)]">{errorMessage(query.error)}</div> : <>
      {query.data?.fallback && <section className="rounded-[var(--radius-lg)] border border-[var(--status-amber)]/40 bg-[var(--status-amber-bg)] p-4 text-[var(--text-xs)] text-[var(--status-amber-fg)]"><div className="flex gap-2"><AlertTriangle className="h-4 w-4 shrink-0" /><div><p className="font-semibold">Transparent sparse-evidence fallback</p><p className="mt-1">{query.data.fallback.message}</p></div></div>{query.data.fallback.broaderEvidence.map((evidence) => <BroaderEvidenceCard key={`${evidence.target.profileId}:${evidence.target.currentProfileVersion}:${evidence.sample.candidateCases}`} evidence={evidence} />)}</section>}
      <div className="space-y-4">{rows.length ? rows.map((row) => <RecommendationRow key={row.id} recommendation={row} canReview={canReview} members={members.data ?? []} onDecision={(id, payload) => decide.mutate({ id, payload })} />) : <div className="rounded border border-dashed border-[var(--border-strong)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--text-muted)]">No evidence-backed recommendations have been created for review.</div>}</div>
    </>}
  </div>;
}