import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Edit2, PowerOff, Plus, ShieldCheck, Users, X } from 'lucide-react';
import { Badge, Button, IconTile, Label, LoadingBlock, cn } from '@/components/ui-shared';
import { useOrganizationRole } from '@/hooks/use-organization-role';
import {
  assignPolicyAuthority,
  listJobProfiles,
  listPolicyAuthorityMembers,
  listPolicyAuthorities,
  revokePolicyAuthority,
  saveJobProfile,
  type JobProfile,
  type JobProfileInput,
  type WorkforceContext,
  ORGANIZATION_AUTHORITY_SCOPE,
  hasExplicitWorkforceContext,
  updateWorkforceContext,
} from '@/lib/workforce-policy-api';

const inputCls = 'flex h-[32px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[6px] text-[var(--text-sm)] shadow-sm focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]';
const jobProfileKey = ['onboarding', 'job-profiles'];
const authorityKey = ['onboarding', 'policy-authorities'];

function contextText(context: WorkforceContext) {
  return [
    context.roleFamily && `Family: ${context.roleFamily}`,
    context.workEnvironment && `Environment: ${context.workEnvironment}`,
    context.site && `Site: ${context.site}`,
    context.workCountry && `Country: ${context.workCountry}`,
    context.payBasis && `Pay: ${context.payBasis}`,
  ].filter(Boolean);
}

function JobProfileEditor({ profile, onClose }: { profile: JobProfile | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<JobProfileInput>(() => profile
    ? { profileId: profile.profileId, expectedVersion: profile.version, name: profile.name, context: profile.context, enabled: profile.enabled }
    : { name: '', enabled: true, context: { workEnvironment: 'office' } });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({ mutationFn: (data: JobProfileInput) => saveJobProfile(data) });
  const setContext = (key: keyof WorkforceContext, value: string | boolean | string[] | undefined) =>
    setDraft((current) => ({ ...current, context: updateWorkforceContext(current.context, key, value) }));
  const submit = () => {
    setError(null);
    if (!draft.name.trim() || !hasExplicitWorkforceContext(draft.context)) {
      setError('Name and at least one explicit work-context fact are required.');
      return;
    }
    save.mutate({ ...draft, name: draft.name.trim() }, {
      onSuccess: () => { queryClient.invalidateQueries({ queryKey: jobProfileKey }); onClose(); },
      onError: (error: Error) => setError(error.message),
    });
  };
  return (
    <div className="mb-4 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-alt)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-bold text-[var(--text-primary)]">{profile ? `Edit ${profile.name} · v${profile.version + 1}` : 'New reusable job profile'}</h4>
        <Button variant="ghost" size="sm" onClick={onClose}><X className="h-4 w-4" /></Button>
      </div>
      <p className="mb-3 text-xs text-[var(--text-muted)]">Saved changes create a new version. Cases keep the version and policy snapshot selected when they were enrolled.</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div><Label>Name</Label><input className={cn(inputCls, 'mt-1')} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. Warehouse picker" /></div>
        <div><Label>Role family</Label><input className={cn(inputCls, 'mt-1')} value={draft.context.roleFamily ?? ''} onChange={(event) => setContext('roleFamily', event.target.value)} placeholder="Operations" /></div>
        <div><Label>Band</Label><input className={cn(inputCls, 'mt-1')} value={draft.context.band ?? ''} onChange={(event) => setContext('band', event.target.value)} placeholder="e.g. L3" /></div>
        <div><Label>Department</Label><input className={cn(inputCls, 'mt-1')} value={draft.context.department ?? ''} onChange={(event) => setContext('department', event.target.value)} /></div>
        <div><Label>Legal entity</Label><input className={cn(inputCls, 'mt-1')} value={draft.context.legalEntity ?? ''} onChange={(event) => setContext('legalEntity', event.target.value)} /></div>
        <div><Label>Work environment</Label><select className={cn(inputCls, 'mt-1')} value={draft.context.workEnvironment ?? ''} onChange={(event) => setContext('workEnvironment', event.target.value)}><option value="">Unknown</option><option value="office">Office</option><option value="remote">Remote</option><option value="site">Site</option><option value="field">Field</option><option value="mixed">Mixed</option></select></div>
        <div><Label>Country</Label><input className={cn(inputCls, 'mt-1')} value={draft.context.workCountry ?? ''} onChange={(event) => setContext('workCountry', event.target.value)} /></div>
        <div><Label>Site / facility</Label><input className={cn(inputCls, 'mt-1')} value={draft.context.site ?? ''} onChange={(event) => setContext('site', event.target.value)} /></div>
        <div><Label>Pay basis</Label><input className={cn(inputCls, 'mt-1')} value={draft.context.payBasis ?? ''} onChange={(event) => setContext('payBasis', event.target.value)} placeholder="salary or wage" /></div>
        <div><Label>Shift pattern</Label><input className={cn(inputCls, 'mt-1')} value={draft.context.shiftPattern ?? ''} onChange={(event) => setContext('shiftPattern', event.target.value)} /></div>
        <div><Label>Required licenses</Label><input className={cn(inputCls, 'mt-1')} value={(draft.context.requiredLicenses ?? []).join(', ')} onChange={(event) => setContext('requiredLicenses', event.target.value.split(','))} placeholder="Comma-separated" /></div>
        <div><Label>Hazards</Label><input className={cn(inputCls, 'mt-1')} value={(draft.context.hazards ?? []).join(', ')} onChange={(event) => setContext('hazards', event.target.value.split(','))} placeholder="Comma-separated" /></div>
        <div><Label>Hiring mode</Label><select className={cn(inputCls, 'mt-1')} value={draft.context.hiringMode ?? ''} onChange={(event) => setContext('hiringMode', event.target.value)}><option value="">Unknown</option><option value="individual">Individual</option><option value="batch">Batch</option><option value="seasonal">Seasonal</option></select></div>
        <div><Label>Assisted intake</Label><select className={cn(inputCls, 'mt-1')} value={draft.context.assistedIntake === undefined ? '' : String(draft.context.assistedIntake)} onChange={(event) => setContext('assistedIntake', event.target.value === '' ? undefined : event.target.value === 'true')}><option value="">Unknown</option><option value="true">Yes</option><option value="false">No</option></select></div>
        <div><Label>Site exposure</Label><select className={cn(inputCls, 'mt-1')} value={draft.context.siteExposure === undefined ? '' : String(draft.context.siteExposure)} onChange={(event) => setContext('siteExposure', event.target.value === '' ? undefined : event.target.value === 'true')}><option value="">Unknown</option><option value="true">Yes</option><option value="false">No</option></select></div>
        <div><Label>Safety-critical duties</Label><select className={cn(inputCls, 'mt-1')} value={draft.context.safetyCritical === undefined ? '' : String(draft.context.safetyCritical)} onChange={(event) => setContext('safetyCritical', event.target.value === '' ? undefined : event.target.value === 'true')}><option value="">Unknown</option><option value="true">Yes</option><option value="false">No</option></select></div>
      </div>
      <label className="mt-3 flex items-center gap-2 text-xs text-[var(--text-secondary)]"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Available for future intake</label>
      {error && <p role="alert" className="mt-3 text-xs text-[var(--status-red)]">{error}</p>}
      <div className="mt-4 flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={save.isPending}><Check className="mr-1 h-4 w-4" /> Save version</Button></div>
    </div>
  );
}

export function JobProfilesAndAuthorities() {
  const queryClient = useQueryClient();
  const { isHR, loading: roleLoading } = useOrganizationRole();
  const profiles = useQuery({ queryKey: jobProfileKey, queryFn: listJobProfiles });
  const authorities = useQuery({ queryKey: authorityKey, queryFn: listPolicyAuthorities, enabled: isHR });
  const members = useQuery({ queryKey: ['onboarding', 'policy-authority-members'], queryFn: listPolicyAuthorityMembers, enabled: isHR });
  const [editing, setEditing] = useState<JobProfile | null | undefined>(undefined);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('hse');
  const [caseId, setCaseId] = useState('');
  const [itemId, setItemId] = useState('');
  const [site, setSite] = useState('');
  const [error, setError] = useState<string | null>(null);
  const assign = useMutation({ mutationFn: ({ userId, role, caseId, itemId, site }: { userId: string; role: string; caseId: number; itemId: string; site: string }) => assignPolicyAuthority(userId, role, { caseId, itemId, site }) });
  const revoke = useMutation({ mutationFn: ({ userId, role, caseId, itemId, site }: { userId: string; role: string; caseId: number; itemId: string; site: string }) => revokePolicyAuthority(userId, role, { caseId, itemId, site }) });
  const refreshAuthorities = () => queryClient.invalidateQueries({ queryKey: authorityKey });
  const retire = (profile: JobProfile) => {
    saveJobProfile({ profileId: profile.profileId, expectedVersion: profile.version, name: profile.name, context: profile.context, enabled: false })
      .then(() => queryClient.invalidateQueries({ queryKey: jobProfileKey }))
      .catch((error: Error) => setError(error.message));
  };

  return (
    <div className="mt-8 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-sm">
      <div className="border-b border-[var(--border)] bg-[var(--surface-alt)] p-[var(--space-lg)]">
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-3"><IconTile icon={Users} className="bg-[var(--surface-soft)] text-[var(--text-secondary)] border-transparent" /><div><h3 className="text-xs font-semibold uppercase tracking-[.05em] text-[var(--text-primary)]">Job profile catalog & designated authorities</h3><p className="mt-0.5 text-xs text-[var(--text-muted)]">Reusable, versioned job context is selected at intake. Authorities are tenant-scoped people who can verify independently evidenced gates.</p></div></div>
          {isHR && <Button size="sm" onClick={() => setEditing(null)}><Plus className="mr-1 h-4 w-4" /> New profile</Button>}
        </div>
      </div>
      <div className="p-[var(--space-lg)]">
        {editing !== undefined && <JobProfileEditor profile={editing} onClose={() => setEditing(undefined)} />}
        {error && <p role="alert" className="mb-3 text-xs text-[var(--status-red)]">{error}</p>}
        {profiles.isLoading ? <LoadingBlock>Loading job profiles…</LoadingBlock> : profiles.isError ? (
          <p role="alert" className="rounded border border-[var(--status-red)] bg-[var(--status-red-bg)] p-3 text-xs text-[var(--status-red-fg)]">Job-profile catalog could not be loaded: {profiles.error instanceof Error ? profiles.error.message : 'Please retry.'}</p>
        ) : (
          <div className="space-y-2">
            {!profiles.data?.length && <p className="text-sm text-[var(--text-muted)]">No reusable job profiles yet. Create one for a recurring job context.</p>}
            {profiles.data?.map((profile) => <div key={profile.profileId} className={cn('flex flex-wrap items-center justify-between gap-3 rounded border p-3', profile.enabled ? 'border-[var(--border)] bg-[var(--surface)]' : 'border-dashed border-[var(--border)] bg-[var(--surface-alt)] opacity-70')}>
              <div><div className="flex items-center gap-2"><strong className="text-sm">{profile.name}</strong><Badge className="bg-[var(--surface-soft)] text-[var(--text-secondary)] shadow-none">v{profile.version}</Badge>{!profile.enabled && <Badge className="bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)] shadow-none">Retired</Badge>}</div><p className="mt-1 text-xs text-[var(--text-muted)]">{contextText(profile.context).join(' · ') || 'Explicit context recorded'}</p></div>
              {isHR && <div className="flex gap-1"><Button size="sm" variant="ghost" title="Edit as new version" onClick={() => setEditing(profile)}><Edit2 className="h-4 w-4" /></Button><Button size="sm" variant="ghost" title="Copy as new profile" onClick={() => setEditing({ ...profile, profileId: '', version: 0, name: `${profile.name} copy` })}><Copy className="h-4 w-4" /></Button>{profile.enabled && <Button size="sm" variant="ghost" title="Retire from future intake" onClick={() => retire(profile)} className="text-[var(--status-red)]"><PowerOff className="h-4 w-4" /></Button>}</div>}
            </div>)}
          </div>
        )}
        <div className="mt-6 border-t border-[var(--border)] pt-5">
          <div className="flex items-start gap-3"><IconTile icon={ShieldCheck} className="bg-[var(--surface-soft)] text-[var(--text-secondary)] border-transparent" /><div><h4 className="text-sm font-bold">Designated evidence authorities</h4><p className="mt-0.5 text-xs text-[var(--text-muted)]">Only a current tenant member assigned to the gate’s configured role can record verification. Removing access affects future decisions, not the audit record.</p></div></div>
          {!roleLoading && !isHR && <p className="mt-3 text-xs text-[var(--text-muted)]">Only organization owners and admins can manage authority assignments.</p>}
           {isHR && <><div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-5"><select className={inputCls} value={userId} onChange={(event) => setUserId(event.target.value)} disabled={members.isLoading}><option value="">{members.isLoading ? 'Loading tenant members…' : 'Select tenant member'}</option>{members.data?.map((member) => <option key={member.userId} value={member.userId}>{member.userId} · {member.role}</option>)}</select><input className={inputCls} value={role} onChange={(event) => setRole(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))} placeholder="e.g. hse" /><input className={inputCls} type="number" min="1" value={caseId} onChange={(event) => setCaseId(event.target.value)} placeholder="Case ID" /><input className={inputCls} value={itemId} onChange={(event) => setItemId(event.target.value)} placeholder="Evidence item ID" /><input className={inputCls} value={site} onChange={(event) => setSite(event.target.value)} placeholder="Exact site or organization scope" /></div><div className="mt-2 flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={() => setSite(ORGANIZATION_AUTHORITY_SCOPE)}>Use organization scope</Button><Button disabled={assign.isPending || !userId.trim() || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(role) || !Number.isInteger(Number(caseId)) || Number(caseId) < 1 || !itemId.trim() || !site.trim()} onClick={() => { setError(null); assign.mutate({ userId: userId.trim(), role, caseId: Number(caseId), itemId: itemId.trim(), site: site.trim() }, { onSuccess: () => { setUserId(''); refreshAuthorities(); }, onError: (error: Error) => setError(error.message) }); }}>Assign scoped authority</Button><span className="text-xs text-[var(--text-muted)]">Use organization scope only for a confirmed non-site office/remote case; site work must use the exact current site.</span></div>
           {authorities.isLoading ? <LoadingBlock>Loading authority assignments…</LoadingBlock> : authorities.isError ? <p role="alert" className="mt-3 text-xs text-[var(--status-red)]">Authority assignments could not be loaded: {authorities.error instanceof Error ? authorities.error.message : 'Please retry.'}</p> : <div className="mt-3 space-y-2">{authorities.data?.map((assignment) => <div key={`${assignment.userId}-${assignment.authorityRole}`} className="flex items-center justify-between rounded border border-[var(--border)] bg-[var(--surface-alt)] p-2 text-xs"><span><strong>{assignment.authorityRole}</strong> · {assignment.userId} <span className="text-[var(--text-muted)]">({assignment.membershipRole}) · case #{assignment.caseId} / {assignment.itemId} / {assignment.site}</span></span><Button size="sm" variant="ghost" className="text-[var(--status-red)]" disabled={revoke.isPending} onClick={() => revoke.mutate({ userId: assignment.userId, role: assignment.authorityRole, caseId: assignment.caseId, itemId: assignment.itemId, site: assignment.site }, { onSuccess: refreshAuthorities, onError: (error: Error) => setError(error.message) })}>Revoke</Button></div>)}</div>}</>}
        </div>
      </div>
    </div>
  );
}