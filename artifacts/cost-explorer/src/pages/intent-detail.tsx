import { useRoute, Link } from "wouter";
import { useListIntents, useListFlowClasses } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  ArrowLeft, ShieldCheck, Activity, BrainCircuit, 
  Database, User, Layers, ArrowRight, Zap, Info, DollarSign, Clock
} from "lucide-react";

const circledNumbers: Record<string, string> = {
  "1": "①", "2": "②", "3": "③", "4": "④", "5": "⑤", "6": "⑥", "7": "⑦", "8": "⑧", "9": "⑨"
};

export default function IntentDetail() {
  const [, params] = useRoute("/intents/:key");
  const key = params?.key;
  
  const { data: intents, isLoading: isLoadingIntents } = useListIntents();
  const { data: flowClasses, isLoading: isLoadingFlows } = useListFlowClasses();
  
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
                          {step.systems.map((sys, sidx) => (
                            <div key={sidx} className="flex items-center justify-between bg-muted/50 p-2 rounded-md text-sm border border-border/50">
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
                          ))}
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
    </div>
  );
}
