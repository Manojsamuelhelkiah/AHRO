const fs = require('fs');

const replacement = `import React, { useState, useEffect } from 'react';
import { useGetOnboardingActionCenterIdentities, useUpdateOnboardingActionCenterIdentities, OnbActionCenterIdentityMap, getGetOnboardingActionCenterIdentitiesQueryKey } from '@workspace/api-client-react';
import { Card, Button, Input, Label, Badge } from '@/components/ui-shared';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Save, AlertCircle } from 'lucide-react';
import { useOrganizationRole } from '../hooks/use-organization-role';

export function ActionCenterIdentitiesSettings() {
  const { data, isLoading, isError } = useGetOnboardingActionCenterIdentities();
  const updateMutation = useUpdateOnboardingActionCenterIdentities();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isAuthorized, isDemo } = useOrganizationRole();
  
  const canEdit = isAuthorized || isDemo;

  const [identities, setIdentities] = useState<OnbActionCenterIdentityMap>({});

  useEffect(() => {
    if (data?.identities) {
      setIdentities(data.identities);
    }
  }, [data]);

  const handleSave = () => {
    if (!data) return;
    
    updateMutation.mutate({
      data: {
        version: data.version,
        identities: identities
      }
    }, {
      onSuccess: () => {
        toast({ title: "Stakeholder names updated" });
        queryClient.invalidateQueries({ queryKey: getGetOnboardingActionCenterIdentitiesQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Failed to update", description: err.message || "Version conflict or invalid data", variant: 'destructive' });
      }
    });
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
        {!canEdit && (
          <Badge variant="outline" className="text-[10px] bg-[var(--surface)] text-[var(--text-muted)] gap-1">
            <AlertCircle className="h-3 w-3" /> View Only
          </Badge>
        )}
      </div>

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
                  disabled={!canEdit || current.source === 'existing-profile'}
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
                  disabled={!canEdit}
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
        <div className="mt-8 flex justify-end">
          <Button onClick={handleSave} disabled={updateMutation.isPending} className="gap-2">
            <Save className="h-4 w-4" />
            {updateMutation.isPending ? 'Saving...' : 'Save Configuration'}
          </Button>
        </div>
      )}
    </Card>
  );
}`;

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-settings.tsx', replacement);
