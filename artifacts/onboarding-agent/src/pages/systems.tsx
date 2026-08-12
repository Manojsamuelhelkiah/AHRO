import React, { useState } from 'react';
import { useListOnboardingConnectors, useUpdateOnboardingConnector, useGetOnboardingChannels, useTestOnboardingChannel, getListOnboardingConnectorsQueryKey, getGetOnboardingChannelsQueryKey } from '@workspace/api-client-react';
import { Card, CardHeader, CardTitle, CardContent, Button, Badge, Label, cn } from '@/components/ui-shared';
import { useQueryClient } from '@tanstack/react-query';
import { Server, Zap, Mail, Smartphone, Check, X, ArrowRightLeft } from 'lucide-react';
import { format } from 'date-fns';

export function SystemsPage() {
  const queryClient = useQueryClient();
  const { data: connectors, isLoading: loadingConn } = useListOnboardingConnectors();
  const { data: channels, isLoading: loadingChan } = useGetOnboardingChannels();
  const updateConnector = useUpdateOnboardingConnector();
  const testChannel = useTestOnboardingChannel();

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
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Systems & Integrations</h1>
        <p className="text-muted-foreground mt-1">Manage system-of-record adapters and outbound communication channels.</p>
      </div>

      <div className="space-y-5">
        <div className="border-b pb-2">
          <h2 className="text-xl font-semibold flex items-center gap-2"><Server className="w-5 h-5 text-primary" /> System Adapters</h2>
          <p className="text-sm text-muted-foreground">Source systems that agents read from and write to via MCP.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {loadingConn ? <div className="p-8 text-muted-foreground col-span-full text-center border rounded-xl border-dashed">Loading adapters...</div> : connectors?.map(conn => (
            <Card key={conn.key} className={cn("transition-all duration-300 shadow-sm", conn.status !== 'connected' && "opacity-75 bg-muted/10")}>
              <CardContent className="p-6">
                <div className="flex justify-between items-start mb-6">
                  <div className="flex items-center gap-4">
                    <div className={cn("p-3 rounded-xl flex items-center justify-center shrink-0 border shadow-sm", conn.status === 'connected' ? "bg-primary/10 text-primary border-primary/20" : "bg-muted text-muted-foreground border-border")}>
                      <Server className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="font-bold text-lg leading-tight">{conn.label}</h3>
                      <p className="text-sm text-muted-foreground mt-1">{conn.description}</p>
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
                
                <div className="flex items-end justify-between mt-6 pt-5 border-t border-border">
                  <div className="space-y-1.5 flex-1 max-w-[200px]">
                    <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                      <ArrowRightLeft className="w-3 h-3" /> Active Vendor
                    </Label>
                    <select 
                      className={cn("block w-full text-sm font-semibold rounded-md border-input shadow-sm h-9 px-3 border outline-none focus:border-primary transition-colors", conn.status !== 'connected' ? "bg-muted text-muted-foreground opacity-50" : "bg-background")}
                      value={conn.vendor}
                      onChange={(e) => handleSwap(conn.key, e.target.value)}
                      disabled={conn.status !== 'connected' || updateConnector.isPending}
                    >
                      {conn.availableVendors.map(v => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
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