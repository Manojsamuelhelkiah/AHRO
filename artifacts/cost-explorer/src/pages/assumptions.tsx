import { useState } from "react";
import { useListAssumptions, useListSystems } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Settings2, Database, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const PROVISIONING_META: Record<string, { label: string; className: string; blurb: string }> = {
  core: {
    label: "Core",
    className: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30",
    blurb: "Product fact — identical for every client, maintained by the platform team.",
  },
  configurable: {
    label: "Configurable",
    className: "bg-sky-500/10 text-sky-600 border-sky-500/30",
    blurb: "A dial the client sets per scenario — no code change (rates, models, tiers, ramps).",
  },
  custom: {
    label: "Custom",
    className: "bg-amber-500/10 text-amber-600 border-amber-500/30",
    blurb: "Per-client engineering or content effort — integrations, country packs, onboarding.",
  },
};

export default function Assumptions() {
  const { data: assumptions, isLoading: isLoadingAssumptions } = useListAssumptions();
  const { data: systems, isLoading: isLoadingSystems } = useListSystems();
  const [filter, setFilter] = useState<string | null>(null);

  const filtered = assumptions?.filter(a => !filter || a.provisioning === filter);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Global Assumptions</h1>
        <p className="text-muted-foreground mt-1">Foundational data driving the cost-benefit model</p>
      </div>

      <Card className="bg-muted/30 border-dashed">
        <CardContent className="p-4 flex flex-col gap-3">
          <div className="text-sm font-semibold text-foreground">Product demarcation</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {Object.entries(PROVISIONING_META).map(([key, meta]) => (
              <div key={key} className="flex items-start gap-2">
                <Badge variant="outline" className={`text-[10px] uppercase tracking-wide shrink-0 mt-0.5 ${meta.className}`}>{meta.label}</Badge>
                <span className="text-xs text-muted-foreground leading-snug">{meta.blurb}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <div className="flex items-center gap-2">
            <Settings2 className="w-5 h-5 text-primary" />
            <h2 className="text-xl font-semibold tracking-tight">Rates & Allocations</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant={filter === null ? "default" : "outline"} className="h-7 text-xs" onClick={() => setFilter(null)} data-testid="filter-all">
              All{assumptions ? ` (${assumptions.length})` : ""}
            </Button>
            {Object.entries(PROVISIONING_META).map(([key, meta]) => (
              <Button key={key} size="sm" variant={filter === key ? "default" : "outline"} className="h-7 text-xs" onClick={() => setFilter(filter === key ? null : key)} data-testid={`filter-${key}`}>
                {meta.label}{assumptions ? ` (${assumptions.filter(a => a.provisioning === key).length})` : ""}
              </Button>
            ))}
          </div>
        </div>
        
        {isLoadingAssumptions ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map(i => <Skeleton key={i} className="h-40 rounded-xl" />)}
          </div>
        ) : !filtered ? (
          <div className="text-muted-foreground">Failed to load assumptions.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(assumption => (
              <Card key={assumption.key} className="bg-card shadow-sm hover:border-primary/30 transition-colors">
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-start gap-2">
                    <CardTitle className="text-base">{assumption.label}</CardTitle>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <Badge variant="outline" className={`text-[10px] uppercase tracking-wide ${PROVISIONING_META[assumption.provisioning]?.className ?? "bg-muted/30"}`} data-testid={`badge-provisioning-${assumption.key}`}>
                        {PROVISIONING_META[assumption.provisioning]?.label ?? assumption.provisioning}
                      </Badge>
                      <Badge variant="outline" className="font-mono text-xs bg-muted/30">
                        {assumption.key}
                      </Badge>
                    </div>
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
