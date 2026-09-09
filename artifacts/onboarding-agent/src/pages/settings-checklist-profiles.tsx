import React, { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
import { Button, cn, IconTile, LoadingBlock, Label, Badge } from '@/components/ui-shared';
import { Layers, Plus, Edit2, Copy, PowerOff, X, Check, AlertTriangle } from 'lucide-react';

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

export function TargetedChecklistProfiles() {
  const queryClient = useQueryClient();
  const { data: profiles, isLoading } = useListOnboardingChecklistProfiles();
  const { data: settings } = useGetOnboardingSettings();
  const disableProfile = useDisableOnboardingChecklistProfile();
  const duplicateProfile = useDuplicateOnboardingChecklistProfile();

  const [editingProfile, setEditingProfile] = useState<Partial<OnbChecklistProfile> | null>(null);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);

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
              <h3 style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>Targeted Checklist Profiles</h3>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px', marginBottom: 0 }}>
                Profiles match every criterion you specify. Higher priority wins, equal-priority overlaps are blocked, and the organization default applies when nothing matches.
              </p>
            </div>
          </div>
          <Button size="sm" onClick={() => setEditingProfile({ name: '', enabled: true, priority: 1, criteria: {}, overrides: [] })} className="gap-2">
            <Plus className="w-4 h-4" /> Create Profile
          </Button>
        </div>
      </div>
      <div className="p-[var(--space-lg)] bg-[var(--surface)]">
        {isLoading ? (
          <LoadingBlock>Loading profiles...</LoadingBlock>
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
        location: draft.criteria?.location?.trim() || undefined
      },
      overrides: (draft.overrides || []).map(ov => ({
        ...ov,
        label: ov.label?.trim() || undefined,
        order: ov.order === undefined ? undefined : Number(ov.order)
      }))
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
        <div className="col-span-1 md:col-span-2 flex items-center gap-2 mt-2">
          <input type="checkbox" id="profile-enabled" checked={draft.enabled !== false} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} className="rounded border-[var(--border)] text-[var(--primary)] focus:ring-[var(--primary)]" />
          <Label htmlFor="profile-enabled" className="cursor-pointer">Profile Enabled</Label>
        </div>
      </div>

      <div className="mb-4">
        <div className="flex items-center justify-between mb-3 border-t border-[var(--border)] pt-4">
          <div>
            <h4 className="font-bold text-[var(--text-sm)] text-[var(--text-primary)]">Item Overrides</h4>
            <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Modify the default checklist, remove items, or add new targeted items.</p>
          </div>
          <Button size="sm" variant="secondary" onClick={addOverride} className="gap-2 shrink-0"><Plus className="w-3 h-3" /> Add Override</Button>
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
          disabled={create.isPending || update.isPending || invalidName || invalidPriority || criteriaCount === 0 || invalidNewItems || (draft.overrides || []).some(o => !o.id)}
          className="gap-2 bg-[var(--primary)] text-white hover:bg-[var(--primary-dark)]"
        >
          <Check className="w-4 h-4" /> Save Profile
        </Button>
      </div>
    </div>
  );
}
