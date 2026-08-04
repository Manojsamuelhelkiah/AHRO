import { useListFlowClasses } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Workflow, Layers, ArrowRight, Activity, Cpu } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function Flows() {
  const { data: flows, isLoading } = useListFlowClasses();

  return (
    <div className="space-y-6 h-full flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Flow Classes</h1>
        <p className="text-muted-foreground mt-1">Standardized architecture templates for HR intents</p>
      </div>

      <div className="flex-1 overflow-auto pb-8">
        {isLoading ? (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {[1, 2, 3, 4].map(i => (
              <Skeleton key={i} className="h-[400px] w-full rounded-xl" />
            ))}
          </div>
        ) : !flows ? (
          <div className="text-center py-20 text-muted-foreground">Failed to load flow classes.</div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {flows.map((flow) => (
              <Card key={flow.key} className="flex flex-col h-full bg-card shadow-sm border-border overflow-hidden group hover:border-primary/30 transition-colors">
                <CardHeader className="pb-4 bg-muted/20 border-b border-border">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <Badge variant="outline" className="font-mono text-xs bg-background mb-2">
                        {flow.key}
                      </Badge>
                      <CardTitle className="text-xl text-foreground group-hover:text-primary transition-colors">
                        {flow.name}
                      </CardTitle>
                      <CardDescription className="text-sm mt-1 max-w-md">
                        {flow.description}
                      </CardDescription>
                    </div>
                    <Badge variant="secondary" className="font-mono bg-primary/10 text-primary border-primary/20">
                      Ref: {flow.slideRef}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="flex-1 p-6 space-y-6">
                  {/* Financials */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-card border border-border rounded-lg p-3">
                      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1">
                        <Activity className="w-3.5 h-3.5" /> Build Cost
                      </div>
                      <div className="text-2xl font-mono font-bold text-foreground">
                        ${(flow.buildCostUsd / 1000).toFixed(1)}k
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-1 uppercase tracking-wider">
                        One-Time CAPEX
                      </div>
                    </div>
                    <div className="bg-card border border-border rounded-lg p-3">
                      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1">
                        <Layers className="w-3.5 h-3.5" /> Amortization
                      </div>
                      <div className="text-2xl font-mono font-bold text-foreground">
                        {(flow.amortizationTransactions / 1000).toFixed(0)}k
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-1 uppercase tracking-wider">
                        Transactions Baseline
                      </div>
                    </div>
                  </div>
                  
                  <div className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg border border-border/50">
                    <span className="font-semibold text-foreground">Assumption:</span> {flow.buildAssumption}
                  </div>

                  {/* Flow Trace Mini */}
                  <div className="space-y-2 pt-2">
                    <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-primary" /> Execution Path
                    </h4>
                    <div className="flex flex-col gap-2">
                      {flow.steps.map((step, idx) => (
                        <div key={step.id} className="flex items-center gap-3">
                          <div className="flex flex-col items-center">
                            <div className={`w-2 h-2 rounded-full ${step.human ? 'bg-warning' : 'bg-primary'}`} />
                            {idx < flow.steps.length - 1 && <div className="w-0.5 h-6 bg-border" />}
                          </div>
                          <div className="flex-1 pb-4 pt-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-foreground">{step.label}</span>
                              {step.human && (
                                <Badge variant="outline" className="text-[9px] uppercase h-4 px-1 py-0 border-warning/50 text-warning-foreground bg-warning/10">
                                  HITL
                                </Badge>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5">
                              {step.stage} • {step.agents.length > 0 ? step.agents.join(', ') : 'System'}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
