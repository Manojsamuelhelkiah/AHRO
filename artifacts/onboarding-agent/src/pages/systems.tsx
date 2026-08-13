import React, { useState } from 'react';
import { useListOnboardingConnectors, useUpdateOnboardingConnector, useGetOnboardingChannels, useTestOnboardingChannel, useGetOnboardingSystemWatcher, useGetOnboardingEmailWatch, useSimulateOnboardingWatchEmail, getListOnboardingConnectorsQueryKey, getGetOnboardingChannelsQueryKey, getGetOnboardingSystemWatcherQueryKey, getGetOnboardingEmailWatchQueryKey } from '@workspace/api-client-react';
import { Card, CardHeader, CardTitle, CardContent, Button, Badge, Label, cn, PageHeader } from '@/components/ui-shared';
import { useQueryClient } from '@tanstack/react-query';
import { Server, Zap, Mail, Smartphone, Check, X, ArrowRightLeft, Radio, AlertTriangle, Eye, Webhook, RefreshCw, Clock, Inbox, FlaskConical } from 'lucide-react';
import { format } from 'date-fns';

export function SystemsPage() {
  const queryClient = useQueryClient();
  const { data: connectors, isLoading: loadingConn } = useListOnboardingConnectors();
  // Refetch periodically so the inbox-monitor health tracks the background
  // poller instead of freezing at whatever it was on page load.
  const { data: channels, isLoading: loadingChan } = useGetOnboardingChannels({ query: { queryKey: getGetOnboardingChannelsQueryKey(), refetchInterval: 30_000 } });
  // Watcher health refetches on a short interval so polling telemetry stays live.
  const { data: watcher, isLoading: loadingWatcher } = useGetOnboardingSystemWatcher({ query: { queryKey: getGetOnboardingSystemWatcherQueryKey(), refetchInterval: 15_000 } });
  const { data: emailWatch, isLoading: loadingEmailWatch } = useGetOnboardingEmailWatch({ query: { queryKey: getGetOnboardingEmailWatchQueryKey(), refetchInterval: 15_000 } });
  const updateConnector = useUpdateOnboardingConnector();
  const testChannel = useTestOnboardingChannel();

  const invalidateWatch = () => {
    queryClient.invalidateQueries({ queryKey: getListOnboardingConnectorsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetOnboardingSystemWatcherQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetOnboardingEmailWatchQueryKey() });
  };

  const handleTrackingMode = (key: string, trackingMode: 'api' | 'email') => {
    updateConnector.mutate({ key, data: { trackingMode } }, { onSuccess: invalidateWatch });
  };

  const handleToggle = (key: string, connected: boolean) => {
    updateConnector.mutate({ key, data: { status: connected ? 'connected' : 'disconnected' } }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListOnboardingConnectorsQueryKey() })
    });
  };

  const handleSwap = (key: string, vendor: string) => {
    updateConnector.mutate({ key, data: { vendor } }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListOnboardingConnectorsQueryKey() })
    });
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12">
      <PageHeader 
        title="Systems & Integrations" 
        subtitle="Manage system-of-record adapters and outbound communication channels." 
      />

      <div className="space-y-5 mt-2">
        <div className="border-b pb-2" style={{ borderColor: 'var(--border)' }}>
          <h2 className="text-[var(--text-lg)] font-semibold flex items-center gap-2"><Server className="w-5 h-5 text-primary" /> System Adapters</h2>
          <p className="text-[var(--text-sm)] text-muted-foreground mt-1">Source systems that agents read from and write to via MCP.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {loadingConn ? <div className="p-[var(--space-2xl)] text-[var(--text-muted)] col-span-full text-center border rounded-[var(--radius-lg)] border-dashed">Loading adapters...</div> : connectors?.map(conn => (
            <Card key={conn.key} className={cn("transition-all duration-300 shadow-sm", conn.status !== 'connected' && "opacity-75 bg-muted/10")}>
              <CardContent className="p-[var(--space-xl)]">
                <div className="flex justify-between items-start mb-6">
                  <div className="flex items-center gap-4">
                    <div className={cn("p-3 rounded-xl flex items-center justify-center shrink-0 border shadow-sm", conn.status === 'connected' ? "bg-primary/10 text-primary border-primary/20" : "bg-muted text-muted-foreground border-border")}>
                      <Server className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="font-bold text-[var(--text-base)] leading-tight">{conn.label}</h3>
                      <p className="text-[var(--text-sm)] text-muted-foreground mt-1">{conn.description}</p>
                    </div>
                  </div>
                  <label className="flex items-center cursor-pointer shrink-0 mt-1">
                    <div className="relative">
                      <input type="checkbox" className="sr-only" checked={conn.status === 'connected'} onChange={(e) => handleToggle(conn.key, e.target.checked)} disabled={updateConnector.isPending} />
                      <div className={cn("block w-12 h-7 rounded-full transition-colors shadow-inner", conn.status === 'connected' ? "bg-emerald-500" : "bg-slate-300")}></div>
                      <div className={cn("dot absolute left-1 top-1 bg-white w-5 h-5 rounded-full transition-transform shadow-sm", conn.status === 'connected' && "transform translate-x-5")}></div>
                    </div>
                  </label>
                </div>
                
                <div className="flex items-end justify-between gap-4 mt-6 pt-5 border-t border-border">
                  <div className="space-y-1.5 flex-1 max-w-[200px]">
                    <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                      <ArrowRightLeft className="w-3 h-3" /> Active Vendor
                    </Label>
                    <select 
                      className={cn("block w-full text-[var(--text-sm)] font-semibold rounded-[var(--radius-md)] border-input shadow-sm h-[32px] px-3 border outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)] transition-colors", conn.status !== 'connected' ? "bg-muted text-muted-foreground opacity-50" : "bg-background")}
                      value={conn.vendor}
                      onChange={(e) => handleSwap(conn.key, e.target.value)}
                      disabled={conn.status !== 'connected' || updateConnector.isPending}
                    >
                      {conn.availableVendors.map((v: string) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                  {WATCHED_KEYS.includes(conn.key) && (
                    <div className="space-y-1.5 flex-1 max-w-[200px]">
                      <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                        <Eye className="w-3 h-3" /> Status Tracking
                      </Label>
                      <select
                        className="block w-full text-[var(--text-sm)] font-semibold rounded-[var(--radius-md)] border-input shadow-sm h-[32px] px-3 border outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)] transition-colors bg-background"
                        value={conn.trackingMode}
                        onChange={(e) => handleTrackingMode(conn.key, e.target.value as 'api' | 'email')}
                        disabled={updateConnector.isPending}
                      >
                        <option value="api">Deep integration (API)</option>
                        <option value="email">Email watch (no API)</option>
                      </select>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <div className="space-y-5 pt-8">
        <div className="border-b pb-2">
          <h2 className="text-xl font-semibold flex items-center gap-2"><Eye className="w-5 h-5 text-primary" /> System Watcher</h2>
          <p className="text-sm text-muted-foreground">Monitoring agent tracking BGV, ITSM access and payroll status — webhook push where the vendor supports it, scheduled polling otherwise.</p>
        </div>
        {loadingWatcher ? (
          <div className="p-8 text-muted-foreground text-center border rounded-xl border-dashed">Loading watcher status...</div>
        ) : watcher ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {watcher.connectors.map((c: any) => <WatcherConnectorCard key={c.key} conn={c} />)}
            </div>
            <WatcherChecksTable checks={watcher.checks} />
          </>
        ) : null}
      </div>

      <div className="space-y-5 pt-8">
        <div className="border-b pb-2">
          <h2 className="text-xl font-semibold flex items-center gap-2"><Inbox className="w-5 h-5 text-primary" /> Email Watch</h2>
          <p className="text-sm text-muted-foreground">Shallow-integration fallback: when a system offers no API or webhook, vendors simply CC status emails to the watch mailbox — the System Watcher reads them as status changes.</p>
        </div>
        {loadingEmailWatch ? (
          <div className="p-8 text-muted-foreground text-center border rounded-xl border-dashed">Loading email watch status...</div>
        ) : emailWatch ? (
          <EmailWatchPanel
            watch={emailWatch}
            checks={(watcher?.checks ?? []).filter((c: any) => c.mode === 'email' && c.status !== 'done')}
            onChanged={invalidateWatch}
          />
        ) : null}
      </div>

      <div className="space-y-5 pt-8">
        <div className="border-b pb-2">
          <h2 className="text-xl font-semibold flex items-center gap-2"><Zap className="w-5 h-5 text-primary" /> Messaging Channels</h2>
          <p className="text-sm text-muted-foreground">Outbound communication targets used by agents to contact hires.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {loadingChan ? <div className="p-8 text-muted-foreground col-span-full text-center border rounded-xl border-dashed">Loading channels...</div> : (
            <>
              {channels?.email && <ChannelCard key="email" channelKey="email" channel={channels.email} onTest={() => testChannel.mutateAsync({ data: { channel: 'email' } })} />}
              {channels?.whatsapp && <ChannelCard key="whatsapp" channelKey="whatsapp" channel={channels.whatsapp} onTest={() => testChannel.mutateAsync({ data: { channel: 'whatsapp' } })} />}
            </>
          )}
        </div>
      </div>

      <div className="space-y-5 pt-8">
        <div className="border-b pb-2">
          <h2 className="text-xl font-semibold flex items-center gap-2"><Radio className="w-5 h-5 text-primary" /> Live Inbox Monitoring</h2>
          <p className="text-sm text-muted-foreground">Background Gmail polling that picks up real email replies from hires.</p>
        </div>
        {loadingChan ? (
          <div className="p-8 text-muted-foreground text-center border rounded-xl border-dashed">Loading monitor status...</div>
        ) : channels?.inboundEmail ? (
          <InboundMonitorCard monitor={channels.inboundEmail} />
        ) : null}
      </div>

    </div>
  );
}

const WATCHED_KEYS = ['bgv', 'itsm', 'payroll'];

function EmailWatchPanel({ watch, checks, onChanged }: { watch: any, checks: any[], onChanged: () => void }) {
  const simulate = useSimulateOnboardingWatchEmail();
  const [lastResult, setLastResult] = useState<string | null>(null);
  const healthy = watch.state === 'healthy';
  const initializing = watch.state === 'initializing';
  const fmt = (iso: string | null) => (iso ? format(new Date(iso), 'MMM d, HH:mm:ss') : 'Never');

  const doSimulate = (check: any, outcome: 'completed' | 'exception') => {
    simulate.mutate({ data: { caseId: check.caseId, system: check.system, outcome } }, {
      onSuccess: (res: any) => { setLastResult(res.message); onChanged(); },
      onError: () => setLastResult('Simulation request failed'),
    });
  };

  return (
    <div className="space-y-5">
      <Card className={cn("shadow-sm border", healthy ? "border-emerald-200" : initializing ? "border-amber-200" : "border-red-200")}>
        <CardContent className="p-6">
          <div className="flex items-start justify-between mb-5">
            <div className="flex items-center gap-4">
              <div className={cn("p-3 rounded-xl flex items-center justify-center shrink-0 border shadow-sm", healthy ? "bg-emerald-100 text-emerald-600 border-emerald-200" : initializing ? "bg-amber-100 text-amber-600 border-amber-200" : "bg-red-100 text-red-600 border-red-200")}>
                <Inbox className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-bold uppercase tracking-wider text-sm">Watch Mailbox</h3>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Vendors CC status emails quoting the tracking reference to{' '}
                  {watch.mailbox ? <span className="font-mono text-xs bg-secondary px-1 rounded">{watch.mailbox}</span> : <span className="italic">the connected Gmail account</span>}
                  {' '}— scanned every {watch.pollIntervalSeconds}s.
                </p>
              </div>
            </div>
            <Badge className={cn("uppercase tracking-wider text-[10px] shadow-none shrink-0", healthy ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-emerald-200" : initializing ? "bg-amber-100 text-amber-800 hover:bg-amber-100 border-amber-200" : "bg-red-100 text-red-800 hover:bg-red-100 border-red-200")}>
              {healthy ? 'HEALTHY' : initializing ? 'INITIALIZING' : watch.state === 'stopped' ? 'NOT RUNNING' : 'BROKEN'}
            </Badge>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="border rounded-md p-3 bg-muted/20">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Last Scan</p>
              <p className="text-sm font-mono mt-1">{fmt(watch.lastPollAt)}</p>
            </div>
            <div className="border rounded-md p-3 bg-muted/20">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Last Success</p>
              <p className="text-sm font-mono mt-1">{fmt(watch.lastSuccessAt)}</p>
            </div>
            <div className="border rounded-md p-3 bg-muted/20">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Checks On Email Watch</p>
              <p className="text-sm font-mono mt-1">{watch.openChecks}</p>
            </div>
          </div>
          {watch.lastError && (
            <div className="p-3 mt-4 text-sm rounded-md border flex items-start gap-3 bg-red-50 border-red-200 text-red-900">
              <X className="w-5 h-5 shrink-0 mt-0.5 text-red-600" />
              <p className="font-mono text-xs break-all opacity-90">{watch.lastError}</p>
            </div>
          )}

          {checks.length > 0 && (
            <div className="pt-5 mt-5 border-t space-y-3">
              <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <FlaskConical className="w-3.5 h-3.5" /> Demo: simulate a vendor status email
              </Label>
              <div className="space-y-2">
                {checks.map((c: any) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 border rounded-md p-2.5 bg-muted/10">
                    <p className="text-sm font-medium">
                      #{c.caseId} {c.caseWorkerName} — {c.label} <span className="font-mono text-xs text-muted-foreground">({c.externalRef})</span>
                    </p>
                    <div className="flex gap-2 shrink-0">
                      <Button size="sm" variant="outline" className="h-8 gap-1 text-emerald-700 border-emerald-200 hover:bg-emerald-50" disabled={simulate.isPending} onClick={() => doSimulate(c, 'completed')}>
                        <Check className="w-3.5 h-3.5" /> Completed
                      </Button>
                      <Button size="sm" variant="outline" className="h-8 gap-1 text-red-700 border-red-200 hover:bg-red-50" disabled={simulate.isPending} onClick={() => doSimulate(c, 'exception')}>
                        <AlertTriangle className="w-3.5 h-3.5" /> Exception
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              {lastResult && (
                <div className="p-2.5 text-xs rounded-md border bg-secondary/50 font-medium">{lastResult}</div>
              )}
            </div>
          )}
          {checks.length === 0 && (
            <p className="text-sm text-muted-foreground mt-5 pt-5 border-t">
              No open checks are on email watch. Switch a system adapter above to <span className="font-semibold">Email watch (no API)</span> and its open checks will be tracked through the mailbox instead.
            </p>
          )}
        </CardContent>
      </Card>

      {watch.recent.length > 0 && (
        <Card className="shadow-sm">
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-left">
                  <th className="px-[var(--space-md)] py-[var(--space-sm)] text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Received</th>
                  <th className="px-[var(--space-md)] py-[var(--space-sm)] text-[10px] font-bold uppercase tracking-wider text-muted-foreground">From</th>
                  <th className="px-[var(--space-md)] py-[var(--space-sm)] text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Subject</th>
                  <th className="px-[var(--space-md)] py-[var(--space-sm)] text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Read As</th>
                  <th className="px-[var(--space-md)] py-[var(--space-sm)] text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Watcher Action</th>
                </tr>
              </thead>
              <tbody>
                {watch.recent.map((e: any) => (
                  <tr key={e.id} className="border-b last:border-0 hover:bg-muted/10 transition-colors">
                    <td className="px-[var(--space-md)] py-[var(--space-sm)] font-mono text-[var(--text-xs)] whitespace-nowrap">{fmt(e.receivedAt)}</td>
                    <td className="px-[var(--space-md)] py-[var(--space-sm)] font-mono text-[var(--text-xs)]">{e.fromAddress}</td>
                    <td className="px-[var(--space-md)] py-[var(--space-sm)] max-w-[280px] truncate text-[var(--text-xs)]" title={e.subject ?? ''}>{e.subject ?? '—'}</td>
                    <td className="px-[var(--space-md)] py-[var(--space-sm)]">
                      <Badge className={cn("uppercase tracking-wider text-[10px] shadow-none",
                        e.parsedStatus === 'completed' ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-emerald-200"
                          : e.parsedStatus === 'exception' ? "bg-red-100 text-red-800 hover:bg-red-100 border-red-200"
                            : "bg-sky-100 text-sky-800 hover:bg-sky-100 border-sky-200")}>
                        {e.parsedStatus}
                      </Badge>
                    </td>
                    <td className="px-[var(--space-md)] py-[var(--space-sm)] text-[var(--text-xs)] text-muted-foreground max-w-[300px] truncate" title={e.action}>{e.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function WatcherConnectorCard({ conn }: { conn: any }) {
  const healthy = conn.state === 'healthy';
  const initializing = conn.state === 'initializing';
  const isPush = conn.mode === 'push';
  const fmt = (iso: string | null) => (iso ? format(new Date(iso), 'MMM d, HH:mm:ss') : 'Never');
  return (
    <Card className={cn("shadow-sm border", healthy ? "border-emerald-200" : initializing ? "border-amber-200" : "border-red-200")}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className={cn("p-2.5 rounded-xl flex items-center justify-center shrink-0 border shadow-sm", healthy ? "bg-emerald-100 text-emerald-600 border-emerald-200" : initializing ? "bg-amber-100 text-amber-600 border-amber-200" : "bg-red-100 text-red-600 border-red-200")}>
              {isPush ? <Webhook className="w-5 h-5" /> : <RefreshCw className="w-5 h-5" />}
            </div>
            <div>
              <h3 className="font-bold text-sm leading-tight">{conn.label}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isPush ? 'Webhook push from vendor' : `Polled every ${conn.pollIntervalSeconds}s`}
              </p>
            </div>
          </div>
          <Badge className={cn("uppercase tracking-wider text-[10px] shadow-none shrink-0", healthy ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-emerald-200" : initializing ? "bg-amber-100 text-amber-800 hover:bg-amber-100 border-amber-200" : "bg-red-100 text-red-800 hover:bg-red-100 border-red-200")}>
            {healthy ? 'HEALTHY' : initializing ? 'INITIALIZING' : conn.state === 'stopped' ? 'NOT RUNNING' : 'BROKEN'}
          </Badge>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          {isPush ? (
            <>
              <div className="border rounded-md p-2 bg-muted/20">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Last Event</p>
                <p className="font-mono mt-0.5">{fmt(conn.lastEventAt)}</p>
              </div>
              <div className="border rounded-md p-2 bg-muted/20">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Events Received</p>
                <p className="font-mono mt-0.5">{conn.eventsReceived}</p>
              </div>
            </>
          ) : (
            <>
              <div className="border rounded-md p-2 bg-muted/20">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Last Poll</p>
                <p className="font-mono mt-0.5">{fmt(conn.lastPollAt)}</p>
              </div>
              <div className="border rounded-md p-2 bg-muted/20">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Last Success</p>
                <p className="font-mono mt-0.5">{fmt(conn.lastSuccessAt)}</p>
              </div>
            </>
          )}
        </div>
        {conn.lastError && (
          <div className="p-2 mt-3 text-xs rounded-md border flex items-start gap-2 bg-red-50 border-red-200 text-red-900">
            <X className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
            <p className="font-mono break-all opacity-90">{conn.lastError}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InboundMonitorCard({ monitor }: { monitor: any }) {
  const healthy = monitor.state === 'healthy';
  const initializing = monitor.state === 'initializing';
  const badgeLabel = healthy ? 'HEALTHY' : initializing ? 'INITIALIZING' : monitor.state === 'stopped' ? 'NOT RUNNING' : 'BROKEN';
  const fmt = (iso: string | null) => (iso ? format(new Date(iso), 'MMM d, HH:mm:ss') : 'Never');
  return (
    <Card className={cn("shadow-sm border", healthy ? "border-emerald-200" : initializing ? "border-amber-200" : "border-red-200")}>
      <CardContent className="p-6">
        <div className="flex items-start justify-between mb-5">
          <div className="flex items-center gap-4">
            <div className={cn("p-3 rounded-xl flex items-center justify-center shrink-0 border shadow-sm", healthy ? "bg-emerald-100 text-emerald-600 border-emerald-200" : initializing ? "bg-amber-100 text-amber-600 border-amber-200" : "bg-red-100 text-red-600 border-red-200")}>
              {healthy || initializing ? <Radio className="w-6 h-6" /> : <AlertTriangle className="w-6 h-6" />}
            </div>
            <div>
              <h3 className="font-bold uppercase tracking-wider text-sm">Gmail Reply Monitor</h3>
              <p className="text-sm text-muted-foreground mt-0.5">
                Checks the inbox every {monitor.pollIntervalSeconds}s for replies from active hires.
              </p>
            </div>
          </div>
          <Badge className={cn("uppercase tracking-wider text-[10px] shadow-none", healthy ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-emerald-200" : initializing ? "bg-amber-100 text-amber-800 hover:bg-amber-100 border-amber-200" : "bg-red-100 text-red-800 hover:bg-red-100 border-red-200")}>
            {badgeLabel}
          </Badge>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="border rounded-md p-3 bg-muted/20">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Last Poll</p>
            <p className="text-sm font-mono mt-1">{fmt(monitor.lastPollAt)}</p>
          </div>
          <div className="border rounded-md p-3 bg-muted/20">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Last Success</p>
            <p className="text-sm font-mono mt-1">{fmt(monitor.lastSuccessAt)}</p>
          </div>
          <div className="border rounded-md p-3 bg-muted/20">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Last Error</p>
            <p className="text-sm font-mono mt-1">{monitor.lastErrorAt ? fmt(monitor.lastErrorAt) : 'None'}</p>
          </div>
        </div>

        {monitor.lastError && (
          <div className="p-3 mt-4 text-sm rounded-md border flex items-start gap-3 bg-red-50 border-red-200 text-red-900">
            <X className="w-5 h-5 shrink-0 mt-0.5 text-red-600" />
            <div>
              <p className="font-bold">Latest poll failed</p>
              <p className="font-mono text-xs mt-1 opacity-80 break-all">{monitor.lastError}</p>
            </div>
          </div>
        )}
        {monitor.alertEmailConfigured === false && (
          <div className="p-3 mt-4 text-sm rounded-md border flex items-start gap-3 bg-amber-50 border-amber-200 text-amber-900">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-amber-600" />
            <div>
              <p className="font-bold">Alert emails are not configured</p>
              <p className="text-xs mt-1 opacity-90">
                If inbox monitoring goes down, no one will be emailed — the outage will only be visible here.
                Set the <span className="font-mono">HR_ALERT_EMAIL</span> environment variable on the API server to enable outage alert emails.
              </p>
            </div>
          </div>
        )}
        {!monitor.lastError && !healthy && (
          <p className="text-sm text-muted-foreground mt-4">
            {initializing
              ? 'Started recently — waiting for the first poll to complete.'
              : monitor.running
                ? 'No successful poll recently — the loop may be stalled. Check the server logs.'
                : 'The polling loop has not been started in this server process.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ChannelCard({ channelKey, channel, onTest }: { channelKey: string, channel: any, onTest: () => Promise<any> }) {
  const [result, setResult] = useState<any>(null);
  const [testing, setTesting] = useState(false);

  const doTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await onTest();
      setResult(res);
    } catch (e) {
      setResult({ success: false, error: 'Request failed to reach server.' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card className="shadow-sm">
      <CardContent className="p-6">
        <div className="flex items-start justify-between mb-5">
          <div className="flex items-center gap-4">
            <div className={cn("p-3 rounded-xl flex items-center justify-center shrink-0 border shadow-sm", channel.configured ? (channelKey === 'whatsapp' ? "bg-emerald-100 text-emerald-600 border-emerald-200" : "bg-blue-100 text-blue-600 border-blue-200") : "bg-muted text-muted-foreground border-border")}>
              {channelKey === 'whatsapp' ? <Smartphone className="w-6 h-6" /> : <Mail className="w-6 h-6" />}
            </div>
            <div>
              <h3 className="font-bold uppercase tracking-wider text-sm">{channelKey}</h3>
              <p className="text-sm text-muted-foreground mt-0.5">{channel.provider} {channel.target && <span className="font-mono text-xs ml-1 bg-secondary px-1 rounded">{channel.target}</span>}</p>
            </div>
          </div>
          <Badge variant={channel.configured ? 'default' : 'secondary'} className={cn("uppercase tracking-wider text-[10px]", channel.configured ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-emerald-200 shadow-none' : '')}>
            {channel.configured ? 'CONFIGURED' : 'UNCONFIGURED'}
          </Badge>
        </div>
        
        {channel.note && <p className="text-sm bg-secondary/50 border p-3 rounded-md mb-5 text-secondary-foreground leading-relaxed">{channel.note}</p>}
        
        <div className="pt-5 border-t space-y-3 bg-muted/10 -mx-6 -mb-6 p-6">
          <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Send Test Message</Label>
          <div className="flex gap-2">
            <Button size="lg" onClick={doTest} disabled={testing} className="w-full gap-2 h-10 font-bold">
              <Zap className="w-4 h-4" /> TEST {channelKey.toUpperCase()}
            </Button>
          </div>
          {result && (
            <div className={cn("p-3 mt-3 text-sm rounded-md border flex items-start gap-3 shadow-sm", result.ok ? "bg-emerald-50 border-emerald-200 text-emerald-900" : "bg-red-50 border-red-200 text-red-900")}>
              {result.ok ? <Check className="w-5 h-5 shrink-0 mt-0.5 text-emerald-600" /> : <X className="w-5 h-5 shrink-0 mt-0.5 text-red-600" />}
              <div>
                <p className="font-bold">{result.ok ? 'Test Successful' : 'Test Failed'}</p>
                <p className="font-mono text-xs mt-1 opacity-80">{result.detail}</p>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function WatcherChecksTable({ checks }: { checks: any[] }) {
  const open = checks.filter(c => c.status !== 'done');
  const recent = checks.filter(c => c.status === 'done').slice(0, 5);
  const rows = [...open, ...recent];
  const fmt = (iso: string | null) => (iso ? format(new Date(iso), 'MMM d, HH:mm:ss') : '—');
  if (rows.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground text-center border rounded-xl border-dashed">No tracked checks yet — run a scenario or create a case and the watcher will start tracking BGV, ITSM and payroll automatically.</div>;
  }
  return (
    <Card className="shadow-sm">
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30 text-left">
              <th className="px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Case</th>
              <th className="px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">System</th>
              <th className="px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Ref</th>
              <th className="px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Mode</th>
              <th className="px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Status</th>
              <th className="px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">SLA Due</th>
              <th className="px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Completed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(c => (
              <tr key={c.id} className="border-b last:border-0">
                <td className="px-4 py-2.5 font-medium whitespace-nowrap">#{c.caseId} {c.caseWorkerName}</td>
                <td className="px-4 py-2.5 whitespace-nowrap">{c.label}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{c.externalRef}</td>
                <td className="px-4 py-2.5">
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    {c.mode === 'push' ? <Webhook className="w-3.5 h-3.5" /> : c.mode === 'email' ? <Inbox className="w-3.5 h-3.5" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    {c.mode}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <Badge className={cn("uppercase tracking-wider text-[10px] shadow-none",
                    c.status === 'done' ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-emerald-200"
                      : c.status === 'overdue' ? "bg-red-100 text-red-800 hover:bg-red-100 border-red-200"
                        : "bg-amber-100 text-amber-800 hover:bg-amber-100 border-amber-200")}>
                    {c.status === 'overdue' && <AlertTriangle className="w-3 h-3 mr-1" />}
                    {c.status === 'pending' && <Clock className="w-3 h-3 mr-1" />}
                    {c.status}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs whitespace-nowrap">{fmt(c.dueAt)}</td>
                <td className="px-4 py-2.5 font-mono text-xs whitespace-nowrap">{fmt(c.completedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
