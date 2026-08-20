import { useListFlowClasses } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Workflow, Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { FlowDiagramMini, AmortCurve } from "@/components/flow-diagram";

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
              <Skeleton key={i} className="h-[440px] w-full rounded-xl" />
            ))}
          </div>
        ) : !flows ? (
          <div className="text-center py-20 text-muted-foreground">Failed to load flow classes.</div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {flows.map((flow) => (
              <Card
                key={flow.key}
                className="flex flex-col h-full bg-card shadow-sm border-border overflow-hidden group hover:border-primary/30 hover:shadow-md transition-all duration-200"
              >
                {/* Header */}
                <CardHeader className="pb-4 bg-muted/20 border-b border-border">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 min-w-0">
                      <Badge variant="outline" className="font-mono text-xs bg-background mb-2">
                        {flow.key}
                      </Badge>
                      <CardTitle className="text-xl text-foreground group-hover:text-primary transition-colors">
                        {flow.name}
                      </CardTitle>
                      <CardDescription className="text-sm mt-1 max-w-md leading-relaxed">
                        {flow.description}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="flex-1 p-5 space-y-5">
                  {/* Financials row */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 rounded-lg p-3">
                      <div className="text-[10px] font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wider mb-1 flex items-center gap-1">
                        <Activity className="w-3 h-3" /> Build Cost
                      </div>
                      <div className="text-xl font-mono font-bold text-foreground">
                        ${(flow.buildCostUsd / 1000).toFixed(0)}k
                      </div>
                      <div className="text-[9px] text-muted-foreground mt-0.5 uppercase tracking-wider">One-Time</div>
                    </div>

                    <div className="bg-muted/40 border border-border rounded-lg p-3">
                      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                        Amort. Vol.
                      </div>
                      <div className="text-xl font-mono font-bold text-foreground">
                        {(flow.amortizationTransactions / 1000).toFixed(0)}k
                      </div>
                      <div className="text-[9px] text-muted-foreground mt-0.5 uppercase tracking-wider">Txn baseline</div>
                    </div>

                    {/* Amortization curve */}
                    <div className="bg-muted/20 border border-border rounded-lg p-2 flex flex-col">
                      <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                        $/txn curve
                      </div>
                      <div className="flex-1 flex items-end">
                        <AmortCurve
                          buildCostUsd={flow.buildCostUsd}
                          amortizationTransactions={flow.amortizationTransactions}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Build assumption */}
                  <div className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg border border-border/50 leading-relaxed">
                    <span className="font-semibold text-foreground">Assumption:</span>{" "}{flow.buildAssumption}
                  </div>

                  {/* Mini flow diagram */}
                  <div className="space-y-2 pt-1">
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                      <Workflow className="w-3.5 h-3.5 text-primary" /> Execution Path
                    </h4>
                    <FlowDiagramMini steps={flow.steps} />
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
