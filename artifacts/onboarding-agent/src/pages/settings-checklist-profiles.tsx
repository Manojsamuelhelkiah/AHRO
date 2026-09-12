import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useListOnboardingChecklistProfiles,
  useCreateOnboardingChecklistProfile,
  useUpdateOnboardingChecklistProfile,
  useDisableOnboardingChecklistProfile,
  useDuplicateOnboardingChecklistProfile,
  getListOnboardingChecklistProfilesQueryKey,
  useGetOnboardingSettings,
  type OnbChecklistProfile,
  type OnbChecklistProfileInput,
  type OnbChecklistItemOverride,
  type OnbChecklistTemplateItem,
} from '@workspace/api-client-react';
import { customFetch } from '@workspace/api-client-react';
import { Button, cn, IconTile, LoadingBlock, Label, Badge } from '@/components/ui-shared';
import { Layers, Plus, Edit2, Copy, PowerOff, X, Check, AlertTriangle } from 'lucide-react';
import { RecommendationsPage } from './recommendations';
import { listPolicyAuthorityMembers, listWorkforceStarterTemplates } from '@/lib/workforce-policy-api';

function mutationMessage(error: any, fallback: string) {
  return error?.data?.message
    ?? error?.response?.data?.message
    ?? error?.message
    ?? fallback;
}

function previewChecklist(
  base: readonly OnbChecklistTemplateItem[],
  overrides: readonly OnbChecklistItemOverride[],
): OnbChecklistTemplateItem[] {
  const items = new Map(base.map((item) => [item.id, { ...item }]));
  for (const override of overrides) {
    const inherited = items.get(override.id);
    if (!inherited && (!override.label?.trim() || override.order === undefined)) continue;
    items.set(override.id, {
      id: override.id,
      label: override.label?.trim() || inherited!.label,
      order: override.order ?? inherited!.order,
      enabled: override.enabled ?? inherited?.enabled ?? true,
      mandatory: override.mandatory ?? inherited?.mandatory ?? false,
      enforcementStage: override.enforcementStage ?? inherited?.enforcementStage ?? 'before-day1-review',
    });
  }
  return [...items.values()].sort((a, b) => a.order - b.order);
}

type PreviewContext = {
  band: string; role: string; employmentType: string; location: string;
  roleFamily: string; department: string; legalEntity: string; businessUnit: string;
  industry: string; workCountry: string; workState: string; site: string;
  employmentArrangement: string; workerCategory: string; payBasis: string;
  shiftPattern: string; workEnvironment: string; hiringMode: string;
  hazards: string; requiredLicenses: string;
  assistedIntake?: boolean; siteExposure?: boolean; safetyCritical?: boolean;
};

const previewTextFields: Array<keyof Omit<PreviewContext, 'assistedIntake' | 'siteExposure' | 'safetyCritical'>> = [
  'band', 'role', 'employmentType', 'location', 'roleFamily', 'department',
  'legalEntity', 'businessUnit', 'industry', 'workCountry', 'workState', 'site',
  'employmentArrangement', 'workerCategory', 'payBasis', 'shiftPattern',
  'workEnvironment', 'hiringMode', 'hazards', 'requiredLicenses',
];

const emptyPreviewContext: PreviewContext = {
  band: '', role: '', employmentType: '', location: '', roleFamily: '', department: '',
  legalEntity: '', businessUnit: '', industry: '', workCountry: '', workState: '', site: '',
  employmentArrangement: '', workerCategory: '', payBasis: '', shiftPattern: '',
  workEnvironment: '', hiringMode: '', hazards: '', requiredLicenses: '',
};

type ChecklistPreviewResponse = {
  selection: { profileName: string; profileId: string; profileVersion: number; explanation: string; items: unknown[] };
};

export function TargetedChecklistProfiles() {
  const queryClient = useQueryClient();
  const { data: profiles, isLoading, isError, error: profilesError } = useListOnboardingChecklistProfiles();
  const { data: settings, isError: settingsError, error: settingsLoadError } = useGetOnboardingSettings();
  const { data: starterTemplates, isLoading: startersLoading } = useQuery({ queryKey: ['onboarding', 'workforce-policy-templates'], queryFn: listWorkforceStarterTemplates });
  const disableProfile = useDisableOnboardingChecklistProfile();
  const duplicateProfile = useDuplicateOnboardingChecklistProfile();

  const [editingProfile, setEditingProfile] = useState<Partial<OnbChecklistProfile> | null>(null);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [studioTab, setStudioTab] = useState<'starters' | 'matching' | 'steps' | 'preview' | 'recommendations'>('starters');

  const activeProfiles = (profiles ?? []).filter(p => p.enabled).sort((a, b) => b.priority - a.priority);
  const inactiveProfiles = (profiles ?? []).filter(p => !p.enabled).sort((a, b) => b.priority - a.priority);

  const handleDuplicate = (profileId: string) => {
    setDuplicateError(null);
    duplicateProfile.mutate({ profileId }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListOnboardingChecklistProfilesQueryKey() }),
      onError: (err: any) => setDuplicateError(mutationMessage(err, 'Failed to duplicate profile.'))
    });
  };

  return (
    <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)' }} className="mt-8">
      <div style={{ backgroundColor: 'var(--surface-alt)', borderBottom: '1px solid var(--border)', padding: 'var(--space-md) var(--space-lg)' }}>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <IconTile icon={Layers} className="bg-[var(--surface-soft)] text-[var(--text-secondary)] border-transparent" />
            <div>
              <h3 style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>Policy Studio · targeted profiles</h3>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px', marginBottom: 0 }}>
                Versioned, explainable policies match explicit job context. Higher priority wins, equal-priority overlaps are blocked, and the organization default applies when nothing matches.
              </p>
            </div>
          </div>
          <Button size="sm" onClick={() => { setStudioTab('matching'); setEditingProfile({ name: '', enabled: false, priority: 1, criteria: {}, overrides: [] }); }} className="gap-2">
            <Plus className="w-4 h-4" /> Create Draft
          </Button>
        </div>
      </div>
       <div className="flex overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] px-[var(--space-lg)]">
         {([
           ['starters', 'Starter templates'],
           ['matching', 'Matching rules'],
           ['steps', 'Process steps'],
           ['preview', 'Preview & publish'],
           ['recommendations', 'Recommendations'],
         ] as const).map(([tab, label]) => (
           <button key={tab} type="button" onClick={() => setStudioTab(tab)} className={cn(
             'shrink-0 border-b-2 px-3 py-2.5 text-xs font-semibold',
             studioTab === tab ? 'border-[var(--primary)] text-[var(--primary)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]',
           )}>{label}</button>
         ))}
       </div>
      <div className="p-[var(--space-lg)] bg-[var(--surface)]">
          {!editingProfile && studioTab === 'starters' && (
           <div className="mb-5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-alt)] p-3">
             <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Reviewed starter templates</p>
             <div className="mt-2 grid gap-2 md:grid-cols-3">
                {startersLoading && <p className="text-[11px] text-[var(--text-muted)]">Loading canonical reviewed templates…</p>}
                {starterTemplates?.map((starter) => <button key={starter.key} type="button" onClick={() => { setStudioTab('matching'); setEditingProfile({
                  name: starter.name, enabled: false, priority: 10,
                 // The organization default is versioned and may already have
                 // custom rows; append rather than colliding with its orders.
                  criteria: starter.criteria as OnbChecklistProfile['criteria'],
                  overrides: starter.overrides.map((override, index) => ({ ...override, order: (settings?.day1Checklist?.length ?? 0) + index })) as OnbChecklistItemOverride[],
                  processPolicy: starter.processPolicy,
                }); }} className="rounded border border-[var(--border)] bg-[var(--surface)] p-3 text-left hover:border-[var(--primary)]">
                 <span className="block text-[12px] font-semibold text-[var(--text-primary)]">{starter.name}</span>
                 <span className="mt-1 block text-[11px] text-[var(--text-muted)]">{starter.description}</span>
               </button>)}
             </div>
             <p className="mt-2 text-[10px] text-[var(--text-muted)]">Starter guidance is editable. Review lawful jurisdiction, contract and site applicability before publishing.</p>
           </div>
         )}
         {studioTab === 'recommendations' ? (
           <div className="-mx-2">
             <RecommendationsPage />
           </div>
          ) : isLoading ? (
          <LoadingBlock>Loading profiles...</LoadingBlock>
         ) : isError || settingsError ? (
           <div role="alert" className="rounded border border-[var(--status-red)] bg-[var(--status-red-bg)] p-3 text-xs text-[var(--status-red-fg)]">
             Workforce policy data could not be loaded for this tenant: {mutationMessage(profilesError ?? settingsLoadError, 'Please retry.')} The policy section remains available once access is restored.
           </div>
        ) : (
          <div className="space-y-4">
            {duplicateError && (
              <div className="mb-4 p-3 rounded-[var(--radius-md)] bg-[var(--status-red-bg)] text-[var(--status-red-fg)] text-[var(--text-sm)] flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <p>{duplicateError}</p>
              </div>
            )}

            {editingProfile && (
              <ProfileEditor 
                profile={editingProfile} 
                onClose={() => setEditingProfile(null)} 
                defaultChecklist={settings?.day1Checklist || []} 
              />
            )}
            
             {!editingProfile && (profiles?.length === 0) && (
              <p className="text-[var(--text-sm)] text-[var(--text-muted)]">No targeted profiles configured.</p>
            )}

             {!editingProfile && profiles && profiles.length > 0 && (
              <div className="space-y-4">
                 {studioTab === 'matching' && <p className="rounded border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-xs text-[var(--text-muted)]">Profile criteria are exact baseline matches. Open a profile to add a grouped AND/OR rule; ambiguous equal-priority overlaps are rejected by the server.</p>}
                 {studioTab === 'steps' && <p className="rounded border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-xs text-[var(--text-muted)]">Open a profile to configure executable intake, ownership, payroll, induction, and unsupported-work handling fields. These fields are snapshotted with each case.</p>}
                 {studioTab === 'preview' && <p className="rounded border border-[var(--status-amber)]/30 bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--status-amber-fg)]">Preview shows the effective checklist that future matching cases receive. Publishing selects the version for future intake; existing cases remain immutable until an explicit audited replacement.</p>}
                {activeProfiles.map(p => (
                  <ProfileRow key={p.profileId} profile={p} onEdit={() => setEditingProfile(p)} onDuplicate={() => handleDuplicate(p.profileId)} onDisable={() => disableProfile.mutate({ profileId: p.profileId }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListOnboardingChecklistProfilesQueryKey() }) })} />
                ))}
                {inactiveProfiles.length > 0 && (
                  <>
                    <h4 className="text-[var(--text-xs)] font-bold text-[var(--text-muted)] uppercase tracking-wider mt-6 mb-2">Disabled Profiles</h4>
                    {inactiveProfiles.map(p => (
                      <ProfileRow key={p.profileId} profile={p} onEdit={() => setEditingProfile(p)} onDuplicate={() => handleDuplicate(p.profileId)} />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileRow({ profile, onEdit, onDuplicate, onDisable }: any) {
  const [previewOpen, setPreviewOpen] = useState(false);
  
  return (
    <div className={cn("p-4 rounded-[var(--radius-md)] border flex flex-col gap-3 transition-colors", profile.enabled ? "bg-[var(--surface)] border-[var(--border)] shadow-sm" : "bg-[var(--surface-alt)] border-[var(--border)] opacity-70")}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h4 className="font-semibold text-[var(--text-sm)] text-[var(--text-primary)]">{profile.name}</h4>
            <Badge className="bg-[var(--surface-soft)] text-[var(--text-secondary)] shadow-none text-[10px]">Priority {profile.priority}</Badge>
            <Badge className="bg-[var(--surface-soft)] text-[var(--text-secondary)] shadow-none text-[10px]">v{profile.version}</Badge>
          </div>
          <div className="flex gap-3 mt-1.5 text-[var(--text-xs)] text-[var(--text-muted)]">
            {Object.entries(profile.criteria || {}).map(([k, v]) => v ? <span key={k}><span className="font-medium text-[var(--text-secondary)] capitalize">{k}:</span> {String(v)}</span> : null)}
            {Object.values(profile.criteria || {}).filter(Boolean).length === 0 && <span>No criteria (matches all)</span>}
          </div>
          <p className="text-[10px] text-[var(--text-muted)] mt-1">{profile.overrides?.length || 0} overrides applied.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button aria-label={`Edit ${profile.name}`} variant="ghost" size="sm" onClick={onEdit} className="text-[var(--text-secondary)] hover:text-[var(--primary)] hover:bg-[var(--primary-light)]"><Edit2 className="w-4 h-4" /></Button>
          <Button aria-label={`Duplicate ${profile.name}`} variant="ghost" size="sm" onClick={onDuplicate} className="text-[var(--text-secondary)] hover:text-[var(--primary)] hover:bg-[var(--primary-light)]"><Copy className="w-4 h-4" /></Button>
          {profile.enabled && onDisable && (
            <Button aria-label={`Disable ${profile.name}`} variant="ghost" size="sm" onClick={onDisable} className="text-[var(--status-red)] hover:text-[var(--status-red)] hover:bg-[var(--status-red-bg)]"><PowerOff className="w-4 h-4" /></Button>
          )}
        </div>
      </div>
      
      <div className="flex justify-start">
        <button onClick={() => setPreviewOpen(!previewOpen)} className="text-[11px] text-[var(--primary)] font-semibold hover:underline">
          {previewOpen ? 'Hide effective checklist' : 'Preview effective checklist'}
        </button>
      </div>

      {previewOpen && profile.effectiveChecklist && (
        <div className="mt-1 border-t border-[var(--border)] pt-3 space-y-2">
          {profile.effectiveChecklist.length === 0 ? (
            <p className="text-[var(--text-xs)] text-[var(--text-muted)] italic">Resulting checklist is empty.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {profile.effectiveChecklist.map((item: any) => (
                <div key={item.id} className={cn("p-2 text-[11px] rounded border flex justify-between items-center", item.enabled !== false ? "bg-[var(--surface-alt)] border-[var(--border)]" : "bg-[var(--surface-soft)] border-dashed opacity-50")}>
                  <div>
                    <span className="font-semibold">{item.label}</span>
                    <span className="text-[var(--text-muted)] ml-2 font-mono">{item.id}</span>
                  </div>
                  <div className="flex gap-2 text-[9px] uppercase font-bold tracking-wider text-[var(--text-muted)]">
                    <span>{item.mandatory ? 'Mandatory' : 'Optional'}</span>
                    <span>{item.enforcementStage?.replace('before-', '')}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProfileEditor({ profile, onClose, defaultChecklist }: any) {
  const queryClient = useQueryClient();
  const create = useCreateOnboardingChecklistProfile();
  const update = useUpdateOnboardingChecklistProfile();
  
  const [draft, setDraft] = useState<Partial<OnbChecklistProfile>>(profile);
  const [error, setError] = useState<string | null>(null);
  const [sampleContext, setSampleContext] = useState<PreviewContext>(emptyPreviewContext);
  const previewSelection = useMutation({
    mutationFn: () => customFetch<ChecklistPreviewResponse>('/api/onboarding/checklist-profiles/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sampleContext), responseType: 'json' }),
  });
  const members = useQuery({ queryKey: ['onboarding', 'policy-authority-members'], queryFn: listPolicyAuthorityMembers });
  const criteriaCount = Object.values(draft.criteria ?? {}).filter((value) => value?.trim()).length;
  const draftPreview = useMemo(
    () => previewChecklist(defaultChecklist, draft.overrides ?? []),
    [defaultChecklist, draft.overrides],
  );
  const invalidNewItems = (draft.overrides ?? []).some((override) =>
    !defaultChecklist.some((item: OnbChecklistTemplateItem) => item.id === override.id)
    && (!override.label?.trim() || override.order === undefined),
  );
  const invalidName = !draft.name?.trim();
  const priority = Number(draft.priority);
  const invalidPriority = !Number.isInteger(priority) || priority < 0;
  const match = (draft.processPolicy?.match && typeof draft.processPolicy.match === 'object')
    ? draft.processPolicy.match as { operator?: 'all' | 'any'; rules?: Array<{ field: string; values: string[] }> }
    : { operator: 'all' as const, rules: [] };
  const setMatch = (next: { operator: 'all' | 'any'; rules: Array<{ field: string; values: string[] }> }) =>
    setDraft({ ...draft, processPolicy: { ...(draft.processPolicy ?? {}), match: next } });
  const updateProcessField = (field: string, value: string) => {
    const policy = { ...(draft.processPolicy ?? {}) } as Record<string, any>;
    const [group, key] = field.split('.');
    if (key) policy[group] = { ...(policy[group] ?? {}), [key]: value || undefined };
    else policy[group] = value || undefined;
    setDraft({ ...draft, processPolicy: policy });
  };
  const learningSteps = Array.isArray((draft.processPolicy as any)?.learning?.steps)
    ? (draft.processPolicy as any).learning.steps as Array<any> : [];
  const updateLearningStep = (index: number, patch: Record<string, unknown>) => {
    const steps = index === learningSteps.length
      ? [...learningSteps, patch]
      : learningSteps.map((step, position) => position === index ? { ...step, ...patch } : step);
    setDraft({ ...draft, processPolicy: { ...(draft.processPolicy ?? {}), learning: { ...((draft.processPolicy as any)?.learning ?? {}), schemaVersion: 'workforce-step-runtime/v1', timing: { anchor: 'joining-date', offsetDays: 0, ...((draft.processPolicy as any)?.learning?.timing ?? {}) }, channel: 'manager-led', ownership: ((draft.processPolicy as any)?.learning?.ownership ?? 'hiring-manager'), steps } } });
  };
  const addLearningStep = () => updateLearningStep(learningSteps.length, {
    id: `learning-task-${learningSteps.length + 1}`, label: 'New accountable learning task', responsibleRole: 'hiring-manager',
    mandatory: true, evidenceRequired: true, nonblocking: false, prerequisites: [], permittedChannels: ['manager-led'],
    timing: { anchor: 'joining-date', dueOffsetDays: 0 },
  });
  const removeLearningStep = (index: number) => {
    const steps = learningSteps.filter((_, position) => position !== index);
    setDraft({ ...draft, processPolicy: { ...(draft.processPolicy ?? {}), learning: { ...((draft.processPolicy as any)?.learning ?? {}), steps } } });
  };
  const invalidMatch = Boolean(match.rules?.some((rule) => !rule.field || rule.values.length === 0));

  const handleSave = () => {
    setError(null);
    const data: OnbChecklistProfileInput = {
      name: draft.name!.trim(),
      priority,
      enabled: draft.enabled !== false,
      criteria: {
        band: draft.criteria?.band?.trim() || undefined,
        role: draft.criteria?.role?.trim() || undefined,
        employmentType: draft.criteria?.employmentType?.trim() || undefined,
        location: draft.criteria?.location?.trim() || undefined,
        roleFamily: draft.criteria?.roleFamily?.trim() || undefined,
        department: draft.criteria?.department?.trim() || undefined,
        legalEntity: draft.criteria?.legalEntity?.trim() || undefined,
        businessUnit: draft.criteria?.businessUnit?.trim() || undefined,
        industry: draft.criteria?.industry?.trim() || undefined,
        workCountry: draft.criteria?.workCountry?.trim() || undefined,
        workState: draft.criteria?.workState?.trim() || undefined,
        site: draft.criteria?.site?.trim() || undefined,
        employmentArrangement: draft.criteria?.employmentArrangement?.trim() || undefined,
        workerCategory: draft.criteria?.workerCategory?.trim() || undefined,
        payBasis: draft.criteria?.payBasis?.trim() || undefined,
        shiftPattern: draft.criteria?.shiftPattern?.trim() || undefined,
        workEnvironment: draft.criteria?.workEnvironment?.trim() || undefined,
        hiringMode: draft.criteria?.hiringMode?.trim() || undefined,
        safetyCritical: draft.criteria?.safetyCritical,
      },
      overrides: (draft.overrides || []).map(ov => ({
        ...ov,
        label: ov.label?.trim() || undefined,
        order: ov.order === undefined ? undefined : Number(ov.order)
      })),
      processPolicy: (() => {
        const policy = { ...(draft.processPolicy ?? {}) } as Record<string, unknown>;
        const candidate = policy.match as { rules?: unknown[] } | undefined;
        if (candidate && (!candidate.rules || candidate.rules.length === 0)) delete policy.match;
        return policy;
      })(),
    };

    if (profile.profileId) {
      update.mutate({ profileId: profile.profileId, data: { ...data, expectedVersion: profile.version } }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListOnboardingChecklistProfilesQueryKey() });
          onClose();
        },
        onError: (err: any) => setError(mutationMessage(err, 'Failed to update profile.'))
      });
    } else {
      create.mutate({ data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListOnboardingChecklistProfilesQueryKey() });
          onClose();
        },
        onError: (err: any) => setError(mutationMessage(err, 'Failed to create profile.'))
      });
    }
  };

  const updateCriteria = (k: string, v: string) => {
    setDraft({ ...draft, criteria: { ...draft.criteria, [k]: v || undefined } });
  };

  const addOverride = () => {
    const highestOrder = Math.max(
      -1,
      ...defaultChecklist.map((item: OnbChecklistTemplateItem) => item.order),
      ...(draft.overrides ?? []).map((item) => item.order ?? -1),
    );
    setDraft({
      ...draft, 
      overrides: [...(draft.overrides || []), {
        id: `custom-${crypto.randomUUID()}`,
        label: 'New Checklist Item',
        order: highestOrder + 1,
        enabled: true,
        mandatory: true,
        enforcementStage: 'before-day1-review',
      }]
    });
  };

  const updateOverride = (index: number, updates: any) => {
    const newOverrides = [...(draft.overrides || [])];
    newOverrides[index] = { ...newOverrides[index], ...updates };
    setDraft({ ...draft, overrides: newOverrides });
  };

  const removeOverride = (index: number) => {
    const newOverrides = [...(draft.overrides || [])];
    newOverrides.splice(index, 1);
    setDraft({ ...draft, overrides: newOverrides });
  };

  const inputCls = "flex h-[32px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[6px] text-[var(--text-sm)] shadow-sm transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]";

  return (
    <div className="border border-[var(--border)] rounded-[var(--radius-lg)] p-4 bg-[var(--surface-alt)] shadow-md">
      <div className="flex items-center justify-between mb-4 border-b border-[var(--border)] pb-3">
        <h4 className="font-bold text-[var(--text-sm)] text-[var(--text-primary)]">{profile.profileId ? 'Edit Profile' : 'New Profile'}</h4>
        <Button variant="ghost" size="sm" onClick={onClose}><X className="w-4 h-4" /></Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="space-y-1">
          <Label>Profile Name</Label>
          <input className={inputCls} value={draft.name || ''} onChange={e => setDraft({ ...draft, name: e.target.value })} />
        </div>

        <div className="space-y-1">
          <Label>Priority (higher wins)</Label>
          <input type="number" min={0} step={1} className={inputCls} value={draft.priority ?? ''} onChange={e => setDraft({ ...draft, priority: Number(e.target.value) })} />
        </div>
        <div className="space-y-1">
          <Label>Band Match</Label>
          <input className={inputCls} placeholder="e.g. L5" value={draft.criteria?.band || ''} onChange={e => updateCriteria('band', e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Role Match</Label>
          <input className={inputCls} placeholder="Exact title" value={draft.criteria?.role || ''} onChange={e => updateCriteria('role', e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Employment Type Match</Label>
          <input className={inputCls} placeholder="e.g. contractor" value={draft.criteria?.employmentType || ''} onChange={e => updateCriteria('employmentType', e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Location Match</Label>
          <input className={inputCls} placeholder="e.g. India" value={draft.criteria?.location || ''} onChange={e => updateCriteria('location', e.target.value)} />
        </div>
         <div className="space-y-1">
           <Label>Work Environment Match</Label>
           <select className={inputCls} value={draft.criteria?.workEnvironment || ''} onChange={e => updateCriteria('workEnvironment', e.target.value)}><option value="">Any</option><option value="office">Office</option><option value="remote">Remote</option><option value="site">Site</option><option value="field">Field</option><option value="mixed">Mixed</option></select>
         </div>
         <div className="space-y-1">
           <Label>Site Match</Label>
           <input className={inputCls} placeholder="Exact site" value={draft.criteria?.site || ''} onChange={e => updateCriteria('site', e.target.value)} />
         </div>
         <div className="space-y-1">
           <Label>Worker Category Match</Label>
           <input className={inputCls} placeholder="e.g. employee" value={draft.criteria?.workerCategory || ''} onChange={e => updateCriteria('workerCategory', e.target.value)} />
         </div>
         <div className="space-y-1">
           <Label>Hiring Mode Match</Label>
           <input className={inputCls} placeholder="individual, batch" value={draft.criteria?.hiringMode || ''} onChange={e => updateCriteria('hiringMode', e.target.value)} />
         </div>
          <div className="space-y-1">
            <Label>Safety-critical duties match</Label>
            <select className={inputCls} value={draft.criteria?.safetyCritical ?? ''} onChange={e => updateCriteria('safetyCritical', e.target.value)}>
              <option value="">Any / unknown</option><option value="true">Yes</option><option value="false">No</option>
            </select>
          </div>
        <div className="col-span-1 md:col-span-2 flex items-center gap-2 mt-2">
          <input type="checkbox" id="profile-enabled" checked={draft.enabled !== false} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} className="rounded border-[var(--border)] text-[var(--primary)] focus:ring-[var(--primary)]" />
           <Label htmlFor="profile-enabled" className="cursor-pointer">Publish this profile (drafts are not selected)</Label>
        </div>
      </div>

       <div className="mb-6 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
         <h4 className="font-bold text-[var(--text-sm)] text-[var(--text-primary)]">Matching rules · AND / OR</h4>
         <p className="mt-1 text-[var(--text-xs)] text-[var(--text-muted)]">Baseline criteria above always match. Add optional grouped rules when one explicit job condition or another can route to this policy.</p>
         <div className="mt-3 flex flex-wrap items-end gap-3">
           <div className="space-y-1"><Label>Group operator</Label><select className={cn(inputCls, 'w-auto')} value={match.operator ?? 'all'} onChange={(event) => setMatch({ operator: event.target.value as 'all' | 'any', rules: match.rules ?? [] })}><option value="all">AND — all rules</option><option value="any">OR — any rule</option></select></div>
           <Button type="button" size="sm" variant="secondary" onClick={() => setMatch({ operator: match.operator ?? 'all', rules: [...(match.rules ?? []), { field: 'roleFamily', values: [] }] })}><Plus className="mr-1 h-3.5 w-3.5" /> Add rule</Button>
         </div>
         <div className="mt-3 space-y-2">
           {(match.rules ?? []).map((rule, index) => <div key={index} className="flex flex-wrap items-center gap-2 rounded border border-[var(--border)] bg-[var(--surface-alt)] p-2">
             <select className={cn(inputCls, 'w-44')} value={rule.field} onChange={(event) => { const rules = [...(match.rules ?? [])]; rules[index] = { ...rule, field: event.target.value }; setMatch({ operator: match.operator ?? 'all', rules }); }}><option value="roleFamily">Role family</option><option value="department">Department</option><option value="workCountry">Work country</option><option value="site">Site</option><option value="payBasis">Pay basis</option><option value="shiftPattern">Shift pattern</option><option value="workEnvironment">Work environment</option><option value="hiringMode">Hiring mode</option></select>
             <input className={cn(inputCls, 'min-w-48 flex-1')} value={rule.values.join(', ')} onChange={(event) => { const rules = [...(match.rules ?? [])]; rules[index] = { ...rule, values: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) }; setMatch({ operator: match.operator ?? 'all', rules }); }} placeholder="One or more exact values, comma-separated" />
             <Button type="button" variant="ghost" size="sm" onClick={() => setMatch({ operator: match.operator ?? 'all', rules: (match.rules ?? []).filter((_, position) => position !== index) })}><X className="h-4 w-4" /></Button>
           </div>)}
           {!match.rules?.length && <p className="text-[11px] text-[var(--text-muted)]">No grouped rules. This profile uses the explicit criteria above only.</p>}
         </div>
       </div>

       <div className="mb-6 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
         <h4 className="font-bold text-[var(--text-sm)] text-[var(--text-primary)]">Process steps · executable fields</h4>
         <p className="mt-1 text-[var(--text-xs)] text-[var(--text-muted)]">These declared workflow fields are included in future case policy snapshots. Unsupported work must stay a human task; no provider is implied by a policy field.</p>
         <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
           <div><Label>Intake mode</Label><select className={cn(inputCls, 'mt-1')} value={(draft.processPolicy as any)?.intake?.mode ?? ''} onChange={(event) => updateProcessField('intake.mode', event.target.value)}><option value="">Not specified</option><option value="individual">Individual</option><option value="individual-or-batch">Individual or batch</option></select></div>
           <div><Label>Intake channel</Label><select className={cn(inputCls, 'mt-1')} value={(draft.processPolicy as any)?.intake?.channel ?? ''} onChange={(event) => updateProcessField('intake.channel', event.target.value)}><option value="">Not specified</option><option value="self-upload">Self-upload</option><option value="assisted-or-self-upload">Assisted or self-upload</option><option value="self-upload-or-assisted">Self-upload or assisted</option></select></div>
           <div><Label>Accountable owner</Label><select className={cn(inputCls, 'mt-1')} value={(draft.processPolicy as any)?.ownership ?? ''} onChange={(event) => updateProcessField('ownership', event.target.value)}><option value="">Not specified</option><option value="hiring-manager">Hiring manager</option><option value="supervisor">Supervisor</option><option value="manager-and-supervisor">Manager and supervisor</option></select></div>
           <div><Label>Payroll pay basis</Label><select className={cn(inputCls, 'mt-1')} value={(draft.processPolicy as any)?.payroll?.payBasis ?? ''} onChange={(event) => updateProcessField('payroll.payBasis', event.target.value)}><option value="">Not specified</option><option value="salary">Salary</option><option value="wage">Wage</option></select></div>
           <div><Label>Payroll prerequisite</Label><select className={cn(inputCls, 'mt-1')} value={(draft.processPolicy as any)?.payroll?.prerequisite ?? ''} onChange={(event) => updateProcessField('payroll.prerequisite', event.target.value)}><option value="">Not specified</option><option value="confirmed-payroll-details">Confirmed payroll details</option><option value="timesheet-and-payroll-details">Timesheet and payroll details</option></select></div>
           <div><Label>Induction route</Label><select className={cn(inputCls, 'mt-1')} value={(draft.processPolicy as any)?.induction ?? ''} onChange={(event) => updateProcessField('induction', event.target.value)}><option value="">Not specified</option><option value="office">Office</option><option value="hse-site">HSE site</option><option value="office-and-site-as-applicable">Office and site as applicable</option></select></div>
           <div><Label>Laptop/access executor</Label><select className={cn(inputCls, 'mt-1')} value={(draft.processPolicy as any)?.executors?.laptopAccess ?? ''} onChange={(event) => updateProcessField('executors.laptopAccess', event.target.value)}><option value="">Not applicable</option><option value="existing-workflow">Existing workflow</option><option value="human-task">Human task</option></select></div>
           <div><Label>Badge, PPE & tools executor</Label><select className={cn(inputCls, 'mt-1')} value={(draft.processPolicy as any)?.executors?.badgePpeTools ?? ''} onChange={(event) => updateProcessField('executors.badgePpeTools', event.target.value)}><option value="">Not applicable</option><option value="existing-workflow">Existing workflow</option><option value="human-task">Human task</option></select></div>
           <div><Label>Payroll executor</Label><select className={cn(inputCls, 'mt-1')} value={(draft.processPolicy as any)?.executors?.payroll ?? ''} onChange={(event) => updateProcessField('executors.payroll', event.target.value)}><option value="">Not applicable</option><option value="existing-workflow">Existing workflow</option><option value="human-task">Human task</option></select></div>
           <div><Label>Unsupported work handler</Label><select className={cn(inputCls, 'mt-1')} value={(draft.processPolicy as any)?.executors?.unsupported ?? 'human-task'} onChange={(event) => updateProcessField('executors.unsupported', event.target.value)}><option value="human-task">Human task</option><option value="existing-workflow">Existing workflow only</option></select></div>
         </div>
       </div>

        <div className="mb-6 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-start justify-between gap-3"><div><h4 className="font-bold text-[var(--text-sm)]">Accountable learning-task compiler</h4><p className="mt-1 text-xs text-[var(--text-muted)]">Create only manager-led human tasks. Named assignees are current authenticated tenant members.</p></div><Button type="button" size="sm" variant="secondary" onClick={addLearningStep}><Plus className="mr-1 h-3.5 w-3.5" /> Add task</Button></div>
          <div className="mt-3 space-y-3">{learningSteps.map((step, index) => <div key={`${step.id}-${index}`} className="rounded border border-[var(--border)] bg-[var(--surface-alt)] p-3"><div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <input className={inputCls} value={step.id ?? ''} placeholder="Stable task ID" onChange={(e) => updateLearningStep(index, { id: e.target.value })} /><input className={inputCls} value={step.label ?? ''} placeholder="Task label" onChange={(e) => updateLearningStep(index, { label: e.target.value })} /><input className={inputCls} value={step.responsibleRole ?? ''} placeholder="Responsible role" onChange={(e) => updateLearningStep(index, { responsibleRole: e.target.value })} />
            <select className={inputCls} value={step.assignedTo ?? ''} onChange={(e) => updateLearningStep(index, { assignedTo: e.target.value || null })}><option value="">Unassigned designated specialist</option>{members.data?.map((member) => <option key={member.userId} value={member.userId}>{member.userId} · {member.role}</option>)}</select><input className={inputCls} value={(step.prerequisites ?? []).join(', ')} placeholder="Prerequisite task IDs" onChange={(e) => updateLearningStep(index, { prerequisites: e.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} /><input className={inputCls} value={step.parallelGroup ?? ''} placeholder="Parallel group" onChange={(e) => updateLearningStep(index, { parallelGroup: e.target.value || null })} />
            <input className={inputCls} type="number" value={step.timing?.notBeforeOffsetDays ?? ''} placeholder="Not before day" onChange={(e) => updateLearningStep(index, { timing: { ...step.timing, anchor: 'joining-date', notBeforeOffsetDays: e.target.value === '' ? undefined : Number(e.target.value) } })} /><input className={inputCls} type="number" value={step.timing?.dueOffsetDays ?? ''} placeholder="Due day" onChange={(e) => updateLearningStep(index, { timing: { ...step.timing, anchor: 'joining-date', dueOffsetDays: e.target.value === '' ? undefined : Number(e.target.value) } })} /><input className={inputCls} type="number" value={step.timing?.escalation?.offsetDays ?? ''} placeholder="Escalate day" onChange={(e) => updateLearningStep(index, { timing: { ...step.timing, escalation: e.target.value === '' ? undefined : { offsetDays: Number(e.target.value), responsibleRole: step.timing?.escalation?.responsibleRole || step.responsibleRole || '' } } })} />
            <input className={inputCls} value={step.timing?.escalation?.responsibleRole ?? ''} placeholder="Escalation role" onChange={(e) => updateLearningStep(index, { timing: { ...step.timing, escalation: { offsetDays: step.timing?.escalation?.offsetDays ?? 0, responsibleRole: e.target.value, assignedTo: step.timing?.escalation?.assignedTo } } })} /><select className={inputCls} value={step.timing?.escalation?.assignedTo ?? ''} onChange={(e) => updateLearningStep(index, { timing: { ...step.timing, escalation: step.timing?.escalation ? { ...step.timing.escalation, assignedTo: e.target.value || null } : undefined } })}><option value="">Escalation assignee</option>{members.data?.map((member) => <option key={member.userId} value={member.userId}>{member.userId}</option>)}</select>
          </div><div className="mt-2 flex flex-wrap gap-3 text-xs"><label><input className="mr-1" type="checkbox" checked={Boolean(step.mandatory)} onChange={(e) => updateLearningStep(index, { mandatory: e.target.checked })} />Mandatory</label><label><input className="mr-1" type="checkbox" checked={Boolean(step.evidenceRequired)} onChange={(e) => updateLearningStep(index, { evidenceRequired: e.target.checked })} />Evidence required</label><label><input className="mr-1" type="checkbox" checked={Boolean(step.nonblocking)} onChange={(e) => updateLearningStep(index, { nonblocking: e.target.checked })} />Nonblocking</label><span>Channel: manager-led</span><Button type="button" variant="ghost" size="sm" className="h-5 text-[var(--status-red)]" onClick={() => removeLearningStep(index)}>Remove</Button></div></div>)}</div>
          {!learningSteps.length && <p className="mt-3 text-xs text-[var(--text-muted)]">No sequenced learning tasks are declared.</p>}
        </div>

      <div className="mb-4">
        <div className="flex items-center justify-between mb-3 border-t border-[var(--border)] pt-4">
          <div>
            <h4 className="font-bold text-[var(--text-sm)] text-[var(--text-primary)]">Item Overrides</h4>
            <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Modify the default checklist, remove items, or add new targeted items.</p>
          </div>
          <Button size="sm" variant="secondary" onClick={addOverride} className="gap-2 shrink-0"><Plus className="w-3 h-3" /> Add Override</Button>
        </div>

        <div className="mb-6 rounded-[var(--radius-md)] border border-[var(--primary)]/30 bg-[var(--primary-light)]/20 p-4">
          <h4 className="font-bold text-[var(--text-sm)] text-[var(--text-primary)]">Actual sample job-context preview</h4>
          <p className="mt-1 text-[var(--text-xs)] text-[var(--text-muted)]">Tests the saved tenant policy resolver and priority precedence against a concrete context. It does not publish or enroll a case.</p>
          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
            {previewTextFields.map((field) => <div key={field}><Label>{field.replace(/([A-Z])/g, ' $1')}</Label><input className={inputCls} value={sampleContext[field]} onChange={(event) => setSampleContext((current) => ({ ...current, [field]: event.target.value }))} /></div>)}
            {(['assistedIntake', 'siteExposure', 'safetyCritical'] as const).map((field) => <div key={field}><Label>{field.replace(/([A-Z])/g, ' $1')}</Label><select className={inputCls} value={sampleContext[field] === undefined ? '' : String(sampleContext[field])} onChange={(event) => setSampleContext((current) => ({ ...current, [field]: event.target.value === '' ? undefined : event.target.value === 'true' }))}><option value="">Unknown</option><option value="true">Yes</option><option value="false">No</option></select></div>)}
          </div>
          <Button type="button" size="sm" className="mt-3" disabled={previewSelection.isPending || !sampleContext.role || !sampleContext.employmentType || !sampleContext.location} onClick={() => previewSelection.mutate()}>{previewSelection.isPending ? 'Resolving…' : 'Preview matching & precedence'}</Button>
          {previewSelection.data && <div className="mt-3 rounded border border-[var(--border)] bg-[var(--surface)] p-3 text-xs"><strong>{previewSelection.data.selection.profileName}</strong> · profile {previewSelection.data.selection.profileId} v{previewSelection.data.selection.profileVersion}<p className="mt-1">{previewSelection.data.selection.explanation}</p><p className="mt-1 text-[var(--text-muted)]">Selected by server priority; enabled equal-priority overlaps are rejected at publish time. {previewSelection.data.selection.items.length} effective checklist items and declared process policy are shown by this actual resolver.</p></div>}
          {previewSelection.error && <p className="mt-2 text-xs text-[var(--status-red)]">{mutationMessage(previewSelection.error, 'Preview could not resolve this sample context.')}</p>}
        </div>
        
        <div className="space-y-3">
          {(draft.overrides || []).length === 0 && (
            <div className="p-4 border border-[var(--border)] border-dashed rounded-[var(--radius-md)] bg-[var(--surface)] text-center text-[var(--text-sm)] text-[var(--text-muted)]">
              No overrides. This profile will inherit the exact default Day-1 checklist.
            </div>
          )}
          {(draft.overrides || []).map((ov: any, i: number) => (
            <div key={i} className="flex flex-col md:flex-row gap-3 p-3 border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface)] shadow-sm">
              <div className="flex-1 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-[10px] text-[var(--text-muted)] uppercase">Target Item ID (or new ID)</Label>
                    <input list="default-checklist-item-ids" className={cn(inputCls, "font-mono text-[11px]")} placeholder="Target Item ID" value={ov.id} onChange={e => updateOverride(i, { id: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-[var(--text-muted)] uppercase">Override Label (optional)</Label>
                    <input className={inputCls} placeholder="Leave blank to keep default" value={ov.label || ''} onChange={e => updateOverride(i, { label: e.target.value })} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-3 items-end">
                  <div className="space-y-1">
                    <Label className="text-[10px] text-[var(--text-muted)] uppercase">Status</Label>
                    <select className={cn(inputCls, "w-auto")} value={ov.enabled === undefined ? 'inherit' : String(ov.enabled)} onChange={e => updateOverride(i, { enabled: e.target.value === 'inherit' ? undefined : e.target.value === 'true' })}>
                      <option value="inherit">Inherit</option>
                      <option value="true">Included</option>
                      <option value="false">Removed</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-[var(--text-muted)] uppercase">Requirement</Label>
                    <select className={cn(inputCls, "w-auto")} value={ov.mandatory === undefined ? 'inherit' : String(ov.mandatory)} onChange={e => updateOverride(i, { mandatory: e.target.value === 'inherit' ? undefined : e.target.value === 'true' })}>
                      <option value="inherit">Inherit</option>
                      <option value="true">Mandatory</option>
                      <option value="false">Optional</option>
                    </select>
                  </div>
                  <div className="space-y-1 flex-1 min-w-[150px]">
                    <Label className="text-[10px] text-[var(--text-muted)] uppercase">Enforcement Stage</Label>
                    <select className={inputCls} value={ov.enforcementStage || ''} onChange={e => updateOverride(i, { enforcementStage: e.target.value || undefined })}>
                      <option value="">Inherit</option>
                      <option value="before-workstreams">Before Workstreams</option>
                      <option value="before-employee-communications">Before Comms</option>
                      <option value="before-day1-review">Before Day-1</option>
                    </select>
                  </div>
                  <div className="space-y-1 w-20">
                    <Label className="text-[10px] text-[var(--text-muted)] uppercase">Order</Label>
                    <input type="number" className={inputCls} placeholder="Auto" value={ov.order ?? ''} onChange={e => updateOverride(i, { order: e.target.value ? Number(e.target.value) : undefined })} />
                  </div>
                </div>
              </div>
              <div className="flex items-start md:items-center justify-end shrink-0">
                <Button variant="ghost" size="icon" className="text-[var(--status-red)] hover:bg-[var(--status-red-bg)] hover:text-[var(--status-red-fg)]" onClick={() => removeOverride(i)}><X className="w-4 h-4" /></Button>
              </div>
            </div>
          ))}
          <datalist id="default-checklist-item-ids">
            {defaultChecklist.map((item: OnbChecklistTemplateItem) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </datalist>
        </div>
      </div>

      <div className="mb-4 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="font-bold text-[var(--text-sm)] text-[var(--text-primary)]">Final effective checklist preview</h4>
            <p className="mt-0.5 text-[var(--text-xs)] text-[var(--text-muted)]">Inherited defaults merged with the draft overrides above.</p>
          </div>
          <Badge className="shrink-0 bg-[var(--surface-soft)] text-[var(--text-secondary)] shadow-none">{draftPreview.filter((item) => item.enabled).length} active</Badge>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
          {draftPreview.map((item) => (
            <div key={item.id} className={cn(
              'rounded border p-2 text-[11px]',
              item.enabled ? 'border-[var(--border)] bg-[var(--surface-alt)]' : 'border-dashed border-[var(--border)] opacity-50',
            )}>
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold text-[var(--text-primary)]">{item.label}</span>
                <span className="font-mono text-[var(--text-muted)]">#{item.order + 1}</span>
              </div>
              <p className="mt-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                {item.enabled ? (item.mandatory ? 'Mandatory' : 'Optional') : 'Disabled'} · {item.enforcementStage.replace('before-', 'before ')}
              </p>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-[var(--radius-md)] bg-[var(--status-red-bg)] text-[var(--status-red-fg)] text-[var(--text-sm)] flex items-start gap-2 border border-[var(--status-red)]/30">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      <div className="flex justify-end gap-3 border-t border-[var(--border)] pt-4 mt-6">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          onClick={handleSave}
          disabled={create.isPending || update.isPending || invalidName || invalidPriority || invalidMatch || criteriaCount === 0 || invalidNewItems || (draft.overrides || []).some(o => !o.id)}
          className="gap-2 bg-[var(--primary)] text-white hover:bg-[var(--primary-dark)]"
        >
          <Check className="w-4 h-4" /> Save Profile
        </Button>
      </div>
    </div>
  );
}
