import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, cn } from '@/components/ui-shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Mail, PhoneCall, AlertTriangle, ShieldCheck, CheckCircle2, Clock } from 'lucide-react';
import { getPinnedOrganizationIdForPage, useGetOnboardingCaseReadinessSla, getGetOnboardingCaseReadinessSlaQueryKey } from '@workspace/api-client-react';

async function fetchContactOptions(caseId: number, currentSnapshotRevision?: number | null) {
  const orgId = getPinnedOrganizationIdForPage() || localStorage.getItem('activeOrganizationId');
  const query = currentSnapshotRevision ? `?currentSnapshotRevision=${currentSnapshotRevision}` : '';
  const res = await fetch(`/api/onboarding/cases/${caseId}/contact-options${query}`, {
    headers: orgId ? { 'x-organization-id': orgId } : {}
  });
  if (!res.ok) throw new Error('Failed to load contact options');
  return res.json();
}

async function sendContact(caseId: number, payload: any) {
  const orgId = getPinnedOrganizationIdForPage() || localStorage.getItem('activeOrganizationId');
  const res = await fetch(`/api/onboarding/cases/${caseId}/contact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(orgId ? { 'x-organization-id': orgId } : {})
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Failed to send contact');
  return res.json();
}

export function ContactDialog({ caseId, open, onOpenChange }: { caseId: number, open: boolean, onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [selectedAction, setSelectedAction] = useState<any>(null);
  
  const { data: slaData } = useGetOnboardingCaseReadinessSla(caseId, {
    query: { queryKey: getGetOnboardingCaseReadinessSlaQueryKey(caseId), enabled: open }
  });
  
  const currentSnapshotRevision = slaData?.snapshotVersion;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['contact-options', caseId, currentSnapshotRevision],
    queryFn: () => fetchContactOptions(caseId, currentSnapshotRevision),
    enabled: open
  });

  const sendMutation = useMutation({
    mutationFn: (payload: any) => sendContact(caseId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contact-options', caseId] });
      // In a real app we would invalidate events, but we don't have the exact query key handy without importing it.
    }
  });

  const [simulate, setSimulate] = useState(true);
  const [goal, setGoal] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const handleSend = () => {
    if (!selectedAction) return;
    const payload = {
      action: selectedAction.action,
      scenario: selectedAction.context?.scenario || 'day-before',
      requestId: crypto.randomUUID(),
      simulate: selectedAction.action === 'candidate-call' ? simulate : undefined,
      slaActionId: selectedAction.context?.slaActionId,
      context: {
        expectedSnapshotRevision: currentSnapshotRevision,
        goal: goal || selectedAction.context?.goal || undefined,
      },
      goal: goal || selectedAction.context?.goal || undefined,
      subject: selectedAction.action === 'candidate-email' ? subject : undefined,
      body: selectedAction.action === 'candidate-email' ? body : undefined,
    };
    sendMutation.mutate(payload);
  };

  const resetForm = () => {
    setSelectedAction(null);
    setGoal('');
    setSubject('');
    setBody('');
    setSimulate(true);
    sendMutation.reset();
  };

  const onDialogChange = (v: boolean) => {
    if (!v) resetForm();
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={onDialogChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Contextual Contact</DialogTitle>
          <DialogDescription>Communicate with the candidate or action owners directly from the case context.</DialogDescription>
        </DialogHeader>

        {isLoading && <div className="p-8 text-center text-[var(--text-muted)] animate-pulse">Loading contact options...</div>}
        {isError && <div className="p-8 text-center text-[var(--status-red)]">Failed to load contact options.</div>}

        {data && !selectedAction && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-[var(--text-sm)] bg-[var(--surface-alt)] p-4 rounded-[var(--radius-md)] border border-[var(--border)]">
              <div>
                <span className="text-[var(--text-muted)] font-bold text-[10px] uppercase tracking-wider block mb-1">Candidate</span>
                <div>{data.contacts?.candidateEmail || 'No email'}</div>
                <div className="mt-0.5">{data.contacts?.candidatePhone || 'No phone'}</div>
              </div>
              <div>
                <span className="text-[var(--text-muted)] font-bold text-[10px] uppercase tracking-wider block mb-1">Status</span>
                <div className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" /> Offer-Acceptance Package: {data.gate?.gateAComplete ? 'Complete' : 'Pending'}</div>
                {data.recentContact?.present && (
                  <div className="flex items-center gap-1.5 mt-1 text-[var(--status-amber)]">
                    <Clock className="w-3.5 h-3.5" /> Recently contacted ({data.recentContact.channel})
                  </div>
                )}
                {data.activeCall && (
                  <div className="flex items-center gap-1.5 mt-1 text-[var(--status-blue)]">
                    <PhoneCall className="w-3.5 h-3.5" /> Call currently in progress
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <h4 className="text-[var(--text-sm)] font-bold text-[var(--text-primary)] border-b border-[var(--border)] pb-2">Available Actions</h4>
              
              {data.options?.length === 0 && <p className="text-[var(--text-sm)] text-[var(--text-muted)] italic">No actions available for current context.</p>}
              
              {data.options?.map((opt: any, i: number) => {
                const Icon = opt.channel === 'email' ? Mail : PhoneCall;
                return (
                  <button
                    key={i}
                    disabled={!opt.available}
                    onClick={() => {
                      setSelectedAction(opt);
                      if (opt.action === 'candidate-call') setSimulate(true);
                    }}
                    className={cn(
                      "w-full text-left p-3 rounded-[var(--radius-md)] border flex items-start gap-3 transition-colors",
                      opt.available 
                        ? "bg-[var(--surface)] border-[var(--border)] hover:border-[var(--primary)] shadow-sm" 
                        : "bg-[var(--surface-alt)] border-[var(--border)] opacity-70 cursor-not-allowed"
                    )}
                  >
                    <Icon className={cn("w-5 h-5 shrink-0 mt-0.5", opt.available ? "text-[var(--primary)]" : "text-[var(--text-muted)]")} />
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-[var(--text-sm)] text-[var(--text-primary)]">{opt.label}</div>
                      <div className="text-[var(--text-xs)] text-[var(--text-secondary)] mt-0.5">Audience: {data.audienceLabels?.[opt.audience] || opt.audience}</div>
                      {!opt.available && opt.reasons?.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {opt.reasons.map((r: string, j: number) => (
                            <div key={j} className="flex items-center gap-1.5 text-[10px] font-bold text-[var(--status-amber)] bg-[var(--status-amber-bg)] px-2 py-0.5 rounded w-fit uppercase tracking-wider">
                              <AlertTriangle className="w-3 h-3" /> {r}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {selectedAction && !sendMutation.isSuccess && (
          <div className="space-y-4">
            <button onClick={() => setSelectedAction(null)} className="text-[var(--text-xs)] font-bold text-[var(--primary)] hover:underline">
              ← Back to options
            </button>
            
            <div className="bg-[var(--surface-alt)] p-4 rounded-[var(--radius-md)] border border-[var(--border)]">
              <h4 className="font-bold text-[var(--text-sm)] flex items-center gap-2">
                {selectedAction.channel === 'email' ? <Mail className="w-4 h-4"/> : <PhoneCall className="w-4 h-4"/>}
                {selectedAction.label}
              </h4>
              <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mt-1">Recipient: {selectedAction.recipient}</p>
            </div>

            {selectedAction.action === 'candidate-email' && (
              <>
                <div>
                  <label className="text-[var(--text-sm)] font-medium block mb-1">Subject (optional)</label>
                  <input 
                    type="text" 
                    className="w-full border border-[var(--border)] rounded-[var(--radius-md)] p-2 text-[var(--text-sm)] bg-[var(--surface)] outline-none focus:border-[var(--primary)]"
                    maxLength={200}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-[var(--text-sm)] font-medium block mb-1">Body (optional)</label>
                  <textarea 
                    className="w-full border border-[var(--border)] rounded-[var(--radius-md)] p-2 text-[var(--text-sm)] bg-[var(--surface)] min-h-[100px] outline-none focus:border-[var(--primary)]"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                </div>
              </>
            )}

            {selectedAction.action === 'candidate-call' && (
              <>
                <div>
                  <label className="text-[var(--text-sm)] font-medium block mb-1">Call Goal / Script instruction (optional)</label>
                  <textarea 
                    className="w-full border border-[var(--border)] rounded-[var(--radius-md)] p-2 text-[var(--text-sm)] bg-[var(--surface)] min-h-[80px] outline-none focus:border-[var(--primary)]"
                    placeholder="E.g., Remind the candidate to complete pending documentation"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                  />
                </div>
                
                <div className="flex items-center gap-2 p-3 bg-[var(--surface-alt)] border border-[var(--border)] rounded-[var(--radius-md)]">
                  <input 
                    type="checkbox" 
                    id="simulate-call" 
                    checked={simulate} 
                    onChange={(e) => setSimulate(e.target.checked)} 
                    className="w-4 h-4 accent-[var(--primary)]"
                  />
                  <label htmlFor="simulate-call" className="text-[var(--text-sm)] font-medium cursor-pointer">Simulate Call (Live test)</label>
                </div>
                {!simulate && (
                  <div className="p-3 bg-[var(--status-red-bg)] text-[var(--status-red-fg)] text-[var(--text-xs)] rounded-[var(--radius-md)] flex items-start gap-2 border border-[var(--status-red)]/30">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <p><strong>Warning:</strong> You are about to initiate a real voice call to the candidate. Ensure you have authorization before proceeding.</p>
                  </div>
                )}
              </>
            )}

            {['owner-email', 'backup-email'].includes(selectedAction.action) && (
              <div>
                <label className="text-[var(--text-sm)] font-medium block mb-1">Notification Goal (optional)</label>
                <textarea 
                  className="w-full border border-[var(--border)] rounded-[var(--radius-md)] p-2 text-[var(--text-sm)] bg-[var(--surface)] min-h-[80px] outline-none focus:border-[var(--primary)]"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                />
              </div>
            )}

            {sendMutation.isError && (
              <div className="p-3 bg-[var(--status-red-bg)] text-[var(--status-red-fg)] text-[var(--text-sm)] rounded-[var(--radius-md)] border border-[var(--status-red)]">
                Failed to dispatch action: {sendMutation.error?.message}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => setSelectedAction(null)}>Cancel</Button>
              <Button onClick={handleSend} disabled={sendMutation.isPending} className="bg-[var(--primary)] text-white gap-2">
                {sendMutation.isPending ? 'Dispatching...' : 'Dispatch Action'}
              </Button>
            </div>
          </div>
        )}

        {sendMutation.isSuccess && (
          <div className="py-8 text-center space-y-4">
            {['withheld', 'failed', 'duplicate', 'queued', 'sending', 'unknown'].includes(sendMutation.data?.delivery) ? (
              <AlertTriangle className="w-12 h-12 text-[var(--status-amber)] mx-auto" />
            ) : (
              <CheckCircle2 className="w-12 h-12 text-[var(--status-green)] mx-auto" />
            )}
            
            <h3 className="text-[var(--text-lg)] font-bold">
              {sendMutation.data?.delivery === 'sent' && 'Sent Successfully'}
              {sendMutation.data?.delivery === 'calling' && 'Call Initiated'}
              {sendMutation.data?.delivery === 'simulated' && 'Call Simulated'}
              {sendMutation.data?.delivery === 'logged-only' && 'Logged successfully'}
              {sendMutation.data?.delivery === 'duplicate' && 'Duplicate request ignored'}
              {sendMutation.data?.delivery === 'withheld' && 'Delivery Withheld'}
              {sendMutation.data?.delivery === 'failed' && 'Delivery Failed'}
              {sendMutation.data?.delivery === 'queued' && 'Delivery Queued'}
              {sendMutation.data?.delivery === 'sending' && 'Delivery Sending'}
              {sendMutation.data?.delivery === 'unknown' && 'Delivery Status Unknown'}
            </h3>
            
            {sendMutation.data?.withheldReason && (
              <p className="text-[var(--text-sm)] text-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 rounded-[var(--radius-md)] inline-block text-left border border-[var(--status-amber)]/30">
                <strong>Reason:</strong> {sendMutation.data.withheldReason}
              </p>
            )}
            
            {sendMutation.data?.failureReason && (
              <p className="text-[var(--text-sm)] text-[var(--status-red)] bg-[var(--status-red-bg)] p-3 rounded-[var(--radius-md)] inline-block text-left border border-[var(--status-red)]/30">
                <strong>Error:</strong> {sendMutation.data.failureReason}
              </p>
            )}

            <div className="pt-4">
              <Button onClick={() => onDialogChange(false)} variant="outline">Close</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}