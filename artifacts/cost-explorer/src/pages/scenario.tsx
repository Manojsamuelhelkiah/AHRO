import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { 
  useComputeRollup, 
  useListDistributionProfiles, 
  useListModelCatalog, useListSystems,
  useListScenarios,
  useListAssumptions,
  useCreateScenario,
  useUpdateScenario,
  useGetScenario,
  getGetScenarioQueryKey,
  useListActualsOverlays,
  ScenarioInputs,
  Rollup,
  type ActualsOverlayRecord,
} from "@workspace/api-client-react";
import { useLocation, Link } from "wouter";
import { toApiInputs, fromApiInputs, OVERRIDABLE_ASSUMPTION_KEYS, type OverridableKey } from "@/lib/scenario-mapper";
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
  Settings2, GitCompareArrows, BrainCircuit,
  RotateCcw, ChevronDown,
  FlaskConical, X, ArrowRight, TrendingDown, CheckCircle2,
} from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import { formatCurrency, formatNumber } from "@/lib/format";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/** Empty inputs are treated as "not provided" — the model falls back to documented defaults. */
const optionalNumber = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (v) => (v === "" || v === null || v === undefined || (typeof v === "number" && Number.isNaN(v)) ? undefined : v),
    schema.optional()
  );
const assumptionOverridesSchema = z.object(
  Object.fromEntries(
    OVERRIDABLE_ASSUMPTION_KEYS.map((k) => [
      k,
      z.union([z.literal(""), z.coerce.number().min(0, "Must be ≥ 0")]).optional(),
    ])
  )
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
  nonIntegratedSystems: z.array(z.string()).optional(),
  _assumptionOverrides: assumptionOverridesSchema.optional(),
});

type FormValues = z.infer<typeof formSchema>;
const defaultValues: FormValues = {
  numSystems: 5,
  annualTransactions: 50000,
  employees: 5000,
  sector: "technology",
  companyType: "multi-country",
  isolationTier: "siloed",
  hrHourlyCostUsd: 45,
  hitlHourlyCostUsd: 35,
  countries: 3,
  _assumptionOverrides: {} as any,
};

export default function Scenario() {
  const [location] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const scenarioId = searchParams.get("id");
  const parsedId = scenarioId ? parseInt(scenarioId, 10) : null;
  
  const { toast } = useToast();
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [activeOverlayId, setActiveOverlayId] = useState<number | null>(null);
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  
  const { data: profiles, isLoading: isLoadingProfiles } = useListDistributionProfiles();
  const { data: modelCatalog } = useListModelCatalog();
  const { data: systemsCatalog } = useListSystems();
  const { data: scenarios, refetch: refetchScenarios } = useListScenarios();
  const { data: overlays } = useListActualsOverlays();
  const { data: globalAssumptions } = useListAssumptions();
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

  // Load scenario if ID in URL; auto-open Tune Assumptions if saved overrides exist.
  // fromApiInputs ensures assumptionOverrides never leak as raw top-level form keys.
  useEffect(() => {
    if (loadedScenario) {
      const formValues = fromApiInputs(
        loadedScenario.inputs as unknown as Record<string, unknown>
      ) as FormValues;
      const hasOverrides =
        Object.values(formValues._assumptionOverrides ?? {}).some(
          (v) => v !== "" && v !== undefined
        );
      if (hasOverrides) setAssumptionsOpen(true);
      form.reset(formValues);
      onSubmit(formValues);
    }
  }, [loadedScenario]);


  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    try {
      const body: { inputs: ScenarioInputs; actualsOverlayId?: number } = {
        inputs: toApiInputs(values) as ScenarioInputs,
      };
      if (activeOverlayId !== null) body.actualsOverlayId = activeOverlayId;
      const result = await computeRollup.mutateAsync({ data: body });
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

  const handleResetOverrides = () => {
    const current = form.getValues();
    const cleared = Object.fromEntries(
      OVERRIDABLE_ASSUMPTION_KEYS.map((k) => [k, "" as const])
    ) as Partial<Record<OverridableKey, number | "">>;
    form.reset({ ...current, _assumptionOverrides: cleared });
  };

  // When overlay changes, clear stale rollup so user must recompute
  const handleOverlaySelect = (id: number) => {
    setActiveOverlayId(id);
    setRollup(null);
  };
  const handleOverlayClear = () => {
    setActiveOverlayId(null);
    setRollup(null);
  };

  // Tabs: include variance when calibrated
  const showVarianceTab = rollup?.calibrated === true;
  const defaultTab = showVarianceTab ? "variance" : "distribution";

  // Lookup global defaults for comparison in the Applied Assumptions tab
  const globalDefaultMap = Object.fromEntries(
    (globalAssumptions ?? []).map((a) => [a.key, a.value])
  );

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

                <Collapsible open={assumptionsOpen} onOpenChange={setAssumptionsOpen}>
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="w-full flex items-center justify-between gap-2 pb-2 border-b border-border text-left"
                    >
                      <div className="flex items-center gap-2">
                        <Settings2 className="w-4 h-4 text-primary" />
                        <h3 className="font-semibold text-sm">Tune Assumptions</h3>
                        {(() => {
                          const ov = form.watch("_assumptionOverrides") ?? {};
                          const count = Object.values(ov).filter(v => v !== "" && v !== undefined).length;
                          return count > 0 ? (
                            <Badge variant="secondary" className="text-[10px] h-4 px-1.5 bg-primary/15 text-primary border-primary/20">
                              {count} custom
                            </Badge>
                          ) : null;
                        })()}
                      </div>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${assumptionsOpen ? "rotate-180" : ""}`} />
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-3 space-y-3">
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      Override any global assumption for this scenario only. Leave blank to use the model default.
                    </p>

                    <div className="space-y-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">AI model call costs</div>
                      {(["slm-call-cost", "llm-call-cost", "frontier-call-cost"] as OverridableKey[]).map(key => {
                        const def = globalDefaultMap[key];
                        return (
                          <FormField key={key} control={form.control} name={`_assumptionOverrides.${key}` as any} render={({ field }) => (
                            <FormItem>
                              <div className="flex items-center justify-between">
                                <FormLabel className="text-xs font-normal text-foreground/80">
                                  {key === "slm-call-cost" ? "SLM call" : key === "llm-call-cost" ? "LLM call" : "Frontier call"} <span className="text-muted-foreground">(USD)</span>
                                </FormLabel>
                                {def !== undefined && <span className="text-[10px] text-muted-foreground">default: {def}</span>}
                              </div>
                              <FormControl>
                                <Input type="number" step="any" min="0" placeholder={def !== undefined ? String(def) : "default"} {...field} value={field.value ?? ""} className="bg-background h-8 text-xs" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        );
                      })}
                    </div>

                    <div className="space-y-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Integration & infra</div>
                      {(["mcp-action-cost", "infra-per-txn"] as OverridableKey[]).map(key => {
                        const def = globalDefaultMap[key];
                        return (
                          <FormField key={key} control={form.control} name={`_assumptionOverrides.${key}` as any} render={({ field }) => (
                            <FormItem>
                              <div className="flex items-center justify-between">
                                <FormLabel className="text-xs font-normal text-foreground/80">
                                  {key === "mcp-action-cost" ? "MCP action" : "Infra per txn"} <span className="text-muted-foreground">(USD)</span>
                                </FormLabel>
                                {def !== undefined && <span className="text-[10px] text-muted-foreground">default: {def}</span>}
                              </div>
                              <FormControl>
                                <Input type="number" step="any" min="0" placeholder={def !== undefined ? String(def) : "default"} {...field} value={field.value ?? ""} className="bg-background h-8 text-xs" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        );
                      })}
                    </div>

                    <div className="space-y-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Landscape factors</div>
                      {(["landscape-fanout", "country-localization"] as OverridableKey[]).map(key => {
                        const def = globalDefaultMap[key];
                        return (
                          <FormField key={key} control={form.control} name={`_assumptionOverrides.${key}` as any} render={({ field }) => (
                            <FormItem>
                              <div className="flex items-center justify-between">
                                <FormLabel className="text-xs font-normal text-foreground/80">
                                  {key === "landscape-fanout" ? "Act fan-out per extra system" : "Localiz. uplift per country"}
                                </FormLabel>
                                {def !== undefined && <span className="text-[10px] text-muted-foreground">default: {def}</span>}
                              </div>
                              <FormControl>
                                <Input type="number" step="any" min="0" placeholder={def !== undefined ? String(def) : "default"} {...field} value={field.value ?? ""} className="bg-background h-8 text-xs" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        );
                      })}
                    </div>

                    <div className="space-y-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Tier & company multipliers</div>
                      {(["tier-pooled", "tier-siloed", "tier-dedicated", "company-multi-country", "company-global"] as OverridableKey[]).map(key => {
                        const def = globalDefaultMap[key];
                        const labels: Record<string, string> = {
                          "tier-pooled": "Pooled multiplier", "tier-siloed": "Siloed multiplier",
                          "tier-dedicated": "Dedicated multiplier", "company-multi-country": "Multi-country uplift",
                          "company-global": "Global uplift",
                        };
                        return (
                          <FormField key={key} control={form.control} name={`_assumptionOverrides.${key}` as any} render={({ field }) => (
                            <FormItem>
                              <div className="flex items-center justify-between">
                                <FormLabel className="text-xs font-normal text-foreground/80">{labels[key]}</FormLabel>
                                {def !== undefined && <span className="text-[10px] text-muted-foreground">default: {def}</span>}
                              </div>
                              <FormControl>
                                <Input type="number" step="any" min="0" placeholder={def !== undefined ? String(def) : "default"} {...field} value={field.value ?? ""} className="bg-background h-8 text-xs" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        );
                      })}
                    </div>

                    <Button type="button" variant="ghost" size="sm" onClick={handleResetOverrides} className="w-full text-xs text-muted-foreground hover:text-foreground h-8">
                      <RotateCcw className="w-3 h-3 mr-1.5" />
                      Reset all to defaults
                    </Button>
                  </CollapsibleContent>
                </Collapsible>

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

                <Separator />

                {/* Calibration overlay selector */}
                <div className="space-y-2">
                  <h3 className="font-semibold flex items-center text-sm uppercase tracking-wide text-muted-foreground">
                    <FlaskConical className="w-4 h-4 mr-2 text-primary" /> Calibration
                  </h3>
                  <OverlaySelector
                    overlays={overlays ?? []}
                    activeId={activeOverlayId}
                    onSelect={handleOverlaySelect}
                    onClear={handleOverlayClear}
                  />
                </div>

              </CardContent>
              <div className="p-4 border-t border-border bg-muted/20 flex flex-col gap-2">
                <div className="flex gap-3">
                  <Button type="submit" className="flex-1 font-semibold" disabled={computeRollup.isPending}>
                    {computeRollup.isPending ? "Computing..." : <><Play className="w-4 h-4 mr-2" /> {activeOverlayId ? "Compute (Calibrated)" : "Compute"}</>}
                  </Button>
                  <Button type="button" variant="outline" onClick={handleSave} disabled={computeRollup.isPending}>
                    <Save className="w-4 h-4" />
                  </Button>
                </div>
                <Link
                  href={parsedId ? `/compare?ids=${parsedId}&baseline=${parsedId}` : "/compare"}
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
            <p className="max-w-md">
              {activeOverlayId
                ? "Calibration overlay selected — click Compute (Calibrated) to see the measured business case and variance."
                : "Enter client parameters on the left and click Compute to generate a full cost-benefit rollup."}
            </p>
            {activeOverlayId && (
              <Badge className="mt-3 bg-violet-500/20 text-violet-700 dark:text-violet-300 border-violet-500/30">
                <FlaskConical className="w-3 h-3 mr-1" />
                Overlay #{activeOverlayId} ready
              </Badge>
            )}
          </div>
        ) : (
          <div className="flex flex-col h-full">
            {/* Header Totals */}
            <div className="p-6 border-b border-border bg-sidebar text-sidebar-foreground">
              <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
                <div>
                  <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                    Business Case Rollup
                    {rollup.calibrated && (
                      <Badge className="bg-violet-500/20 text-violet-200 border-violet-500/30 text-xs font-normal">
                        <FlaskConical className="w-3 h-3 mr-1" /> calibrated
                      </Badge>
                    )}
                  </h2>
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
                  {rollup.calibrated && rollup.estimatedTotals && (
                    <div className="text-xs text-sidebar-foreground/60 mt-0.5">
                      Est. {formatCurrency(rollup.estimatedTotals.netUsd, true)} before calibration
                    </div>
                  )}
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
                    <ConfidenceBadge level={rollup.confidence.level} score={rollup.confidence.score} />
                  </div>
                </div>
                <div className="w-full h-1.5 rounded-full bg-background/20 mb-3">
                  <div
                    className={`h-1.5 rounded-full transition-all ${
                      rollup.confidence.level === "calibrated" ? "bg-violet-400" :
                      rollup.confidence.level === "high" ? "bg-emerald-400" :
                      rollup.confidence.level === "medium" ? "bg-amber-400" : "bg-red-400"
                    }`}
                    style={{ width: `${Math.min(rollup.confidence.score, 100)}%` }}
                  />
                </div>
                {rollup.confidence.level === "calibrated" ? (
                  <p className="text-xs text-violet-300">
                    <CheckCircle2 className="w-3 h-3 inline mr-1" />
                    Fully calibrated — at least one assumption has been replaced by measured production data. The business case reflects actuals, not estimates.
                  </p>
                ) : rollup.confidence.factors.some(f => !f.provided) ? (
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

            {/* Tabs */}
            <div className="flex-1 overflow-hidden flex flex-col">
              <Tabs defaultValue={defaultTab} key={defaultTab} className="flex-1 flex flex-col">
                <div className="px-6 pt-4 border-b border-border overflow-x-auto">
                  <TabsList className="bg-muted">
                    {showVarianceTab && (
                      <TabsTrigger value="variance" className="text-violet-700 dark:text-violet-300 data-[state=active]:bg-violet-500/20">
                        <FlaskConical className="w-4 h-4 mr-2" /> Variance
                      </TabsTrigger>
                    )}
                    <TabsTrigger value="distribution"><Database className="w-4 h-4 mr-2"/> Intent Distribution</TabsTrigger>
                    <TabsTrigger value="charts"><BarChart3 className="w-4 h-4 mr-2"/> Breakdown Charts</TabsTrigger>
                    <TabsTrigger value="build"><Database className="w-4 h-4 mr-2"/> Build Costs</TabsTrigger>
                    <TabsTrigger value="assumptions"><Settings2 className="w-4 h-4 mr-2"/> Applied Assumptions</TabsTrigger>
                  </TabsList>
                </div>
                
                <div className="flex-1 overflow-y-auto p-6">

                  {/* Variance tab */}
                  {showVarianceTab && (
                    <TabsContent value="variance" className="m-0">
                      <VarianceView rollup={rollup} />
                    </TabsContent>
                  )}
                  
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
                      {rollup.appliedAssumptions.map(ass => {
                        const isMeasured = ass.source?.confidence === "measured";
                        const isCustom = !isMeasured && globalDefaultMap[ass.key] !== undefined && ass.value !== globalDefaultMap[ass.key];
                        return (
                          <div key={ass.key} className={`p-4 rounded-lg border transition-colors ${
                            isMeasured ? "border-violet-500/40 bg-violet-500/5" :
                            isCustom ? "bg-amber-500/5 border-amber-500/30" :
                            "bg-muted/30 border-border"
                          }`}>
                            <div className="flex justify-between items-start mb-2 gap-2 flex-wrap">
                              <span className="font-semibold text-sm">{ass.label}</span>
                              <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                                {isMeasured ? (
                                  <>
                                    <Badge className="bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30 text-[10px]">
                                      measured
                                    </Badge>
                                    <Badge variant="outline" className="font-mono text-xs bg-card line-through text-muted-foreground">
                                      {ass.value} {ass.unit}
                                    </Badge>
                                    <Badge className="font-mono text-xs bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30">
                                      {ass.measuredValue?.toFixed(4)} {ass.unit}
                                    </Badge>
                                  </>
                                ) : (
                                  <>
                                    {isCustom && (
                                      <Badge className="bg-amber-500/20 text-amber-600 dark:text-amber-300 border border-amber-500/30 text-[10px] h-4 px-1.5">
                                        custom
                                      </Badge>
                                    )}
                                    {ass.source?.confidence === "client-confirmed" && (
                                      <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 text-[10px]">
                                        client-confirmed
                                      </Badge>
                                    )}
                                    <Badge variant="outline" className="font-mono text-xs bg-card">{ass.value} {ass.unit}</Badge>
                                  </>
                                )}
                              </div>
                            </div>
                            {isCustom && globalDefaultMap[ass.key] !== undefined && (
                              <div className="text-[11px] text-amber-600 dark:text-amber-400 mb-1.5">
                                Default: {globalDefaultMap[ass.key]} {ass.unit}
                              </div>
                            )}
                            <p className="text-xs text-muted-foreground">{ass.rationale}</p>
                            {isMeasured && ass.source?.name && (
                              <p className="text-[10px] text-violet-600 dark:text-violet-400 mt-1.5 flex items-center gap-1">
                                <FlaskConical className="w-3 h-3" /> {ass.source.name}
                              </p>
                            )}
                          </div>
                        );
                      })}
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
const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];

function ConfidenceBadge({ level, score }: { level: string; score: number }) {
  if (level === "calibrated") {
    return (
      <Badge className="bg-violet-500/20 text-violet-200 border-violet-500/30 flex items-center gap-1">
        <CheckCircle2 className="w-3 h-3" />
        {score} · calibrated
      </Badge>
    );
  }
  return (
    <Badge className={
      level === "high" ? "bg-emerald-500/20 text-emerald-200 border-emerald-500/30" :
      level === "medium" ? "bg-amber-500/20 text-amber-200 border-amber-500/30" :
      "bg-red-500/20 text-red-200 border-red-500/30"
    }>
      {score}/100 · {level}
    </Badge>
  );
}

function OverlaySelector({
  overlays,
  activeId,
  onSelect,
  onClear,
}: {
  overlays: ActualsOverlayRecord[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onClear: () => void;
}) {
  const active = overlays.find(o => o.id === activeId);
  return (
    <div className={`rounded-lg border p-3 space-y-2 transition-colors ${active ? "border-violet-500/40 bg-violet-500/5" : "border-border bg-muted/20"}`}>
      <div className="flex items-center gap-2">
        <FlaskConical className={`w-4 h-4 ${active ? "text-violet-500" : "text-muted-foreground"}`} />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Calibration Overlay</span>
        {active && (
          <button
            type="button"
            onClick={onClear}
            className="ml-auto text-muted-foreground hover:text-foreground"
            title="Remove overlay"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {active ? (
        <div>
          <p className="text-sm font-medium text-violet-700 dark:text-violet-300 truncate">
            {active.clientLabel ?? `Overlay #${active.id}`}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Applied — recompute to see calibrated business case + variance
          </p>
        </div>
      ) : (
        <div>
          {overlays.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No overlays saved yet.{" "}
              <Link href="/calibration" className="text-primary hover:underline">Create one in Calibration →</Link>
            </p>
          ) : (
            <Select onValueChange={v => onSelect(Number(v))}>
              <SelectTrigger className="bg-background h-8 text-xs">
                <SelectValue placeholder="Select overlay to apply…" />
              </SelectTrigger>
              <SelectContent>
                {overlays.map(o => (
                  <SelectItem key={o.id} value={String(o.id)}>
                    #{o.id} · {o.clientLabel ?? "Unnamed"}
                    {o.periodStart ? ` (${o.periodStart})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
    </div>
  );
}

function VarianceView({ rollup }: { rollup: Rollup }) {
  if (!rollup.calibrated || !rollup.variance || !rollup.estimatedTotals) return null;

  const est = rollup.estimatedTotals;
  const act = rollup.totals;
  const costDelta = act.totalCostUsd - est.totalCostUsd;
  const benefitDelta = act.benefitUsd - est.benefitUsd;
  const netDelta = act.netUsd - est.netUsd;

  const fmt = (v: number) => formatCurrency(v, true);
  const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const fmtAbs = (v: number) => `${v >= 0 ? "+" : ""}${fmt(Math.abs(v))}`;

  return (
    <div className="space-y-5">
      {/* Business case delta summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: "Total Cost", est: est.totalCostUsd, act: act.totalCostUsd, delta: costDelta, positiveIsGood: false },
          { label: "Gross Benefit", est: est.benefitUsd, act: act.benefitUsd, delta: benefitDelta, positiveIsGood: true },
          { label: "Net Value", est: est.netUsd, act: act.netUsd, delta: netDelta, positiveIsGood: true },
        ].map(({ label, est: e, act: a, delta, positiveIsGood }) => {
          const good = positiveIsGood ? delta > 0 : delta < 0;
          const neutral = Math.abs(delta) < 1;
          return (
            <div key={label} className={`rounded-lg border p-3 ${neutral ? "border-border" : good ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5"}`}>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">{label}</div>
              <div className="flex items-baseline gap-2">
                <span className="text-sm text-muted-foreground line-through">{fmt(e)}</span>
                <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                <span className="font-bold font-mono">{fmt(a)}</span>
              </div>
              {!neutral && (
                <div className={`text-xs font-mono mt-1 flex items-center gap-1 ${good ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                  {good ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {fmtAbs(delta)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Per-assumption variance table */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Per-Assumption Variance</h3>
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm text-left">
            <thead className="bg-muted/50 text-muted-foreground text-xs uppercase font-semibold">
              <tr>
                <th className="px-4 py-3">Assumption</th>
                <th className="px-4 py-3 text-center">Affects</th>
                <th className="px-4 py-3 text-right">Estimated</th>
                <th className="px-4 py-3 text-right">Measured</th>
                <th className="px-4 py-3 text-right">Δ abs</th>
                <th className="px-4 py-3 text-right">Δ %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rollup.variance.map(v => {
                const pct = v.pctVariance;
                const isNeg = v.absVariance < 0;
                const isZero = Math.abs(v.absVariance) < 1e-9;
                return (
                  <tr key={v.assumptionKey} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground text-xs">{v.label}</div>
                      <div className="text-[10px] text-muted-foreground font-mono">{v.unit}</div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant="outline" className="text-[9px] capitalize bg-background">
                        {v.direction}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                      {v.estimatedValue.toFixed(v.unit.includes("USD") ? 4 : 4)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs font-semibold">
                      {v.actualValue.toFixed(4)}
                      <Badge className="ml-1.5 bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30 text-[9px]">
                        measured
                      </Badge>
                    </td>
                    <td className={`px-4 py-3 text-right font-mono text-xs font-semibold ${isZero ? "text-muted-foreground" : isNeg ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                      {isZero ? "—" : `${isNeg ? "" : "+"}${v.absVariance.toFixed(4)}`}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono text-xs font-semibold ${isZero ? "text-muted-foreground" : Math.abs(pct) > 10 ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}>
                      {isZero ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Estimated values are pre-calibration (assumptions register / scenario inputs). Measured values come from the actuals overlay. Δ = measured − estimated.
        </p>
      </div>
    </div>
  );
}
