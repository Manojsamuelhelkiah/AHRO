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

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">Loading case details...</div>;
  if (!c) return <div className="p-8 text-center text-destructive">Case not found.</div>;

  const isLive = c.orchestrationStatus === 'running' || c.orchestrationStatus === 'waiting-approval';

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* HEADER */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-card p-6 rounded-xl border shadow-sm">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{c.workerName}</h1>
            <Badge variant="outline">{c.hireType}</Badge>
            {c.urgency !== 'normal' && <Badge variant="destructive">{c.urgency}</Badge>}
            {isLive && <span className="flex items-center gap-1.5 text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-md border border-blue-200 shadow-sm"><span className="w-1.5 h-1.5 bg-blue-600 rounded-full animate-pulse" /> LIVE</span>}
          </div>
          <p className="text-muted-foreground mt-1 text-sm font-medium">{c.role} • {c.geography} • Joining {format(new Date(c.joiningDate), 'MMM d, yyyy')}</p>
          <div className="flex gap-4 mt-3 text-xs text-muted-foreground bg-secondary/50 inline-flex p-2 rounded-md">
            <span><strong>Email:</strong> {c.workerEmail}</span>
            {c.workerPhone && <span><strong>Phone:</strong> {c.workerPhone}</span>}
            <span className="flex items-center gap-1">
              <strong>Contact via:</strong>
              {(c.channelPreference === 'email' || c.channelPreference === 'both') && <Mail className="h-3 w-3 text-blue-600" />}
              {(c.channelPreference === 'whatsapp' || c.channelPreference === 'both') && <Smartphone className="h-3 w-3 text-emerald-600" />}
              {c.channelPreference === 'both' ? 'Email + WhatsApp' : c.channelPreference === 'whatsapp' ? 'WhatsApp' : 'Email'}
            </span>
            <span><strong>Manager:</strong> {c.managerName}</span>
            <span><strong>Recruiter:</strong> {c.recruiterName}</span>
          </div>
        </div>
        <div className="text-right flex flex-col items-end gap-2">
          <div>
            <div className="text-xs font-bold text-muted-foreground mb-1 tracking-wider">STAGE: {c.lifecycleStage.toUpperCase()}</div>
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
              <CardTitle className="text-base">Day-1 Readiness</CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              {c.readiness?.map(r => (
                <div key={r.key} className="flex items-start gap-3">
                  <div className="mt-0.5">
                    {r.status === 'ready' && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                    {r.status === 'pending' && <Clock className="w-4 h-4 text-slate-300" />}
                    {r.status === 'in-progress' && <Clock className="w-4 h-4 text-blue-500 animate-pulse" />}
                    {r.status === 'exception' && <XCircle className="w-4 h-4 text-red-500" />}
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold">{r.label}</p>
                    {r.note && <p className="text-xs text-muted-foreground mt-0.5">{r.note}</p>}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-base flex items-center gap-2"><FileText className="w-4 h-4 text-primary" /> Document Checklist</CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-2.5">
              {(docs ?? []).length === 0 && <p className="text-sm text-muted-foreground">Documentation pack not issued yet.</p>}
              {(docs ?? []).map(d => (
                <div key={d.key} className="flex items-start gap-3">
                  <div className="mt-0.5">
                    {d.status === 'verified' && <FileCheck2 className="w-4 h-4 text-emerald-500" />}
                    {d.status === 'received' && <Clock className="w-4 h-4 text-blue-500" />}
                    {d.status === 'pending' && <Clock className="w-4 h-4 text-slate-300" />}
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium leading-snug">
                      {d.label}
                      {!d.required && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-bold">optional</span>}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      <span className={cn("font-bold uppercase tracking-wider text-[10px] mr-1.5",
                        d.status === 'verified' ? 'text-emerald-600' : d.status === 'received' ? 'text-blue-600' : 'text-slate-400')}>{d.status}</span>
                      {d.note}
                    </p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-base">AI Plan Summary</CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
                {c.planSummary || "Plan generation pending..."}
              </p>
            </CardContent>
          </Card>

          {c.hireType === 'rehire' && <PastEmploymentCard caseId={caseId} />}

          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-base">Workstreams</CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              {c.workstreams?.map(w => (
                <div key={w.key} className="p-3 rounded-lg border bg-secondary/20">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold">{w.label}</span>
                    <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider", 
                      w.status === 'ready' ? 'text-emerald-700 bg-emerald-100 border border-emerald-200' :
                      w.status === 'blocked' ? 'text-red-700 bg-red-100 border border-red-200' :
                      w.status === 'in-progress' ? 'text-blue-700 bg-blue-100 border border-blue-200' : 'text-slate-600 bg-slate-100 border border-slate-200'
                    )}>{w.status}</span>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-1">
                    <p>Agent: <span className="font-mono bg-secondary px-1 py-0.5 rounded text-secondary-foreground">{w.agent}</span></p>
                    <p>Owner: {w.owner}</p>
                    {w.blockers && w.blockers.length > 0 && (
                      <div className="mt-2 p-2 bg-red-50 border border-red-100 rounded text-red-700">
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
            <CardHeader className="pb-3 border-b shrink-0 bg-muted/20">
              <CardTitle className="text-base">Agent Activity Feed</CardTitle>
            </CardHeader>
            <CardContent className="p-0 flex-1 overflow-y-auto">
              <div className="divide-y divide-border/50">
                {events?.map((e) => (
                  <div key={e.id} className="p-4 hover:bg-muted/10 transition-colors">
                    <div className="flex justify-between items-start mb-2">
                      <EngineBadge engine={e.engine} />
                      <span className="text-[10px] font-mono text-muted-foreground bg-secondary/50 px-1 py-0.5 rounded">{format(new Date(e.createdAt), 'HH:mm:ss.SSS')}</span>
                    </div>
                    <p className="text-sm font-semibold mb-1 leading-snug">{e.title}</p>
                    <p className="text-xs text-muted-foreground mb-3 leading-relaxed">{e.detail}</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[9px] bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded font-mono border">{e.agent}</span>
                      {e.ruleRef && <span className="text-[9px] bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded font-mono border">{e.ruleRef}</span>}
                      {e.hitlPattern && <HitlBadge pattern={e.hitlPattern} />}
                    </div>
                  </div>
                ))}
                {!events?.length && <div className="p-6 text-center text-sm text-muted-foreground">No events logged.</div>}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* RIGHT COL: Comms */}
        <div className="lg:col-span-1">
          <Card className="h-full max-h-[800px] flex flex-col">
            <CardHeader className="pb-3 border-b shrink-0 bg-muted/20">
              <CardTitle className="text-base flex items-center gap-2">
                <MessageSquare className="h-4 w-4" /> Communications
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-black/20">
              <div className="p-4 space-y-4">
                {comms?.map(msg => (
                  <div key={msg.id} className={cn("flex flex-col max-w-[90%]", msg.direction === 'inbound' ? "items-start mr-auto" : "items-end ml-auto")}>
                    <div className="flex items-center gap-1 mb-1 px-1">
                      {msg.channel === 'voice' ? <Phone className="h-3 w-3 text-violet-600" /> : msg.channel === 'whatsapp' ? <Smartphone className="h-3 w-3 text-emerald-600" /> : <Mail className="h-3 w-3 text-blue-600" />}
                      <span className="text-[10px] text-muted-foreground uppercase font-bold">{msg.channel}</span>
                      <span className="text-[10px] text-muted-foreground ml-1 font-mono">{format(new Date(msg.createdAt), 'HH:mm')}</span>
                    </div>
                    <div className={cn("px-3 py-2.5 rounded-2xl text-sm shadow-sm", 
                      msg.channel === 'voice' ? "bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800 text-foreground rounded-tr-sm w-full" :
                      msg.direction === 'inbound' ? "bg-white border text-foreground rounded-tl-sm" : "bg-primary text-primary-foreground rounded-tr-sm shadow-primary/20"
                    )}>
                      {msg.channel === 'voice' && msg.subject && (
                        <p className="text-[10px] font-bold uppercase tracking-wider text-violet-600 dark:text-violet-400 mb-1.5 flex items-center gap-1"><PhoneCall className="h-3 w-3" /> {msg.subject}</p>
                      )}
                      <p className="whitespace-pre-wrap leading-relaxed">{msg.body}</p>
                    </div>
                    {msg.direction === 'outbound' && (
                      <div className="flex items-center gap-1 mt-1 px-1">
                        <span className={cn("text-[9px] font-bold uppercase", 
                          msg.status === 'failed' ? 'text-red-500' :
                          msg.status === 'delivered' ? 'text-emerald-500' : 'text-slate-400'
                        )}>{msg.status}</span>
                        {msg.sensitive && <span className="text-[9px] bg-amber-100 text-amber-700 border border-amber-200 px-1 rounded font-bold">SENSITIVE</span>}
                        {msg.failureReason && <span className="text-[9px] text-red-500 truncate max-w-[100px]" title={msg.failureReason}>({msg.failureReason})</span>}
                      </div>
                    )}
                  </div>
                ))}
                {!comms?.length && <div className="text-center text-sm text-muted-foreground pt-4">No communications yet.</div>}
              </div>
            </CardContent>
            <div className="p-3 border-t bg-card shrink-0">
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
        <CardTitle className="text-base flex items-center gap-2">
          <Archive className="w-4 h-4 text-primary" /> Past Employment Records
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">
        {isLoading && <p className="text-sm text-muted-foreground">Loading archive…</p>}
        {!isLoading && (records ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">No archived records found for this worker.</p>
        )}
        {(records ?? []).map((r) => {
          const noticeShortfall = r.noticeServedDays < r.noticeRequiredDays;
          return (
            <div key={r.id} className="p-3 rounded-lg border bg-secondary/20 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold leading-snug">{r.role}</p>
                  <p className="text-xs text-muted-foreground">{r.department} • {r.startDate} → {r.endDate}</p>
                </div>
                <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider border shrink-0",
                  r.rehireEligible ? 'text-emerald-700 bg-emerald-100 border-emerald-200' : 'text-red-700 bg-red-100 border-red-200'
                )}>{r.rehireEligible ? 'Rehire-eligible' : 'Not eligible'}</span>
              </div>
              <p className="text-xs text-muted-foreground"><strong>Exit:</strong> {r.exitReason}</p>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className={cn("font-medium", noticeShortfall ? 'text-amber-700' : 'text-muted-foreground')}>
                  Notice: {r.noticeServedDays}/{r.noticeRequiredDays} days{noticeShortfall ? ' (shortfall)' : ''}
                </span>
                <span className="flex items-center gap-1 text-muted-foreground font-medium">
                  <Star className="w-3 h-3 text-amber-500" /> {r.performanceRating}/5
                </span>
              </div>
              {r.notes && <p className="text-xs text-muted-foreground italic">{r.notes}</p>}
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
        <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" disabled={startCall.isPending || !hasPhone}
          title={hasPhone ? 'AI voice call: day-before-joining check-in' : 'No phone number on file'}
          onClick={() => place('day-before', false)}>
          <PhoneCall className="h-3.5 w-3.5 text-violet-600" /> Day-before call
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" disabled={startCall.isPending || !hasPhone}
          title={hasPhone ? 'AI voice call: chase an overdue onboarding item' : 'No phone number on file'}
          onClick={() => place('sla-escalation', false)}>
          <Phone className="h-3.5 w-3.5 text-amber-600" /> Escalation call
        </Button>
      </div>
      <button type="button" className="text-[10px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50" disabled={startCall.isPending}
        onClick={() => place('day-before', true)}>
        {startCall.isPending ? 'Working…' : 'Run a simulated call instead'}
      </button>
      {note && <p className="text-[10px] text-muted-foreground max-w-[240px] text-right leading-snug">{note}</p>}
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
      <select value={channel} onChange={(e) => setChannel(e.target.value)} className="text-xs rounded border border-input bg-transparent px-2 shadow-sm h-9 w-24 font-medium focus:ring-1 focus:ring-ring focus:outline-none">
        <option value="email">Email</option>
        <option value="whatsapp">WhatsApp</option>
      </select>
      <Input value={content} onChange={(e) => setContent(e.target.value)} placeholder="Simulate hire reply..." className="flex-1 text-sm" />
      <Button type="submit" size="icon" disabled={receiveInbound.isPending || !content.trim()}>
        <Send className="h-4 w-4" />
      </Button>
    </form>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    'not-started': 'bg-slate-100 text-slate-700 border-slate-200',
    'running': 'bg-blue-100 text-blue-700 border-blue-200 shadow-[0_0_15px_rgba(59,130,246,0.3)] animate-pulse',
    'waiting-approval': 'bg-amber-100 text-amber-700 border-amber-200 shadow-[0_0_10px_rgba(245,158,11,0.2)]',
    'blocked': 'bg-red-100 text-red-700 border-red-200',
    'completed': 'bg-emerald-100 text-emerald-700 border-emerald-200',
  };
  return <span className={cn("px-4 py-1.5 rounded-md text-sm font-bold border tracking-wide", colors[status] || 'bg-gray-100')}>{status.toUpperCase()}</span>;
}
