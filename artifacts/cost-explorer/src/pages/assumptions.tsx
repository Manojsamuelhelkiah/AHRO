import { useListAssumptions, useListSystems } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Settings2, Database, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function Assumptions() {
  const { data: assumptions, isLoading: isLoadingAssumptions } = useListAssumptions();
  const { data: systems, isLoading: isLoadingSystems } = useListSystems();

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Global Assumptions</h1>
        <p className="text-muted-foreground mt-1">Foundational data driving the cost-benefit model</p>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2 mb-4">
          <Settings2 className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-semibold tracking-tight">Rates & Allocations</h2>
        </div>
        
        {isLoadingAssumptions ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map(i => <Skeleton key={i} className="h-40 rounded-xl" />)}
          </div>
        ) : !assumptions ? (
          <div className="text-muted-foreground">Failed to load assumptions.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {assumptions.map(assumption => (
              <Card key={assumption.key} className="bg-card shadow-sm hover:border-primary/30 transition-colors">
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-start">
                    <CardTitle className="text-base">{assumption.label}</CardTitle>
                    <Badge variant="outline" className="font-mono text-xs bg-muted/30">
                      {assumption.key}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-baseline gap-1">
                    <span className="text-2xl font-bold font-mono text-primary">
                      {assumption.value}
                    </span>
                    <span className="text-sm text-muted-foreground">{assumption.unit}</span>
                  </div>
                  
                  <div className="text-sm text-muted-foreground leading-relaxed border-t border-border pt-3">
                    {assumption.rationale}
                  </div>
                  
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 px-2 py-1.5 rounded">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>{assumption.source.name}</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-4 pt-8">
        <div className="flex items-center gap-2 mb-4">
          <Database className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-semibold tracking-tight">Modeled Systems of Record</h2>
        </div>
        
        {isLoadingSystems ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
        ) : !systems ? (
          <div className="text-muted-foreground">Failed to load systems.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {systems.map(sys => (
              <Card key={sys.key} className="bg-card shadow-sm border-border">
                <CardContent className="p-4 flex flex-col justify-between h-full">
                  <div>
                    <div className="flex justify-between items-start mb-2">
                      <div className="font-semibold text-foreground">{sys.name}</div>
                      <Badge variant="secondary" className="capitalize text-[10px]">
                        {sys.category}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground line-clamp-3">
                      {sys.description}
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-border/60">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-primary mb-0.5">
                      {sys.integration.label}
                    </div>
                    <div className="text-[11px] text-muted-foreground leading-snug">
                      {sys.integration.note}
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
