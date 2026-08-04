import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { 
  useComputeRollup, 
  useListDistributionProfiles, 
  useListScenarios,
  useCreateScenario,
  useUpdateScenario,
  useGetScenario,
  getGetScenarioQueryKey,
  ScenarioInputs,
  Rollup
} from "@workspace/api-client-react";
import { useLocation } from "wouter";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { 
  Calculator, Save, Play, Clock, DollarSign, Activity, 
  TrendingUp, Users, ArrowRight, Download, BarChart3, Database, Workflow,
  Settings2
} from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";

const formSchema = z.object({
  numSystems: z.coerce.number().int("Whole number required").min(1, "At least 1 system"),
  annualTransactions: z.coerce.number().int("Whole number required").min(100, "Min 100 transactions"),
  employees: z.coerce.number().int("Whole number required").min(10, "Min 10 employees"),
  sector: z.string().min(1, "Required"),
  companyType: z.enum(["single-country", "multi-country", "global"]),
  isolationTier: z.enum(["pooled", "siloed", "dedicated"]),
  hrHourlyCostUsd: z.coerce.number().min(1),
  hitlHourlyCostUsd: z.coerce.number().min(1),
  countries: z.coerce.number().int("Whole number required").min(1)
});

const defaultValues: z.infer<typeof formSchema> = {
  numSystems: 5,
  annualTransactions: 50000,
  employees: 5000,
  sector: "technology",
  companyType: "multi-country",
  isolationTier: "siloed",
  hrHourlyCostUsd: 45,
  hitlHourlyCostUsd: 35,
  countries: 3
};

const formatCurrency = (val: number, compact = false) => {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 0
  }).format(val);
};

const formatNumber = (val: number) => {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(val);
};

const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];

export default function Scenario() {
  const [location] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const scenarioId = searchParams.get("id");
  const parsedId = scenarioId ? parseInt(scenarioId, 10) : null;
  
  const { toast } = useToast();
  const [rollup, setRollup] = useState<Rollup | null>(null);
  
  const { data: profiles, isLoading: isLoadingProfiles } = useListDistributionProfiles();
  const { data: scenarios, refetch: refetchScenarios } = useListScenarios();
  const computeRollup = useComputeRollup();
  const createScenario = useCreateScenario();
  const updateScenario = useUpdateScenario();
  const { data: loadedScenario } = useGetScenario(parsedId as number, { 
    query: { 
      enabled: !!parsedId,
      queryKey: getGetScenarioQueryKey(parsedId as number)
    } 
  });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues
  });

  // Load scenario if ID in URL
  useEffect(() => {
    if (loadedScenario) {
      form.reset(loadedScenario.inputs as z.infer<typeof formSchema>);
      onSubmit(loadedScenario.inputs as z.infer<typeof formSchema>);
    }
  }, [loadedScenario, form]);

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    try {
      const result = await computeRollup.mutateAsync({ data: { inputs: values } });
      setRollup(result);
    } catch (e) {
      toast({ title: "Computation Failed", description: "Could not compute rollup.", variant: "destructive" });
    }
  };

  const handleSave = form.handleSubmit(async (values) => {
    const name = `Scenario - ${values.employees} EEs, ${values.sector}`;

    try {
      if (parsedId) {
        await updateScenario.mutateAsync({ id: parsedId, data: { name, inputs: values } });
        toast({ title: "Saved", description: "Scenario updated successfully." });
      } else {
        await createScenario.mutateAsync({ data: { name, inputs: values } });
        toast({ title: "Saved", description: "New scenario created." });
        refetchScenarios();
      }
    } catch (e) {
      toast({ title: "Save Failed", description: "Could not save scenario.", variant: "destructive" });
    }
  });

  return (
    <div className="flex flex-col lg:flex-row h-full gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20">
      
      {/* LEFT PANE: Form */}
      <div className="w-full lg:w-[400px] flex-shrink-0 flex flex-col gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Scenario Builder</h1>
          <p className="text-muted-foreground mt-1">Configure client landscape</p>
        </div>

        <Card className="shadow-sm border-border bg-card flex-1 overflow-hidden flex flex-col">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col h-full">
              <CardContent className="flex-1 overflow-y-auto p-5 space-y-5">
                
                <div className="space-y-4">
                  <div className="flex items-center gap-2 pb-2 border-b border-border">
                    <Users className="w-4 h-4 text-primary" />
                    <h3 className="font-semibold text-sm">Scale & Scope</h3>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="employees" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Employees</FormLabel>
                        <FormControl><Input type="number" {...field} className="bg-background" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="annualTransactions" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Transactions/Yr</FormLabel>
                        <FormControl><Input type="number" {...field} className="bg-background" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                  
                  <FormField control={form.control} name="sector" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Sector</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value} disabled={isLoadingProfiles}>
                        <FormControl>
                          <SelectTrigger className="bg-background">
                            <SelectValue placeholder="Select sector" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {profiles?.map(p => (
                            <SelectItem key={p.sector} value={p.sector} className="capitalize">{p.sector}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                <div className="space-y-4">
                  <div className="flex items-center gap-2 pb-2 border-b border-border">
                    <Database className="w-4 h-4 text-primary" />
                    <h3 className="font-semibold text-sm">Landscape Complexity</h3>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="numSystems" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">HR Systems</FormLabel>
                        <FormControl><Input type="number" {...field} className="bg-background" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="countries" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Countries</FormLabel>
                        <FormControl><Input type="number" {...field} className="bg-background" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>

                  <FormField control={form.control} name="companyType" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Geographic Span</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="single-country">Single Country</SelectItem>
                          <SelectItem value="multi-country">Multi-Country (2-5)</SelectItem>
                          <SelectItem value="global">Global (6+)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="isolationTier" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Compute Isolation</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="pooled">Pooled (Shared)</SelectItem>
                          <SelectItem value="siloed">Siloed (Tenant DB)</SelectItem>
                          <SelectItem value="dedicated">Dedicated (VPC)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                <div className="space-y-4">
                  <div className="flex items-center gap-2 pb-2 border-b border-border">
                    <DollarSign className="w-4 h-4 text-primary" />
                    <h3 className="font-semibold text-sm">Cost Baseline</h3>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="hrHourlyCostUsd" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">As-Is HR $/hr</FormLabel>
                        <FormControl><Input type="number" {...field} className="bg-background" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="hitlHourlyCostUsd" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">To-Be HITL $/hr</FormLabel>
                        <FormControl><Input type="number" {...field} className="bg-background" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                </div>

              </CardContent>
              <div className="p-4 border-t border-border bg-muted/20 flex gap-3">
                <Button type="submit" className="flex-1 font-semibold" disabled={computeRollup.isPending}>
                  {computeRollup.isPending ? "Computing..." : <><Play className="w-4 h-4 mr-2" /> Compute</>}
                </Button>
                <Button type="button" variant="outline" onClick={handleSave} disabled={computeRollup.isPending}>
                  <Save className="w-4 h-4" />
                </Button>
              </div>
            </form>
          </Form>
        </Card>
      </div>

      {/* RIGHT PANE: Results */}
      <div className="flex-1 flex flex-col min-h-0 bg-card rounded-xl border border-border shadow-sm overflow-hidden">
        {!rollup ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
            <Calculator className="w-16 h-16 mb-4 opacity-20" />
            <h2 className="text-xl font-semibold text-foreground mb-2">Ready to Compute</h2>
            <p className="max-w-md">Enter client parameters on the left and click Compute to generate a full cost-benefit rollup.</p>
          </div>
        ) : (
          <div className="flex flex-col h-full">
            {/* Header Totals */}
            <div className="p-6 border-b border-border bg-sidebar text-sidebar-foreground">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-2xl font-bold tracking-tight">Business Case Rollup</h2>
                  <div className="text-sm text-sidebar-foreground/70 flex items-center gap-2 mt-1">
                    <Badge className="bg-sidebar-primary text-sidebar-primary-foreground border-none font-mono">
                      Tier {rollup.tierMultiplier}x
                    </Badge>
                    <span>Based on {formatNumber(form.getValues().annualTransactions)} tx/yr</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-3xl font-bold text-emerald-400">
                    {formatCurrency(rollup.totals.netUsd, true)} Net Value
                  </div>
                  <div className="text-sm font-medium text-sidebar-foreground/80">
                    {rollup.totals.roi.toFixed(1)}x ROI
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-background/10 rounded-lg p-3 border border-sidebar-border">
                  <div className="text-xs text-sidebar-foreground/60 uppercase tracking-wider mb-1">Total Run Cost</div>
                  <div className="text-xl font-semibold font-mono">{formatCurrency(rollup.totals.runCostUsd, true)}</div>
                </div>
                <div className="bg-background/10 rounded-lg p-3 border border-sidebar-border">
                  <div className="text-xs text-sidebar-foreground/60 uppercase tracking-wider mb-1">Total Build Cost</div>
                  <div className="text-xl font-semibold font-mono">{formatCurrency(rollup.totals.buildCostUsd, true)}</div>
                </div>
                <div className="bg-background/10 rounded-lg p-3 border border-sidebar-border">
                  <div className="text-xs text-sidebar-foreground/60 uppercase tracking-wider mb-1">Gross Benefit</div>
                  <div className="text-xl font-semibold font-mono">{formatCurrency(rollup.totals.benefitUsd, true)}</div>
                </div>
                <div className="bg-emerald-500/20 rounded-lg p-3 border border-emerald-500/30">
                  <div className="text-xs text-emerald-200 uppercase tracking-wider mb-1">FTE Equivalent Saved</div>
                  <div className="text-xl font-semibold font-mono text-emerald-100">{rollup.totals.fteEquivalent.toFixed(1)}</div>
                </div>
              </div>
            </div>

            {/* Tabs for details */}
            <div className="flex-1 overflow-hidden flex flex-col">
              <Tabs defaultValue="distribution" className="flex-1 flex flex-col">
                <div className="px-6 pt-4 border-b border-border">
                  <TabsList className="bg-muted">
                    <TabsTrigger value="distribution"><Database className="w-4 h-4 mr-2"/> Intent Distribution</TabsTrigger>
                    <TabsTrigger value="charts"><BarChart3 className="w-4 h-4 mr-2"/> Breakdown Charts</TabsTrigger>
                    <TabsTrigger value="assumptions"><Settings2 className="w-4 h-4 mr-2"/> Applied Assumptions</TabsTrigger>
                  </TabsList>
                </div>
                
                <div className="flex-1 overflow-y-auto p-6">
                  
                  <TabsContent value="distribution" className="m-0 h-full">
                    <div className="rounded-md border border-border overflow-hidden">
                      <table className="w-full text-sm text-left">
                        <thead className="bg-muted/50 text-muted-foreground text-xs uppercase font-semibold">
                          <tr>
                            <th className="px-4 py-3">Intent</th>
                            <th className="px-4 py-3">Domain</th>
                            <th className="px-4 py-3 text-right">Vol (%)</th>
                            <th className="px-4 py-3 text-right">Cost</th>
                            <th className="px-4 py-3 text-right">Benefit</th>
                            <th className="px-4 py-3 text-right">Net Value</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {rollup.rows.sort((a,b) => b.share - a.share).map(row => (
                            <tr key={row.intentKey} className="hover:bg-muted/30 transition-colors">
                              <td className="px-4 py-3 font-medium text-foreground">{row.intentName}</td>
                              <td className="px-4 py-3">
                                <Badge variant="outline" className="capitalize text-[10px] bg-background">
                                  {row.domain}
                                </Badge>
                              </td>
                              <td className="px-4 py-3 text-right font-mono text-xs">
                                {(row.share * 100).toFixed(1)}%<br/>
                                <span className="text-muted-foreground">{formatNumber(row.transactions)}</span>
                              </td>
                              <td className="px-4 py-3 text-right font-mono text-xs">
                                {formatCurrency(row.runCostUsd + row.buildCostUsd, true)}
                              </td>
                              <td className="px-4 py-3 text-right font-mono text-xs text-emerald-600 dark:text-emerald-400">
                                {formatCurrency(row.benefitUsd, true)}
                              </td>
                              <td className="px-4 py-3 text-right font-mono font-semibold">
                                <span className={row.netUsd >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>
                                  {row.netUsd >= 0 ? "+" : ""}{formatCurrency(row.netUsd, true)}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </TabsContent>

                  <TabsContent value="charts" className="m-0 h-full">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-full">
                      <Card className="shadow-none border-border">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm">Cost Breakdown by Type</CardTitle>
                        </CardHeader>
                        <CardContent className="h-[250px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                              <Pie
                                data={rollup.byCostComponent}
                                cx="50%" cy="50%"
                                innerRadius={60} outerRadius={80}
                                paddingAngle={5}
                                dataKey="usd"
                                nameKey="label"
                              >
                                {rollup.byCostComponent.map((entry, index) => (
                                  <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                                ))}
                              </Pie>
                              <Tooltip formatter={(val: number) => formatCurrency(val, true)} />
                              <Legend />
                            </PieChart>
                          </ResponsiveContainer>
                        </CardContent>
                      </Card>

                      <Card className="shadow-none border-border">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm">Value by Domain</CardTitle>
                        </CardHeader>
                        <CardContent className="h-[250px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={rollup.byDomain} layout="vertical" margin={{ top: 5, right: 30, left: 40, bottom: 5 }}>
                              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                              <XAxis type="number" tickFormatter={(val) => formatNumber(val)} stroke="hsl(var(--muted-foreground))" fontSize={12} />
                              <YAxis type="category" dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                              <Tooltip formatter={(val: number) => formatCurrency(val, true)} />
                              <Bar dataKey="usd" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
                            </BarChart>
                          </ResponsiveContainer>
                        </CardContent>
                      </Card>
                    </div>
                  </TabsContent>

                  <TabsContent value="assumptions" className="m-0 h-full">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {rollup.appliedAssumptions.map(ass => (
                        <div key={ass.key} className="bg-muted/30 p-4 rounded-lg border border-border">
                          <div className="flex justify-between items-start mb-2">
                            <span className="font-semibold text-sm">{ass.label}</span>
                            <Badge variant="outline" className="font-mono text-xs bg-card">{ass.value} {ass.unit}</Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">{ass.rationale}</p>
                        </div>
                      ))}
                    </div>
                  </TabsContent>

                </div>
              </Tabs>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
