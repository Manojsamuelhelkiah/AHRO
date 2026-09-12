import React, { useState } from 'react';
import {
  useGetOnboardingActionCenter,
  OnbActionCenter,
  useRemindOnboardingActionCenterDocument,
  useRecordOnboardingActionCenterCallOutcome,
  useAssignOnboardingActionCenterWork,
  useReassignOnboardingActionCenterWork,
  useEscalateOnboardingActionCenterWork,
  useResolveOnboardingActionCenterWork,
  getGetOnboardingActionCenterQueryKey,
  useGetOnboardingCase,
  getGetOnboardingCaseQueryKey
} from '@workspace/api-client-react';
import { Card, Button, Badge, cn, Input, Label, PageHeader } from '@/components/ui-shared';
import { format } from 'date-fns';
import { ShieldAlert, AlertCircle, Clock, FileText, Briefcase, Phone, Mail, CheckCircle2, ChevronRight, User, AlertTriangle, PlayCircle } from 'lucide-react';
import { Link, useSearch } from 'wouter';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
const uuidv4 = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useOrganizationRole } from '../hooks/use-organization-role';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActionCenterCreateWork } from './action-center-create-work';
import { getEarlyTenureReminderInbox, postEarlyTenureInboxEvidence, type EarlyTenureInboxReminder } from '../lib/early-tenure-api';

function WorkforceContextTags({ c }: { c: OnbActionCenter['documentFollowups'][0]['case'] }) {
  const label = (c.workforceClassification as { label?: string } | null)?.label ?? 'unclassified';
  return <span className="flex flex-wrap gap-1 text-[10px]">
    <span className="rounded bg-[var(--surface-soft)] px-1.5 py-0.5 uppercase">{label.replace(/-/g, ' ')}</span>
    {c.siteExposure && <span className="rounded bg-[var(--status-amber-bg)] px-1.5 py-0.5 text-[var(--status-amber-fg)]">Site exposure</span>}
    {c.safetyCritical && <span className="rounded bg-[var(--status-red-bg)] px-1.5 py-0.5 text-[var(--status-red-fg)]">Safety-critical</span>}
  </span>;
}

export function NeedsAttentionTab() {
  const [workforce, setWorkforce] = useState<'white-collar' | 'blue-collar-frontline' | 'mixed' | 'needs-review' | 'unclassified' | ''>('');
  const [safetyOnly, setSafetyOnly] = useState(false);
  const [siteOnly, setSiteOnly] = useState(false);
  const { data, isLoading, isFetching } = useGetOnboardingActionCenter({
    scope: 'active',
    workforce: workforce || undefined,
    safetyCritical: safetyOnly || undefined,
    siteExposure: siteOnly || undefined,
  });

  if (isLoading) return <div className="py-12 text-center text-sm text-[var(--text-muted)]">Loading actionable items...</div>;
  if (!data) return <div className="py-12 text-center text-sm text-[var(--status-red)]">Failed to load action center.</div>;

  const totalActionable = data.notifications.length + data.documentFollowups.length + data.workItems.length + data.opportunities.length;

  return (
    <div className="space-y-6 relative">
      {isFetching && !isLoading && (
        <div className="absolute -top-10 right-0 text-[10px] text-[var(--text-muted)] flex items-center gap-1">
          <Clock className="h-3 w-3 animate-spin" /> Updating...
        </div>
      )}

      
      {data.pausedOffline && (
        <div className="mb-4 bg-[var(--status-amber-bg)] border border-[var(--status-amber)] text-[var(--status-amber)] px-4 py-3 rounded-md flex items-center gap-3 text-sm font-medium">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <p>Paused offline cases are read-only. Other cases retain their permitted actions.</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 rounded border border-[var(--border)] bg-[var(--surface-alt)] p-3">
        <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-muted)]">Job context filters</span>
        <select aria-label="Workforce classification filter" value={workforce} onChange={(event) => setWorkforce(event.target.value as typeof workforce)} className="h-8 rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-[12px]">
          <option value="">All classifications</option>
          <option value="white-collar">White-collar</option>
          <option value="blue-collar-frontline">Blue-collar / frontline</option>
          <option value="mixed">Mixed</option>
          <option value="needs-review">Needs review</option>
          <option value="unclassified">Unclassified</option>
        </select>
        <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]"><input type="checkbox" checked={safetyOnly} onChange={(event) => setSafetyOnly(event.target.checked)} /> Safety-critical only</label>
         <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]"><input type="checkbox" checked={siteOnly} onChange={(event) => setSiteOnly(event.target.checked)} /> Site exposure only</label>
      </div>
      <EarlyTenureReminderInbox />
      {totalActionable === 0 ? (
        <Card className="text-center border-dashed py-16" style={{ borderColor: 'var(--border)', backgroundColor: 'transparent', boxShadow: 'none' }}>
          <CheckCircle2 className="mx-auto h-12 w-12 text-[var(--status-green)] opacity-50 mb-4" />
          <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-1">All Clear</h3>
          <p className="text-sm text-[var(--text-secondary)]">No cases require immediate attention.</p>
        </Card>
      ) : (
        <>
          {data.notifications.length > 0 && (
            <section className="space-y-3">
              <h4 className="text-sm font-semibold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-2">
                <AlertCircle className="h-4 w-4" /> Notifications ({data.notifications.length})
              </h4>
              <div className="grid gap-3">
                {data.notifications.map(n => (
                  <NotificationCard key={n.id} notification={n} />
                ))}
              </div>
            </section>
          )}

          {data.documentFollowups.length > 0 && (
            <section className="space-y-3">
              <h4 className="text-sm font-semibold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-2">
                <FileText className="h-4 w-4" /> Missing Documents ({data.documentFollowups.length})
              </h4>
              <div className="grid gap-3">
                {data.documentFollowups.map(d => (
                  <DocumentFollowupCard key={d.documentId} doc={d} />
                ))}
              </div>
            </section>
          )}

          {data.workItems.length > 0 && (
            <section className="space-y-3">
              <h4 className="text-sm font-semibold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-2">
                <Briefcase className="h-4 w-4" /> Work Items ({data.workItems.length})
              </h4>
              <div className="grid gap-3">
                {data.workItems.map(w => (
                  <WorkItemCard key={w.id} item={w} />
                ))}
              </div>
            </section>
          )}

          {data.opportunities.length > 0 && (
            <section className="space-y-3">
              <h4 className="text-sm font-semibold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" /> Opportunities ({data.opportunities.length})
              </h4>
              <div className="grid gap-3">
                {data.opportunities.map(o => (
                  <OpportunityCard key={o.id} opp={o} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** Member-scoped task prompts are intentionally separate from the HR case view.
 * The server returns no worker or case narrative; its opaque action path is the
 * only client-side completion capability. */
export function EarlyTenureReminderInbox() {
  const inbox = useQuery({
    queryKey: ['early-tenure-reminder-inbox'],
    queryFn: getEarlyTenureReminderInbox,
    retry: false,
    staleTime: 30_000,
  });
  if (inbox.isLoading) return <p className="text-xs text-[var(--text-muted)]" role="status">Loading assigned early-tenure reminders…</p>;
  if (inbox.isError) return <p className="text-xs text-[var(--status-red)]" role="alert">Assigned early-tenure reminders could not be loaded.</p>;
  const reminders = inbox.data ?? [];
  return <section aria-labelledby="early-tenure-inbox-heading" className="min-w-0 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 id="early-tenure-inbox-heading" className="font-bold text-[var(--text-primary)]">My early-tenure reminders</h3><p className="mt-1 text-xs text-[var(--text-muted)]">Member-assigned label, timing, and opaque task reference only.</p></div><span className="rounded-full bg-[var(--primary-light)] px-2 py-1 text-[10px] font-bold text-[var(--primary)]">{reminders.length}</span></div>
    {reminders.length ? <ul className="mt-3 divide-y divide-[var(--border)]">{reminders.map((reminder) => <EarlyTenureReminderRow key={reminder.id} reminder={reminder} />)}</ul> : <p className="mt-3 text-sm text-[var(--text-muted)]">No early-tenure reminders are currently assigned to you.</p>}
  </section>;
}

function EarlyTenureReminderRow({ reminder }: { reminder: EarlyTenureInboxReminder }) {
  const [evidenceReference, setEvidenceReference] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const complete = useMutation({
    mutationFn: () => postEarlyTenureInboxEvidence<null>(reminder.evidenceCompletionPath!, { evidenceReference }),
    onSuccess: () => {
      setNotice('Completion evidence submitted.');
      queryClient.setQueryData<EarlyTenureInboxReminder[]>(['early-tenure-reminder-inbox'], (current) => current?.filter((item) => item.id !== reminder.id));
    },
    onError: (error: any) => setNotice(error?.message || 'Completion evidence could not be submitted.'),
  });
  return <li className="min-w-0 py-3">
    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4"><div className="min-w-0"><p className="break-words text-xs font-semibold text-[var(--text-primary)]">{reminder.label || `${reminder.targetType} reminder`}</p>{reminder.taskReference && <p className="mt-1 break-all font-mono text-[10px] text-[var(--text-muted)]">Task ref: {reminder.taskReference}</p>}</div><p className="shrink-0 text-xs text-[var(--text-secondary)]">Available {new Date(reminder.availableAt).toLocaleDateString()} · Due {new Date(reminder.dueAt).toLocaleDateString()}</p></div>
    {reminder.evidenceCompletionPath && <div className="mt-2 flex flex-col gap-2 sm:flex-row"><input aria-label={`Completion evidence for ${reminder.label || reminder.targetType}`} value={evidenceReference} onChange={(event) => setEvidenceReference(event.target.value)} placeholder="Human-authorized evidence reference" className="h-9 min-w-0 flex-1 rounded border border-[var(--border)] px-2 text-sm" /><Button size="sm" disabled={!evidenceReference.trim() || complete.isPending} onClick={() => complete.mutate()}>{complete.isPending ? 'Submitting…' : 'Submit completion evidence'}</Button></div>}
    {notice && <p role="status" className="mt-2 text-xs text-[var(--text-secondary)]">{notice}</p>}
  </li>;
}

function NotificationCard({ notification }: { notification: OnbActionCenter['notifications'][0] }) {
  return (
    <Card className="p-4 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between bg-[var(--surface)] hover:border-[var(--primary)] transition-colors">
      <div className="flex-1">
        <div className="flex items-center gap-2 mb-1">
          <Badge variant="outline" className="uppercase text-[10px] bg-[var(--status-red-bg)] text-[var(--status-red)] border-[var(--status-red)]">
            {notification.kind}
          </Badge>
          <span className="text-xs text-[var(--text-muted)]">{format(new Date(notification.createdAt), 'MMM d, HH:mm')}</span>
          <span className="text-[10px] text-[var(--text-muted)] uppercase bg-[var(--surface-alt)] px-1.5 py-0.5 rounded ml-auto md:ml-2">
            Source: {notification.source}
          </span>
        </div>
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">{notification.title}</h4>
        <p className="text-sm text-[var(--text-secondary)] mt-1">{notification.detail}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0 w-full md:w-auto mt-2 md:mt-0">
         <Link href={notification.caseHref} className="text-xs font-medium text-[var(--primary)] hover:underline flex items-center">
           View Case <ChevronRight className="h-3 w-3 ml-1" />
         </Link>
      </div>
    </Card>
  );
}

function DocumentFollowupCard({ doc }: { doc: OnbActionCenter['documentFollowups'][0] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const remindMutation = useRemindOnboardingActionCenterDocument();

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'live'|'simulation'>('live');

  const { role, organizationId, loading: roleLoading } = useOrganizationRole();
  const isDemo = organizationId === 'demo';
  const isAuthorized = role === 'admin' || role === 'owner';
  const canRemind = !roleLoading && (isAuthorized || isDemo) && (doc.capabilities?.canRemind ?? false);
  
  const handleRemind = () => {
    if (!canRemind || !doc.eligibleForReminder) return;
    remindMutation.mutate({
      data: {
        requestId: uuidv4(),
        caseId: doc.caseId,
        documentId: doc.documentId,
        mode: isDemo ? 'simulation' : 'live'
      }
    }, {
      onSuccess: (result) => {
        toast({
          title: isDemo ? "Reminder simulated" : "Reminder result",
          description: `Status: ${result.action.status}. Sending or recording a reminder does not change readiness.`,
          variant: ['failed', 'blocked'].includes(result.action.status) && !isDemo ? 'destructive' : 'default',
        });
        setOpen(false);
        queryClient.invalidateQueries({ queryKey: getGetOnboardingActionCenterQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Error sending reminder", description: err.message || "Failed to remind", variant: 'destructive' });
      }
    });
  };

  return (
    <Card className="p-4 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between bg-[var(--surface)] hover:border-[var(--primary)] transition-colors">
      <div className="flex-1">
        <div className="flex items-center gap-2 mb-1">
          <Badge variant="outline" className="uppercase text-[10px]">Document</Badge>
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] bg-[var(--surface-alt)] px-1.5 py-0.5 rounded">
            {doc.case.workerName} • {doc.case.role}
          </span>
          <span className="text-[10px] font-mono text-[var(--text-muted)] ml-auto md:ml-2 truncate max-w-[120px]">
            {doc.case.workerEmail}
          </span>
           <WorkforceContextTags c={doc.case} />
        </div>
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">{doc.action === 'review' ? 'Review submitted document:' : 'Pending:'} {doc.label} {doc.required && <span className="text-[var(--status-red)]">*</span>}</h4>
        <div className="text-xs text-[var(--text-secondary)] mt-1 flex flex-wrap gap-4 items-center">
           <span>Reminders sent: <strong>{doc.reminderCount}</strong></span>
           {doc.lastReminderAt && <span>Last: {format(new Date(doc.lastReminderAt), 'MMM d, HH:mm')}</span>}
           {doc.nextReminderAt && <span>Next automated: {format(new Date(doc.nextReminderAt), 'MMM d, HH:mm')}</span>}
            {!doc.eligibleForReminder && <span className="text-[var(--status-amber)] text-[10px] uppercase font-bold border border-[var(--status-amber)] px-1 rounded">{doc.action === 'review' ? 'Human review needed' : 'Reminder not currently due'}</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 w-full md:w-auto mt-2 md:mt-0">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" disabled={!doc.eligibleForReminder || !canRemind} className="gap-2">
              <Mail className="h-3 w-3" /> Remind
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Send Reminder</DialogTitle>
              <DialogDescription>Manually trigger a reminder for <strong>{doc.label}</strong> to {doc.case.workerName}.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
               <div className="space-y-2">
                 <Label>Delivery Mode</Label>
                  <Select value={isDemo ? 'simulation' : 'live'} onValueChange={(val: any) => setMode(val)}>
                   <SelectTrigger><SelectValue /></SelectTrigger>
                   <SelectContent>
                      {!isDemo && <SelectItem value="live">Live (Send to candidate)</SelectItem>}
                      {isDemo && <SelectItem value="simulation">Simulation (No email is sent)</SelectItem>}
                   </SelectContent>
                 </Select>
                 <p className="text-[10px] text-[var(--text-muted)] mt-1">Live mode honors candidate authorization and explicit opt-outs. We never promise a reminder raises readiness score.</p>
               </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
               <Button onClick={handleRemind} disabled={remindMutation.isPending || !canRemind}>
                 {remindMutation.isPending ? 'Processing...' : isDemo ? 'Simulate Reminder' : 'Send Reminder'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Link href={doc.caseHref} className="text-xs font-medium text-[var(--primary)] hover:underline flex items-center ml-2">
          View Case
        </Link>
      </div>
    </Card>
  );
}

function WorkItemCard({ item }: { item: OnbActionCenter['workItems'][0] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const escalateMutation = useEscalateOnboardingActionCenterWork();
  const assignMutation = useAssignOnboardingActionCenterWork();
  const reassignMutation = useReassignOnboardingActionCenterWork();
  const resolveMutation = useResolveOnboardingActionCenterWork();

  const [assignOpen, setAssignOpen] = useState(false);
  const [escalateOpen, setEscalateOpen] = useState(false);

  const [owner, setOwner] = useState(item.owner || 'hr');
  const [assignee, setAssignee] = useState(item.assignee || '');
  const [reason, setReason] = useState(item.reason || '');
  const { role, organizationId, loading: roleLoading } = useOrganizationRole();
  const isDemo = organizationId === 'demo';
  const isAuthorized = role === 'admin' || role === 'owner';
  const canResolve = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canResolve ?? false);
  const canReassign = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canReassign ?? false);
  const canAct = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canAct ?? false);


  const handleResolve = () => {
    resolveMutation.mutate({
      data: {
        requestId: uuidv4(),
        caseId: item.caseId,
        workItemId: item.id,
        expectedVersion: item.actionVersion
      }
    }, {
      onSuccess: () => {
        toast({ title: "Work item resolved" });
        queryClient.invalidateQueries({ queryKey: getGetOnboardingActionCenterQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Error resolving", description: err.message, variant: 'destructive' });
      }
    });
  };

  const handleEscalate = () => {
    escalateMutation.mutate({
      data: {
        requestId: uuidv4(),
        caseId: item.caseId,
        owner: owner as any,
        assignee: assignee || undefined,
        reason: reason || undefined,
        expectedVersion: item.actionVersion
      }
    }, {
      onSuccess: () => {
        toast({ title: "Work item escalated" });
        setEscalateOpen(false);
        queryClient.invalidateQueries({ queryKey: getGetOnboardingActionCenterQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Error escalating", description: err.message, variant: 'destructive' });
      }
    });
  };

  const handleAssign = () => {
    reassignMutation.mutate({
      data: {
        requestId: uuidv4(),
        caseId: item.caseId,
        workItemId: item.id,
        owner: owner as any,
        assignee: assignee || undefined,
        reason: reason || undefined,
        expectedVersion: item.actionVersion
      }
    }, {
      onSuccess: () => {
        toast({ title: "Work item reassigned" });
        setAssignOpen(false);
        queryClient.invalidateQueries({ queryKey: getGetOnboardingActionCenterQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Error assigning", description: err.message, variant: 'destructive' });
      }
    });
  };

  return (
    <Card className="p-4 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between bg-[var(--surface)] hover:border-[var(--primary)] transition-colors">
      <div className="flex-1">
        <div className="flex items-center gap-2 mb-1">
          <Badge variant="outline" className="uppercase text-[10px] bg-[var(--surface-alt)]">Work Item • {item.kind}</Badge>
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] bg-[var(--surface-alt)] px-1.5 py-0.5 rounded">
            Case #{item.caseId}
          </span>
          <span className="text-xs text-[var(--text-muted)]">{format(new Date(item.createdAt), 'MMM d, HH:mm')}</span>
        </div>
        <h4 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          {item.owner || 'Unassigned'}
          {item.assignee && <span className="text-xs font-normal text-[var(--text-secondary)]">({item.assignee})</span>}
        </h4>
        {item.reason && <p className="text-sm text-[var(--text-secondary)] mt-1">{item.reason}</p>}
        <p className="text-[10px] text-[var(--text-muted)] mt-2 italic">Created by {item.actor}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0 w-full md:w-auto mt-2 md:mt-0">
         <Button size="sm" variant="ghost" onClick={handleResolve} disabled={resolveMutation.isPending || !canResolve} className="text-[var(--status-green)] hover:text-[var(--status-green)] hover:bg-[var(--status-green-bg)] mr-2">
             {resolveMutation.isPending ? 'Resolving...' : 'Resolve'}
           </Button>
         <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
           <DialogTrigger asChild>
             <Button size="sm" variant="outline" className="gap-2" disabled={!canReassign}>
               Reassign
             </Button>
           </DialogTrigger>
           <DialogContent>
             <DialogHeader>
               <DialogTitle>Reassign Work Item</DialogTitle>
               <DialogDescription>Assign this durable work item to a team or individual.</DialogDescription>
             </DialogHeader>
             <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label>Owner Queue</Label>
                  <Select value={owner} onValueChange={setOwner}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hr">HR</SelectItem>
                      <SelectItem value="recruiter">Recruiter</SelectItem>
                      <SelectItem value="hiring-manager">Hiring Manager</SelectItem>
                      <SelectItem value="bgv-team">BGV Team</SelectItem>
                      <SelectItem value="documentation">Documentation</SelectItem>
                      <SelectItem value="operations">Operations</SelectItem>
                      <SelectItem value="compliance">Compliance</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Assignee (Optional)</Label>
                  <Input value={assignee} onChange={e => setAssignee(e.target.value)} placeholder="e.g. hr@example.com or Jane Doe" />
                </div>
                <div className="space-y-2">
                  <Label>Reason (Optional)</Label>
                  <Textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for assignment..." />
                </div>
             </div>
             <DialogFooter>
               <Button variant="outline" onClick={() => setAssignOpen(false)}>Cancel</Button>
               <Button onClick={handleAssign} disabled={reassignMutation.isPending || !canReassign}>
                 {reassignMutation.isPending ? 'Reassigning...' : 'Reassign'}
               </Button>
             </DialogFooter>
           </DialogContent>
         </Dialog>

         <Dialog open={escalateOpen} onOpenChange={setEscalateOpen}>
           <DialogTrigger asChild>
             <Button size="sm" variant="outline" className="gap-2 text-[var(--status-red)] border-[var(--status-red)] hover:bg-[var(--status-red-bg)]" disabled={!canAct}>
               Escalate
             </Button>
           </DialogTrigger>
           <DialogContent>
             <DialogHeader>
               <DialogTitle>Escalate Work Item</DialogTitle>
               <DialogDescription>Escalate this work item for urgent review.</DialogDescription>
             </DialogHeader>
             <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label>Target Queue</Label>
                  <Select value={owner} onValueChange={setOwner}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hr">HR</SelectItem>
                      <SelectItem value="bgv-team">BGV Team</SelectItem>
                      <SelectItem value="compliance">Compliance</SelectItem>
                      <SelectItem value="operations">Operations</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Escalation Assignee (Optional)</Label>
                  <Input value={assignee} onChange={e => setAssignee(e.target.value)} placeholder="Specific queue or person" />
                </div>
                <div className="space-y-2">
                  <Label>Escalation Reason</Label>
                  <Textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Why is this being escalated?" />
                </div>
             </div>
             <DialogFooter>
               <Button variant="outline" onClick={() => setEscalateOpen(false)}>Cancel</Button>
               <Button onClick={handleEscalate} variant="destructive" disabled={escalateMutation.isPending || !canAct}>
                 {escalateMutation.isPending ? 'Escalating...' : 'Escalate'}
               </Button>
             </DialogFooter>
           </DialogContent>
         </Dialog>

         <Link href={item.caseHref} className="text-xs font-medium text-[var(--primary)] hover:underline flex items-center ml-2">
           View Case
         </Link>
      </div>
    </Card>
  );
}

function OpportunityCard({ opp }: { opp: OnbActionCenter['opportunities'][0] }) {
  const { role, organizationId, loading: roleLoading } = useOrganizationRole();
  const isDemo = organizationId === 'demo';
  const isAuthorized = role === 'admin' || role === 'owner';
  const canAct = !roleLoading && (isAuthorized || isDemo) && (opp.capabilities?.canAct ?? false);
  return (
    <Card className="p-4 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between bg-[var(--surface)] hover:border-[var(--primary)] transition-colors">
      <div className="flex-1">
        <div className="flex items-center gap-2 mb-1">
          <Badge variant="outline" className="uppercase text-[10px] bg-[var(--primary-light)] text-[var(--primary)] border-[var(--primary)]">Opportunity</Badge>
          <span className={cn(
            "text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded",
            opp.priority === 'critical' || opp.priority === 'high' ? 'bg-[var(--status-amber-bg)] text-[var(--status-amber)]' : 'bg-[var(--surface-alt)] text-[var(--text-muted)]'
          )}>
            {opp.priority} priority
          </span>
        </div>
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">{opp.title}</h4>
        <p className="text-sm text-[var(--text-secondary)] mt-1">{opp.description}</p>

        {opp.benefit.type === 'mandatory-checkpoint' ? (
          <p className="text-[11px] text-[var(--text-muted)] mt-2 italic flex items-center gap-1">
             <CheckCircle2 className="h-3 w-3" /> Could help clear checkpoint: <strong>{opp.benefit.checkpoint}</strong>
          </p>
        ) : opp.benefit.type === 'existing-policy-delta' ? (
          <p className="text-[11px] text-[var(--text-muted)] mt-2 italic flex items-center gap-1">
             <CheckCircle2 className="h-3 w-3" /> Fulfills policy: {opp.benefit.delta || 'Unknown delta'}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 shrink-0 w-full md:w-auto mt-2 md:mt-0">
         <ManualCallDialog caseId={opp.caseId} defaultNotes={`Regarding opportunity: ${opp.title}`} disabled={!canAct} />
         <ActionCenterCreateWork caseId={opp.caseId} actionVersion={opp.actionVersion} reason={opp.description} disabled={!canAct} />
         <Link href={opp.caseHref} className="text-xs font-medium text-[var(--primary)] hover:underline flex items-center ml-2">
           View Case <ChevronRight className="h-3 w-3 ml-1" />
         </Link>
      </div>
    </Card>
  );
}

export function ManualCallDialog({ caseId, defaultNotes = '', personaEnabled = false, disabled = false }: { caseId: number, defaultNotes?: string, personaEnabled?: boolean, disabled?: boolean }) {
  const { role, organizationId, loading: roleLoading } = useOrganizationRole();
  const isDemo = organizationId === 'demo';
  const isAuthorized = role === 'admin' || role === 'owner';
  const canLog = !roleLoading && (isAuthorized || isDemo) && !disabled;
  const isGenuinePaused = false; // The caller should pass disabled if it's paused. We rely on the disabled prop.
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const recordOutcome = useRecordOnboardingActionCenterCallOutcome();

  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState('reached');
  const [notes, setNotes] = useState(defaultNotes);
  const [persona, setPersona] = useState('');

  const { data: c } = useGetOnboardingCase(caseId, {
    query: {
      enabled: open,
      queryKey: getGetOnboardingCaseQueryKey(caseId)
    }
  });

  const handleRecord = () => {
    recordOutcome.mutate({
      data: {
        requestId: uuidv4(),
        caseId,
        outcome: outcome as any,
        notes,
        persona: persona || undefined,
        selfReported: true
      }
    }, {
      onSuccess: () => {
        toast({ title: "Call outcome recorded" });
        setOpen(false);
        queryClient.invalidateQueries({ queryKey: getGetOnboardingActionCenterQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Error recording outcome", description: err.message, variant: 'destructive' });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={(val) => {
      setOpen(val);
      if(val) { setOutcome('reached'); setNotes(defaultNotes); setPersona(''); }
    }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-2" disabled={!canLog}>
          <Phone className="h-3 w-3" /> Log Call
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log Manual Call</DialogTitle>
          <DialogDescription>Record a manual call outcome for Case #{caseId}. This is self-reported and does not verify readiness.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
           {open && c && !isDemo && isAuthorized && c.workerPhone && (
             <div className="mb-2">
               <a href={`tel:${c.workerPhone}`} className="inline-flex items-center gap-2 text-sm font-medium text-[var(--primary)] hover:underline border border-[var(--border)] rounded-md px-3 py-1.5 bg-[var(--surface-alt)]">
                 <Phone className="h-4 w-4" /> Dial {c.workerPhone}
               </a>
             </div>
           )}
           {open && c && !isDemo && isAuthorized && !c.workerPhone && (
             <div className="mb-2 text-sm text-[var(--text-muted)] italic">
               Phone number unavailable
             </div>
           )}
           {open && c && isDemo && (
             <div className="mb-2 text-sm text-[var(--status-amber)] italic bg-[var(--status-amber-bg)] px-3 py-1.5 rounded-md border border-[var(--status-amber)]">
               Simulation log only
             </div>
           )}
           <div className="space-y-2">
             <Label>Outcome</Label>
             <Select value={outcome} onValueChange={setOutcome}>
               <SelectTrigger><SelectValue /></SelectTrigger>
               <SelectContent>
                 <SelectItem value="reached">Reached</SelectItem>
                 <SelectItem value="no-answer">No Answer</SelectItem>
                 <SelectItem value="left-voicemail">Left Voicemail</SelectItem>
                 <SelectItem value="wrong-number">Wrong Number</SelectItem>
                 <SelectItem value="scheduled">Scheduled</SelectItem>
                 <SelectItem value="declined">Declined</SelectItem>
                 <SelectItem value="other">Other</SelectItem>
               </SelectContent>
             </Select>
           </div>

           {isDemo && (
           <div className="space-y-2">
             <Label>Demo Persona (Optional)</Label>
             <Input value={persona} onChange={e => setPersona(e.target.value)} placeholder="e.g. VIP Demo" />
             <p className="text-[10px] text-[var(--text-muted)]">Allowed only in Demo Organization. Records as demo metadata.</p>
           </div>
           )}

           <div className="space-y-2">
             <Label>Notes</Label>
             <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Call details..." className="min-h-[80px]" />
           </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleRecord} disabled={recordOutcome.isPending}>
            {recordOutcome.isPending ? 'Saving...' : 'Save Outcome'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CompletedTab() {
  const { data, isLoading } = useGetOnboardingActionCenter({ scope: 'completed' });

  if (isLoading) return <div className="py-12 text-center text-sm text-[var(--text-muted)]">Loading completed actions...</div>;
  if (!data || data.completed.length === 0) {
    return <div className="py-12 text-center text-sm text-[var(--text-muted)]">No completed actions found.</div>;
  }

  return (
    <div className="space-y-3">
      {data.completed.map(c => (
        <Card key={c.id} className="p-4 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between bg-[var(--surface)] opacity-75">
          <div className="flex-1">
             <div className="flex items-center gap-2 mb-1">
               <Badge variant="outline" className="uppercase text-[10px] bg-[var(--status-green-bg)] text-[var(--status-green)] border-[var(--status-green)]">
                 Completed
               </Badge>
               <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] bg-[var(--surface-alt)] px-1.5 py-0.5 rounded">
                 Case #{c.caseId}
               </span>
               <span className="text-xs text-[var(--text-muted)]">{format(new Date(c.createdAt), 'MMM d, HH:mm')}</span>
             </div>
             <h4 className="text-sm font-medium text-[var(--text-primary)]">{c.summary}</h4>
             <p className="text-xs text-[var(--text-secondary)] mt-1">By {c.actor} • {c.kind}</p>
          </div>
          <div className="shrink-0">
             <Link href={c.caseHref} className="text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--primary)] hover:underline flex items-center">
               Case Context <ChevronRight className="h-3 w-3 ml-1" />
             </Link>
          </div>
        </Card>
      ))}
    </div>
  );
}


export function CommunicationsTab() {
  const { data, isLoading } = useGetOnboardingActionCenter({ scope: 'all' });
  const search = useSearch();
  const searchParams = new URLSearchParams(search);
  const filterCaseId = searchParams.get('caseId');
  const [searchTerm, setSearchTerm] = useState(filterCaseId ? `case:${filterCaseId}` : '');
  const { role, organizationId, loading: roleLoading } = useOrganizationRole();

  if (isLoading) return <div className="py-12 text-center text-sm text-[var(--text-muted)]">Loading communications...</div>;
  if (!data) return <div className="py-12 text-center text-sm text-[var(--status-red)]">Failed to load action center.</div>;

  const isDemo = organizationId === 'demo';
  const isAuthorized = role === 'admin' || role === 'owner';
  const canCall = !roleLoading && (isAuthorized || isDemo);
  const hrefTemplate = data.capabilities.aiCall.hrefTemplate || '/cases/{caseId}?tab=Communications';

  const commsAndNotifications = [
    ...data.notifications.map(n => ({...n, _type: 'notification'})),
    ...data.completed.filter(c => c.kind.includes('call') || c.kind.includes('comm')).map(c => ({...c, _type: 'completed'}))
  ];

  const filtered = commsAndNotifications.filter(item => {
    const term = searchTerm.toLowerCase();
    if (term.startsWith('case:')) {
      const id = term.split(':')[1].trim();
      if (id && item.caseId.toString() !== id) return false;
      return true;
    }
     const row = item as any;
     const text = [row.title, row.summary, row.detail, row.deliveryLabel, row.recipient, row.initiator]
       .filter(value => typeof value === 'string').join(' ').toLowerCase();
    return text.includes(term) || item.caseId.toString() === term;
  }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex-1 w-full max-w-md relative">
          <Input
            type="text"
            placeholder="Search communications, recipients..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full bg-[var(--surface)]"
          />
        </div>
      </div>

      <div className="space-y-3">
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-[var(--text-muted)] border rounded-md border-dashed">
            No communications found.
          </div>
        ) : (
          filtered.map(item => {
            const isCompleted = item._type === 'completed';
            const caseHref = item.caseHref || `/cases/${item.caseId}`;
            const aiCallHref = hrefTemplate.replace('{caseId}', item.caseId.toString());

            return (
              <Card key={item.id} className="p-4 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between bg-[var(--surface)] hover:border-[var(--primary)] transition-colors">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className={cn("uppercase text-[10px]", isCompleted ? "bg-[var(--status-green-bg)] text-[var(--status-green)] border-[var(--status-green)]" : "bg-[var(--primary-light)] text-[var(--primary)] border-[var(--primary)]")}>
                      {isCompleted ? 'Completed' : (item as any).kind}
                    </Badge>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] bg-[var(--surface-alt)] px-1.5 py-0.5 rounded">
                      Case #{item.caseId}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">{format(new Date(item.createdAt), 'MMM d, HH:mm')}</span>
                  </div>

                  <h4 className="text-sm font-semibold text-[var(--text-primary)] mt-1">
                    {(item as any).title || (item as any).summary}
                  </h4>

                  {!isCompleted && (
                    <div className="mt-2 space-y-1">
                      {(item as any).detail && <p className="text-sm text-[var(--text-secondary)]">{(item as any).detail}</p>}
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-[var(--text-secondary)]">
                        {(item as any).deliveryLabel && <span>Delivery: <strong>{(item as any).deliveryLabel}</strong></span>}
                        {(item as any).provenance && <span>Provenance: <strong>{(item as any).provenance}</strong></span>}
                        {(item as any).recipient && <span>Recipient: <strong>{(item as any).recipient}</strong></span>}
                        {(item as any).initiator && <span>Initiator: <strong>{(item as any).initiator}</strong></span>}
                        {(item as any).source && <span>Source: <strong>{(item as any).source}</strong></span>}
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 shrink-0 w-full md:w-auto mt-3 md:mt-0">
                  <ManualCallDialog caseId={item.caseId} defaultNotes={`Regarding: ${(item as any).title || (item as any).summary}`} personaEnabled={false} disabled={!((item as any).capabilities?.canAct ?? false)} />

                  {canCall && ((item as any).capabilities?.canAct ?? false) && (
                    <Link href={aiCallHref} className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3 gap-2">
                      <Phone className="h-3 w-3" /> AI Call
                    </Link>
                  )}

                  <Link href={caseHref} className="text-xs font-medium text-[var(--primary)] hover:underline flex items-center ml-2">
                    Case Context <ChevronRight className="h-3 w-3 ml-1" />
                  </Link>
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
