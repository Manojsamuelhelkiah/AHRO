import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, CheckCircle2, ClipboardCheck, FileCheck2, RefreshCw, ShieldCheck, UserRoundCheck, UsersRound } from 'lucide-react';
import { Button, cn, LoadingBlock } from '@/components/ui-shared';
import { getEarlyTenureCase, getEarlyTenureOwnerOptions, postEarlyTenure, postOutcomeEvidence, type EarlyTenureAssignment, type EarlyTenureCase, type EarlyTenureOwnerOption, type EmploymentOutcomeEvidenceWriteResponse } from '../../../lib/early-tenure-api';
import { probationTiming, type ProbationDisposition } from '../../../lib/early-tenure-probation';

const queryKey = (caseId: number) => ['early-tenure-case', caseId] as const;
const completeStates = new Set(['complete', 'completed', 'verified', 'acknowledged', 'delivered']);

function displayDate(value?: string | null) {
  if (!value) return 'Not scheduled';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(parsed);
}

function displayDateTime(value?: string | null) {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
}

function localDateTimeValue(value = new Date()) {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function statusClass(status: string) {
  return completeStates.has(status.toLowerCase())
    ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]'
    : ['blocked', 'failed', 'overdue'].includes(status.toLowerCase())
      ? 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)]'
      : 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]';
}

function friendlyStatus(status: string) {
  return status.replace(/[-_]/g, ' ');
}

export function EarlyTenurePanel({ caseId, joiningDate }: { caseId: number; joiningDate?: string | null }) {
  const client = useQueryClient();
  const [actualJoiningDate, setActualJoiningDate] = useState('');
  const [expandedAssignment, setExpandedAssignment] = useState<string | number | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKey(caseId),
    queryFn: () => getEarlyTenureCase(caseId),
    retry: false,
    staleTime: 15_000,
  });

  const refresh = () => client.invalidateQueries({ queryKey: queryKey(caseId) });
  const enroll = useMutation({
    mutationFn: () => postEarlyTenure<unknown>(`/cases/${caseId}/enroll`),
    onSuccess: () => { setNotice({ ok: true, text: 'Early-tenure plan enrolled. Review each evidence requirement before treating work as complete.' }); void refresh(); },
    onError: (caught: any) => setNotice({ ok: false, text: caught?.message || 'The early-tenure plan could not be enrolled.' }),
  });
  const anchor = useMutation({
    mutationFn: () => postEarlyTenure<unknown>(`/cases/${caseId}/joining-anchor`, { actualJoinedAt: actualJoiningDate, expectedAnchorRevision: data?.snapshot?.anchorRevision ?? 0 }),
    onSuccess: () => { setNotice({ ok: true, text: 'Actual joining was recorded. Only incomplete future work was rescheduled.' }); setActualJoiningDate(''); void refresh(); },
    onError: (caught: any) => setNotice({ ok: false, text: caught?.message || 'Actual joining could not be recorded.' }),
  });

  if (isLoading) return <LoadingBlock>Loading early-tenure plan…</LoadingBlock>;
  if (isError) {
    const restricted = (error as any)?.status === 403 || (error as any)?.response?.status === 403;
    return (
      <section className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3"><AlertTriangle className="mt-0.5 h-5 w-5 text-[var(--status-amber)]" /><div><h2 className="text-base font-bold">Early tenure</h2><p className="mt-1 text-sm text-[var(--text-muted)]">{restricted ? 'This early-tenure record is restricted by your authority assignment.' : 'The early-tenure record could not be loaded. Existing final-readiness status is unchanged.'}</p></div></div>
          {!restricted && <Button variant="outline" onClick={() => void refetch()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>}
        </div>
      </section>
    );
  }

  if (!data?.snapshot) {
    return (
      <section className="space-y-5">
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div><div className="flex items-center gap-2"><CalendarClock className="h-5 w-5 text-[var(--primary)]" /><h2 className="text-base font-bold text-[var(--text-primary)]">Early tenure</h2></div><p className="mt-2 max-w-2xl text-sm text-[var(--text-secondary)]">No early-tenure plan has been enrolled. A plan creates evidence-backed induction, compliance, buddy, manager, and policy check-in work anchored to actual joining—not final readiness.</p></div>
            <Button disabled={enroll.isPending} onClick={() => enroll.mutate()}>{enroll.isPending ? 'Enrolling…' : 'Enroll plan'}</Button>
          </div>
          {notice && <Notice notice={notice} />}
        </div>
        <RestrictedOutcomeEvidence caseId={caseId} />
      </section>
    );
  }

  return (
    <section aria-labelledby="early-tenure-heading" className="space-y-5">
      <div className="rounded-[var(--radius-lg)] border border-[var(--primary)]/30 bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div><div className="flex flex-wrap items-center gap-2"><CalendarClock className="h-5 w-5 text-[var(--primary)]" /><h2 id="early-tenure-heading" className="text-lg font-bold text-[var(--text-primary)]">Early tenure plan</h2><span className="rounded-full bg-[var(--primary-light)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--primary)]">Policy v{data.snapshot.policyVersion ?? '—'}</span></div><p className="mt-2 text-sm text-[var(--text-secondary)]">The planned joining date is never treated as actual employment. Final-readiness controls remain separate and unchanged.</p></div>
          <div className="grid grid-cols-2 gap-x-5 gap-y-2 text-xs"><Metric label="Planned joining" value={displayDate(data.snapshot.plannedJoiningAt ?? joiningDate)} /><Metric label="Actual joining" value={data.snapshot.actualJoinedAt ? displayDate(data.snapshot.actualJoinedAt) : 'Not recorded'} /><Metric label="Policy check-ins" value={`${data.checkIns.length} scheduled`} /><Metric label="Probation policy" value={data.snapshot.probationLengthDays ? `${data.snapshot.probationLengthDays} days` : 'Not configured'} /></div>
        </div>
      </div>

      <div className="rounded-[var(--radius-lg)] border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-4"><div className="flex gap-3"><AlertTriangle className="mt-0.5 h-5 w-5 text-[var(--status-amber-fg)]" /><div className="min-w-0 flex-1"><h3 className="font-bold text-[var(--status-amber-fg)]">{data.snapshot.actualJoinedAt ? 'Correct actual joining' : 'Confirm actual joining before rescheduling'}</h3><p className="mt-1 text-sm text-[var(--status-amber-fg)]">{data.snapshot.actualJoinedAt ? `Current recorded anchor: ${displayDate(data.snapshot.actualJoinedAt)}. A correction is revision-checked and only supersedes eligible incomplete future work; completed evidence stays historical.` : 'Recording actual joining safely supersedes incomplete future work only; completed evidence stays historical.'}</p><div className="mt-3 flex flex-col gap-2 sm:flex-row"><input aria-label="Actual joining date" type="date" value={actualJoiningDate} onChange={(event) => setActualJoiningDate(event.target.value)} className="h-9 rounded-[var(--radius-md)] border border-[var(--status-amber)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)]" /><Button size="sm" disabled={!actualJoiningDate || anchor.isPending} onClick={() => anchor.mutate()}>{anchor.isPending ? 'Recording…' : data.snapshot.actualJoinedAt ? 'Save actual-joining correction' : 'Record actual joining'}</Button></div></div></div></div>
      {notice && <Notice notice={notice} />}
      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <AssignmentList caseId={caseId} assignments={data.assignments} expanded={expandedAssignment} onToggle={setExpandedAssignment} onUpdated={refresh} />
        <div className="space-y-5"><CheckInList caseId={caseId} checkIns={data.checkIns} onUpdated={refresh} /><ProbationDecisionPanel caseId={caseId} plan={data} onUpdated={refresh} /><RestrictedOutcomeEvidence caseId={caseId} /></div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">{label}</p><p className="mt-0.5 font-semibold text-[var(--text-primary)]">{value}</p></div>;
}

function Notice({ notice }: { notice: { ok: boolean; text: string } }) {
  return <p role={notice.ok ? 'status' : 'alert'} className={cn('mt-4 rounded-[var(--radius-md)] p-3 text-sm', notice.ok ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]' : 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)]')}>{notice.text}</p>;
}

function AssignmentList({ caseId, assignments, expanded, onToggle, onUpdated }: { caseId: number; assignments: EarlyTenureAssignment[]; expanded: string | number | null; onToggle: (id: string | number | null) => void; onUpdated: () => void }) {
  const owners = useQuery({ queryKey: ['early-tenure-owner-options', caseId], queryFn: () => getEarlyTenureOwnerOptions(caseId), retry: false, staleTime: 60_000 });
  return <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]"><div className="border-b border-[var(--border)] p-4"><div className="flex items-center gap-2"><ClipboardCheck className="h-4 w-4 text-[var(--primary)]" /><h3 className="font-bold">Evidence-backed obligations</h3></div><p className="mt-1 text-xs text-[var(--text-muted)]">Induction, compliance and learning require source-confirmed or explicit human evidence.</p></div><div className="divide-y divide-[var(--border)]">{assignments.length ? assignments.map((assignment) => <AssignmentRow key={assignment.id} assignment={assignment} ownerOptions={owners.data ?? []} ownersLoading={owners.isLoading} ownerOptionsError={owners.isError} expanded={expanded === assignment.id} onToggle={() => onToggle(expanded === assignment.id ? null : assignment.id)} onUpdated={onUpdated} />) : <p className="p-4 text-sm text-[var(--text-muted)]">No applicable obligations are in this policy snapshot.</p>}</div></div>;
}

function AssignmentRow({ assignment, ownerOptions, ownersLoading, ownerOptionsError, expanded, onToggle, onUpdated }: { assignment: EarlyTenureAssignment; ownerOptions: EarlyTenureOwnerOption[]; ownersLoading: boolean; ownerOptionsError: boolean; expanded: boolean; onToggle: () => void; onUpdated: () => void }) {
  const [ownerUserId, setOwnerUserId] = useState(assignment.ownerUserId ?? '');
  const [buddyUserId, setBuddyUserId] = useState(assignment.buddyUserId ?? '');
  const [dueAt, setDueAt] = useState(assignment.dueAt?.slice(0, 10) ?? '');
  const [reference, setReference] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const ownerIsCurrentTenantMember = ownerOptions.some((member) => member.userId === ownerUserId);
  const buddyIsCurrentTenantMember = ownerOptions.some((member) => member.userId === buddyUserId);
  const needsBuddyAssignment = assignment.kind === 'buddy-acknowledgement';
  const isCurrentPending = assignment.status.toLowerCase() === 'pending';
  const assignmentDueAt = assignment.dueAt ? new Date(assignment.dueAt) : null;
  const canRescheduleFuture = isCurrentPending && assignmentDueAt !== null && !Number.isNaN(assignmentDueAt.getTime()) && assignmentDueAt.getTime() > Date.now();
  const revisionTaskDetails = needsBuddyAssignment
    ? { buddyAssignment: 'assigned', buddyUserId }
    : assignment.kind === 'manager-connect'
      ? { structuredAgenda: assignment.structuredAgenda ?? [] }
      : undefined;
  const revise = useMutation({ mutationFn: () => postEarlyTenure<unknown>(`/assignments/${assignment.id}/revise`, { ownerName: ownerUserId, ownerUserId, dueAt, expectedRevision: assignment.revision ?? 1, ...(revisionTaskDetails ? { taskDetails: revisionTaskDetails } : {}) }), onSuccess: () => { setNotice('Future assignment revision recorded.'); onUpdated(); }, onError: (error: any) => setNotice(error?.message || 'Revision could not be saved.') });
  const assignOwner = useMutation({ mutationFn: () => postEarlyTenure<unknown>(`/assignments/${assignment.id}/owner`, { expectedRevision: assignment.revision ?? 1, ownerUserId, ...(needsBuddyAssignment ? { buddyUserId } : {}) }), onSuccess: () => { setNotice('Owner handoff recorded. The due date was preserved.'); onUpdated(); }, onError: (error: any) => setNotice(error?.message || 'Owner could not be assigned.') });
  const evidence = useMutation({ mutationFn: () => postEarlyTenure<unknown>(`/assignments/${assignment.id}/evidence`, { evidenceReference: reference, provenance: 'human-authorized', observedAt: new Date().toISOString() }), onSuccess: () => { setReference(''); setNotice('Evidence submitted for verification.'); onUpdated(); }, onError: (error: any) => setNotice(error?.message || 'Evidence could not be submitted.') });
  return <div className="p-4">
    <button type="button" onClick={onToggle} className="flex w-full items-start justify-between gap-3 text-left">
      <div><p className="font-semibold text-[var(--text-primary)]">{assignment.label}</p><p className="mt-1 text-xs text-[var(--text-muted)]">Owner: {assignment.owner || assignment.ownerUserId || 'Explicit human owner required'} · Due {displayDate(assignment.dueAt)}{assignment.revision ? ` · rev ${assignment.revision}` : ''}</p></div>
      <span className={cn('shrink-0 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide', statusClass(assignment.status))}>{friendlyStatus(assignment.status)}</span>
    </button>
    {assignment.buddyAssignment && <p className="mt-2 text-xs text-[var(--text-secondary)]">Buddy: {assignment.buddyAssignment}. Acknowledgement still needs evidence.</p>}
    {assignment.connectorStatus && <p className="mt-2 text-xs text-[var(--text-secondary)]">Connector: {friendlyStatus(assignment.connectorStatus)}. This is not completion evidence.</p>}
    {assignment.reminderStatus && <p className="mt-2 text-xs text-[var(--text-secondary)]">Reminder: {friendlyStatus(assignment.reminderStatus)}.</p>}
    {expanded && <div className="mt-4 grid gap-4 border-t border-[var(--border)] pt-4">
      {assignment.structuredAgenda?.length ? <div className="rounded-[var(--radius-md)] bg-[var(--primary-light)]/30 p-3"><p className="text-xs font-bold text-[var(--text-primary)]">Structured manager-connect agenda</p><ul className="mt-1 list-disc pl-4 text-xs text-[var(--text-secondary)]">{assignment.structuredAgenda.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
      <div><p className="text-xs font-bold uppercase tracking-wide text-[var(--text-muted)]">Dated evidence</p>{assignment.evidence?.length ? <ul className="mt-2 space-y-1 text-xs text-[var(--text-secondary)]">{assignment.evidence.map((item) => <li key={item.id} className="rounded bg-[var(--surface-alt)] p-2">{displayDate(item.occurredAt)} · {item.source || 'Human evidence'}{item.reference ? ` · ${item.reference}` : ''}</li>)}</ul> : <p className="mt-2 text-sm text-[var(--text-muted)]">No completion evidence recorded.</p>}</div>
      <div className="grid gap-3">
        <label className="text-xs font-semibold text-[var(--text-secondary)]">Owner tenant member
          <select aria-label="Owner tenant member" value={ownerUserId} onChange={(event) => setOwnerUserId(event.target.value)} disabled={ownersLoading || ownerOptionsError} className="mt-1 h-9 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm">
            <option value="">{ownersLoading ? 'Loading members…' : ownerOptionsError ? 'Members unavailable' : 'Select current member'}</option>
            {ownerOptions.map((member) => <option key={member.userId} value={member.userId}>{member.userId} · {member.role}</option>)}
          </select>
        </label>
      </div>
      {needsBuddyAssignment && <label className="text-xs font-semibold text-[var(--text-secondary)]">Assigned buddy tenant member
        <select aria-label="Assigned buddy tenant member" value={buddyUserId} onChange={(event) => setBuddyUserId(event.target.value)} disabled={ownersLoading || ownerOptionsError} className="mt-1 h-9 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm">
          <option value="">{ownersLoading ? 'Loading members…' : ownerOptionsError ? 'Members unavailable' : 'Select assigned buddy'}</option>
          {ownerOptions.map((member) => <option key={member.userId} value={member.userId}>{member.userId} · {member.role}</option>)}
        </select>
        <span className="mt-1 block font-normal text-[var(--text-muted)]">A buddy acknowledgement can only be revised to assigned when this current tenant member is selected.</span>
      </label>}
      {ownerOptionsError && <p role="alert" className="text-xs text-[var(--status-red)]">Current tenant members could not be loaded. Reload before revising ownership.</p>}
      {isCurrentPending && <div className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-[var(--text-secondary)]">Owner handoff preserves the current due date ({displayDate(assignment.dueAt)}), including Day-0 and overdue work.</p><Button size="sm" variant="outline" disabled={!ownerIsCurrentTenantMember || (needsBuddyAssignment && !buddyIsCurrentTenantMember) || ownersLoading || ownerOptionsError || assignOwner.isPending} onClick={() => assignOwner.mutate()}>{assignOwner.isPending ? 'Assigning…' : assignment.ownerUserId ? 'Change owner' : 'Assign owner'}</Button></div>}
      {canRescheduleFuture && <div className="grid gap-3 rounded-[var(--radius-md)] border border-[var(--border)] p-3 sm:grid-cols-[minmax(0,1fr)_auto]"><label className="text-xs font-semibold text-[var(--text-secondary)]">New due date<input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} className="mt-1 h-9 w-full rounded border border-[var(--border)] px-2 text-sm" /></label><Button size="sm" variant="outline" className="self-end" disabled={!ownerIsCurrentTenantMember || !dueAt || (needsBuddyAssignment && !buddyIsCurrentTenantMember) || ownersLoading || ownerOptionsError || revise.isPending} onClick={() => revise.mutate()}>{revise.isPending ? 'Saving…' : 'Reschedule future work'}</Button></div>}
      {assignment.kind === 'compliance-training' && <div className="rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-3"><p className="text-xs font-bold text-[var(--text-primary)]">Compliance enrollment and completion</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{assignment.sourceConfirmationRequired ? `Enrollment and completion must be confirmed by the configured ${assignment.requiredConnectorKey || 'trusted'} connector. A browser entry cannot replace source confirmation.` : 'Record the authorized enrollment/completion evidence reference below. This explicit human record is distinct from a reminder or a claimed connector result.'}</p></div>}
      {assignment.sourceConfirmationRequired ? <p className="text-xs text-[var(--text-muted)]">Completion remains pending until the configured trusted source confirms it.</p> : <div className="flex flex-col gap-2 sm:flex-row"><input aria-label={assignment.kind === 'compliance-training' ? 'Compliance enrollment or completion evidence reference' : 'Human-authorized evidence reference'} value={reference} onChange={(event) => setReference(event.target.value)} placeholder={assignment.kind === 'compliance-training' ? 'Authorized compliance enrollment/completion reference' : 'Human-authorized evidence reference'} className="h-9 min-w-0 flex-1 rounded border border-[var(--border)] px-2 text-sm" /><Button size="sm" disabled={!reference || evidence.isPending} onClick={() => evidence.mutate()}>{evidence.isPending ? 'Submitting…' : assignment.kind === 'compliance-training' ? 'Record compliance evidence' : 'Submit evidence'}</Button></div>}
      {notice && <p role="status" className="text-xs text-[var(--text-secondary)]">{notice}</p>}
    </div>}
  </div>;
}

function CheckInList({ caseId, checkIns, onUpdated }: { caseId: number; checkIns: EarlyTenureCase['checkIns']; onUpdated: () => void }) {
  const [reference, setReference] = useState('');
  const [openId, setOpenId] = useState<string | number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ownerSelections, setOwnerSelections] = useState<Record<string, string>>({});
  const owners = useQuery({ queryKey: ['early-tenure-owner-options', caseId], queryFn: () => getEarlyTenureOwnerOptions(caseId), retry: false, staleTime: 60_000 });
  const complete = useMutation({ mutationFn: (checkIn: EarlyTenureCase['checkIns'][number]) => postEarlyTenure<unknown>(`/checkins/${checkIn.id}/complete`, { expectedRevision: checkIn.revision ?? 1, evidenceReference: reference, completedAt: new Date().toISOString() }), onSuccess: () => { setNotice('Check-in completion evidence recorded.'); setReference(''); setOpenId(null); onUpdated(); }, onError: (error: any) => setNotice(error?.message || 'Check-in could not be completed.') });
  const assignOwner = useMutation({
    mutationFn: ({ checkIn, ownerUserId }: { checkIn: EarlyTenureCase['checkIns'][number]; ownerUserId: string }) => postEarlyTenure<unknown>(`/checkins/${checkIn.id}/owner`, { expectedRevision: checkIn.revision ?? 1, ownerUserId }),
    onSuccess: () => { setNotice('Check-in owner assigned through a new revision.'); onUpdated(); },
    onError: (error: any) => setNotice(error?.message || 'Check-in owner could not be assigned.'),
  });
  return <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)]"><div className="flex items-center gap-2"><UsersRound className="h-4 w-4 text-[var(--primary)]" /><h3 className="font-bold">Policy check-ins</h3></div><p className="mt-1 text-xs text-[var(--text-muted)]">30/60/90 is a policy cadence, not a legal probation assumption.</p><div className="mt-4 space-y-3">{checkIns.length ? checkIns.map((checkIn) => {
    const selectionKey = String(checkIn.id);
    const ownerUserId = ownerSelections[selectionKey] ?? checkIn.ownerUserId ?? '';
    const ownerIsCurrentTenantMember = (owners.data ?? []).some((member) => member.userId === ownerUserId);
    return <div key={checkIn.id} className="rounded-[var(--radius-md)] border border-[var(--border)] p-3"><button type="button" onClick={() => setOpenId(openId === checkIn.id ? null : checkIn.id)} className="flex w-full items-center justify-between gap-3 text-left"><div><p className="text-sm font-semibold">{checkIn.label}</p><p className="text-xs text-[var(--text-muted)]">Due {displayDate(checkIn.dueAt)}{checkIn.ownerUserId ? ` · owner ${checkIn.ownerUserId}` : ' · owner not assigned'}{checkIn.reminderStatus ? ` · reminder ${friendlyStatus(checkIn.reminderStatus)}` : ''}</p>{checkIn.evidence?.length ? <p className="mt-1 text-xs text-[var(--text-secondary)]">Completion evidence: {checkIn.evidence.map((item) => item.reference || 'recorded').join(', ')}</p> : null}</div><span className={cn('rounded-full px-2 py-1 text-[10px] font-bold uppercase', statusClass(checkIn.status))}>{friendlyStatus(checkIn.status)}</span></button>{openId === checkIn.id && !completeStates.has(checkIn.status.toLowerCase()) && <div className="mt-3 flex flex-col gap-3 border-t border-[var(--border)] pt-3"><div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"><label className="text-xs font-semibold text-[var(--text-secondary)]">Check-in owner<select aria-label={`${checkIn.label} owner`} value={ownerUserId} onChange={(event) => setOwnerSelections((current) => ({ ...current, [selectionKey]: event.target.value }))} disabled={owners.isLoading || owners.isError || assignOwner.isPending} className="mt-1 h-9 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"><option value="">{owners.isLoading ? 'Loading members…' : owners.isError ? 'Members unavailable' : 'Select current member'}</option>{(owners.data ?? []).map((member) => <option key={member.userId} value={member.userId}>{member.userId} · {member.role}</option>)}</select></label><Button size="sm" variant="outline" className="self-end" disabled={!ownerIsCurrentTenantMember || owners.isLoading || owners.isError || assignOwner.isPending} onClick={() => assignOwner.mutate({ checkIn, ownerUserId })}>{assignOwner.isPending ? 'Assigning…' : 'Assign owner'}</Button></div>{owners.isError && <p role="alert" className="text-xs text-[var(--status-red)]">Current tenant members could not be loaded. Reload before assigning ownership.</p>}<div className="flex flex-col gap-2 sm:flex-row"><input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Check-in evidence reference" className="h-9 rounded border border-[var(--border)] px-2 text-sm" /><Button size="sm" disabled={!reference || complete.isPending} onClick={() => complete.mutate(checkIn)}>{complete.isPending ? 'Recording…' : 'Record completed check-in'}</Button></div></div>}</div>;
  }) : <p className="text-sm text-[var(--text-muted)]">No policy check-ins are configured.</p>}</div>{notice && <p role="status" className="mt-3 text-xs text-[var(--text-secondary)]">{notice}</p>}</div>;
}

function ProbationDecisionPanel({ caseId, plan, onUpdated }: { caseId: number; plan: EarlyTenureCase; onUpdated: () => void }) {
  const [disposition, setDisposition] = useState<ProbationDisposition>('confirmed');
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [effectiveAt, setEffectiveAt] = useState(() => localDateTimeValue());
  const [extensionEndsAt, setExtensionEndsAt] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const timing = probationTiming({
    actualJoinedAt: plan.snapshot?.actualJoinedAt,
    maturityAt: plan.probation?.maturityAt,
    governedEndAt: plan.probation?.governedEndAt,
    effectiveAt,
    extensionEndsAt,
    disposition,
  });
  const decision = useMutation({
    mutationFn: () => postEarlyTenure<unknown>('/probation-decisions', {
      caseId,
      expectedSnapshotVersion: plan.snapshot?.snapshotVersion ?? 1,
      expectedAnchorRevision: plan.snapshot?.anchorRevision ?? 0,
      expectedDecisionVersion: plan.probationDecision?.decisionVersion ?? 0,
      disposition,
      effectiveAt: new Date(effectiveAt).toISOString(),
      rationale: note,
      evidenceReference: reference,
      ...(disposition === 'extended' ? { extensionEndsAt: new Date(extensionEndsAt).toISOString() } : {}),
    }),
    onSuccess: () => {
      setNotice('Decision submitted for authority validation.');
      setNote('');
      setReference('');
      setEffectiveAt(localDateTimeValue());
      setExtensionEndsAt('');
      onUpdated();
    },
    onError: (error: any) => setNotice(error?.message || 'Decision was not accepted. Confirm your current authority and reload.'),
  });
  const prior = plan.probationDecision;
  const stale = prior?.stale === true || (prior?.anchorRevision != null && prior.anchorRevision !== plan.snapshot?.anchorRevision);
  const hasCurrentExtension = Boolean(plan.probation?.governedEndAt && plan.probation.governedEndAt !== plan.probation.maturityAt);
  return <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)]">
    {prior?.disposition && <div className={cn('mb-4 rounded-[var(--radius-md)] p-3', stale ? 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]' : 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]')}><div className="flex gap-2"><ShieldCheck className="h-5 w-5" /><div><h3 className="font-bold">{stale ? 'Prior probation decision needs review' : 'Human probation decision recorded'}</h3><p className="mt-1 text-sm">{friendlyStatus(prior.disposition)} · {displayDateTime(prior.decidedAt)}</p><p className="mt-1 text-xs">Authority: {prior.authority || 'validated by service'}{prior.extensionEndsAt ? ` · Extension end ${displayDateTime(prior.extensionEndsAt)}` : ''}{stale ? ' · Actual joining changed after this decision. Record a fresh authorized review below.' : ''}</p></div></div></div>}
    <div className="flex gap-2"><UserRoundCheck className="h-4 w-4 text-[var(--primary)]" /><div><h3 className="font-bold">{prior?.disposition ? 'Record a reviewed probation update' : 'Human probation decision'}</h3><p className="mt-1 text-xs text-[var(--text-muted)]">Only a currently authorized human may record confirmation, extension, or another reviewed disposition. The agent cannot make an adverse employment decision.</p></div></div>
    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-3 text-xs"><Metric label="Policy maturity" value={displayDateTime(plan.probation?.maturityAt)} /><Metric label={hasCurrentExtension ? 'Current extension end' : 'Current governed end'} value={displayDateTime(plan.probation?.governedEndAt)} /></div>
    <div className="mt-3 space-y-3">
      <select value={disposition} onChange={(event) => setDisposition(event.target.value as ProbationDisposition)} className="h-9 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"><option value="confirmed">Confirmation</option><option value="extended">Extension</option><option value="reviewed-other">Reviewed other</option></select>
      <label className="block text-xs font-semibold text-[var(--text-secondary)]">Reviewed effective date and time<input type="datetime-local" value={effectiveAt} onChange={(event) => setEffectiveAt(event.target.value)} aria-label="Reviewed effective date and time" className="mt-1 h-9 w-full rounded border border-[var(--border)] px-2 text-sm" /></label>
      {disposition === 'extended' && <label className="block text-xs font-semibold text-[var(--text-secondary)]">Extension end date and time<input type="datetime-local" value={extensionEndsAt} onChange={(event) => setExtensionEndsAt(event.target.value)} aria-label="Extension end date and time" className="mt-1 h-9 w-full rounded border border-[var(--border)] px-2 text-sm" /></label>}
      {!timing.canSubmit && <p role="status" className="rounded-[var(--radius-md)] bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--status-amber-fg)]">{timing.message}</p>}
      {disposition === 'confirmed' && timing.canSubmit && <p className="text-xs text-[var(--text-muted)]">Confirmation is available because the reviewed effective time is at or after the current governed probation end.</p>}
      <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Decision rationale" className="min-h-20 w-full rounded border border-[var(--border)] p-2 text-sm" />
      <input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Dated decision evidence reference" className="h-9 w-full rounded border border-[var(--border)] px-2 text-sm" />
      <Button size="sm" disabled={!timing.canSubmit || !note || !reference || decision.isPending} onClick={() => decision.mutate()}>{decision.isPending ? 'Submitting…' : prior?.disposition ? 'Submit reviewed update' : 'Submit for authority validation'}</Button>
      {notice && <p role="status" className="text-xs text-[var(--text-secondary)]">{notice}</p>}
    </div>
  </div>;
}

function RestrictedOutcomeEvidence({ caseId }: { caseId: number }) {
  const [surveyScore, setSurveyScore] = useState('');
  const [surveySubmittedAt, setSurveySubmittedAt] = useState('');
  const [surveyReference, setSurveyReference] = useState('');
  const [employmentStatus, setEmploymentStatus] = useState<'active' | 'terminated' | 'unknown'>('active');
  const [actualJoinedAt, setActualJoinedAt] = useState('');
  const [effectiveAt, setEffectiveAt] = useState('');
  const [observedAt, setObservedAt] = useState('');
  const [employmentReference, setEmploymentReference] = useState('');
  const [correctsEvidenceId, setCorrectsEvidenceId] = useState('');
  const [createdEmploymentEvidenceId, setCreatedEmploymentEvidenceId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const toIso = (value: string) => new Date(value).toISOString();
  const survey = useMutation({
    mutationFn: () => postOutcomeEvidence<null>('/surveys', { caseId, surveyKind: 'onboarding-30-day', voluntary: true, score: Number(surveyScore), submittedAt: toIso(surveySubmittedAt), evidenceReference: surveyReference }),
    onSuccess: () => { setSurveyScore(''); setSurveySubmittedAt(''); setSurveyReference(''); setNotice({ ok: true, text: 'Restricted voluntary survey evidence was recorded. Individual responses remain unavailable in this case workspace.' }); },
    onError: (error: any) => setNotice({ ok: false, text: error?.message || 'Survey evidence was not accepted. A current HR compliance authority, one trustworthy actual-start record, and a submission at least 30 days after that start are required.' }),
  });
  const employment = useMutation({
    mutationFn: () => postOutcomeEvidence<EmploymentOutcomeEvidenceWriteResponse>('/employment', { caseId, actualJoinedAt: toIso(actualJoinedAt), employmentStatus, observedAt: toIso(observedAt), evidenceReference: employmentReference, ...(employmentStatus === 'terminated' ? { effectiveAt: toIso(effectiveAt) } : {}), ...(employmentStatus === 'active' && correctsEvidenceId ? { correctsEvidenceId: Number(correctsEvidenceId) } : {}) }),
    onSuccess: (response) => { setActualJoinedAt(''); setEffectiveAt(''); setObservedAt(''); setEmploymentReference(''); setCorrectsEvidenceId(''); setCreatedEmploymentEvidenceId(response.evidenceId); setNotice({ ok: true, text: 'Restricted employment outcome evidence was recorded. Individual outcome values remain unavailable in this case workspace.' }); },
    onError: (error: any) => setNotice({ ok: false, text: error?.message || 'Employment outcome evidence was not accepted. Check dates and your current HR compliance authority.' }),
  });
  const validSurveyScore = surveyScore !== '' && Number.isInteger(Number(surveyScore)) && Number(surveyScore) >= 0 && Number(surveyScore) <= 10;
  const validEmploymentDates = Boolean(actualJoinedAt && observedAt && employmentReference && (employmentStatus !== 'terminated' || effectiveAt) && (!correctsEvidenceId || (employmentStatus === 'active' && Number.isInteger(Number(correctsEvidenceId)) && Number(correctsEvidenceId) > 0)));
  return <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)]"><div className="flex gap-2"><FileCheck2 className="h-4 w-4 text-[var(--primary)]" /><div><h3 className="font-bold">Restricted outcome evidence</h3><p className="mt-1 text-xs text-[var(--text-muted)]">Authorized human entry only. Submitted values are append-only and never returned to this case workspace.</p></div></div><div className="mt-3 space-y-4"><form onSubmit={(event) => { event.preventDefault(); survey.mutate(); }} className="rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-3"><p className="text-xs font-bold text-[var(--text-primary)]">30-day voluntary survey</p><p className="mt-1 text-xs text-[var(--text-secondary)]">Record only a voluntary onboarding-30-day response verified by your current HR compliance authority. The API also requires exactly one trustworthy actual employment-start record already on this case and a submission at least 30 days after that start. Browser entry is always human-authorized; it cannot claim provider provenance.</p><div className="mt-3 grid gap-2 sm:grid-cols-2"><label className="text-xs font-semibold text-[var(--text-secondary)]">Score (0–10)<input aria-label="Voluntary survey score from 0 through 10" type="number" min="0" max="10" step="1" value={surveyScore} onChange={(event) => setSurveyScore(event.target.value)} className="mt-1 h-9 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" /></label><label className="text-xs font-semibold text-[var(--text-secondary)]">Submitted at<input aria-label="Survey submitted at" type="datetime-local" value={surveySubmittedAt} onChange={(event) => setSurveySubmittedAt(event.target.value)} className="mt-1 h-9 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" /></label></div><label className="mt-2 block text-xs font-semibold text-[var(--text-secondary)]">Restricted evidence reference<input value={surveyReference} onChange={(event) => setSurveyReference(event.target.value)} placeholder="Verified survey record reference" className="mt-1 h-9 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" /></label><Button type="submit" size="sm" className="mt-3" disabled={!validSurveyScore || !surveySubmittedAt || !surveyReference || survey.isPending}>{survey.isPending ? 'Recording…' : 'Record voluntary survey'}</Button></form><form onSubmit={(event) => { event.preventDefault(); employment.mutate(); }} className="rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-3"><p className="text-xs font-bold text-[var(--text-primary)]">Employment outcome</p><p className="mt-1 text-xs text-[var(--text-secondary)]">Use dated actual employment start—not planned joining. A termination needs an effective date; active/unknown evidence must not include one. This entry is human-authorized, never claimed HRIS/provider data.</p><div className="mt-3 grid gap-2 sm:grid-cols-2"><label className="text-xs font-semibold text-[var(--text-secondary)]">Actual joined at<input aria-label="Actual employment start" type="datetime-local" value={actualJoinedAt} onChange={(event) => setActualJoinedAt(event.target.value)} className="mt-1 h-9 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" /></label><label className="text-xs font-semibold text-[var(--text-secondary)]">Observed at<input aria-label="Employment observation time" type="datetime-local" value={observedAt} onChange={(event) => setObservedAt(event.target.value)} className="mt-1 h-9 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" /></label><label className="text-xs font-semibold text-[var(--text-secondary)]">Employment status<select value={employmentStatus} onChange={(event) => { const next = event.target.value as 'active' | 'terminated' | 'unknown'; setEmploymentStatus(next); if (next !== 'active') setCorrectsEvidenceId(''); }} className="mt-1 h-9 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"><option value="active">Active</option><option value="terminated">Terminated</option><option value="unknown">Unknown</option></select></label>{employmentStatus === 'terminated' && <label className="text-xs font-semibold text-[var(--text-secondary)]">Termination effective at<input aria-label="Termination effective time" type="datetime-local" value={effectiveAt} onChange={(event) => setEffectiveAt(event.target.value)} className="mt-1 h-9 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" /></label>}{employmentStatus === 'active' && <label className="text-xs font-semibold text-[var(--text-secondary)]">Corrects prior termination evidence ID (optional)<input aria-label="Prior termination evidence ID to correct" type="number" min="1" step="1" value={correctsEvidenceId} onChange={(event) => setCorrectsEvidenceId(event.target.value)} placeholder="ID returned by an earlier write" className="mt-1 h-9 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" /></label>}</div><label className="mt-2 block text-xs font-semibold text-[var(--text-secondary)]">Restricted evidence reference<input value={employmentReference} onChange={(event) => setEmploymentReference(event.target.value)} placeholder="Verified HR record reference" className="mt-1 h-9 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" /></label><Button type="submit" size="sm" className="mt-3" disabled={!validEmploymentDates || employment.isPending}>{employment.isPending ? 'Recording…' : 'Record employment outcome'}</Button>{createdEmploymentEvidenceId !== null && <p role="status" className="mt-2 text-xs text-[var(--text-secondary)]">Employment evidence recorded with ID {createdEmploymentEvidenceId}. Retain this ID only if a later active correction must explicitly reverse this case’s prior termination; no evidence history is displayed here.</p>}</form>{notice && <Notice notice={notice} />}<p className="text-[11px] leading-relaxed text-[var(--text-muted)]">This form does not display past survey scores, respondent details, actual join dates, employment statuses, source records, or authorities. Analytics receives only tenant-scoped aggregate projections subject to privacy suppression.</p></div></div>;
}