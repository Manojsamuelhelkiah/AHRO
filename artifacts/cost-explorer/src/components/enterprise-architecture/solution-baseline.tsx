import { useGetEnterpriseArchitectureBaseline } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Building2, Layers, Cpu, Code2, Lock, Workflow, BarChart3, Link, AppWindow } from "lucide-react";

export function SolutionBaseline() {
  const { data: baseline, isLoading } = useGetEnterpriseArchitectureBaseline();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map(i => <Skeleton key={i} className="h-48 rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (!baseline) {
    return <div>Failed to load solution baseline.</div>;
  }

  const domainIcons: Record<string, any> = {
    business: Building2,
    data: BarChart3,
    application: AppWindow,
    technology: Cpu,
    integration: Link,
    ai: Code2,
    security: Lock,
    "operating-model": Workflow,
  };

  return (
    <div className="space-y-8 animate-in fade-in">
      <div>
        <h2 className="text-2xl font-bold">Reusable Solution Baseline</h2>
        <p className="text-muted-foreground mt-1">
          Derived from the global corpus. Contains {baseline.sourceCounts.intents} intents and {baseline.sourceCounts.systems} systems.
          Last generated at {new Date(baseline.generatedAt).toLocaleString()}.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {baseline.viewpoints.map((viewpoint) => {
          const Icon = domainIcons[viewpoint.domain] || Layers;
          return (
            <Card key={viewpoint.domain} className="flex flex-col">
              <CardHeader className="pb-3 border-b bg-muted/20">
                <CardTitle className="flex items-center gap-2 text-lg capitalize">
                  <Icon className="w-5 h-5 text-primary" />
                  {viewpoint.domain.replace('-', ' ')}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 pt-4 space-y-4">
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {viewpoint.summary}
                </p>
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Building Blocks</h4>
                  <div className="flex flex-wrap gap-2">
                    {viewpoint.buildingBlocks.slice(0, 5).map(bb => (
                      <Badge key={bb.key} variant="secondary" className="font-normal text-xs">
                        {bb.name}
                      </Badge>
                    ))}
                    {viewpoint.buildingBlocks.length > 5 && (
                      <Badge variant="outline" className="font-normal text-xs text-muted-foreground">
                        +{viewpoint.buildingBlocks.length - 5} more
                      </Badge>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

