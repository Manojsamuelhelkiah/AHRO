import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { 
  useComputeRollup, 
  useListDistributionProfiles, 
  useListModelCatalog, useListSystems,
  useListScenarios,
  useCreateScenario,
  useUpdateScenario,
  useGetScenario,
  getGetScenarioQueryKey,
  ScenarioInputs,
  Rollup
} from "@workspace/api-client-react";
import { useLocation, Link } from "wouter";

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
  Calculator, Save, Play, DollarSign, 
  TrendingUp, Users, BarChart3, Database, 
  Settings2, GitCompareArrows, BrainCircuit
} from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import { formatCurrency, formatNumber } from "@/lib/format";

/** Empty inputs are treated as "not provided" — the model falls back to documented defaults. */
const optionalNumber = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (v) => (v === "" || v === null || v === undefined || (typeof v === "number" && Number.isNaN(v)) ? undefined : v),
    schema.optional()
  );

const formSchema = z.object({
  numSystems: z.coerce.number().int("Whole number required").min(1, "At least 1 system"),
  annualTransactions: z.coerce.number().int("Whole number required").min(100, "Min 100 transactions"),
  employees: z.coerce.number().int("Whole number required").min(10, "Min 10 employees"),
  sector: z.string().min(1, "Required"),
  companyType: z.enum(["single-country", "multi-country", "global"]),
  isolationTier: z.enum(["pooled", "siloed", "dedicated"]),
  hrHourlyCostUsd: z.coerce.number().min(1),
  hitlHourlyCostUsd: z.coerce.number().min(1),
  countries: z.coerce.number().int("Whole number required").min(1),
  adoptionRate: optionalNumber(z.coerce.number().min(0.01, "Min 1%").max(1, "Max 100%")),
  hitlSamplingRate: optionalNumber(z.coerce.number().min(0.01, "Min 1%").max(1, "Max 100%")),
  landscapeMaturity: z.enum(["clean", "mixed", "legacy"]).optional(),
  contractYears: optionalNumber(z.coerce.number().int("Whole number required").min(1).max(10)),
  reworkRatePct: optionalNumber(z.coerce.number().min(0).max(20, "Max 20%")),
  peakLoadFactor: optionalNumber(z.coerce.number().min(1, "Min 1.0").max(1.5, "Max 1.5")),
  containmentFc1: optionalNumber(z.coerce.number().min(0).max(1)),
  containmentFc2: optionalNumber(z.coerce.number().min(0).max(1)),
  containmentFc3: optionalNumber(z.coerce.number().min(0).max(1)),
  containmentFc4: optionalNumber(z.coerce.number().min(0).max(1)),
  modelRouter: z.string().optional(),
  modelReasoning: z.string().optional(),
  modelFrontier: z.string().optional(),
  modelData: z.string().optional(),
  nonIntegratedSystems: z.array(z.string()).optional()
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

/** Maps the flat form values to the API ScenarioInputs shape. */
const toApiInputs = (v: z.infer<typeof formSchema>) => {
  const {
    adoptionRate, hitlSamplingRate, landscapeMaturity, contractYears,
    reworkRatePct, peakLoadFactor,
    containmentFc1, containmentFc2, containmentFc3, containmentFc4,
    modelRouter, modelReasoning, modelFrontier, modelData,
    nonIntegratedSystems,
    ...core
  } = v;
  const modelSelection: Record<string, string> = {};
  if (modelRouter) modelSelection.router = modelRouter;
  if (modelReasoning) modelSelection.reasoning = modelReasoning;
  if (modelFrontier) modelSelection.frontier = modelFrontier;
  if (modelData) modelSelection.data = modelData;
  const containmentOverrides: Record<string, number> = {};
  if (containmentFc1 !== undefined) containmentOverrides["fc1-deterministic"] = containmentFc1;
  if (containmentFc2 !== undefined) containmentOverrides["fc2-policy"] = containmentFc2;
  if (containmentFc3 !== undefined) containmentOverrides["fc3-multiagent"] = containmentFc3;
  if (containmentFc4 !== undefined) containmentOverrides["fc4-frontier"] = containmentFc4;
  return {
    ...core,
    ...(adoptionRate !== undefined && { adoptionRate }),
    ...(hitlSamplingRate !== undefined && { hitlSamplingRate }),
    ...(landscapeMaturity !== undefined && { landscapeMaturity }),
    ...(contractYears !== undefined && { contractYears }),
    ...(reworkRatePct !== undefined && { reworkRatePct }),
    ...(peakLoadFactor !== undefined && { peakLoadFactor }),
    ...(Object.keys(containmentOverrides).length > 0 && { containmentOverrides }),
    ...(Object.keys(modelSelection).length > 0 && { modelSelection }),
    ...((nonIntegratedSystems?.length ?? 0) > 0 && { nonIntegratedSystems })
  };
};

/** Maps stored API inputs back onto the flat form shape. */
const fromApiInputs = (inputs: Record<string, unknown>): z.infer<typeof formSchema> => {
  const co = (inputs.containmentOverrides ?? {}) as Record<string, number>;
  const ms = (inputs.modelSelection ?? {}) as Record<string, string>;
  return {
    ...defaultValues,
    ...(inputs as Partial<z.infer<typeof formSchema>>),
    adoptionRate: inputs.adoptionRate as number | undefined,
    hitlSamplingRate: inputs.hitlSamplingRate as number | undefined,
    landscapeMaturity: inputs.landscapeMaturity as "clean" | "mixed" | "legacy" | undefined,
    contractYears: inputs.contractYears as number | undefined,
    reworkRatePct: inputs.reworkRatePct as number | undefined,
    peakLoadFactor: inputs.peakLoadFactor as number | undefined,
    containmentFc1: co["fc1-deterministic"],
    containmentFc2: co["fc2-policy"],
    containmentFc3: co["fc3-multiagent"],
    containmentFc4: co["fc4-frontier"],
    modelRouter: ms.router,
    modelReasoning: ms.reasoning,
    modelFrontier: ms.frontier,
    modelData: ms.data,
    nonIntegratedSystems: (inputs.nonIntegratedSystems as string[] | undefined) ?? []
  };
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
  const { data: modelCatalog } = useListModelCatalog();
  const { data: systemsCatalog } = useListSystems();
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
      const values = fromApiInputs(loadedScenario.inputs as unknown as Record<string, unknown>);
      form.reset(values);
      onSubmit(values);
    }
  }, [loadedScenario, form]);

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    try {
      const result = await computeRollup.mutateAsync({ data: { inputs: toApiInputs(values) } });
      setRollup(result);
    } catch (e) {
      toast({ title: "Computation Failed", description: "Could not compute rollup.", variant: "destructive" });
    }
  };

  const handleSave = form.handleSubmit(async (values) => {
    const name = `Scenario - ${values.employees} EEs, ${values.sector}`;
    const inputs = toApiInputs(values);

    try {
      if (parsedId) {
        await updateScenario.mutateAsync({ id: parsedId, data: { name, inputs } });
        toast({ title: "Saved", description: "Scenario updated successfully." });
      } else {
        await createScenario.mutateAsync({ data: { name, inputs } });
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

                  <FormField control={form.control} name="reworkRatePct" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">As-Is Rework Rate %</FormLabel>
                      <FormControl><Input type="number" step="0.5" {...field} value={field.value ?? ""} placeholder="default 0" className="bg-background" /></FormControl>
                      <p className="text-[10px] text-muted-foreground">Share of transactions needing rework today; drives the error-reduction benefit</p>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                <div className="space-y-4">
                  <div className="flex items-center gap-2 pb-2 border-b border-border">
                    <TrendingUp className="w-4 h-4 text-primary" />
                    <h3 className="font-semibold text-sm">Adoption & Trust</h3>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="adoptionRate" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Adoption Rate (0-1)</FormLabel>
                        <FormControl><Input type="number" step="0.05" {...field} value={field.value ?? ""} placeholder="default 1.0" className="bg-background" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="hitlSamplingRate" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">HITL Sampling (0-1)</FormLabel>
                        <FormControl><Input type="number" step="0.05" {...field} value={field.value ?? ""} placeholder="default 1.0" className="bg-background" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>

                  <div>
                    <p className="text-xs font-medium">Containment by Flow Class (0-1)</p>
                    <div className="grid grid-cols-2 gap-3 mt-2">
                      <FormField control={form.control} name="containmentFc1" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-[10px] text-muted-foreground">Deterministic (FC1)</FormLabel>
                          <FormControl><Input type="number" step="0.05" {...field} value={field.value ?? ""} placeholder="0.95" className="bg-background" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="containmentFc2" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-[10px] text-muted-foreground">Policy (FC2)</FormLabel>
                          <FormControl><Input type="number" step="0.05" {...field} value={field.value ?? ""} placeholder="0.85" className="bg-background" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="containmentFc3" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-[10px] text-muted-foreground">Multi-Agent (FC3)</FormLabel>
                          <FormControl><Input type="number" step="0.05" {...field} value={field.value ?? ""} placeholder="0.75" className="bg-background" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="containmentFc4" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-[10px] text-muted-foreground">Frontier (FC4)</FormLabel>
                          <FormControl><Input type="number" step="0.05" {...field} value={field.value ?? ""} placeholder="0.60" className="bg-background" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">Uncontained transactions still incur AI/infra cost but fall back to full human handling</p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center gap-2 pb-2 border-b border-border">
                    <Settings2 className="w-4 h-4 text-primary" />
                    <h3 className="font-semibold text-sm">Delivery & Seasonality</h3>
                  </div>

                  <FormField control={form.control} name="landscapeMaturity" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Landscape Maturity</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? ""}>
                        <FormControl>
                          <SelectTrigger className="bg-background"><SelectValue placeholder="Not assessed (defaults to mixed)" /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="clean">Clean (API-first, −20% integration effort)</SelectItem>
                          <SelectItem value="mixed">Mixed (baseline)</SelectItem>
                          <SelectItem value="legacy">Legacy (+40% integration effort)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="contractYears" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Contract Years</FormLabel>
                        <FormControl><Input type="number" {...field} value={field.value ?? ""} placeholder="default 3" className="bg-background" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="peakLoadFactor" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Peak Load Factor</FormLabel>
                        <FormControl><Input type="number" step="0.05" {...field} value={field.value ?? ""} placeholder="default 1.0" className="bg-background" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                  <p className="text-[10px] text-muted-foreground">Onboarding cost is amortized over the contract; peak factor values automation at seasonal demand spikes (1.0-1.5)</p>

                  <FormField control={form.control} name="nonIntegratedSystems" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Non-Integrated Systems</FormLabel>
                      <p className="text-[10px] text-muted-foreground -mt-0.5 mb-1.5">
                        Systems the client will NOT connect to the MCP layer (no API access, vendor restrictions, security policy). Their get/put actions stay manual: no MCP cost, but ~5 min of agent handling per action, reducing the benefit for intents touching them.
                      </p>
                      <div className="grid grid-cols-2 gap-1.5">
                        {(systemsCatalog ?? []).map((sys) => {
                          const selected = (field.value ?? []).includes(sys.key);
                          return (
                            <button
                              key={sys.key}
                              type="button"
                              onClick={() => {
                                const cur = field.value ?? [];
                                field.onChange(selected ? cur.filter((k) => k !== sys.key) : [...cur, sys.key]);
                              }}
                              className={`text-left text-[11px] px-2 py-1.5 rounded-md border transition-colors ${
                                selected
                                  ? "border-destructive/50 bg-destructive/10 text-destructive font-medium"
                                  : "border-border bg-background text-muted-foreground hover:border-primary/40"
                              }`}
                              title={sys.name}
                            >
                              {selected ? "✕ " : ""}{sys.key}
                            </button>
                          );
                        })}
                      </div>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                <Separator />

                {/* AI Model Stack */}
                <div className="space-y-4">
                  <h3 className="font-semibold flex items-center text-sm uppercase tracking-wide text-muted-foreground">
                    <BrainCircuit className="w-4 h-4 mr-2 text-primary" /> AI Model Stack
                  </h3>
                  {(["router", "reasoning", "frontier", "data"] as const).map((role) => {
                    const fieldName = role === "router" ? "modelRouter" : role === "reasoning" ? "modelReasoning" : role === "frontier" ? "modelFrontier" : "modelData";
                    const options = (modelCatalog ?? []).filter((m) => m.role === role);
                    const label = role === "router" ? "Router / Classification (SLM)" : role === "reasoning" ? "Reasoning / Grounded Answers (LLM)" : role === "frontier" ? "Frontier / High-Judgment Cases (LRM)" : "Data Access / Legacy Databases (LDM)";
                    return (
                      <FormField key={role} control={form.control} name={fieldName} render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs">{label}</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value ?? ""}>
                            <FormControl>
                              <SelectTrigger className="bg-background">
                                <SelectValue placeholder="Default pricing (not confirmed)" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {options.map((m) => (
                                <SelectItem key={m.key} value={m.key}>
                                  {m.label} — ${m.pricePerCallUsd.toFixed(4)}/call{m.isDefault ? " (default)" : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )} />
                    );
                  })}
                  <p className="text-[10px] text-muted-foreground">Per-call prices from published token rates at a typical HRO call profile. Confirming the stack raises estimate confidence; every AI step reprices exactly.</p>
                </div>

              </CardContent>
              <div className="p-4 border-t border-border bg-muted/20 flex flex-col gap-2">
                <div className="flex gap-3">
                  <Button type="submit" className="flex-1 font-semibold" disabled={computeRollup.isPending}>
                    {computeRollup.isPending ? "Computing..." : <><Play className="w-4 h-4 mr-2" /> Compute</>}
                  </Button>
                  <Button type="button" variant="outline" onClick={handleSave} disabled={computeRollup.isPending}>
                    <Save className="w-4 h-4" />
                  </Button>
                </div>
                <Link
                  href={parsedId ? `/compare?a=${parsedId}` : "/compare"}
                  className="w-full"
                >
                  <Button type="button" variant="ghost" className="w-full text-muted-foreground text-xs">
                    <GitCompareArrows className="w-3.5 h-3.5 mr-1.5" />
                    Compare Scenarios
                  </Button>
                </Link>
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

              {/* Confidence */}
              <div className="mt-4 bg-background/10 rounded-lg p-4 border border-sidebar-border">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs uppercase tracking-wider text-sidebar-foreground/60">Estimate Confidence</span>
                    <Badge className={
                      rollup.confidence.level === "high" ? "bg-emerald-500/20 text-emerald-200 border-emerald-500/30" :
                      rollup.confidence.level === "medium" ? "bg-amber-500/20 text-amber-200 border-amber-500/30" :
                      "bg-red-500/20 text-red-200 border-red-500/30"
                    }>
                      {rollup.confidence.score}/100 · {rollup.confidence.level}
                    </Badge>
                  </div>
                </div>
                <div className="w-full h-1.5 rounded-full bg-background/20 mb-3">
                  <div
                    className={`h-1.5 rounded-full ${
                      rollup.confidence.level === "high" ? "bg-emerald-400" :
                      rollup.confidence.level === "medium" ? "bg-amber-400" : "bg-red-400"
                    }`}
                    style={{ width: `${rollup.confidence.score}%` }}
                  />
                </div>
                {rollup.confidence.factors.some(f => !f.provided) ? (
                  <div className="space-y-1.5">
                    <p className="text-xs text-sidebar-foreground/70 font-medium">
                      Missing client data (each adds points when provided):
                    </p>
                    {rollup.confidence.factors.filter(f => !f.provided).map(f => (
                      <div key={f.key} className="flex gap-2 text-xs text-sidebar-foreground/60">
                        <span className="font-mono text-amber-300/80 shrink-0">+{f.weight}</span>
                        <span><span className="font-medium text-sidebar-foreground/80">{f.label}:</span> {f.note}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-sidebar-foreground/70">All client-specific parameters provided — the business case rests on client data rather than generic defaults.</p>
                )}
              </div>
            </div>

            {/* Tabs for details */}
            <div className="flex-1 overflow-hidden flex flex-col">
              <Tabs defaultValue="distribution" className="flex-1 flex flex-col">
                <div className="px-6 pt-4 border-b border-border">
                  <TabsList className="bg-muted">
                    <TabsTrigger value="distribution"><Database className="w-4 h-4 mr-2"/> Intent Distribution</TabsTrigger>
                    <TabsTrigger value="charts"><BarChart3 className="w-4 h-4 mr-2"/> Breakdown Charts</TabsTrigger>
                    <TabsTrigger value="build"><Database className="w-4 h-4 mr-2"/> Build Costs</TabsTrigger>
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
                              <td className="px-4 py-3 font-medium text-foreground">
                                {row.intentName}
                                {row.overridden && (
                                  <Badge className="ml-2 bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/30 text-[10px]">SME-adjusted</Badge>
                                )}
                              </td>
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

                  <TabsContent value="build" className="m-0 h-full">
                    <p className="text-xs text-muted-foreground mb-3">
                      What it costs to build each component of the solution. One-time = engineering cost to stand the component up (platform components scale with landscape maturity). Annual = the share amortized into this scenario's build cost — platform components over expected transaction volume, onboarding over the contract term. Annual amounts sum exactly to the scenario's total build cost.
                    </p>
                    <div className="rounded-md border border-border overflow-hidden">
                      <table className="w-full text-sm text-left">
                        <thead className="bg-muted/50 text-muted-foreground text-xs uppercase font-semibold">
                          <tr>
                            <th className="px-4 py-3">Component</th>
                            <th className="px-4 py-3">Type</th>
                            <th className="px-4 py-3 text-right">One-Time Build</th>
                            <th className="px-4 py-3 text-right">Annual (this scenario)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {[...rollup.buildBreakdown].sort((a, b) => b.annualUsd - a.annualUsd).map((c) => (
                            <tr key={c.key} className="hover:bg-muted/30 transition-colors">
                              <td className="px-4 py-3">
                                <div className="font-medium text-foreground">{c.name}</div>
                                <div className="text-xs text-muted-foreground mt-0.5 max-w-xl">{c.description}</div>
                              </td>
                              <td className="px-4 py-3">
                                <Badge variant="outline" className={`text-[10px] capitalize ${c.kind === "platform" ? "bg-primary/5 text-primary border-primary/30" : "bg-background"}`}>
                                  {c.kind}
                                </Badge>
                              </td>
                              <td className="px-4 py-3 text-right font-mono text-xs">{formatCurrency(c.oneTimeUsd, true)}</td>
                              <td className="px-4 py-3 text-right font-mono text-xs font-semibold">{formatCurrency(c.annualUsd, true)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-muted/50">
                          <tr>
                            <td className="px-4 py-3 font-semibold text-xs uppercase text-muted-foreground" colSpan={2}>Total build cost in this scenario</td>
                            <td className="px-4 py-3 text-right font-mono text-xs">{formatCurrency(rollup.buildBreakdown.reduce((a, c) => a + c.oneTimeUsd, 0), true)}</td>
                            <td className="px-4 py-3 text-right font-mono text-xs font-bold">{formatCurrency(rollup.totals.buildCostUsd, true)}</td>
                          </tr>
                        </tfoot>
                      </table>
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
