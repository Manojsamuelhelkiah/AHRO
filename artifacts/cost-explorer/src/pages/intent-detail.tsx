import { useState } from "react";
import { useRoute, Link } from "wouter";
import {
  useListIntents, useListFlowClasses, useListSystems,
  useListFlowOverrides, useCreateFlowOverride, useApproveFlowOverride, useDeleteFlowOverride, useRevokeFlowOverride,
  getListFlowOverridesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { 
  ArrowLeft, ShieldCheck, Activity, BrainCircuit, 
  Database, User, Layers, ArrowRight, Zap, Info, DollarSign, Clock,
  PenLine, CheckCircle2, Trash2
} from "lucide-react";

const circledNumbers: Record<string, string> = {
  "1": "①", "2": "②", "3": "③", "4": "④", "5": "⑤", "6": "⑥", "7": "⑦", "8": "⑧", "9": "⑨"
};

export default function IntentDetail() {
  const [, params] = useRoute("/intents/:key");
  const key = params?.key;
  
  const { data: intents, isLoading: isLoadingIntents } = useListIntents();
  const { data: flowClasses, isLoading: isLoadingFlows } = useListFlowClasses();
  const { data: systems } = useListSystems();
  const systemInfo = (key: string) => systems?.find(s => s.key === key);
  
  const intent = intents?.find(i => i.key === key);
  const flowClass = flowClasses?.find(fc => fc.key === intent?.flowClass);

  if (isLoadingIntents || isLoadingFlows) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }

  if (!intent) {
    return (
      <div className="text-center py-20">
        <h2 className="text-2xl font-bold text-foreground">Intent Not Found</h2>
        <p className="text-muted-foreground mt-2">Could not find intent with key: {key}</p>
        <Link href="/intents" className="text-primary mt-4 inline-block hover:underline">
          Return to Catalog
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-20 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <Link href="/intents" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-primary transition-colors">
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to Intents
      </Link>
      
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
        <div className="space-y-2 flex-1">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="capitalize">{intent.domain}</Badge>
            <Badge variant="outline" className="font-mono bg-card">{intent.flowClass}</Badge>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{intent.name}</h1>
          <p className="text-lg text-muted-foreground leading-relaxed max-w-3xl">
            {intent.description}
          </p>
          <div className="flex items-center gap-4 pt-2 text-sm flex-wrap">
            <div className="flex items-center gap-1.5 text-muted-foreground bg-card px-3 py-1.5 rounded-md border border-border">
              <ShieldCheck className="w-4 h-4 text-primary" />
              Source: <span className="font-medium text-foreground">{intent.source.name}</span>
            </div>
            <div className="flex items-center gap-1.5 text-muted-foreground bg-card px-3 py-1.5 rounded-md border border-border">
              <span className="font-semibold">Weight:</span> <span className="font-mono text-foreground">{intent.baseWeight}x</span>
            </div>
            <div className="flex items-center gap-1.5 text-muted-foreground bg-card px-3 py-1.5 rounded-md border border-border">
              <span className="font-semibold">Actions:</span>
              <span className="text-blue-600 dark:text-blue-400 font-mono">{intent.actGetActions} GET</span> /
              <span className="text-amber-600 dark:text-amber-400 font-mono">{intent.actPutActions} PUT</span>
            </div>
            {intent.tags.map(tag => (
              <Badge key={tag} variant="secondary" className="bg-muted/50 font-normal">#{tag}</Badge>
            ))}
          </div>
        </div>
        
        <div className="flex gap-4">
          <Card className="bg-card shadow-sm border-border min-w-[140px]">
            <CardContent className="p-4 flex flex-col items-center justify-center text-center h-full">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1">
                <Activity className="w-3.5 h-3.5" /> As-Is
              </div>
              <div className="text-3xl font-mono font-bold text-foreground">{intent.asIsHandlingMin}<span className="text-lg text-muted-foreground font-sans font-normal ml-1">m</span></div>
            </CardContent>
          </Card>
          <Card className="bg-card shadow-sm border-border min-w-[140px]">
            <CardContent className="p-4 flex flex-col items-center justify-center text-center h-full">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1">
                <BrainCircuit className="w-3.5 h-3.5" /> To-Be Human
              </div>
              <div className="text-3xl font-mono font-bold text-primary">{intent.toBeHumanMin}<span className="text-lg text-muted-foreground font-sans font-normal ml-1">m</span></div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="mt-8">
        <div className="flex items-center gap-2 mb-6">
          <Zap className="w-5 h-5 text-primary" />
          <h2 className="text-2xl font-bold tracking-tight">Flow Tracer</h2>
        </div>

        {!flowClass ? (
          <div className="p-6 border border-dashed border-border rounded-xl text-center text-muted-foreground">
            Flow architecture details not available for {intent.flowClass}.
          </div>
        ) : (
          <div className="space-y-4">
            {flowClass.steps.map((step, idx) => {
              const isHitl = step.human;
              
              return (
                <Card 
                  key={step.id} 
                  className={`relative overflow-hidden transition-colors ${
                    isHitl ? 'border-warning/50 bg-warning/5' : 'border-border bg-card'
                  }`}
                >
                  {isHitl && (
                    <div className="absolute top-0 right-0 w-2 h-full bg-warning"></div>
                  )}
                  <CardHeader className="pb-3 flex flex-row items-start justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={`font-mono text-xs ${isHitl ? 'border-warning/30 text-warning-foreground' : ''}`}>
                          STEP {idx + 1} • {step.stage.toUpperCase()}
                        </Badge>
                        {isHitl && (
                          <Badge className="bg-warning text-warning-foreground hover:bg-warning/90 text-xs flex items-center gap-1">
                            <User className="w-3 h-3" /> HUMAN IN LOOP
                          </Badge>
                        )}
                      </div>
                      <CardTitle className="text-xl">{step.label}</CardTitle>
                    </div>
                    
                    <div className="flex items-center gap-3">
                      {step.agents.length > 0 && (
                        <div className="flex items-center gap-1 text-sm text-muted-foreground">
                          <BrainCircuit className="w-4 h-4" />
                          <span className="font-medium text-foreground">{step.agents.join(', ')}</span>
                        </div>
                      )}
                      
                      {step.componentRefs.length > 0 && (
                        <div className="flex items-center gap-1 font-mono text-lg text-primary bg-primary/10 px-2 py-0.5 rounded">
                          {step.componentRefs.map(r => circledNumbers[r] || r).join(' ')}
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  
                  <CardContent className="grid grid-cols-1 lg:grid-cols-3 gap-6 pt-0">
                    {/* Systems */}
                    <div className="lg:col-span-1 space-y-3">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                        <Database className="w-3.5 h-3.5" /> Systems Touched
                      </h4>
                      {step.systems.length === 0 ? (
                        <div className="text-sm text-muted-foreground italic">No external systems</div>
                      ) : (
                        <div className="space-y-2">
                          {step.systems.map((sys, sidx) => {
                            const info = systemInfo(sys.systemKey);
                            return (
                              <div key={sidx} className="bg-muted/50 p-2 rounded-md text-sm border border-border/50">
                                <div className="flex items-center justify-between">
                                  <span className="font-medium text-foreground">{sys.systemKey}</span>
                                  <div className="flex gap-1">
                                    {sys.actions.map(act => (
                                      <Badge key={act} variant="secondary" className={`text-[10px] uppercase px-1.5 py-0 ${
                                        act === 'get' ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                                      }`}>
                                        {act}
                                      </Badge>
                                    ))}
                                  </div>
                                </div>
                                {info && (
                                  <div className="mt-1.5 pt-1.5 border-t border-border/40">
                                    <div className="text-[10px] font-semibold uppercase tracking-wider text-primary">{info.integration.label}</div>
                                    <div className="text-[11px] text-muted-foreground leading-snug mt-0.5">{info.integration.note}</div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Costs */}
                    <div className="lg:col-span-1 space-y-3 border-t lg:border-t-0 lg:border-l border-border pt-4 lg:pt-0 lg:pl-6">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                        <DollarSign className="w-3.5 h-3.5" /> Per-Step Cost
                      </h4>
                      {step.costs.length === 0 ? (
                        <div className="text-sm text-muted-foreground italic">Negligible cost</div>
                      ) : (
                        <div className="space-y-3">
                          {step.costs.map((cost, cidx) => (
                            <div key={cidx} className="space-y-1">
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-medium text-foreground">{cost.label}</span>
                                <span className="font-mono text-sm">${cost.unitCostUsd.toFixed(3)}</span>
                              </div>
                              <div className="text-xs text-muted-foreground bg-muted/30 p-2 rounded border border-border/40">
                                <span className="font-semibold text-foreground/70 block mb-0.5">Assumption:</span>
                                {cost.assumption}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Benefits */}
                    <div className="lg:col-span-1 space-y-3 border-t lg:border-t-0 lg:border-l border-border pt-4 lg:pt-0 lg:pl-6">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" /> Value Delivered
                      </h4>
                      {step.benefits.length === 0 ? (
                        <div className="text-sm text-muted-foreground italic">Enabling step</div>
                      ) : (
                        <div className="space-y-3">
                          {step.benefits.map((ben, bidx) => (
                            <div key={bidx} className="space-y-1">
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-medium text-foreground">{ben.label}</span>
                                {ben.dollarized && (
                                  <span className="font-mono text-sm text-emerald-600 dark:text-emerald-400">
                                    +${ben.unitBenefitUsd.toFixed(2)}
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-muted-foreground bg-muted/30 p-2 rounded border border-border/40">
                                {ben.dollarized ? (
                                  <><span className="font-semibold text-foreground/70 block mb-0.5">Assumption:</span>{ben.assumption}</>
                                ) : (
                                  <span className="text-primary/80 italic">{ben.qualitative}</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <FlowOverridePanel intentKey={intent.key} currentFlowClass={intent.flowClass} flowClasses={(flowClasses ?? []).map(fc => fc.key)} />
    </div>
  );
}

/**
 * SME flow adjustments: versioned per-intent overrides. Drafts must be
 * approved before they affect scenario roll-ups; the reference corpus is
 * never mutated, and any version can be deleted to revert.
 */
function FlowOverridePanel({ intentKey, currentFlowClass, flowClasses }: {
  intentKey: string;
  currentFlowClass: string;
  flowClasses: string[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: allOverrides, isLoading } = useListFlowOverrides();
  const createOverride = useCreateFlowOverride();
  const approveOverride = useApproveFlowOverride();
  const deleteOverride = useDeleteFlowOverride();
  const revokeOverride = useRevokeFlowOverride();

  const [author, setAuthor] = useState("");
  const [rationale, setRationale] = useState("");
  const [flowClass, setFlowClass] = useState<string>("");
  const [toBeHumanMin, setToBeHumanMin] = useState("");
  const [actGet, setActGet] = useState("");
  const [actPut, setActPut] = useState("");

  const versions = (allOverrides ?? []).filter(o => o.intentKey === intentKey);
  const active = versions.filter(o => o.status === "approved").sort((a, b) => b.version - a.version)[0];

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListFlowOverridesQueryKey() });

  const handlePropose = async () => {
    if (!author.trim() || !rationale.trim()) {
      toast({ title: "Author and rationale are required", variant: "destructive" });
      return;
    }
    const payload = {
      intentKey,
      author: author.trim(),
      rationale: rationale.trim(),
      ...(flowClass && { flowClass }),
      ...(toBeHumanMin !== "" && { toBeHumanMin: Number(toBeHumanMin) }),
      ...(actGet !== "" && { actGetActions: Number(actGet) }),
      ...(actPut !== "" && { actPutActions: Number(actPut) }),
    };
    if (!payload.flowClass && payload.toBeHumanMin === undefined && payload.actGetActions === undefined && payload.actPutActions === undefined) {
      toast({ title: "Change at least one flow property", variant: "destructive" });
      return;
    }
    try {
      await createOverride.mutateAsync({ data: payload });
      toast({ title: "Draft proposed", description: "Approve it below to apply it to scenario roll-ups." });
      setRationale(""); setFlowClass(""); setToBeHumanMin(""); setActGet(""); setActPut("");
      refresh();
    } catch (e) {
      toast({ title: "Could not save the proposal", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  return (
    <div className="mt-10">
      <div className="flex items-center gap-2 mb-2">
        <PenLine className="w-5 h-5 text-primary" />
        <h2 className="text-2xl font-bold tracking-tight">SME Flow Adjustments</h2>
        {active && (
          <Badge className="bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/30">
            Active override v{active.version}
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-6 max-w-3xl">
        Subject matter experts can adjust how this intent flows — reassign it to a different flow class, change residual human minutes,
        or the system actions taken. Every change is a new version; only approved versions affect scenario roll-ups, and the reference flow is never modified.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Propose a change</CardTitle>
            <CardDescription>Creates a draft version for review</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Your name</Label>
                <Input value={author} onChange={e => setAuthor(e.target.value)} placeholder="e.g. Maria (Payroll SME)" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Flow class (current: {currentFlowClass})</Label>
                <Select value={flowClass} onValueChange={setFlowClass}>
                  <SelectTrigger><SelectValue placeholder="Keep current" /></SelectTrigger>
                  <SelectContent>
                    {flowClasses.map(k => <SelectItem key={k} value={k}>{k}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">To-be human (min)</Label>
                <Input type="number" value={toBeHumanMin} onChange={e => setToBeHumanMin(e.target.value)} placeholder="keep" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">GET actions</Label>
                <Input type="number" value={actGet} onChange={e => setActGet(e.target.value)} placeholder="keep" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">PUT actions</Label>
                <Input type="number" value={actPut} onChange={e => setActPut(e.target.value)} placeholder="keep" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Rationale (required)</Label>
              <Textarea value={rationale} onChange={e => setRationale(e.target.value)} placeholder="Why should this flow change? e.g. In practice this intent needs a manager approval step in DACH countries." rows={3} />
            </div>
            <Button onClick={handlePropose} disabled={createOverride.isPending} className="w-full">
              {createOverride.isPending ? "Saving..." : "Propose draft"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Version history</CardTitle>
            <CardDescription>Latest approved version is applied to roll-ups</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : versions.length === 0 ? (
              <p className="text-sm text-muted-foreground italic py-6 text-center">No adjustments proposed yet — this intent uses the reference flow.</p>
            ) : (
              <div className="space-y-3">
                {versions.sort((a, b) => b.version - a.version).map(v => (
                  <div key={v.id} className={`p-3 rounded-lg border text-sm ${v.status === "approved" ? "border-violet-500/30 bg-violet-500/5" : "border-border bg-muted/30"}`}>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="font-mono text-[10px]">v{v.version}</Badge>
                        <Badge className={v.status === "approved" ? "bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/30" : v.status === "superseded" ? "bg-muted text-muted-foreground border-border" : "bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30"}>
                          {v.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{v.author} · {new Date(v.createdAt).toLocaleDateString()}</span>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        {v.status === "draft" && (
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={approveOverride.isPending}
                            onClick={async () => { try { await approveOverride.mutateAsync({ id: v.id }); toast({ title: `v${v.version} approved`, description: "It now applies to scenario roll-ups; any prior approval was superseded." }); refresh(); } catch { toast({ title: "Approval failed", variant: "destructive" }); } }}>
                            <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Approve
                          </Button>
                        )}
                        {v.status === "approved" && (
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={revokeOverride.isPending}
                            onClick={async () => { try { await revokeOverride.mutateAsync({ id: v.id }); toast({ title: `v${v.version} revoked`, description: "The intent reverts to the reference flow; history is kept." }); refresh(); } catch { toast({ title: "Revoke failed", variant: "destructive" }); } }}>
                            Revoke
                          </Button>
                        )}
                        {v.status === "draft" && (
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" disabled={deleteOverride.isPending}
                            onClick={async () => { try { await deleteOverride.mutateAsync({ id: v.id }); toast({ title: `v${v.version} deleted` }); refresh(); } catch { toast({ title: "Delete failed", variant: "destructive" }); } }}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs font-mono text-foreground/80 mb-1">
                      {v.flowClass && <span>flow → {v.flowClass}</span>}
                      {v.toBeHumanMin != null && <span>human → {v.toBeHumanMin}m</span>}
                      {v.actGetActions != null && <span>GET → {v.actGetActions}</span>}
                      {v.actPutActions != null && <span>PUT → {v.actPutActions}</span>}
                    </div>
                    <p className="text-xs text-muted-foreground">{v.rationale}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
