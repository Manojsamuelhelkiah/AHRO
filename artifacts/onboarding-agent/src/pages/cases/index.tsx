import React, { useState } from 'react';
import { useListOnboardingCases, useCreateOnboardingCase, getListOnboardingCasesQueryKey } from '@workspace/api-client-react';
import { Link, useLocation } from 'wouter';
import { Card, Button, Input, cn, Label, PageHeader } from '@/components/ui-shared';
import { format } from 'date-fns';
import { Plus, Search } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

export function CasesPage() {
  const { data: cases, isLoading } = useListOnboardingCases();
  const [showNew, setShowNew] = useState(false);
  const [, setLocation] = useLocation();

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <PageHeader title="Onboarding Cases" subtitle="Manage and track in-flight onboardings.">
        <Button onClick={() => setShowNew(!showNew)} className="gap-2">
          <Plus className="h-4 w-4" /> New Case Trigger
        </Button>
      </PageHeader>

      {showNew && <NewCaseForm onClose={() => setShowNew(false)} />}

      <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
        <div style={{ padding: 'var(--space-md) var(--space-lg)', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--surface)' }} className="flex items-center gap-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4" style={{ color: 'var(--text-muted)' }} />
            <Input className="pl-9" placeholder="Search cases..." />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--surface-alt)', borderBottom: '2px solid var(--border)' }}>
                <th style={{ padding: '10px var(--space-lg)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 600 }}>Worker</th>
                <th style={{ padding: '10px var(--space-lg)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 600 }}>Role & Geo</th>
                <th style={{ padding: '10px var(--space-lg)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 600 }}>Joining Date</th>
                <th style={{ padding: '10px var(--space-lg)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 600 }}>Stage</th>
                <th style={{ padding: '10px var(--space-lg)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 600 }}>Orchestration</th>
                <th style={{ padding: '10px var(--space-lg)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 600, textAlign: 'right' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Loading...</td></tr>
              ) : cases?.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>No cases found.</td></tr>
              ) : (
                cases?.map(c => (
                  <tr 
                    key={c.id} 
                    className="group transition-colors cursor-pointer"
                    style={{ borderBottom: '1px solid var(--border)' }}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--primary-light)'}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                    onClick={(e) => {
                      if (!(e.target as HTMLElement).closest('a') && !(e.target as HTMLElement).closest('button')) {
                        setLocation(`/cases/${c.id}`);
                      }
                    }}
                  >
                    <td style={{ padding: '12px var(--space-lg)' }}>
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>{c.workerName}</div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px' }}>{c.workerEmail}</div>
                      <div className="flex gap-2 mt-1">
                        <TypeBadge type={c.hireType} />
                        {c.urgency !== 'normal' && <UrgencyBadge urgency={c.urgency} />}
                      </div>
                    </td>
                    <td style={{ padding: '12px var(--space-lg)' }}>
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>{c.role}</div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px' }}>{c.geography}</div>
                    </td>
                    <td style={{ padding: '12px var(--space-lg)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }} className="whitespace-nowrap">
                      {format(new Date(c.joiningDate), 'MMM d, yyyy')}
                    </td>
                    <td style={{ padding: '12px var(--space-lg)' }}>
                      <StageBadge stage={c.lifecycleStage} />
                    </td>
                    <td style={{ padding: '12px var(--space-lg)' }}>
                      <StatusBadge status={c.orchestrationStatus} />
                    </td>
                    <td style={{ padding: '12px var(--space-lg)', textAlign: 'right' }}>
                      <Link href={`/cases/${c.id}`} className="hover:underline" style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--primary)' }} onClick={e => e.stopPropagation()}>
                        View Details
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  let style = {};
  if (type === 'contractor') style = { backgroundColor: 'var(--surface-soft)', color: 'var(--status-blue)' };
  else if (type === 'external-fte') style = { backgroundColor: 'var(--primary-light)', color: 'var(--primary-dark)' };
  else style = { backgroundColor: 'var(--surface-soft)', color: 'var(--status-green)' };

  return (
    <span style={{ ...style, fontSize: '10px', fontWeight: 600, padding: '2px 6px', borderRadius: '4px', textTransform: 'uppercase' }}>
      {type.replace('-', ' ')}
    </span>
  );
}

function UrgencyBadge({ urgency }: { urgency: string }) {
  let style = {};
  if (urgency === 'high' || urgency === 'critical' || urgency === 'elevated') style = { backgroundColor: 'var(--surface-soft)', color: 'var(--status-amber)' };
  else style = { backgroundColor: 'var(--surface-alt)', color: 'var(--text-muted)' };

  return (
    <span style={{ ...style, fontSize: '10px', fontWeight: 600, padding: '2px 6px', borderRadius: '4px', textTransform: 'uppercase' }}>
      {urgency}
    </span>
  );
}

function StageBadge({ stage }: { stage: string }) {
  let style = {};
  switch (stage.toLowerCase()) {
    case 'preboarding':
      style = { backgroundColor: 'var(--surface-soft)', color: 'var(--status-blue)' };
      break;
    case 'in-progress':
      style = { backgroundColor: 'var(--surface-soft)', color: 'var(--status-amber)' };
      break;
    case 'day1-review':
      style = { backgroundColor: 'var(--primary-light)', color: 'var(--primary-dark)' };
      break;
    case 'completed':
    case 'complete':
      style = { backgroundColor: 'var(--surface-soft)', color: 'var(--status-green)' };
      break;
    default:
      style = { backgroundColor: 'var(--surface-alt)', color: 'var(--text-muted)' };
  }
  return <span style={{ ...style, fontSize: 'var(--text-xs)', fontWeight: 600, padding: '4px 8px', borderRadius: '20px', textTransform: 'uppercase' }}>{stage}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const isRunning = status === 'running' || status === 'waiting-approval';
  const style = isRunning
    ? { backgroundColor: 'var(--surface-soft)', color: 'var(--status-green)' }
    : { backgroundColor: 'var(--surface-alt)', color: 'var(--text-muted)' };

  return (
    <span style={{ ...style, fontSize: 'var(--text-xs)', fontWeight: 600, padding: '4px 8px', borderRadius: '20px', textTransform: 'uppercase', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      {isRunning && <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: 'var(--status-green)' }}></span>}
      {status === 'not-started' ? 'IDLE' : status}
    </span>
  );
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
    <Card className="mb-6 shadow-md">
      <div style={{ padding: 'var(--space-md) var(--space-lg)', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--surface-alt)' }} className="flex justify-between items-center">
        <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>New Intake Trigger</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
      </div>
      <form onSubmit={handleSubmit} className="p-[var(--space-lg)] space-y-4">
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
              <p className="text-[11px] leading-snug" style={{ color: 'var(--status-amber)' }}>
                {channelPref === 'whatsapp'
                  ? 'WhatsApp is selected — a phone number is required (the agent falls back to email without one).'
                  : 'Without a phone number, WhatsApp messages are skipped and only email is used.'}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label>Contact Channel</Label>
            <select name="channelPreference" value={channelPref} onChange={(e) => setChannelPref(e.target.value)} className="flex h-[32px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[6px] text-[var(--text-sm)] shadow-sm transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]" required>
              <option value="email">Email only</option>
              <option value="whatsapp">WhatsApp only</option>
              <option value="both">Email + WhatsApp</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>Hire Type</Label>
            <select name="hireType" className="flex h-[32px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[6px] text-[var(--text-sm)] shadow-sm transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]" required>
              <option value="external-fte">External FTE</option>
              <option value="contractor">Contractor</option>
              <option value="rehire">Rehire</option>
              <option value="internal-transfer">Internal Transfer</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>Worker Category</Label>
            <select name="workerCategory" className="flex h-[32px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[6px] text-[var(--text-sm)] shadow-sm transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]" required>
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
            <select name="urgency" className="flex h-[32px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[6px] text-[var(--text-sm)] shadow-sm transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]">
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
        <div className="flex justify-end pt-4 mt-2" style={{ borderTop: '1px solid var(--border)' }}>
          <Button type="submit" disabled={createCase.isPending}>
            {createCase.isPending ? 'Triggering...' : 'Submit to Intake Agent'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
