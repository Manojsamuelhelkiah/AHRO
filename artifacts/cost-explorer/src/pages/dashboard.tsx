import { useGetCorpusSummary, useListScenarios } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { ArrowRight, BarChart3, Database, GitMerge, FileText, Layers, AlertCircle, Calculator } from "lucide-react";
import { ResponsiveContainer, BarChart, XAxis, YAxis, Bar, Tooltip } from "recharts";

export default function Dashboard() {
  const { data: summary, isLoading: isLoadingSummary, isError: isErrorSummary } = useGetCorpusSummary();
  const { data: scenarios, isLoading: isLoadingScenarios } = useListScenarios();

  if (isErrorSummary) {
    return (
      <div className="flex h-full items-center justify-center text-destructive">
        <AlertCircle className="w-6 h-6 mr-2" />
        Failed to load dashboard data.
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Overview</h1>
        <p className="text-muted-foreground mt-2">HRO Intent Flow Cost-Benefit Explorer</p>
      </div>

      {/* KPI cards */}
      {isLoadingSummary || !summary ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[1,2,3].map(i => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Modeled Intents — cobalt accent */}
          <Card className="border-border shadow-sm overflow-hidden relative">
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary rounded-l-xl" />
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0 pl-5">
              <CardTitle className="text-sm font-medium">Modeled Intents</CardTitle>
              <Database className="w-4 h-4 text-primary/70" />
            </CardHeader>
            <CardContent className="pl-5">
              <div className="text-3xl font-bold text-foreground">{summary.intentCount}</div>
              <p className="text-xs text-muted-foreground mt-1">Across {summary.byDomain.length} HR domains</p>
            </CardContent>
          </Card>

          {/* Flow Architectures — purple accent */}
          <Card className="border-border shadow-sm overflow-hidden relative">
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-purple-500 rounded-l-xl" />
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0 pl-5">
              <CardTitle className="text-sm font-medium">Flow Architectures</CardTitle>
              <GitMerge className="w-4 h-4 text-purple-500/70" />
            </CardHeader>
            <CardContent className="pl-5">
              <div className="text-3xl font-bold text-foreground">{summary.byFlowClass.length}</div>
              <p className="text-xs text-muted-foreground mt-1">Standardized automation patterns</p>
            </CardContent>
          </Card>

          {/* System Interfaces — teal accent */}
          <Card className="border-border shadow-sm overflow-hidden relative">
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-teal-500 rounded-l-xl" />
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0 pl-5">
              <CardTitle className="text-sm font-medium">System Interfaces</CardTitle>
              <Layers className="w-4 h-4 text-teal-500/70" />
            </CardHeader>
            <CardContent className="pl-5">
              <div className="text-3xl font-bold text-foreground">{summary.systemCount}</div>
              <p className="text-xs text-muted-foreground mt-1">Systems of record mapped</p>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">

        {/* Left column: quick actions + domain distribution */}
        <div className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold tracking-tight mb-4">Quick Actions</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Link href="/intents" className="block group">
                <Card className="h-full transition-all hover:border-primary/50 hover:shadow-md hover:-translate-y-0.5 cursor-pointer duration-200">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2 group-hover:text-primary transition-colors">
                      <Database className="w-4 h-4" /> Browse Intents
                    </CardTitle>
                    <CardDescription>Explore the full corpus of mapped HR intents</CardDescription>
                  </CardHeader>
                </Card>
              </Link>
              <Link href="/scenario" className="block group">
                <Card className="h-full transition-all hover:border-primary/50 hover:shadow-md hover:-translate-y-0.5 cursor-pointer duration-200">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2 group-hover:text-primary transition-colors">
                      <Calculator className="w-4 h-4" /> Build Scenario
                    </CardTitle>
                    <CardDescription>Run cost-benefit analysis for a client</CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            </div>
          </div>

          {/* Domain distribution bar chart */}
          {summary && summary.byDomain.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold tracking-tight mb-4">Intent Distribution by Domain</h2>
              <Card className="shadow-sm">
                <CardContent className="pt-4 pb-2 pr-3">
                  <ResponsiveContainer width="100%" height={Math.min(summary.byDomain.length * 28, 280)}>
                    <BarChart
                      data={[...summary.byDomain]
                        .sort((a, b) => b.count - a.count)
                        .map(d => ({ name: d.key, count: d.count }))}
                      layout="vertical"
                      margin={{ top: 0, right: 32, left: 0, bottom: 0 }}
                    >
                      <XAxis type="number" hide />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={100}
                        tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                        tickLine={false}
                        axisLine={false}
                        style={{ textTransform: "capitalize" }}
                      />
                      <Tooltip
                        formatter={(v: number) => [`${v} intents`, "Count"]}
                        contentStyle={{ borderRadius: 8, border: "1px solid hsl(var(--border))", fontSize: 12 }}
                      />
                      <Bar
                        dataKey="count"
                        fill="hsl(var(--primary))"
                        radius={[0, 4, 4, 0]}
                        maxBarSize={16}
                        label={{ position: "right", fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        {/* Right column: recent scenarios */}
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold tracking-tight">Recent Scenarios</h2>
            <Link href="/scenario" className="text-sm text-primary font-medium hover:underline flex items-center">
              View all <ArrowRight className="w-4 h-4 ml-1" />
            </Link>
          </div>

          <Card className="shadow-sm">
            <CardContent className="p-0">
              {isLoadingScenarios ? (
                <div className="p-6 space-y-4">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : !scenarios || scenarios.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground text-sm flex flex-col items-center">
                  <FileText className="w-8 h-8 mb-3 opacity-20" />
                  No saved scenarios yet.
                  <Link href="/scenario" className="text-primary mt-2 hover:underline">
                    Create your first scenario
                  </Link>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {scenarios.slice(0, 6).map((scenario) => (
                    <div key={scenario.id} className="px-4 py-3.5 flex items-center justify-between hover:bg-muted/30 transition-colors group">
                      <div>
                        <div className="font-medium text-sm text-foreground">{scenario.name}</div>
                        <div className="text-xs text-muted-foreground mt-0.5 capitalize">
                          {scenario.inputs.employees.toLocaleString()} employees · {scenario.inputs.sector}
                        </div>
                      </div>
                      <Link
                        href={`/scenario?id=${scenario.id}`}
                        className="p-2 text-muted-foreground hover:text-primary rounded-md hover:bg-primary/10 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <BarChart3 className="w-4 h-4" />
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
