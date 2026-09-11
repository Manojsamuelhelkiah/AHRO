const fs = require('fs');

const code = `import React, { useState, useEffect } from 'react';
import { useGetOnboardingActionCenterIdentities, useUpdateOnboardingActionCenterIdentities, getGetOnboardingActionCenterIdentitiesQueryKey } from '@workspace/api-client-react';
import { Card, Button, Input, Label, Badge } from '@/components/ui-shared';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Save, AlertCircle, RefreshCw } from 'lucide-react';
import { useOrganizationRole } from '../hooks/use-organization-role';

export function ActionCenterIdentitiesSettings() {
  const { data, isLoading, isError } = useGetOnboardingActionCenterIdentities();
  const updateMutation = useUpdateOnboardingActionCenterIdentities();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { role, organizationId, loading: roleLoading } = useOrganizationRole();
  
  const isAuthorized = role === 'admin' || role === 'owner';
  const isDemo = organizationId === 'DEMO';
  const canEdit = !roleLoading && (isAuthorized || isDemo);

  const [identities, setIdentities] = useState<Record<string, any>>({});
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const [isConflict, setIsConflict] = useState(false);

  useEffect(() => {
    if (data?.identities && draftVersion === null) {
      setIdentities(data.identities);
      setDraftVersion(data.version);
      setIsConflict(false);
    } else if (data && draftVersion !== null && data.version > draftVersion && !isConflict) {
      // Background poll showed a newer version exists, but we have a draft.
      // We don't overwrite the draft, but we could warn.
    }
  }, [data, draftVersion, isConflict]);

  const handleSave = () => {
    if (draftVersion === null) return;
    
    updateMutation.mutate({
      data: {
        version: draftVersion,
        identities: identities as any
      }
    }, {
      onSuccess: (newData) => {
        toast({ title: "Stakeholder names updated" });
        setDraftVersion(newData.version);
        setIdentities(newData.identities);
        setIsConflict(false);
        queryClient.invalidateQueries({ queryKey: getGetOnboardingActionCenterIdentitiesQueryKey() });
      },
      onError: (err: any) => {
        if (err?.status === 409 || err?.message?.includes('409') || err?.message?.toLowerCase().includes('conflict')) {
          setIsConflict(true);
          toast({ title: "Update conflict", description: "Another user updated this configuration. Please reload the latest changes.", variant: 'destructive' });
        } else {
          toast({ title: "Failed to update", description: err.message || "Invalid data", variant: 'destructive' });
        }
      }
    });
  };

  const handleReload = () => {
    setDraftVersion(null);
    setIsConflict(false);
    queryClient.invalidateQueries({ queryKey: getGetOnboardingActionCenterIdentitiesQueryKey() });
  };

  const updateIdentity = (key: string, field: 'name' | 'mailboxType', value: any) => {
    setIdentities(prev => ({
      ...prev,
      [key]: {
        ...prev[key],
        [field]: value
      }
    }));
  };

  if (isLoading) return <div className="text-sm text-[var(--text-muted)] py-4">Loading identity configuration...</div>;
  if (isError || !data) return <div className="text-sm text-[var(--status-red)] py-4">Failed to load configuration.</div>;

  const roles = [
    { key: 'hr', label: 'HR / People Ops' },
    { key: 'bgvTeam', label: 'BGV Team' },
    { key: 'recruiter', label: 'Recruiter' },
    { key: 'hiringManager', label: 'Hiring Manager' },
    { key: 'compliance', label: 'Compliance' }
  ];
  
  const isInputDisabled = !canEdit || updateMutation.isPending;

  return (
    <Card className="p-6 mt-6 bg-[var(--surface-alt)]">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h3 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Building2 className="h-5 w-5 text-[var(--primary)]" /> Action Center Stakeholders
          </h3>
          <p className="text-sm text-[var(--text-secondary)] max-w-2xl mt-1">
            Display names for work queues and assignments. These are presentation metadata only and do not grant permissions or change candidate routing.
          </p>
        </div>
        {!canEdit && !roleLoading && (
          <Badge variant="outline" className="text-[10px] bg-[var(--surface)] text-[var(--text-muted)] gap-1">
            <AlertCircle className="h-3 w-3" /> View Only
          </Badge>
        )}
      </div>
      
      {isConflict && (
        <div className="mb-6 p-4 border border-[var(--status-red)] bg-[var(--status-red-bg)] rounded-md flex items-center justify-between">
          <div className="flex items-center gap-2 text-[var(--status-red)]">
            <AlertCircle className="h-4 w-4" />
            <span className="text-sm font-medium">Conflict: A newer version exists on the server.</span>
          </div>
          <Button size="sm" variant="outline" onClick={handleReload} className="gap-2 border-[var(--status-red)] text-[var(--status-red)] hover:bg-[var(--status-red)] hover:text-white">
            <RefreshCw className="h-3 w-3" /> Reload Latest
          </Button>
        </div>
      )}

      <div className="space-y-6">
        {roles.map(role => {
          const current = identities[role.key];
          if (!current) return null;
          
          return (
            <div key={role.key} className="grid md:grid-cols-3 gap-4 items-start border-b border-[var(--border)] pb-6 last:border-0 last:pb-0">
              <div>
                <Label className="text-sm font-semibold">{role.label}</Label>
                {current.source && (
                  <p className="text-[10px] text-[var(--text-muted)] mt-1 uppercase tracking-wider">
                    Source: {current.source}
                  </p>
                )}
              </div>
              
              <div className="space-y-2">
                <Label className="text-xs">Display Name</Label>
                <Input 
                  value={current.name || ''} 
                  onChange={e => updateIdentity(role.key, 'name', e.target.value || null)}
                  placeholder="e.g. People Operations"
                  disabled={isInputDisabled || current.source === 'existing-profile'}
                />
                {current.source === 'existing-profile' && (
                  <p className="text-[10px] text-[var(--text-muted)]">Managed by existing authoritative profile.</p>
                )}
              </div>
              
              <div className="space-y-2">
                <Label className="text-xs">Mailbox Type (Label only)</Label>
                <Select 
                  value={current.mailboxType} 
                  onValueChange={v => updateIdentity(role.key, 'mailboxType', v)}
                  disabled={isInputDisabled}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="shared">Shared Inbox</SelectItem>
                    <SelectItem value="individual">Individual</SelectItem>
                    <SelectItem value="not-configured">Not Configured</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          );
        })}
      </div>

      {canEdit && (
        <div className="mt-8 flex justify-end gap-3">
          {(draftVersion !== data.version) && !isConflict && (
            <Button variant="outline" onClick={handleReload} disabled={updateMutation.isPending} className="gap-2">
              <RefreshCw className="h-4 w-4" /> Discard Changes
            </Button>
          )}
          <Button onClick={handleSave} disabled={updateMutation.isPending || isConflict} className="gap-2">
            <Save className="h-4 w-4" />
            {updateMutation.isPending ? 'Saving...' : 'Save Configuration'}
          </Button>
        </div>
      )}
    </Card>
  );
}
`;

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-settings.tsx', code);
