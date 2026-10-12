import React, { useState } from 'react';
import { useListOnboardingConnectors, useUpdateOnboardingConnector, useGetOnboardingChannels, useTestOnboardingChannel, useGetOnboardingSystemWatcher, useGetOnboardingEmailWatch, useSimulateOnboardingWatchEmail, getListOnboardingConnectorsQueryKey, getGetOnboardingChannelsQueryKey, getGetOnboardingSystemWatcherQueryKey, getGetOnboardingEmailWatchQueryKey } from '@workspace/api-client-react';
import { Card, CardHeader, CardTitle, CardContent, Button, Badge, Label, cn, PageHeader, SectionHeading, IconTile, LoadingBlock } from '@/components/ui-shared';
import { useQueryClient } from '@tanstack/react-query';
import { Server, Zap, Mail, Smartphone, Check, X, ArrowRightLeft, Radio, AlertTriangle, Eye, Webhook, RefreshCw, Clock, Inbox, FlaskConical } from 'lucide-react';
import { format } from 'date-fns';
import { MalwareScannerStatus } from '@/components/malware-scanner-status';
import { StandardProvidersPanel } from '@/components/standard-providers-panel';

export function SystemsPage() {
  const queryClient = useQueryClient();
  const { data: connectors, isLoading: loadingConn } = useListOnboardingConnectors();
  const { data: channels, isLoading: loadingChan } = useGetOnboardingChannels({ query: { queryKey: getGetOnboardingChannelsQueryKey(), refetchInterval: 30_000 } });
  const { data: watcher, isLoading: loadingWatcher, isError: watcherError } = useGetOnboardingSystemWatcher({ query: { queryKey: getGetOnboardingSystemWatcherQueryKey(), refetchInterval: 15_000 } });
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
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      <PageHeader 
        title="Systems & Integrations" 
        subtitle="Manage system-of-record adapters and outbound communication channels." 
      />

      <div className="pt-4">
        <StandardProvidersPanel />
      </div>

      <div className="space-y-4 pt-10">
        <div>
          <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Server className="w-4 h-4 text-[var(--primary)]" /> System Adapters (Legacy)
          </h2>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '2px', marginBottom: 0 }}>Legacy adapters for tracking mode and watcher configurations.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {loadingConn ? <LoadingBlock className="col-span-full">Loading adapters...</LoadingBlock> : connectors?.map(conn => (
            <div key={conn.key} style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: conn.status === 'connected' ? 'var(--shadow-sm)' : 'none', opacity: conn.status === 'connected' ? 1 : 0.75, transition: 'all 300ms' }}>
              <div className="p-[var(--space-lg)]">
                <div className="flex justify-between items-start mb-6">
                  <div className="flex items-center gap-4">
                    <IconTile icon={Server} className={cn("border-none shadow-sm", conn.status === 'connected' ? "bg-[var(--status-info-bg)] text-[var(--primary)]" : "bg-[var(--surface-alt)] text-[var(--text-muted)]")} />
                    <div>
                      <h3 className="font-semibold text-[var(--text-base)] text-[var(--text-primary)] leading-tight">{conn.label}</h3>
                      <p className="text-[var(--text-sm)] text-[var(--text-muted)] mt-1 font-medium">{conn.description}</p>
                    </div>
                  </div>
                  <label className="flex items-center cursor-pointer shrink-0 mt-1">
                    <div className="relative">
                      <input type="checkbox" className="sr-only" checked={conn.status === 'connected'} onChange={(e) => handleToggle(conn.key, e.target.checked)} disabled={updateConnector.isPending} />
                      <div className={cn("block w-12 h-7 rounded-full transition-colors shadow-inner", conn.status === 'connected' ? "bg-[var(--status-green-fg)]" : "bg-[var(--border-strong)]")}></div>
                      <div className={cn("dot absolute left-1 top-1 bg-[var(--surface)] w-5 h-5 rounded-full transition-transform shadow-sm", conn.status === 'connected' && "transform translate-x-5")}></div>
                    </div>
                  </label>
                </div>
                
                <div className="flex items-end justify-between gap-4 mt-6 pt-5 border-t border-[var(--border)]">
                  <div className="space-y-2 flex-1 max-w-[200px]">
                    <Label className="text-[var(--text-xs)] font-semibold text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1.5">
                      <ArrowRightLeft className="w-3.5 h-3.5" /> Active Vendor
                    </Label>
                    <select 
                      className={cn("block w-full text-[var(--text-sm)] font-semibold rounded-[var(--radius-md)] shadow-sm h-[36px] px-3 border outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)] transition-colors cursor-pointer", conn.status !== 'connected' ? "bg-[var(--surface-alt)] text-[var(--text-muted)] border-[var(--border)] opacity-60" : "bg-[var(--surface)] text-[var(--text-primary)] border-[var(--border)]")}
                      value={conn.vendor}
                      onChange={(e) => handleSwap(conn.key, e.target.value)}
                      disabled={conn.status !== 'connected' || updateConnector.isPending}
                    >
                      {conn.availableVendors.map((v: string) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                  {WATCHED_KEYS.includes(conn.key) && (
                    <div className="space-y-2 flex-1 max-w-[200px]">
                      <Label className="text-[var(--text-xs)] font-semibold text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1.5">
                        <Eye className="w-3.5 h-3.5" /> Status Tracking
                      </Label>
                      <select
                        className="block w-full text-[var(--text-sm)] font-semibold rounded-[var(--radius-md)] border-[var(--border)] shadow-sm h-[36px] px-3 outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)] transition-colors bg-[var(--surface)] text-[var(--text-primary)] cursor-pointer"
                        value={conn.trackingMode}
                        onChange={(e) => handleTrackingMode(conn.key, e.target.value as 'api' | 'email')}
                        disabled={updateConnector.isPending}
                      >
                        <option value="api">Direct integration</option>
                        <option value="email">Email watch</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        {!loadingChan && channels?.blockedPublishBackup && (
          <BlockedPublishBackupCard readiness={channels.blockedPublishBackup} />
        )}
      </div>

      <div className="space-y-4 pt-4">
        <div>
          <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Eye className="w-4 h-4 text-[var(--primary)]" /> System Watcher
          </h2>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '2px', marginBottom: 0 }}>Monitoring agent tracking BGV, ITSM access and payroll status — webhook push where the vendor supports it, scheduled polling otherwise.</p>
        </div>
        {loadingWatcher ? (
          <LoadingBlock>Loading watcher status...</LoadingBlock>
        ) : watcher ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {watcher.connectors.map((c: any) => <WatcherConnectorCard key={c.key} conn={c} />)}
            </div>
            <div className="mt-6">
              <WatcherChecksTable checks={watcher.checks} />
            </div>
          </>
        ) : null}
        <div className="mt-6">
          <MalwareScannerStatus
            status={watcher?.malwareScanner}
            loading={loadingWatcher}
            error={watcherError}
          />
        </div>
      </div>

      <div className="space-y-4 pt-4">
        <div>
          <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Inbox className="w-4 h-4 text-[var(--primary)]" /> Email Watch
          </h2>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '2px', marginBottom: 0 }}>Email watch tracks status emails sent to the watched mailbox for Background Verification, ITSM / Ticketing, and Payroll & Benefits. It does not grant system access.</p>
        </div>
        {loadingEmailWatch ? (
          <LoadingBlock>Loading email watch status...</LoadingBlock>
        ) : emailWatch ? (
          <EmailWatchPanel
            watch={emailWatch}
            checks={(watcher?.checks ?? []).filter((c: any) => c.mode === 'email' && c.status !== 'done')}
            onChanged={invalidateWatch}
          />
        ) : null}
      </div>

      <div className="space-y-4 pt-4">
        <div>
          <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Zap className="w-4 h-4 text-[var(--primary)]" /> Messaging Channels
          </h2>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '2px', marginBottom: 0 }}>Outbound communication targets used by agents to contact hires.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {loadingChan ? <LoadingBlock className="col-span-full">Loading channels...</LoadingBlock> : (
            <>
              {channels?.email && <ChannelCard key="email" channelKey="email" channel={channels.email} onTest={() => testChannel.mutateAsync({ data: { channel: 'email' } })} />}
              {channels?.whatsapp && <ChannelCard key="whatsapp" channelKey="whatsapp" channel={channels.whatsapp} onTest={() => testChannel.mutateAsync({ data: { channel: 'whatsapp' } })} />}
            </>
          )}
        </div>
      </div>

      <div className="space-y-4 pt-4">
        <div>
          <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Radio className="w-4 h-4 text-[var(--primary)]" /> Live Inbox Monitoring
          </h2>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '2px', marginBottom: 0 }}>Background Gmail polling that picks up real email replies from hires.</p>
        </div>
        {loadingChan ? (
          <LoadingBlock>Loading monitor status...</LoadingBlock>
        ) : channels?.inboundEmail ? (
          <InboundMonitorCard monitor={channels.inboundEmail} />
        ) : null}
      </div>

    </div>
  );
}

export function BlockedPublishBackupCard({ readiness }: { readiness: {
  ready: boolean;
  destination: string | null;
  sender: string | null;
  missing: string[];
  invalid: string[];
  note: string;
} }) {
  return (
    <div className={cn(
      "rounded-[var(--radius-lg)] border p-[var(--space-lg)] shadow-[var(--shadow-sm)]",
      readiness.ready
        ? "border-[var(--status-green-fg)] bg-[var(--status-green-bg)]"
        : "border-[var(--status-amber-fg)] bg-[var(--status-amber-bg)]",
    )}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <IconTile
            icon={readiness.ready ? Check : AlertTriangle}
            className={cn(
              "border-none shadow-sm",
              readiness.ready
                ? "bg-[var(--surface)] text-[var(--status-green-fg)]"
                : "bg-[var(--surface)] text-[var(--status-amber-fg)]",
            )}
          />
          <div>
            <h3 className="font-semibold text-[var(--text-sm)] text-[var(--text-primary)]">
              Blocked-release backup alerts
            </h3>
            <p className="mt-1 text-[var(--text-sm)] font-medium text-[var(--text-secondary)]">
              {readiness.note}
            </p>
          </div>
        </div>
        <Badge className={cn(
          "shrink-0 border-none text-[var(--text-xs)] font-semibold shadow-none",
          readiness.ready
            ? "bg-[var(--surface)] text-[var(--status-green-fg)]"
            : "bg-[var(--surface)] text-[var(--status-amber-fg)]",
        )}>
          {readiness.ready ? "READY" : "NEEDS ATTENTION"}
        </Badge>
      </div>
      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-[var(--radius-md)] bg-[var(--surface)] p-3">
          <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Backup destination
          </p>
          <p className="mt-1.5 font-mono text-[var(--text-sm)] font-medium text-[var(--text-primary)]">
            {readiness.destination ?? "Not configured"}
          </p>
        </div>
        <div className="rounded-[var(--radius-md)] bg-[var(--surface)] p-3">
          <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Twilio sender
          </p>
          <p className="mt-1.5 font-mono text-[var(--text-sm)] font-medium text-[var(--text-primary)]">
            {readiness.sender ?? "Not configured"}
          </p>
        </div>
      </div>
      {readiness.missing.length > 0 && (
        <div className="mt-4 rounded-[var(--radius-md)] bg-[var(--surface)] p-3">
          <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Missing configuration
          </p>
          <ul className="mt-2 space-y-1 text-[var(--text-sm)] font-medium text-[var(--text-primary)]">
            {readiness.missing.map((category) => (
              <li key={category}>{category}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-4 text-[var(--text-xs)] font-medium text-[var(--text-secondary)]">
        Readiness only — this check does not send an alert.
      </p>
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

  const getBadgeColor = () => {
    if (healthy) return 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]';
    if (initializing) return 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]';
    return 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)]';
  };

  return (
    <div className="space-y-6">
      <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)' }}>
        <div className="p-[var(--space-lg)]">
          <div className="flex items-start justify-between mb-6">
            <div className="flex items-center gap-4">
              <IconTile icon={Inbox} className={cn("border-none shadow-sm", getBadgeColor())} />
              <div>
                <h3 className="font-semibold text-[var(--text-sm)] text-[var(--text-primary)]">Watch Mailbox</h3>
                <p className="text-[var(--text-sm)] text-[var(--text-muted)] mt-1 font-medium">
                  Vendors CC status emails quoting the tracking reference to{' '}
                  {watch.mailbox ? <span className="font-mono text-[var(--text-xs)] bg-[var(--surface-soft)] px-1.5 py-0.5 rounded text-[var(--text-primary)]">{watch.mailbox}</span> : <span className="italic">the connected Gmail account</span>}
                  {' '}— scanned every {watch.pollIntervalSeconds}s.
                </p>
              </div>
            </div>
            <Badge className={cn("text-[var(--text-xs)] shadow-none shrink-0 border-none font-semibold", getBadgeColor())}>
              {healthy ? 'HEALTHY' : initializing ? 'INITIALIZING' : watch.state === 'stopped' ? 'NOT RUNNING' : 'BROKEN'}
            </Badge>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="rounded-[var(--radius-md)] p-3 bg-[var(--surface-soft)] border border-transparent">
              <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Last Scan</p>
              <p className="text-[var(--text-sm)] font-mono font-medium mt-1.5 text-[var(--text-primary)]">{fmt(watch.lastPollAt)}</p>
            </div>
            <div className="rounded-[var(--radius-md)] p-3 bg-[var(--surface-soft)] border border-transparent">
              <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Last Success</p>
              <p className="text-[var(--text-sm)] font-mono font-medium mt-1.5 text-[var(--text-primary)]">{fmt(watch.lastSuccessAt)}</p>
            </div>
            <div className="rounded-[var(--radius-md)] p-3 bg-[var(--surface-soft)] border border-transparent">
              <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Checks On Email Watch</p>
              <p className="text-[var(--text-sm)] font-mono font-medium mt-1.5 text-[var(--text-primary)]">{watch.openChecks}</p>
            </div>
          </div>
          {watch.lastError && (
            <div className="p-4 mt-5 rounded-[var(--radius-md)] flex items-start gap-3 bg-[var(--status-red-bg)] text-[var(--status-red-fg)]">
              <X className="w-5 h-5 shrink-0 mt-0.5" />
              <p className="font-mono text-[var(--text-xs)] font-medium break-all">{watch.lastError}</p>
            </div>
          )}

          {false && checks.length > 0 && (
            <div className="pt-6 mt-6 border-t border-[var(--border)] space-y-4">
              <Label className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-2">
                <FlaskConical className="w-4 h-4 text-[var(--primary)]" /> Demo: simulate a vendor status email
              </Label>
              <div className="space-y-3">
                {checks.map((c: any) => (
                  <div key={c.id} className="flex items-center justify-between gap-4 rounded-[var(--radius-md)] p-3 bg-[var(--surface-alt)] shadow-[var(--shadow-sm)] border border-[var(--border)]">
                    <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">
                      #{c.caseId} {c.caseWorkerName} — {c.label} <span className="font-mono text-[var(--text-xs)] text-[var(--text-muted)] ml-1">({c.externalRef})</span>
                    </p>
                    <div className="flex gap-2 shrink-0">
                      <Button size="sm" className="h-8 gap-1.5 bg-[var(--status-green-bg)] text-[var(--status-green-fg)] hover:opacity-80 shadow-none border-none font-semibold" disabled={simulate.isPending} onClick={() => doSimulate(c, 'completed')}>
                        <Check className="w-4 h-4" /> Completed
                      </Button>
                      <Button size="sm" className="h-8 gap-1.5 bg-[var(--status-red-bg)] text-[var(--status-red-fg)] hover:opacity-80 shadow-none border-none font-semibold" disabled={simulate.isPending} onClick={() => doSimulate(c, 'exception')}>
                        <AlertTriangle className="w-4 h-4" /> Exception
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              {lastResult && (
                <div className="p-3 text-[var(--text-sm)] rounded-[var(--radius-md)] bg-[var(--surface-soft)] font-medium text-[var(--text-primary)] mt-3 border border-[var(--border)]">{lastResult}</div>
              )}
            </div>
          )}
          {checks.length === 0 && (
            <p className="text-[var(--text-sm)] text-[var(--text-muted)] mt-5 pt-5 border-t border-[var(--border)] font-medium">
               No open checks are on Email watch. Switch a supported system above from <span className="font-semibold text-[var(--text-primary)]">Direct integration</span> to <span className="font-semibold text-[var(--text-primary)]">Email watch</span> and its open checks will be tracked through the mailbox instead.
            </p>
          )}
        </div>
      </div>

      {watch.recent.length > 0 && (
        <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)' }}>
          <div className="p-0 overflow-x-auto">
            <table className="w-full text-[var(--text-sm)]">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-alt)] text-left">
                  <th className="px-[var(--space-lg)] py-[var(--space-md)] text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Received</th>
                  <th className="px-[var(--space-lg)] py-[var(--space-md)] text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">From</th>
                  <th className="px-[var(--space-lg)] py-[var(--space-md)] text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Subject</th>
                  <th className="px-[var(--space-lg)] py-[var(--space-md)] text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Read As</th>
                  <th className="px-[var(--space-lg)] py-[var(--space-md)] text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Watcher Action</th>
                </tr>
              </thead>
              <tbody>
                {watch.recent.map((e: any) => (
                  <tr key={e.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-soft)] transition-colors">
                    <td className="px-[var(--space-lg)] py-[var(--space-md)] font-mono text-[var(--text-xs)] whitespace-nowrap text-[var(--text-secondary)] font-medium">{fmt(e.receivedAt)}</td>
                    <td className="px-[var(--space-lg)] py-[var(--space-md)] font-mono text-[var(--text-xs)] text-[var(--text-secondary)] font-medium">{e.fromAddress}</td>
                    <td className="px-[var(--space-lg)] py-[var(--space-md)] max-w-[280px] truncate text-[var(--text-sm)] text-[var(--text-primary)] font-medium" title={e.subject ?? ''}>{e.subject ?? '—'}</td>
                    <td className="px-[var(--space-lg)] py-[var(--space-md)]">
                      <Badge className={cn("text-[var(--text-xs)] shadow-none border-none font-semibold",
                        e.parsedStatus === 'completed' ? "bg-[var(--status-green-bg)] text-[var(--status-green-fg)]"
                          : e.parsedStatus === 'exception' ? "bg-[var(--status-red-bg)] text-[var(--status-red-fg)]"
                            : "bg-[var(--status-info-bg)] text-[var(--status-info-fg)]")}>
                        {e.parsedStatus}
                      </Badge>
                    </td>
                    <td className="px-[var(--space-lg)] py-[var(--space-md)] text-[var(--text-sm)] text-[var(--text-secondary)] max-w-[300px] truncate font-medium" title={e.action}>{e.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function WatcherConnectorCard({ conn }: { conn: any }) {
  const healthy = conn.state === 'healthy';
  const initializing = conn.state === 'initializing';
  const isPush = conn.mode === 'push';
  const fmt = (iso: string | null) => (iso ? format(new Date(iso), 'MMM d, HH:mm:ss') : 'Never');

  const getBadgeColor = () => {
    if (healthy) return 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]';
    if (initializing) return 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]';
    return 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)]';
  };

  return (
    <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)' }}>
      <div className="p-[var(--space-lg)]">
        <div className="flex items-start justify-between mb-5">
          <div className="flex items-center gap-3">
            <IconTile icon={isPush ? Webhook : RefreshCw} className={cn("border-none shadow-sm", getBadgeColor())} />
            <div>
              <h3 className="font-semibold text-[var(--text-base)] text-[var(--text-primary)] leading-tight">{conn.label}</h3>
              <p className="text-[var(--text-sm)] text-[var(--text-muted)] mt-1 font-medium">
                {isPush ? 'Webhook push from vendor' : `Polled every ${conn.pollIntervalSeconds}s`}
              </p>
            </div>
          </div>
          <Badge className={cn("text-[var(--text-xs)] shadow-none shrink-0 border-none font-semibold", getBadgeColor())}>
            {healthy ? 'HEALTHY' : initializing ? 'INITIALIZING' : conn.state === 'stopped' ? 'NOT RUNNING' : 'BROKEN'}
          </Badge>
        </div>
        <div className="grid grid-cols-2 gap-3 text-[var(--text-sm)]">
          {isPush ? (
            <>
              <div className="rounded-[var(--radius-md)] p-3 bg-[var(--surface-soft)]">
                <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Last Event</p>
                <p className="font-mono mt-1 text-[var(--text-primary)] font-medium text-[var(--text-xs)]">{fmt(conn.lastEventAt)}</p>
              </div>
              <div className="rounded-[var(--radius-md)] p-3 bg-[var(--surface-soft)]">
                <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Events Received</p>
                <p className="font-mono mt-1 text-[var(--text-primary)] font-medium text-[var(--text-xs)]">{conn.eventsReceived}</p>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-[var(--radius-md)] p-3 bg-[var(--surface-soft)]">
                <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Last Poll</p>
                <p className="font-mono mt-1 text-[var(--text-primary)] font-medium text-[var(--text-xs)]">{fmt(conn.lastPollAt)}</p>
              </div>
              <div className="rounded-[var(--radius-md)] p-3 bg-[var(--surface-soft)]">
                <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Last Success</p>
                <p className="font-mono mt-1 text-[var(--text-primary)] font-medium text-[var(--text-xs)]">{fmt(conn.lastSuccessAt)}</p>
              </div>
            </>
          )}
        </div>
        {conn.lastError && (
          <div className="p-3 mt-4 text-[var(--text-sm)] rounded-[var(--radius-md)] flex items-start gap-2.5 bg-[var(--status-red-bg)] text-[var(--status-red-fg)] font-medium">
            <X className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="font-mono break-all">{conn.lastError}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function InboundMonitorCard({ monitor }: { monitor: any }) {
  const healthy = monitor.state === 'healthy';
  const initializing = monitor.state === 'initializing';
  const badgeLabel = healthy ? 'HEALTHY' : initializing ? 'INITIALIZING' : monitor.state === 'stopped' ? 'NOT RUNNING' : 'BROKEN';
  const fmt = (iso: string | null) => (iso ? format(new Date(iso), 'MMM d, HH:mm:ss') : 'Never');

  const getBadgeColor = () => {
    if (healthy) return 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]';
    if (initializing) return 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]';
    return 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)]';
  };

  return (
    <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)' }}>
      <div className="p-[var(--space-lg)]">
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center gap-4">
            <IconTile icon={healthy || initializing ? Radio : AlertTriangle} className={cn("border-none shadow-sm", getBadgeColor())} />
            <div>
              <h3 className="font-semibold text-[var(--text-sm)] text-[var(--text-primary)]">Gmail Reply Monitor</h3>
              <p className="text-[var(--text-sm)] text-[var(--text-muted)] mt-1 font-medium">
                Checks the inbox every {monitor.pollIntervalSeconds}s for replies from active hires.
              </p>
            </div>
          </div>
          <Badge className={cn("text-[var(--text-xs)] shadow-none border-none font-semibold", getBadgeColor())}>
            {badgeLabel}
          </Badge>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-[var(--radius-md)] p-3 bg-[var(--surface-soft)]">
            <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Last Poll</p>
            <p className="text-[var(--text-xs)] font-mono font-medium mt-1.5 text-[var(--text-primary)]">{fmt(monitor.lastPollAt)}</p>
          </div>
          <div className="rounded-[var(--radius-md)] p-3 bg-[var(--surface-soft)]">
            <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Last Success</p>
            <p className="text-[var(--text-xs)] font-mono font-medium mt-1.5 text-[var(--text-primary)]">{fmt(monitor.lastSuccessAt)}</p>
          </div>
          <div className="rounded-[var(--radius-md)] p-3 bg-[var(--surface-soft)]">
            <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Last Error</p>
            <p className="text-[var(--text-xs)] font-mono font-medium mt-1.5 text-[var(--text-primary)]">{monitor.lastErrorAt ? fmt(monitor.lastErrorAt) : 'None'}</p>
          </div>
        </div>

        {monitor.lastError && (
          <div className="p-4 mt-5 text-[var(--text-sm)] rounded-[var(--radius-md)] flex items-start gap-3 bg-[var(--status-red-bg)] text-[var(--status-red-fg)]">
            <X className="w-5 h-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Latest poll failed</p>
              <p className="font-mono text-[var(--text-xs)] font-medium mt-1.5 opacity-90 break-all">{monitor.lastError}</p>
            </div>
          </div>
        )}
        {monitor.alertEmailConfigured === false && (
          <div className="p-4 mt-5 text-[var(--text-sm)] rounded-[var(--radius-md)] flex items-start gap-3 bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Alert emails are not configured</p>
              <p className="text-[var(--text-xs)] font-medium mt-1.5 opacity-90 leading-relaxed">
                If inbox monitoring goes down, no one will be emailed — the outage will only be visible here.
                Set the <span className="font-mono bg-[var(--surface)] text-[var(--text-primary)] px-1.5 py-0.5 rounded shadow-sm border border-[var(--border)]">HR_ALERT_EMAIL</span> environment variable on the API server to enable outage alert emails.
              </p>
            </div>
          </div>
        )}
        {!monitor.lastError && !healthy && (
          <p className="text-[var(--text-sm)] text-[var(--text-muted)] mt-5 font-medium border-t border-[var(--border)] pt-5">
            {initializing
              ? 'Started recently — waiting for the first poll to complete.'
              : monitor.running
                ? 'No successful poll recently — the loop may be stalled. Check the server logs.'
                : 'The polling loop has not been started in this server process.'}
          </p>
        )}
      </div>
    </div>
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
    <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      <div className="p-[var(--space-lg)] pb-0">
        <div className="flex items-start justify-between mb-5">
          <div className="flex items-center gap-4">
            <IconTile icon={channelKey === 'whatsapp' ? Smartphone : Mail} className={cn("border-none shadow-sm", channel.configured ? (channelKey === 'whatsapp' ? "bg-[var(--status-green-bg)] text-[var(--status-green-fg)]" : "bg-[var(--status-info-bg)] text-[var(--status-info-fg)]") : "bg-[var(--surface-soft)] text-[var(--text-muted)]")} />
            <div>
              <h3 className="font-semibold capitalize text-[var(--text-sm)] text-[var(--text-primary)]">{channelKey}</h3>
              <p className="text-[var(--text-sm)] text-[var(--text-muted)] mt-1 font-medium">{channel.provider} {channel.target && <span className="font-mono text-[var(--text-xs)] ml-1 bg-[var(--surface-soft)] px-1.5 py-0.5 rounded text-[var(--text-primary)]">{channel.target}</span>}</p>
            </div>
          </div>
          <Badge className={cn("text-[var(--text-xs)] shadow-none border-none font-semibold", channel.configured ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]' : 'bg-[var(--surface-soft)] text-[var(--text-muted)]')}>
            {channel.configured ? 'Configured' : 'Unconfigured'}
          </Badge>
        </div>
        
        {channel.note && <p className="text-[var(--text-sm)] bg-[var(--surface-alt)] border border-[var(--border)] p-3 rounded-[var(--radius-md)] mb-5 text-[var(--text-secondary)] font-medium leading-relaxed">{channel.note}</p>}
      </div>

      <div className="bg-[var(--surface-alt)] p-[var(--space-lg)] mt-2">
        <Label className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-3">Send Test Message</Label>
        <div className="flex gap-3">
          <Button onClick={doTest} disabled={testing} variant="secondary" className="w-full gap-2 font-semibold tracking-wide uppercase text-[var(--text-xs)] h-10 shadow-sm border-[var(--border)] hover:bg-[var(--surface-soft)]">
            <Zap className="w-4 h-4" /> TEST {channelKey.toUpperCase()}
          </Button>
        </div>
        {result && (
          <div className={cn("p-4 mt-4 text-[var(--text-sm)] rounded-[var(--radius-md)] flex items-start gap-3 shadow-sm", result.ok ? "bg-[var(--status-green-bg)] text-[var(--status-green-fg)]" : "bg-[var(--status-red-bg)] text-[var(--status-red-fg)]")}>
            {result.ok ? <Check className="w-5 h-5 shrink-0 mt-0.5" /> : <X className="w-5 h-5 shrink-0 mt-0.5" />}
            <div>
              <p className="font-semibold">{result.ok ? 'Test Successful' : 'Test Failed'}</p>
              <p className="font-mono text-[var(--text-xs)] font-medium mt-1.5 opacity-90">{result.detail}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WatcherChecksTable({ checks }: { checks: any[] }) {
  const open = checks.filter(c => c.status !== 'done');
  const recent = checks.filter(c => c.status === 'done').slice(0, 5);
  const rows = [...open, ...recent];
  const fmt = (iso: string | null) => (iso ? format(new Date(iso), 'MMM d, HH:mm:ss') : '—');
  if (rows.length === 0) {
    return <LoadingBlock>No tracked checks yet — run a scenario or create a case and the watcher will start tracking BGV, ITSM and payroll automatically.</LoadingBlock>;
  }
  return (
    <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      <div className="p-0 overflow-x-auto">
        <table className="w-full text-left" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ backgroundColor: 'var(--surface-alt)', borderBottom: '2px solid var(--border)' }}>
              {['Check', 'Case / Hire', 'System', 'Status', 'SLA Due', 'Completed'].map((h) => (
                <th key={h} style={{ padding: '10px var(--space-lg)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 600 }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(c => (
              <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }} className="last:border-0 hover:bg-[var(--surface-soft)] transition-colors">
                <td style={{ padding: '12px var(--space-lg)' }}>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>{c.label}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px', fontFamily: 'var(--font-mono, monospace)' }}>{c.externalRef}</div>
                </td>
                <td style={{ padding: '12px var(--space-lg)' }}>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>#{c.caseId} {c.caseWorkerName}</div>
                </td>
                <td style={{ padding: '12px var(--space-lg)', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  {c.system}
                  <span style={{ marginLeft: '8px', fontSize: '10px', backgroundColor: 'var(--surface-alt)', padding: '2px 6px', borderRadius: '4px', fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-muted)' }}>{c.mode}</span>
                </td>
                <td style={{ padding: '12px var(--space-lg)' }}>
                  <span style={{ 
                    backgroundColor: c.status === 'done' ? 'var(--status-green-bg)' : c.status === 'failed' ? 'var(--status-red-bg)' : 'var(--status-amber-bg)', 
                    color: c.status === 'done' ? 'var(--status-green-fg)' : c.status === 'failed' ? 'var(--status-red-fg)' : 'var(--status-amber-fg)', 
                    fontSize: 'var(--text-xs)', fontWeight: 600, padding: '3px 8px', borderRadius: '20px', textTransform: 'uppercase', letterSpacing: '0.03em', display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' 
                  }}>
                    {c.status}
                  </span>
                </td>
                <td style={{ padding: '12px var(--space-lg)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono, monospace)' }}>
                  {fmt(c.dueAt)}
                </td>
                <td style={{ padding: '12px var(--space-lg)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono, monospace)' }}>
                  {fmt(c.completedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
