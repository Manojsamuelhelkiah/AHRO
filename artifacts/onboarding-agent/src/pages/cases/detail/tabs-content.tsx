import React, { useState } from 'react';
import { format } from 'date-fns';
import { CheckCircle2, Clock, AlertTriangle, XCircle, FileText, FileCheck2, MessageSquare, Phone, Smartphone, Mail, Send, PhoneCall, Archive, Star, RotateCcw } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent, Button, cn, Input } from '@/components/ui-shared';
import { EngineBadge, HitlBadge } from '@/components/engine-badge';
import { useReceiveOnboardingInbound, getListOnboardingCaseCommunicationsQueryKey, getListOnboardingCaseEventsQueryKey, useStartOnboardingVoiceCall, useRetryOnboardingCaseEmail } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { WhatsAppSandboxWarning } from '@/components/whatsapp-sandbox-warning';
import { StatusBadgeText } from './components';

export function TasksTab({ c }: { c: any }) {
  return (
    <div className="space-y-6 pb-12 max-w-4xl">
      <Card>
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-[var(--text-base)]">Execution Plan</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <p className="text-[var(--text-sm)] text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
            {c.planSummary || "Plan generation pending..."}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-[var(--text-base)]">Workstreams</CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-4">
          {c.workstreams?.map((w: any) => (
            <div key={w.key} className="p-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-alt)]">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[var(--text-base)] font-bold">{w.label}</span>
                <StatusBadgeText status={w.status} />
              </div>
              <div className="text-[var(--text-sm)] text-[var(--text-secondary)] space-y-2">
                <div className="flex gap-2">
                  <span className="w-16 font-semibold text-[var(--text-muted)] text-[11px] uppercase tracking-wider">Agent:</span> 
                  <span className="font-mono bg-[var(--surface)] px-1.5 py-0.5 rounded text-[11px]">{w.agent}</span>
                </div>
                <div className="flex gap-2">
                  <span className="w-16 font-semibold text-[var(--text-muted)] text-[11px] uppercase tracking-wider">Owner:</span> 
                  <span>{w.owner}</span>
                </div>
                {w.blockers && w.blockers.length > 0 && (
                  <div className="mt-3 p-3 rounded-[var(--radius-md)] bg-[var(--status-red-bg)] border border-[var(--status-red)] text-[var(--status-red-fg)]">
                    <strong className="text-[11px] uppercase tracking-wider">Blockers:</strong>
                    <ul className="list-disc pl-5 mt-1 space-y-1">
                      {w.blockers.map((b: string, i: number) => <li key={i}>{b}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-[var(--text-base)]">Readiness Detail</CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-3">
          {c.readiness?.map((r: any) => (
            <div key={r.key} className="flex items-start gap-3 p-3 hover:bg-[var(--surface-alt)] rounded-[var(--radius-md)] transition-colors border border-transparent hover:border-[var(--border)]">
              <div className="mt-0.5">
                {r.status === 'ready' && <CheckCircle2 className="w-4 h-4 text-[var(--status-green)]" />}
                {r.status === 'pending' && <Clock className="w-4 h-4 text-[var(--text-muted)] opacity-50" />}
                {r.status === 'in-progress' && <Clock className="w-4 h-4 text-[var(--status-blue)]" />}
                {r.status === 'exception' && <XCircle className="w-4 h-4 text-[var(--status-red)]" />}
              </div>
              <div className="flex-1">
                <p className="text-[var(--text-sm)] font-bold">{r.label}</p>
                {r.note && <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mt-1">{r.note}</p>}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function DocumentsTab({ docs }: { docs: any[] }) {
  return (
    <div className="pb-12 max-w-4xl">
      <Card>
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-[var(--text-base)] flex items-center gap-2"><FileText className="w-4 h-4 text-[var(--primary)]" /> Document Checklist</CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-3">
          {(docs ?? []).length === 0 && <p className="text-[var(--text-sm)] text-[var(--text-muted)]">Documentation pack not issued yet.</p>}
          {(docs ?? []).map((d: any) => (
            <div key={d.key} className="flex items-start gap-4 p-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-alt)]">
              <div className="mt-0.5 bg-[var(--surface)] p-2 rounded-full shadow-sm">
                {d.status === 'verified' && <FileCheck2 className="w-4 h-4 text-[var(--status-green)]" />}
                {d.status === 'received' && <Clock className="w-4 h-4 text-[var(--status-blue)]" />}
                {d.status === 'pending' && <Clock className="w-4 h-4 text-[var(--text-muted)] opacity-50" />}
              </div>
              <div className="flex-1">
                <p className="text-[var(--text-sm)] font-bold leading-snug">
                  {d.label}
                  {!d.required && <span className="ml-2 text-[9px] uppercase tracking-wider bg-[var(--surface)] border px-1.5 py-0.5 rounded text-[var(--text-muted)] font-bold">optional</span>}
                </p>
                <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mt-1">
                  <span className={cn("font-bold uppercase tracking-wider text-[10px] mr-2")} style={{ color: d.status === 'verified' ? 'var(--status-green)' : d.status === 'received' ? 'var(--status-blue)' : 'var(--text-muted)' }}>{d.status}</span>
                  {d.note}
                </p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function ActivityTab({ events }: { events: any[] }) {
  return (
    <div className="pb-12 max-w-4xl">
      <Card>
        <CardHeader className="pb-3 border-b shrink-0 bg-[var(--surface-alt)]">
          <CardTitle className="text-[var(--text-base)]">Operational Timeline</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-[var(--border)]">
            {events?.map((e: any) => (
              <div key={e.id} className="p-5 hover:bg-[var(--surface-alt)] transition-colors">
                <div className="flex justify-between items-start mb-2">
                  <EngineBadge engine={e.engine} />
                  <span className="text-[10px] font-mono text-[var(--text-muted)] bg-[var(--surface-alt)] px-1.5 py-0.5 rounded border border-[var(--border)]">{format(new Date(e.createdAt), 'MMM d, HH:mm:ss')}</span>
                </div>
                <p className="text-[var(--text-sm)] font-bold mb-1 leading-snug text-[var(--text-primary)]">{e.title}</p>
                <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mb-3 leading-relaxed">{e.detail}</p>
              </div>
            ))}
            {!events?.length && <div className="p-[var(--space-xl)] text-center text-[var(--text-sm)] text-[var(--text-muted)]">No events logged.</div>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function CommunicationsTab({ caseId, c, comms, channels }: any) {
  const retryEmail = useRetryOnboardingCaseEmail();
  const queryClient = useQueryClient();
  const [retryError, setRetryError] = useState<string | null>(null);
  const retry = (communicationId: number) => {
    setRetryError(null);
    retryEmail.mutate({ id: caseId, communicationId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseCommunicationsQueryKey(caseId) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(caseId) });
      },
      onError: (error: any) => {
        setRetryError(error?.data?.message || error?.message || 'Email retry failed.');
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseCommunicationsQueryKey(caseId) });
      },
    });
  };
  return (
    <div className="pb-12 max-w-4xl space-y-6">
      <WhatsAppSandboxWarning
        caseId={caseId}
        channelPreference={c.channelPreference}
        comms={comms}
        sandbox={channels?.whatsapp}
      />
      <Card className="flex flex-col border-[var(--border)] shadow-[var(--shadow-sm)]">
        <CardHeader className="pb-3 border-b shrink-0 bg-[var(--surface-alt)]">
          <CardTitle className="text-[var(--text-base)] flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-[var(--primary)]" /> Communication History
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 flex-1 bg-[var(--surface-alt)]">
          <div className="p-6 space-y-6">
            {retryError && (
              <div role="alert" className="rounded-[var(--radius-md)] border p-3 text-[var(--text-xs)] text-[var(--status-red)]" style={{ borderColor: 'var(--status-red)', background: 'var(--status-red-bg)' }}>
                {retryError}
              </div>
            )}
            {comms?.map((msg: any) => (
              <div key={msg.id} className={cn("flex flex-col max-w-[85%]", msg.direction === 'inbound' ? "items-start mr-auto" : "items-end ml-auto")}>
                <div className="flex items-center gap-1.5 mb-1.5 px-1">
                  {msg.channel === 'voice' ? <Phone className="h-3.5 w-3.5 text-[var(--violet)]" /> : msg.channel === 'whatsapp' ? <Smartphone className="h-3.5 w-3.5 text-[var(--status-green)]" /> : <Mail className="h-3.5 w-3.5 text-[var(--status-blue)]" />}
                  <span className="text-[10px] text-[var(--text-muted)] uppercase font-bold tracking-wider">{msg.channel}</span>
                  <span className="text-[10px] text-[var(--text-muted)] ml-1 font-mono">{format(new Date(msg.createdAt), 'MMM d, HH:mm')}</span>
                </div>
                <div className={cn("px-4 py-3 rounded-[var(--radius-lg)] text-[var(--text-sm)] shadow-sm border", 
                  msg.channel === 'voice' ? "bg-[var(--surface-soft)] text-[var(--text-primary)] rounded-tr-sm w-full border-[var(--border-strong)]" :
                  msg.direction === 'inbound' ? "bg-[var(--surface)] text-[var(--text-primary)] rounded-tl-sm border-[var(--border)]" : "bg-[var(--primary)] text-white rounded-tr-sm shadow-[var(--shadow-sm)] border-transparent"
                )}>
                  {msg.channel === 'voice' && msg.subject && (
                    <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--violet)] mb-2 flex items-center gap-1.5"><PhoneCall className="h-3.5 w-3.5" /> {msg.subject}</p>
                  )}
                  <p className="whitespace-pre-wrap leading-relaxed">{msg.body}</p>
                </div>
                {msg.direction === 'outbound' && (
                  <div className="flex flex-col items-end gap-1.5 mt-1.5 px-1 max-w-full">
                    <div className="flex flex-wrap justify-end items-center gap-1.5">
                    <span className={cn("text-[9px] font-bold uppercase tracking-wider", 
                      msg.status === 'failed' ? 'text-[var(--status-red)]' :
                      msg.status === 'delivered' || msg.status === 'sent' ? 'text-[var(--status-green)]' :
                      msg.status === 'sending' ? 'text-[var(--status-amber)]' : 'text-[var(--text-muted)]'
                    )}>{msg.status}</span>
                    {msg.sensitive && <span className="text-[9px] bg-[var(--surface-soft)] text-[var(--status-amber)] border px-1.5 py-0.5 rounded font-bold" style={{ borderColor: 'var(--status-amber)' }}>SENSITIVE</span>}
                    {msg.channel === 'email'
                      && msg.audience === 'candidate'
                      && ['failed', 'logged-only'].includes(msg.status)
                      && !/^\[AP-\d+\](?:\s|$)/i.test((msg.subject ?? '').trim())
                      && !/^Onboarding channel test$/i.test((msg.subject ?? '').trim())
                      && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1.5 text-[10px]"
                        disabled={retryEmail.isPending}
                        onClick={() => retry(msg.id)}
                      >
                        <RotateCcw className="h-3 w-3" />
                        {retryEmail.isPending && retryEmail.variables?.communicationId === msg.id ? 'Retrying…' : 'Retry email'}
                      </Button>
                    )}
                    </div>
                    {msg.failureReason && (
                      <p className="text-[10px] leading-relaxed text-right max-w-md m-0" style={{ color: msg.status === 'failed' ? 'var(--status-red)' : 'var(--text-secondary)' }}>
                        {msg.failureReason}
                      </p>
                    )}
                    {msg.retriedAt && <span className="text-[9px] text-[var(--text-muted)]">Retried {format(new Date(msg.retriedAt), 'MMM d, HH:mm')}{msg.retriedBy ? ` by ${msg.retriedBy}` : ''}</span>}
                  </div>
                )}
              </div>
            ))}
            {!comms?.length && <div className="text-center text-[var(--text-sm)] text-[var(--text-muted)] pt-8 pb-8">No communications yet.</div>}
          </div>
        </CardContent>
      </Card>

      <details className="border border-[var(--border)] rounded-[var(--radius-lg)] bg-[var(--surface)] overflow-hidden shadow-sm">
        <summary className="p-4 font-bold text-[var(--text-sm)] cursor-pointer hover:bg-[var(--surface-alt)] select-none uppercase tracking-wider text-[var(--text-secondary)] text-[11px]">
          Simulation Tools (Development Only)
        </summary>
        <div className="p-5 border-t border-[var(--border)] space-y-6 bg-[var(--surface-alt)]">
          <div className="space-y-2">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Simulate Hire Reply</h4>
            <ReplyComposer caseId={caseId} />
          </div>
          <div className="space-y-2">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Simulate Voice Actions</h4>
            <SimulateVoiceCall caseId={caseId} />
          </div>
        </div>
      </details>
    </div>
  );
}

function ReplyComposer({ caseId }: { caseId: number }) {
  const receiveInbound = useReceiveOnboardingInbound();
  const queryClient = useQueryClient();
  const [channel, setChannel] = useState('email');
  const [content, setContent] = useState('');

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    receiveInbound.mutate({ 
      id: caseId,
      data: { channel, body: content.trim() } 
    }, {
      onSuccess: () => {
        setContent('');
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseCommunicationsQueryKey(caseId) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(caseId) });
      }
    });
  };

  return (
    <form onSubmit={handleSend} className="flex gap-2 w-full max-w-2xl">
      <select value={channel} onChange={(e) => setChannel(e.target.value)} className="text-[var(--text-sm)] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-2 shadow-sm h-[32px] w-28 font-medium focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)] focus:outline-none" style={{ color: 'var(--text-primary)' }}>
        <option value="email">Email</option>
        <option value="whatsapp">WhatsApp</option>
      </select>
      <Input value={content} onChange={(e) => setContent(e.target.value)} placeholder="Type a simulated reply from the hire..." className="flex-1 text-[var(--text-sm)]" />
      <Button type="submit" size="icon" disabled={receiveInbound.isPending || !content.trim()}>
        <Send className="h-4 w-4" />
      </Button>
    </form>
  );
}

function SimulateVoiceCall({ caseId }: { caseId: number }) {
  const startCall = useStartOnboardingVoiceCall();
  const queryClient = useQueryClient();
  const [note, setNote] = useState<string | null>(null);

  const place = (scenario: 'day-before' | 'sla-escalation') => {
    setNote(null);
    startCall.mutate({ id: caseId, data: { scenario, simulate: true } }, {
      onSuccess: (res) => {
        setNote(res.note);
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseCommunicationsQueryKey(caseId) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(caseId) });
      },
      onError: () => setNote('Simulation request failed.'),
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="bg-[var(--surface)]" onClick={() => place('day-before')} disabled={startCall.isPending}>Simulate Day-before Call</Button>
        <Button size="sm" variant="outline" className="bg-[var(--surface)]" onClick={() => place('sla-escalation')} disabled={startCall.isPending}>Simulate Escalation Call</Button>
      </div>
      {note && <p className="text-[var(--text-xs)] font-mono text-[var(--text-muted)] bg-[var(--surface)] p-2 rounded border border-[var(--border)] inline-block">{note}</p>}
    </div>
  );
}

export function AuditTab({ events, approvals, records }: any) {
  return (
    <div className="space-y-8 pb-12 max-w-5xl">
      <div>
        <h2 className="text-[var(--text-lg)] font-bold text-[var(--text-primary)] mb-4">Execution Trace</h2>
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] overflow-hidden shadow-[var(--shadow-sm)]">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[600px]">
              <thead className="bg-[var(--surface-alt)] border-b border-[var(--border)] text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold">
                <tr>
                  <th className="p-4 font-bold">Timestamp</th>
                  <th className="p-4 font-bold">Engine</th>
                  <th className="p-4 font-bold">Event / Detail</th>
                  <th className="p-4 font-bold">Technical Refs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {events?.map((e: any) => (
                  <tr key={e.id} className="hover:bg-[var(--surface-alt)] transition-colors">
                    <td className="p-4 text-[var(--text-xs)] font-mono text-[var(--text-secondary)] whitespace-nowrap align-top">{format(new Date(e.createdAt), 'HH:mm:ss.SSS')}</td>
                    <td className="p-4 align-top"><EngineBadge engine={e.engine} /></td>
                    <td className="p-4 align-top min-w-[250px]">
                      <p className="text-[var(--text-sm)] font-bold text-[var(--text-primary)]">{e.title}</p>
                      <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mt-1">{e.detail}</p>
                    </td>
                    <td className="p-4 align-top space-y-2 min-w-[180px]">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[9px] bg-[var(--surface)] text-[var(--text-secondary)] px-1.5 py-0.5 rounded font-mono border border-[var(--border)]">{e.agent}</span>
                        {e.ruleRef && <span className="text-[9px] bg-[var(--surface)] text-[var(--text-secondary)] px-1.5 py-0.5 rounded font-mono border border-[var(--border)]">{e.ruleRef}</span>}
                      </div>
                      {e.hitlPattern && <div><HitlBadge pattern={e.hitlPattern} /></div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      
      {records && records.length > 0 && (
         <div>
           <h2 className="text-[var(--text-lg)] font-bold text-[var(--text-primary)] mb-4">Past Employment Records</h2>
           <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             {records.map((r: any) => {
               const noticeShortfall = r.noticeServedDays < r.noticeRequiredDays;
               return (
                 <div key={r.id} className="p-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)] space-y-2">
                   <div className="flex items-start justify-between gap-2">
                     <div>
                       <p className="text-[var(--text-sm)] font-bold leading-snug text-[var(--text-primary)]">{r.role}</p>
                       <p className="text-[var(--text-xs)] text-[var(--text-secondary)]">{r.department} • {r.startDate} → {r.endDate}</p>
                     </div>
                     <span className={cn("text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider shrink-0")} style={{ backgroundColor: r.rehireEligible ? 'var(--status-green-bg)' : 'var(--status-red-bg)', color: r.rehireEligible ? 'var(--status-green-fg)' : 'var(--status-red-fg)' }}>
                       {r.rehireEligible ? 'Rehire-eligible' : 'Not eligible'}
                     </span>
                   </div>
                   <p className="text-[var(--text-xs)] text-[var(--text-secondary)]"><strong className="text-[var(--text-muted)]">Exit:</strong> {r.exitReason}</p>
                   <div className="flex flex-wrap items-center gap-3 text-[var(--text-xs)] pt-2 border-t border-[var(--border)]">
                     <span className={cn("font-medium")} style={{ color: noticeShortfall ? 'var(--status-amber)' : 'var(--text-secondary)' }}>
                       Notice: {r.noticeServedDays}/{r.noticeRequiredDays} days{noticeShortfall ? ' (shortfall)' : ''}
                     </span>
                     <span className="flex items-center gap-1 font-medium text-[var(--text-secondary)]">
                       <Star className="w-3.5 h-3.5 text-[var(--status-amber)]" /> {r.performanceRating}/5
                     </span>
                   </div>
                   {r.notes && <p className="text-[var(--text-xs)] text-[var(--text-secondary)] italic bg-[var(--surface-alt)] p-2 rounded mt-2">"{r.notes}"</p>}
                 </div>
               );
             })}
           </div>
         </div>
      )}
    </div>
  );
}
