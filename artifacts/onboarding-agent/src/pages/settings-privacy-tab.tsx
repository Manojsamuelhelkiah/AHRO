import React, { useState } from 'react';
import { ShieldCheck, ShieldAlert, Plus, Trash2, Edit2, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import { Card, CardContent, Button, Badge, Label, cn } from '@/components/ui-shared';
import { useGetLifecyclePolicies, useUpdateLifecyclePolicy, useListLifecycleDeletionJobs, useRetryDeletionJob, type RetentionPolicy } from '../hooks/use-privacy-api';

const SENSITIVE_DATA_CLASSES = [
  "candidate-document",
  "identity",
  "medical",
  "payroll",
  "bgv",
  "candidate-contact",
  "candidate-voice",
  "candidate-portal",
];

export function PrivacyAdministrationCard() {
  const { data, isLoading, error } = useGetLifecyclePolicies();
  const [editingPolicy, setEditingPolicy] = useState<RetentionPolicy | null>(null);

  if (isLoading) return <div className="text-sm text-[var(--text-muted)] animate-pulse">Loading privacy policies...</div>;
  if (error) return <div className="text-sm text-[var(--status-red-fg)] flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> {(error as any).message}</div>;

  const policies = data?.policies || [];

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-[var(--shadow-sm)] p-6 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-[var(--text-normal)] flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-[var(--primary)]" />
            Sensitive Lifecycle Policies
          </h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            Configure approved retention policies and permitted providers.
          </p>
        </div>
        <Button variant="outline" onClick={() => setEditingPolicy({
          dataClass: 'candidate-document',
          purpose: '',
          jurisdiction: '',
          lawfulBasis: '',
          retentionDays: Number.NaN,
          providerSharingApproved: false,
          permittedProviders: [],
          policyReference: '',
          approvalReference: '',
          expectedRevision: 0
        })}>
          <Plus className="w-4 h-4 mr-2" /> Add Policy
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {policies.length === 0 && !editingPolicy && (
          <div className="p-8 text-center text-sm text-[var(--text-muted)] bg-[var(--surface-alt)] border border-[var(--border)] rounded-[var(--radius-md)]">
            No retention policies defined.
          </div>
        )}

        {editingPolicy && (
          <PolicyEditor 
            policy={editingPolicy} 
            onCancel={() => setEditingPolicy(null)}
            onSave={() => setEditingPolicy(null)}
          />
        )}

        {policies.map(policy => (
          <Card key={`${policy.dataClass}-${policy.jurisdiction}-${policy.revision}`} className="overflow-hidden">
            <CardContent className="p-5 flex flex-col md:flex-row gap-6 bg-[var(--surface-sunken)]">
              <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1 block">Class & Jurisdiction</Label>
                  <div className="text-sm font-medium text-[var(--text-normal)]">
                    <Badge variant="outline" className="mr-2 border-[var(--primary)] text-[var(--primary-dark)]">{policy.dataClass}</Badge>
                    {policy.jurisdiction}
                  </div>
                </div>
                <div>
                  <Label className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1 block">Retention Period</Label>
                  <div className="text-sm font-medium text-[var(--text-normal)]">
                    {policy.retentionDays} days
                  </div>
                </div>
                <div>
                  <Label className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1 block">Purpose & Lawful Basis</Label>
                  <div className="text-sm text-[var(--text-normal)]">{policy.purpose} &bull; {policy.lawfulBasis}</div>
                </div>
                <div>
                  <Label className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1 block">Provider Sharing</Label>
                  <div className="text-sm text-[var(--text-normal)]">
                    {policy.providerSharingApproved ? (
                      <span className="text-[var(--status-green-fg)] flex items-center gap-1 text-xs font-semibold">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Approved
                      </span>
                    ) : (
                      <span className="text-[var(--text-muted)] text-xs">Not Approved</span>
                    )}
                  </div>
                </div>
                <div className="md:col-span-2 flex items-center justify-between">
                  <div>
                    <Label className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1 block">Policy / Approval References</Label>
                    <div className="text-xs font-mono text-[var(--text-muted)]">
                      {policy.policyReference || 'N/A'} / {policy.approvalReference || 'N/A'}
                    </div>
                  </div>
                  <div className="text-xs text-[var(--text-muted)] mt-4">Rev. {policy.revision}</div>
                </div>
              </div>
              <div className="flex items-start">
                <Button variant="ghost" size="sm" onClick={() => setEditingPolicy({
                  ...policy,
                  expectedRevision: policy.revision,
                })}>
                  <Edit2 className="w-4 h-4 mr-2" /> Revise
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <DeletionJobsSection />
    </div>
  );
}

function DeletionJobsSection() {
  const { data, isLoading, error } = useListLifecycleDeletionJobs();
  const retryJob = useRetryDeletionJob();

  if (isLoading) return null;
  if (error) return <p role="alert" className="mt-4 text-sm text-[var(--status-red-fg)]">Deletion jobs could not be loaded: {error.message}</p>;
  
  const jobs = data?.jobs || [];
  if (jobs.length === 0) return null;

  return (
    <div className="mt-12 space-y-4">
      <h3 className="text-lg font-semibold text-[var(--text-normal)]">Deletion Jobs</h3>
      {retryJob.error && <p role="alert" className="text-sm text-[var(--status-red-fg)]">{retryJob.error.message}</p>}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-[var(--shadow-sm)] overflow-x-auto">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-[var(--surface-sunken)] border-b border-[var(--border)] text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider">
            <tr>
              <th className="px-4 py-3">Job ID</th>
              <th className="px-4 py-3">Class</th>
              <th className="px-4 py-3">Record</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Attempts</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] text-[var(--text-normal)]">
            {jobs.map((job) => (
              <tr key={job.id}>
                <td className="px-4 py-3 font-mono text-xs">{job.id}</td>
                <td className="px-4 py-3 text-xs">{job.dataClass}</td>
                <td className="px-4 py-3 font-mono text-xs">{job.recordId?.startsWith("case-derived-envelope:") ? "Case and derived records" : job.recordKind}: {job.recordId}</td>
                <td className="px-4 py-3">
                  <Badge variant="outline" className={cn(
                    job.status === 'failed' ? 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)] border-[var(--status-red-fg)]' :
                    job.status === 'completed' ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)] border-[var(--status-green-fg)]' :
                    job.status === 'processing' ? 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] border-[var(--status-amber-fg)]' :
                    'bg-[var(--surface-alt)] text-[var(--text-muted)] border-[var(--border)]'
                  )}>
                    {job.status}
                  </Badge>
                  {job.lastError && (
                    <div className="text-[10px] text-[var(--status-red-fg)] mt-1 whitespace-normal break-words max-w-[200px] flex items-start gap-1">
                      <AlertTriangle className="w-3 h-3 shrink-0" />
                      {job.lastError}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-xs">{job.attempts}</td>
                <td className="px-4 py-3">
                  {job.status === 'failed' && (
                    <Button variant="outline" size="sm" onClick={() => retryJob.mutate(job.id)} disabled={retryJob.isPending}>
                      <RefreshCw className={cn("w-3 h-3 mr-2", retryJob.isPending && "animate-spin")} />
                      Retry
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PolicyEditor({ policy, onCancel, onSave }: { policy: RetentionPolicy, onCancel: () => void, onSave: () => void }) {
  const [draft, setDraft] = useState<RetentionPolicy>(policy);
  const [errorMsg, setErrorMsg] = useState('');
  const updatePolicy = useUpdateLifecyclePolicy();

  const handleSave = () => {
    setErrorMsg('');
    if (!Number.isInteger(draft.retentionDays) || draft.retentionDays < 0) {
      setErrorMsg('Enter the retention period from the approved policy. No default period is assumed.');
      return;
    }
    updatePolicy.mutate(draft, {
      onSuccess: () => onSave(),
      onError: (err: any) => setErrorMsg(err.message)
    });
  };

  return (
    <Card className="border-[var(--primary)] border-2">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-[var(--text-normal)]">
            {policy.revision !== undefined ? `Revise Policy (Current: v${policy.revision})` : 'New Policy'}
          </h3>
        </div>

        {errorMsg && (
          <div className="p-3 bg-[var(--status-red-bg)] text-[var(--status-red-fg)] text-sm rounded-md border border-[var(--status-red-fg)]">
            {errorMsg}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label className="text-xs mb-1 block">Data Class</Label>
            <select 
              value={draft.dataClass}
              onChange={e => setDraft({...draft, dataClass: e.target.value})}
              className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3 text-sm"
              disabled={policy.revision !== undefined} // Cannot change class on revision
            >
              {SENSITIVE_DATA_CLASSES.map(dc => <option key={dc} value={dc}>{dc}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-xs mb-1 block">Jurisdiction</Label>
            <input 
              value={draft.jurisdiction}
              onChange={e => setDraft({...draft, jurisdiction: e.target.value})}
              className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3 text-sm"
              disabled={policy.revision !== undefined}
            />
          </div>
          
          <div>
            <Label className="text-xs mb-1 block">Retention Days</Label>
            <input 
              type="number"
              value={Number.isFinite(draft.retentionDays) ? draft.retentionDays : ''}
              onChange={e => setDraft({...draft, retentionDays: e.target.value === '' ? Number.NaN : Number(e.target.value)})}
              className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3 text-sm"
            />
          </div>
          <div>
            <Label className="text-xs mb-1 block">Provider Sharing Approved</Label>
            <select 
              value={draft.providerSharingApproved ? 'true' : 'false'}
              onChange={e => setDraft({...draft, providerSharingApproved: e.target.value === 'true'})}
              className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3 text-sm"
            >
              <option value="false">No</option>
              <option value="true">Yes</option>
            </select>
          </div>

          <div>
            <Label className="text-xs mb-1 block">Purpose</Label>
            <input 
              value={draft.purpose}
              onChange={e => setDraft({...draft, purpose: e.target.value})}
              className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3 text-sm"
            />
          </div>
          <div>
            <Label className="text-xs mb-1 block">Lawful Basis</Label>
            <input 
              value={draft.lawfulBasis}
              onChange={e => setDraft({...draft, lawfulBasis: e.target.value})}
              className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3 text-sm"
            />
          </div>

          <div>
            <Label className="text-xs mb-1 block">Policy Reference</Label>
            <input 
              value={draft.policyReference}
              onChange={e => setDraft({...draft, policyReference: e.target.value})}
              className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3 text-sm"
            />
          </div>
          <div>
            <Label className="text-xs mb-1 block">Approval Reference</Label>
            <input 
              value={draft.approvalReference}
              onChange={e => setDraft({...draft, approvalReference: e.target.value})}
              className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3 text-sm"
            />
          </div>
          <div className="md:col-span-2">
            <Label className="text-xs mb-1 block">Permitted Providers (comma-separated)</Label>
            <input 
              value={(draft.permittedProviders || []).join(', ')}
              onChange={e => setDraft({...draft, permittedProviders: e.target.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)})}
              className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3 text-sm"
              placeholder="e.g., gmail, twilio-whatsapp"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-[var(--border)]">
          <Button variant="outline" onClick={onCancel} disabled={updatePolicy.isPending}>Cancel</Button>
          <Button onClick={handleSave} disabled={updatePolicy.isPending}>
            {updatePolicy.isPending ? 'Saving...' : 'Save Policy'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
