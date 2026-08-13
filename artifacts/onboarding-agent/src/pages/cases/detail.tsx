import React, { useState } from 'react';
import { useParams } from 'wouter';
import { 
  useGetOnboardingCase, 
  useListOnboardingCaseEvents, 
  useListOnboardingCaseCommunications,
  useReceiveOnboardingInbound,
  useStartOnboardingVoiceCall,
  useListOnboardingCaseDocuments,
  getListOnboardingCaseDocumentsQueryKey,
  getGetOnboardingCaseQueryKey,
  getListOnboardingCaseEventsQueryKey,
  getListOnboardingCaseCommunicationsQueryKey,
  useGetOnboardingChannels,
  getGetOnboardingChannelsQueryKey,
  useListOnboardingCaseRecords,
  getListOnboardingCaseRecordsQueryKey
} from '@workspace/api-client-react';
import { WhatsAppSandboxWarning } from '@/components/whatsapp-sandbox-warning';
import { Card, CardHeader, CardTitle, CardContent, Button, Badge, cn, Input } from '@/components/ui-shared';
import { EngineBadge, HitlBadge } from '@/components/engine-badge';
import { format } from 'date-fns';
import { CheckCircle2, Clock, AlertTriangle, XCircle, Send, MessageSquare, Mail, Smartphone, FileText, FileCheck2, Phone, PhoneCall, Archive, Star } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

export function CaseDetailPage() {
  const { id } = useParams();
  const caseId = Number(id);
  
  const { data: c, isLoading } = useGetOnboardingCase(caseId, {
    query: {
      enabled: !!caseId,
      queryKey: getGetOnboardingCaseQueryKey(caseId),
      refetchInterval: (query: any) => {
        const status = query?.state?.data?.orchestrationStatus;
        return (status === 'running' || status === 'waiting-approval') ? 2500 : false;
      }
    }
  });

  const { data: events } = useListOnboardingCaseEvents(caseId, {
    query: {
      enabled: !!caseId,
      queryKey: getListOnboardingCaseEventsQueryKey(caseId),
      refetchInterval: (query: any) => {
        // use local case `c` for events polling conditionally
        return (c?.orchestrationStatus === 'running' || c?.orchestrationStatus === 'waiting-approval') ? 2500 : false;
      }
    }
  });

  const { data: docs } = useListOnboardingCaseDocuments(caseId, {
    query: {
      enabled: !!caseId,
      queryKey: getListOnboardingCaseDocumentsQueryKey(caseId),
    }
  });

  const { data: comms } = useListOnboardingCaseCommunications(caseId, {
    query: {
      enabled: !!caseId,
      queryKey: getListOnboardingCaseCommunicationsQueryKey(caseId),
      refetchInterval: (query: any) => {
        return (c?.orchestrationStatus === 'running' || c?.orchestrationStatus === 'waiting-approval') ? 2500 : false;
      }
    }
  });

  // Sandbox sender number + join keyword for the expiry warning's re-join instructions.
  const { data: channels } = useGetOnboardingChannels({
    query: { enabled: !!caseId, queryKey: getGetOnboardingChannelsQueryKey(), staleTime: 60_000 }
  });

  if (isLoading) return <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>Loading case details...</div>;
  if (!c) return <div className="p-8 text-center text-[var(--status-red)]">Case not found.</div>;

  const isLive = c.orchestrationStatus === 'running' || c.orchestrationStatus === 'waiting-approval';

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* HEADER */}
      <div 
        className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4"
        style={{ 
          padding: 'var(--space-lg) var(--space-xl) var(--space-md)', 
          borderBottom: '1px solid var(--border)', 
          margin: '0 calc(var(--space-xl) * -1) var(--space-lg) calc(var(--space-xl) * -1)',
          backgroundColor: 'var(--surface)'
        }}
      >
        <div>
          <div className="flex items-center gap-3">
            <h1 style={{ fontSize: 'var(--text-2xl)', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.2, margin: 0 }}>{c.workerName}</h1>
            <Badge variant="outline">{c.hireType}</Badge>
            {c.urgency !== 'normal' && <Badge variant="destructive">{c.urgency}</Badge>}
            {isLive && <span className="flex items-center gap-1.5 text-[var(--text-xs)] font-bold text-[var(--status-blue)] bg-[var(--surface-soft)] px-2 py-0.5 rounded-[var(--radius-sm)] border"><span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: 'var(--status-blue)' }} /> LIVE</span>}
          </div>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '4px', fontWeight: 500 }}>{c.role} • {c.geography} • Joining {format(new Date(c.joiningDate), 'MMM d, yyyy')}</p>
          <div className="flex gap-4 mt-3" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            <span><strong>Email:</strong> {c.workerEmail}</span>
            {c.workerPhone && <span><strong>Phone:</strong> {c.workerPhone}</span>}
            <span className="flex items-center gap-1">
              <strong>Contact via:</strong>
              {(c.channelPreference === 'email' || c.channelPreference === 'both') && <Mail className="h-3 w-3 text-[var(--status-blue)]" />}
              {(c.channelPreference === 'whatsapp' || c.channelPreference === 'both') && <Smartphone className="h-3 w-3 text-[var(--status-green)]" />}
              {c.channelPreference === 'both' ? 'Email + WhatsApp' : c.channelPreference === 'whatsapp' ? 'WhatsApp' : 'Email'}
            </span>
            <span><strong>Manager:</strong> {c.managerName}</span>
            <span><strong>Recruiter:</strong> {c.recruiterName}</span>
          </div>
        </div>
        <div className="text-right flex flex-col items-end gap-3">
          <div className="flex items-center gap-3">
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>STAGE: {c.lifecycleStage.toUpperCase()}</div>
            <StatusBadge status={c.orchestrationStatus} />
          </div>
          <VoiceCallButtons caseId={caseId} hasPhone={!!c.workerPhone} />
        </div>
      </div>

      <WhatsAppSandboxWarning
        caseId={caseId}
        channelPreference={c.channelPreference}
        comms={comms}
        sandbox={channels?.whatsapp}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT COL: Readiness & Plan */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-[var(--text-base)]">Day-1 Readiness</CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              {c.readiness?.map(r => (
                <div key={r.key} className="flex items-start gap-3">
                  <div className="mt-0.5">
                    {r.status === 'ready' && <CheckCircle2 className="w-4 h-4 text-[var(--status-green)]" />}
                    {r.status === 'pending' && <Clock className="w-4 h-4 text-[var(--text-muted)] opacity-50" />}
                    {r.status === 'in-progress' && <Clock className="w-4 h-4 text-[var(--status-blue)] animate-pulse" />}
                    {r.status === 'exception' && <XCircle className="w-4 h-4 text-[var(--status-red)]" />}
                  </div>
                  <div className="flex-1">
                    <p className="text-[var(--text-sm)] font-semibold">{r.label}</p>
                    {r.note && <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-0.5">{r.note}</p>}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-[var(--text-base)] flex items-center gap-2"><FileText className="w-4 h-4 text-[var(--primary)]" /> Document Checklist</CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-2.5">
              {(docs ?? []).length === 0 && <p className="text-[var(--text-sm)] text-[var(--text-muted)]">Documentation pack not issued yet.</p>}
              {(docs ?? []).map(d => (
                <div key={d.key} className="flex items-start gap-3">
                  <div className="mt-0.5">
                    {d.status === 'verified' && <FileCheck2 className="w-4 h-4 text-[var(--status-green)]" />}
                    {d.status === 'received' && <Clock className="w-4 h-4 text-[var(--status-blue)]" />}
                    {d.status === 'pending' && <Clock className="w-4 h-4 text-[var(--text-muted)] opacity-50" />}
                  </div>
                  <div className="flex-1">
                    <p className="text-[var(--text-sm)] font-medium leading-snug">
                      {d.label}
                      {!d.required && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold">optional</span>}
                    </p>
                    <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-0.5">
                      <span className={cn("font-bold uppercase tracking-wider text-[10px] mr-1.5")} style={{ color: d.status === 'verified' ? 'var(--status-green)' : d.status === 'received' ? 'var(--status-blue)' : 'var(--text-muted)' }}>{d.status}</span>
                      {d.note}
                    </p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-[var(--text-base)]">AI Plan Summary</CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <p className="text-[var(--text-sm)] text-[var(--text-muted)] whitespace-pre-wrap leading-relaxed">
                {c.planSummary || "Plan generation pending..."}
              </p>
            </CardContent>
          </Card>

          {c.hireType === 'rehire' && <PastEmploymentCard caseId={caseId} />}

          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-[var(--text-base)]">Workstreams</CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              {c.workstreams?.map(w => (
                <div key={w.key} className="p-3 rounded-[var(--radius-md)] border bg-[var(--surface-alt)]">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[var(--text-sm)] font-semibold">{w.label}</span>
                    <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider")} style={{
                      backgroundColor: w.status === 'ready' ? 'var(--surface-soft)' : w.status === 'blocked' ? 'var(--surface)' : w.status === 'in-progress' ? 'var(--surface-soft)' : 'var(--surface)',
                      color: w.status === 'ready' ? 'var(--status-green)' : w.status === 'blocked' ? 'var(--status-red)' : w.status === 'in-progress' ? 'var(--status-blue)' : 'var(--text-muted)',
                      border: '1px solid currentColor',
                      opacity: 0.8
                    }}>{w.status}</span>
                  </div>
                  <div className="text-[var(--text-xs)] text-[var(--text-muted)] space-y-1">
                    <p>Agent: <span className="font-mono bg-[var(--surface)] px-1 py-0.5 rounded text-[var(--text-secondary)]">{w.agent}</span></p>
                    <p>Owner: {w.owner}</p>
                    {w.blockers && w.blockers.length > 0 && (
                      <div className="mt-2 p-2 rounded" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--status-red)', color: 'var(--status-red)' }}>
                        <strong>Blockers:</strong>
                        <ul className="list-disc pl-4 mt-1">
                          {w.blockers.map((b, i) => <li key={i}>{b}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* MIDDLE COL: Activity Feed */}
        <div className="lg:col-span-1">
          <Card className="h-full max-h-[800px] flex flex-col">
            <CardHeader className="pb-3 border-b shrink-0 bg-[var(--surface-alt)]">
              <CardTitle className="text-[var(--text-base)]">Agent Activity Feed</CardTitle>
            </CardHeader>
            <CardContent className="p-0 flex-1 overflow-y-auto">
              <div className="divide-y divide-[var(--border)]">
                {events?.map((e) => (
                  <div key={e.id} className="p-4 hover:bg-[var(--surface-alt)] transition-colors">
                    <div className="flex justify-between items-start mb-2">
                      <EngineBadge engine={e.engine} />
                      <span className="text-[10px] font-mono text-[var(--text-muted)] bg-[var(--surface-alt)] px-1 py-0.5 rounded">{format(new Date(e.createdAt), 'HH:mm:ss.SSS')}</span>
                    </div>
                    <p className="text-[var(--text-sm)] font-semibold mb-1 leading-snug">{e.title}</p>
                    <p className="text-[var(--text-xs)] text-[var(--text-muted)] mb-3 leading-relaxed">{e.detail}</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[9px] bg-[var(--surface-alt)] text-[var(--text-secondary)] px-1.5 py-0.5 rounded font-mono border">{e.agent}</span>
                      {e.ruleRef && <span className="text-[9px] bg-[var(--surface-alt)] text-[var(--text-secondary)] px-1.5 py-0.5 rounded font-mono border">{e.ruleRef}</span>}
                      {e.hitlPattern && <HitlBadge pattern={e.hitlPattern} />}
                    </div>
                  </div>
                ))}
                {!events?.length && <div className="p-[var(--space-xl)] text-center text-[var(--text-sm)] text-[var(--text-muted)]">No events logged.</div>}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* RIGHT COL: Comms */}
        <div className="lg:col-span-1">
          <Card className="h-full max-h-[800px] flex flex-col">
            <CardHeader className="pb-3 border-b shrink-0 bg-[var(--surface-alt)]">
              <CardTitle className="text-[var(--text-base)] flex items-center gap-2">
                <MessageSquare className="h-4 w-4" /> Communications
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 flex-1 overflow-y-auto bg-[var(--surface-alt)]">
              <div className="p-[var(--space-md)] space-y-4">
                {comms?.map(msg => (
                  <div key={msg.id} className={cn("flex flex-col max-w-[90%]", msg.direction === 'inbound' ? "items-start mr-auto" : "items-end ml-auto")}>
                    <div className="flex items-center gap-1 mb-1 px-1">
                      {msg.channel === 'voice' ? <Phone className="h-3 w-3 text-[var(--violet)]" /> : msg.channel === 'whatsapp' ? <Smartphone className="h-3 w-3 text-[var(--status-green)]" /> : <Mail className="h-3 w-3 text-[var(--status-blue)]" />}
                      <span className="text-[10px] text-[var(--text-muted)] uppercase font-bold">{msg.channel}</span>
                      <span className="text-[10px] text-[var(--text-muted)] ml-1 font-mono">{format(new Date(msg.createdAt), 'HH:mm')}</span>
                    </div>
                    <div className={cn("px-3 py-2.5 rounded-[var(--radius-lg)] text-[var(--text-sm)] shadow-sm border", 
                      msg.channel === 'voice' ? "bg-[var(--surface-soft)] text-[var(--text-primary)] rounded-tr-sm w-full border-[var(--border-strong)]" :
                      msg.direction === 'inbound' ? "bg-[var(--surface)] text-[var(--text-primary)] rounded-tl-sm border-[var(--border)]" : "bg-[var(--primary)] text-white rounded-tr-sm shadow-[var(--shadow-sm)] border-transparent"
                    )}>
                      {msg.channel === 'voice' && msg.subject && (
                        <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--violet)] mb-1.5 flex items-center gap-1"><PhoneCall className="h-3 w-3" /> {msg.subject}</p>
                      )}
                      <p className="whitespace-pre-wrap leading-relaxed">{msg.body}</p>
                    </div>
                    {msg.direction === 'outbound' && (
                      <div className="flex items-center gap-1 mt-1 px-1">
                        <span className={cn("text-[9px] font-bold uppercase", 
                          msg.status === 'failed' ? 'text-[var(--status-red)]' :
                          msg.status === 'delivered' ? 'text-[var(--status-green)]' : 'text-[var(--text-muted)]'
                        )}>{msg.status}</span>
                        {msg.sensitive && <span className="text-[9px] bg-[var(--surface-soft)] text-[var(--status-amber)] border px-1 rounded font-bold" style={{ borderColor: 'var(--status-amber)' }}>SENSITIVE</span>}
                        {msg.failureReason && <span className="text-[9px] text-[var(--status-red)] truncate max-w-[100px]" title={msg.failureReason}>({msg.failureReason})</span>}
                      </div>
                    )}
                  </div>
                ))}
                {!comms?.length && <div className="text-center text-[var(--text-sm)] text-[var(--text-muted)] pt-4">No communications yet.</div>}
              </div>
            </CardContent>
            <div className="p-3 border-t bg-[var(--surface)] shrink-0">
              <ReplyComposer caseId={caseId} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function PastEmploymentCard({ caseId }: { caseId: number }) {
  const { data: records, isLoading } = useListOnboardingCaseRecords(caseId, {
    query: { enabled: !!caseId, queryKey: getListOnboardingCaseRecordsQueryKey(caseId) }
  });

  return (
    <Card>
      <CardHeader className="pb-3 border-b">
        <CardTitle className="text-[var(--text-base)] flex items-center gap-2">
          <Archive className="w-4 h-4 text-[var(--primary)]" /> Past Employment Records
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">
        {isLoading && <p className="text-[var(--text-sm)] text-[var(--text-muted)]">Loading archive…</p>}
        {!isLoading && (records ?? []).length === 0 && (
          <p className="text-[var(--text-sm)] text-[var(--text-muted)]">No archived records found for this worker.</p>
        )}
        {(records ?? []).map((r) => {
          const noticeShortfall = r.noticeServedDays < r.noticeRequiredDays;
          return (
            <div key={r.id} className="p-3 rounded-lg border bg-[var(--surface-alt)] space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[var(--text-sm)] font-semibold leading-snug">{r.role}</p>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)]">{r.department} • {r.startDate} → {r.endDate}</p>
                </div>
                <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider border shrink-0")} style={{ color: r.rehireEligible ? 'var(--status-green)' : 'var(--status-red)' }}>
                  {r.rehireEligible ? 'Rehire-eligible' : 'Not eligible'}
                </span>
              </div>
              <p className="text-[var(--text-xs)] text-[var(--text-muted)]"><strong>Exit:</strong> {r.exitReason}</p>
              <div className="flex flex-wrap items-center gap-3 text-[var(--text-xs)]">
                <span className={cn("font-medium")} style={{ color: noticeShortfall ? 'var(--status-amber)' : 'var(--text-muted)' }}>
                  Notice: {r.noticeServedDays}/{r.noticeRequiredDays} days{noticeShortfall ? ' (shortfall)' : ''}
                </span>
                <span className="flex items-center gap-1 font-medium" style={{ color: 'var(--text-muted)' }}>
                  <Star className="w-3 h-3 text-[var(--status-amber)]" /> {r.performanceRating}/5
                </span>
              </div>
              {r.notes && <p className="text-[var(--text-xs)] text-[var(--text-muted)] italic">{r.notes}</p>}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function VoiceCallButtons({ caseId, hasPhone }: { caseId: number; hasPhone: boolean }) {
  const startCall = useStartOnboardingVoiceCall();
  const queryClient = useQueryClient();
  const [note, setNote] = useState<string | null>(null);

  const place = (scenario: 'day-before' | 'sla-escalation', simulate: boolean) => {
    setNote(null);
    startCall.mutate({ id: caseId, data: { scenario, simulate } }, {
      onSuccess: (res) => {
        setNote(res.note);
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseCommunicationsQueryKey(caseId) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(caseId) });
      },
      onError: () => setNote('Call request failed — see the activity feed.'),
    });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="h-8 text-[var(--text-xs)] gap-1.5" disabled={startCall.isPending || !hasPhone}
          title={hasPhone ? 'AI voice call: day-before-joining check-in' : 'No phone number on file'}
          onClick={() => place('day-before', false)}>
          <PhoneCall className="h-3.5 w-3.5 text-[var(--violet)]" /> Day-before call
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-[var(--text-xs)] gap-1.5" disabled={startCall.isPending || !hasPhone}
          title={hasPhone ? 'AI voice call: chase an overdue onboarding item' : 'No phone number on file'}
          onClick={() => place('sla-escalation', false)}>
          <Phone className="h-3.5 w-3.5 text-[var(--status-amber)]" /> Escalation call
        </Button>
      </div>
      <button type="button" className="text-[10px] underline-offset-2 hover:underline disabled:opacity-50" style={{ color: 'var(--text-muted)' }} disabled={startCall.isPending}
        onClick={() => place('day-before', true)}>
        {startCall.isPending ? 'Working…' : 'Run a simulated call instead'}
      </button>
      {note && <p className="text-[10px] max-w-[240px] text-right leading-snug" style={{ color: 'var(--text-muted)' }}>{note}</p>}
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
    <form onSubmit={handleSend} className="flex gap-2">
      <select value={channel} onChange={(e) => setChannel(e.target.value)} className="text-[var(--text-sm)] rounded-[var(--radius-md)] border border-[var(--border)] bg-transparent px-2 shadow-sm h-[32px] w-28 font-medium focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)] focus:outline-none" style={{ color: 'var(--text-primary)' }}>
        <option value="email">Email</option>
        <option value="whatsapp">WhatsApp</option>
      </select>
      <Input value={content} onChange={(e) => setContent(e.target.value)} placeholder="Simulate hire reply..." className="flex-1 text-[var(--text-sm)]" />
      <Button type="submit" size="icon" disabled={receiveInbound.isPending || !content.trim()}>
        <Send className="h-4 w-4" />
      </Button>
    </form>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isRunning = status === 'running' || status === 'waiting-approval';
  const style = isRunning
    ? { backgroundColor: 'var(--surface-soft)', color: 'var(--status-green)' }
    : { backgroundColor: 'var(--surface-alt)', color: 'var(--text-muted)' };

  return (
    <span style={{ ...style, fontSize: '11px', fontWeight: 600, padding: '4px 10px', borderRadius: '20px', textTransform: 'uppercase', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      {isRunning && <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: 'var(--status-green)' }}></span>}
      {status === 'not-started' ? 'IDLE' : status}
    </span>
  );
}
