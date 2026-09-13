import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { recordConsultationMilestone, recordIntegrationAction, recordWorkerObjection, type ConsultationMilestone, type IntegrationAction, type WorkforceTransferProgram } from '@/lib/workforce-transfers-api';
import { Button, Input, Label } from '@/components/ui-shared';
import { MutationError, RefreshButton, Section, WorkerPicker, dateLabel, humanize, selectClass, useProgramWorkers } from './shared';

type MilestoneForm = { milestoneId?: number; jurisdiction: string; kind: string; dueAt: string; completedAt: string; status: ConsultationMilestone['status']; evidenceReference: string };
type ActionForm = { actionId?: string; kind: IntegrationAction['kind']; ownerUserId: string; dueAt: string; completedAt: string; status: IntegrationAction['status']; evidenceReference: string; legalApprovalReference: string };
const milestoneStatuses: MilestoneForm['status'][] = ['planned', 'communicated', 'completed', 'blocked'];
const actionKinds: IntegrationAction['kind'][] = ['induction', 'integration', 'harmonisation', 'contingency-parallel-run'];
const actionStatuses: ActionForm['status'][] = ['planned', 'in-progress', 'completed', 'blocked'];
const objectionOutcomes = ['pending', 'objected', 'withdrawn', 'resolved'] as const;
const blankMilestone = (country: string): MilestoneForm => ({ jurisdiction: country, kind: '', dueAt: '', completedAt: '', status: 'planned', evidenceReference: '' });
const blankAction = (): ActionForm => ({ kind: 'induction', ownerUserId: '', dueAt: '', completedAt: '', status: 'planned', evidenceReference: '', legalApprovalReference: '' });
const dateInput = (value: string | null) => value ? value.slice(0, 10) : '';

export function OperationsSection({ program }: { program: WorkforceTransferProgram }) {
  const client = useQueryClient();
  const invalidate = () => client.invalidateQueries({ queryKey: ['workforce-transfers', 'program', program.id] });
  const { workers, isLoading: loadingWorkers, errors } = useProgramWorkers(program);
  const [milestone, setMilestone] = useState<MilestoneForm>(() => blankMilestone(program.countries[0] ?? ''));
  const [integration, setIntegration] = useState<ActionForm>(blankAction);
  const [objection, setObjection] = useState<{ workerId: string; outcome: typeof objectionOutcomes[number]; receivedAt: string; evidenceReference: string }>({ workerId: '', outcome: 'pending', receivedAt: '', evidenceReference: '' });
  const selectedWorker = workers.find((worker) => worker.id === objection.workerId);
  const milestoneMutation = useMutation({
    mutationFn: () => recordConsultationMilestone(program.id, { ...milestone, expectedVersion: program.version, completedAt: milestone.status === 'completed' ? milestone.completedAt : undefined }),
    onSuccess: () => { invalidate(); setMilestone(blankMilestone(program.countries[0] ?? '')); },
  });
  const integrationMutation = useMutation({
    mutationFn: () => recordIntegrationAction(program.id, {
      expectedVersion: program.version, ...(integration.actionId ? { actionId: integration.actionId } : {}), kind: integration.kind, ownerUserId: integration.ownerUserId, dueAt: integration.dueAt, status: integration.status,
      ...(integration.status === 'completed' ? { completedAt: integration.completedAt } : {}),
      ...(integration.evidenceReference ? { evidenceReference: integration.evidenceReference } : {}),
      ...(integration.legalApprovalReference ? { legalApprovalReference: integration.legalApprovalReference } : {}),
    }),
    onSuccess: () => { invalidate(); setIntegration(blankAction()); },
  });
  const objectionMutation = useMutation({
    mutationFn: () => recordWorkerObjection(objection.workerId, { expectedWorkerVersion: selectedWorker!.version, outcome: objection.outcome, receivedAt: objection.receivedAt, evidenceReference: objection.evidenceReference }),
    onSuccess: () => { invalidate(); client.invalidateQueries({ queryKey: ['workforce-transfers', 'population'] }); },
  });
  const editMilestone = (item: ConsultationMilestone, complete = false) => setMilestone({ milestoneId: item.id, jurisdiction: item.jurisdiction, kind: item.kind, dueAt: dateInput(item.dueAt), completedAt: dateInput(item.completedAt), status: complete ? 'completed' : item.status, evidenceReference: '' });
  const editAction = (item: IntegrationAction, complete = false) => setIntegration({ actionId: item.id, kind: item.kind, ownerUserId: item.ownerUserId, dueAt: dateInput(item.dueAt), completedAt: dateInput(item.completedAt), status: complete ? 'completed' : item.status, evidenceReference: '', legalApprovalReference: '' });

  return <div className="space-y-6">
    <Section title="Consultation milestones" description="Update or complete the existing stable milestone record. Submitting an edit records a server-side supersession rather than a duplicate.">
      <div className="space-y-2">{program.consultation.length ? program.consultation.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-sm"><div><strong>{item.kind}</strong><span className="ml-2">{item.jurisdiction}</span><span className="ml-2 text-xs text-[var(--text-muted)]">{humanize(item.status)} · due {dateLabel(item.dueAt)}{item.completedAt ? ` · completed ${dateLabel(item.completedAt)}` : ''}</span></div><div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={() => editMilestone(item)}>Update</Button>{item.status !== 'completed' && <Button type="button" size="sm" onClick={() => editMilestone(item, true)}>Complete</Button>}</div></div>) : <p className="text-sm text-[var(--text-muted)]">No consultation milestones recorded.</p>}</div>
      <form className="grid grid-cols-1 md:grid-cols-3 gap-4" onSubmit={(event) => { event.preventDefault(); milestoneMutation.mutate(); }}>
        <Field label="Jurisdiction"><select className={selectClass} value={milestone.jurisdiction} onChange={(e) => setMilestone((p) => ({ ...p, jurisdiction: e.target.value }))}>{program.countries.map((country) => <option key={country} value={country}>{country}</option>)}</select></Field>
        <Field label="Milestone"><Input required value={milestone.kind} onChange={(e) => setMilestone((p) => ({ ...p, kind: e.target.value }))} /></Field>
        <Field label="Due date"><Input required type="date" value={milestone.dueAt} onChange={(e) => setMilestone((p) => ({ ...p, dueAt: e.target.value }))} /></Field>
        <Field label="Status"><select className={selectClass} value={milestone.status} onChange={(e) => setMilestone((p) => ({ ...p, status: e.target.value as MilestoneForm['status'] }))}>{milestoneStatuses.map((status) => <option key={status} value={status}>{humanize(status)}</option>)}</select></Field>
        {milestone.status === 'completed' && <Field label="Completed date"><Input required type="date" value={milestone.completedAt} onChange={(e) => setMilestone((p) => ({ ...p, completedAt: e.target.value }))} /></Field>}
        <Field label="Evidence reference"><Input required value={milestone.evidenceReference} onChange={(e) => setMilestone((p) => ({ ...p, evidenceReference: e.target.value }))} /></Field>
        <div className="flex items-end gap-2"><Button disabled={milestoneMutation.isPending}>{milestoneMutation.isPending ? 'Saving…' : milestone.milestoneId ? 'Update milestone' : 'Record milestone'}</Button>{milestone.milestoneId && <Button type="button" variant="outline" onClick={() => setMilestone(blankMilestone(program.countries[0] ?? ''))}>Cancel</Button>}</div>
      </form><MutationError error={milestoneMutation.error} />
    </Section>
    <Section title="Integration actions" description="Update or complete an action in place; updates are retained as supersessions. Completion dates are recorded facts, never inferred from creation time. A completed contingency / parallel-run action with evidence is required for Go.">
      <div className="space-y-2">{program.integrationActions.length ? program.integrationActions.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-sm"><div><strong className="capitalize">{humanize(item.kind)}</strong><span className="ml-2 text-xs text-[var(--text-muted)]">{humanize(item.status)} · owner {item.ownerUserId} · due {dateLabel(item.dueAt)}{item.completedAt ? ` · completed ${dateLabel(item.completedAt)}` : ''}{item.policyApprovedAt ? ` · Legal approved ${dateLabel(item.policyApprovedAt)}` : ''} · evidence {item.evidenceRecorded ? 'recorded' : 'not recorded'}</span></div><div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={() => editAction(item)}>Update</Button>{item.status !== 'completed' && <Button type="button" size="sm" onClick={() => editAction(item, true)}>Complete</Button>}</div></div>) : <p className="text-sm text-[var(--text-muted)]">No integration actions recorded.</p>}</div>
      <form className="grid grid-cols-1 md:grid-cols-3 gap-4" onSubmit={(event) => { event.preventDefault(); integrationMutation.mutate(); }}>
        <Field label="Action type"><select className={selectClass} value={integration.kind} onChange={(e) => setIntegration((p) => ({ ...p, kind: e.target.value as IntegrationAction['kind'] }))}>{actionKinds.map((kind) => <option key={kind} value={kind}>{humanize(kind)}</option>)}</select></Field>
        <Field label="Owner user ID"><Input required value={integration.ownerUserId} onChange={(e) => setIntegration((p) => ({ ...p, ownerUserId: e.target.value }))} /></Field>
        <Field label="Due date"><Input required type="date" value={integration.dueAt} onChange={(e) => setIntegration((p) => ({ ...p, dueAt: e.target.value }))} /></Field>
        <Field label="Status"><select className={selectClass} value={integration.status} onChange={(e) => setIntegration((p) => ({ ...p, status: e.target.value as ActionForm['status'] }))}>{actionStatuses.map((status) => <option key={status} value={status}>{humanize(status)}</option>)}</select></Field>
        {integration.status === 'completed' && <Field label="Actual completion date"><Input required type="date" value={integration.completedAt} onChange={(e) => setIntegration((p) => ({ ...p, completedAt: e.target.value }))} /></Field>}
        <Field label={`Evidence reference ${integration.kind === 'contingency-parallel-run' && integration.status === 'completed' ? '(required)' : '(optional)'}`}><Input required={integration.kind === 'contingency-parallel-run' && integration.status === 'completed'} value={integration.evidenceReference} onChange={(e) => setIntegration((p) => ({ ...p, evidenceReference: e.target.value }))} /></Field>
        {integration.kind === 'harmonisation' && <Field label="Legal policy approval reference"><Input required value={integration.legalApprovalReference} onChange={(e) => setIntegration((p) => ({ ...p, legalApprovalReference: e.target.value }))} /><p className="text-xs text-[var(--text-muted)]">Must match a current Legal pathway approval; the server records its approval receipt.</p></Field>}
        <div className="flex items-end gap-2"><Button disabled={integrationMutation.isPending}>{integrationMutation.isPending ? 'Saving…' : integration.actionId ? 'Update action' : 'Record action'}</Button>{integration.actionId && <Button type="button" variant="outline" onClick={() => setIntegration(blankAction())}>Cancel</Button>}</div>
      </form><MutationError error={integrationMutation.error} />
    </Section>
    <Section title="Worker objections" description="Choose a worker from the live population list; the worker's current version is sent with this restricted update.">
      {loadingWorkers ? <p className="text-sm text-[var(--text-muted)]">Loading workers…</p> : <form className="grid grid-cols-1 md:grid-cols-2 gap-4" onSubmit={(event) => { event.preventDefault(); objectionMutation.mutate(); }}>
        <WorkerPicker workers={workers} value={objection.workerId} onChange={(workerId) => setObjection((p) => ({ ...p, workerId }))} />
        <Field label="Outcome"><select className={selectClass} value={objection.outcome} onChange={(e) => setObjection((p) => ({ ...p, outcome: e.target.value as typeof objection.outcome }))}>{objectionOutcomes.map((outcome) => <option key={outcome} value={outcome}>{outcome}</option>)}</select></Field>
        <Field label="Received date"><Input required type="date" value={objection.receivedAt} onChange={(e) => setObjection((p) => ({ ...p, receivedAt: e.target.value }))} /></Field>
        <Field label="Evidence reference"><Input required value={objection.evidenceReference} onChange={(e) => setObjection((p) => ({ ...p, evidenceReference: e.target.value }))} /></Field>
        <Button disabled={!selectedWorker || objectionMutation.isPending}>{objectionMutation.isPending ? 'Saving…' : 'Record objection'}</Button>
      </form>}<MutationError error={errors[0] || objectionMutation.error} />
    </Section><RefreshButton programId={program.id} />
  </div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <div className="space-y-1"><Label>{label}</Label>{children}</div>; }