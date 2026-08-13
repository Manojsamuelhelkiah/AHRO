import React, { useState } from 'react';
import { useListOnboardingCases, useCreateOnboardingCase, getListOnboardingCasesQueryKey } from '@workspace/api-client-react';
import { Link } from 'wouter';
import { Card, Button, Input, Badge, cn, Label } from '@/components/ui-shared';
import { format } from 'date-fns';
import { Plus, Search } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

export function CasesPage() {
  const { data: cases, isLoading } = useListOnboardingCases();
  const [showNew, setShowNew] = useState(false);

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Onboarding Cases</h1>
          <p className="text-muted-foreground mt-1">Manage and track in-flight onboardings.</p>
        </div>
        <Button onClick={() => setShowNew(!showNew)} className="gap-2">
          <Plus className="h-4 w-4" /> New Case Trigger
        </Button>
      </div>

      {showNew && <NewCaseForm onClose={() => setShowNew(false)} />}

      <Card>
        <div className="p-4 border-b flex items-center gap-4 bg-muted/20">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9 bg-background" placeholder="Search cases..." />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted-foreground bg-muted/50 border-b">
              <tr>
                <th className="px-6 py-3 font-medium">Worker</th>
                <th className="px-6 py-3 font-medium">Role & Geo</th>
                <th className="px-6 py-3 font-medium">Joining Date</th>
                <th className="px-6 py-3 font-medium">Stage</th>
                <th className="px-6 py-3 font-medium">Orchestration</th>
                <th className="px-6 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">Loading...</td></tr>
              ) : cases?.length === 0 ? (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">No cases found.</td></tr>
              ) : (
                cases?.map(c => (
                  <tr key={c.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-6 py-3">
                      <div className="font-medium text-foreground">{c.workerName}</div>
                      <div className="text-xs text-muted-foreground">{c.workerEmail}</div>
                      <div className="flex gap-1 mt-1">
                        <Badge variant="outline" className="text-[10px] px-1 py-0">{c.hireType}</Badge>
                        {c.urgency !== 'normal' && <Badge variant="destructive" className="text-[10px] px-1 py-0">{c.urgency}</Badge>}
                      </div>
                    </td>
                    <td className="px-6 py-3">
                      <div className="font-medium">{c.role}</div>
                      <div className="text-xs text-muted-foreground">{c.geography}</div>
                    </td>
                    <td className="px-6 py-3 whitespace-nowrap">
                      {format(new Date(c.joiningDate), 'MMM d, yyyy')}
                    </td>
                    <td className="px-6 py-3">
                      <StageBadge stage={c.lifecycleStage} />
                    </td>
                    <td className="px-6 py-3">
                      <StatusBadge status={c.orchestrationStatus} />
                    </td>
                    <td className="px-6 py-3 text-right">
                      <Link href={`/cases/${c.id}`} className="text-primary hover:underline font-medium">
                        View Details
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function StageBadge({ stage }: { stage: string }) {
  return <span className="px-2 py-1 rounded bg-secondary text-secondary-foreground text-xs font-medium uppercase tracking-wider border border-border/50">{stage}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    'not-started': 'bg-slate-100 text-slate-700 border-slate-200',
    'running': 'bg-blue-100 text-blue-700 border-blue-200 shadow-[0_0_10px_rgba(59,130,246,0.15)] animate-pulse',
    'waiting-approval': 'bg-amber-100 text-amber-700 border-amber-200',
    'blocked': 'bg-red-100 text-red-700 border-red-200',
    'completed': 'bg-emerald-100 text-emerald-700 border-emerald-200',
  };
  return <span className={cn("px-2 py-1 rounded text-xs font-bold border", colors[status] || 'bg-gray-100')}>{status.toUpperCase()}</span>;
}

function NewCaseForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const createCase = useCreateOnboardingCase();
  const [channelPref, setChannelPref] = useState('both');
  const [phone, setPhone] = useState('');
  const needsPhone = channelPref !== 'email' && !phone.trim();
  
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const data = {
      workerName: fd.get('workerName') as string,
      workerEmail: fd.get('workerEmail') as string,
      workerPhone: fd.get('workerPhone') as string || undefined,
      channelPreference: fd.get('channelPreference') as 'email' | 'whatsapp' | 'both',
      hireType: fd.get('hireType') as string,
      workerCategory: fd.get('workerCategory') as string,
      role: fd.get('role') as string,
      department: fd.get('department') as string,
      geography: fd.get('geography') as string,
      legalEntity: fd.get('legalEntity') as string,
      managerName: fd.get('managerName') as string,
      recruiterName: fd.get('recruiterName') as string,
      joiningDate: fd.get('joiningDate') as string,
      urgency: fd.get('urgency') as string,
      notes: fd.get('notes') as string || undefined,
    };
    
    createCase.mutate({ data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListOnboardingCasesQueryKey() });
        onClose();
      }
    });
  };

  return (
    <Card className="mb-6 border-primary/20 shadow-md">
      <div className="p-4 border-b bg-muted/20 flex justify-between items-center">
        <h3 className="font-semibold">New Intake Trigger</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
      </div>
      <form onSubmit={handleSubmit} className="p-4 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <Label>Worker Name</Label>
            <Input name="workerName" required />
          </div>
          <div className="space-y-1">
            <Label>Email</Label>
            <Input name="workerEmail" type="email" required />
          </div>
          <div className="space-y-1">
            <Label>Phone (E.164)</Label>
            <Input name="workerPhone" placeholder="+1234567890" value={phone} onChange={(e) => setPhone(e.target.value)} required={channelPref === 'whatsapp'} />
            {needsPhone && (
              <p className="text-[11px] text-amber-600">
                {channelPref === 'whatsapp'
                  ? 'WhatsApp is selected — a phone number is required (the agent falls back to email without one).'
                  : 'Without a phone number, WhatsApp messages are skipped and only email is used.'}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label>Contact Channel</Label>
            <select name="channelPreference" value={channelPref} onChange={(e) => setChannelPref(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm" required>
              <option value="email">Email only</option>
              <option value="whatsapp">WhatsApp only</option>
              <option value="both">Email + WhatsApp</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>Hire Type</Label>
            <select name="hireType" className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm" required>
              <option value="external-fte">External FTE</option>
              <option value="contractor">Contractor</option>
              <option value="rehire">Rehire</option>
              <option value="internal-transfer">Internal Transfer</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>Worker Category</Label>
            <select name="workerCategory" className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm" required>
              <option value="employee">Employee</option>
              <option value="contractor">Contractor</option>
              <option value="vendor">Vendor</option>
              <option value="intern">Intern</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>Role</Label>
            <Input name="role" required />
          </div>
          <div className="space-y-1">
            <Label>Department</Label>
            <Input name="department" required />
          </div>
          <div className="space-y-1">
            <Label>Geography</Label>
            <Input name="geography" required />
          </div>
          <div className="space-y-1">
            <Label>Legal Entity</Label>
            <Input name="legalEntity" required />
          </div>
          <div className="space-y-1">
            <Label>Joining Date</Label>
            <Input name="joiningDate" type="date" required />
          </div>
          <div className="space-y-1">
            <Label>Manager</Label>
            <Input name="managerName" required />
          </div>
          <div className="space-y-1">
            <Label>Recruiter</Label>
            <Input name="recruiterName" required />
          </div>
          <div className="space-y-1">
            <Label>Urgency</Label>
            <select name="urgency" className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm">
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <div className="col-span-2 space-y-1">
            <Label>Notes</Label>
            <Input name="notes" placeholder="Free text recruiter notes..." />
          </div>
        </div>
        <div className="flex justify-end pt-2 border-t">
          <Button type="submit" disabled={createCase.isPending}>
            {createCase.isPending ? 'Triggering...' : 'Submit to Intake Agent'}
          </Button>
        </div>
      </form>
    </Card>
  );
}