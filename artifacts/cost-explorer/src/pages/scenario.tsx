import { useState, useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  useComputeRollup,
  useImportScenarioWorkbook,
  useComputeSensitivity,
  type SensitivityResult,
  useListDistributionProfiles,
  useListModelCatalog, useListSystems,
  useListScenarios,
  useListAssumptions,
  useListFlowClasses,
  useListIntents,
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
import {
  FLOW_CLASSES, DEFAULT_CONTAINMENT, DEFAULT_SAMPLING,
  type FcKey, formSchema, type FormValues, defaultValues,
  toApiInputs, fromApiInputs,
} from "@/lib/scenario-form";
import { OVERRIDABLE_ASSUMPTION_KEYS, type OverridableKey } from "@/lib/scenario-mapper";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Calculator, Save, Play, DollarSign,
  TrendingUp, Users, BarChart3, Database,
  Settings2, GitCompareArrows, BrainCircuit,
  RotateCcw, ChevronDown, ShieldCheck, GitBranch,
  FlaskConical, X, ArrowRight, TrendingDown, CheckCircle2, AlertCircle,
  FileSpreadsheet, Upload, Gauge,
} from "lucide-react";
import {
  ResponsiveContainer, ComposedChart, BarChart, PieChart, Pie, Cell,
  CartesianGrid, XAxis, YAxis, Tooltip, Legend, Bar, Area, Line, ReferenceLine,
} from "recharts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FlowDiagram } from "@/components/flow-diagram";

const pct = (v: number) => `${Math.round(v * 100)}%`;

export default function Scenario() {
  const searchParams = new URLSearchParams(window.location.search);
  const scenarioId = searchParams.get("id");
  const parsedId = scenarioId ? parseInt(scenarioId, 10) : null;
  // overlayId URL param lets deep-links (and tests) pre-select an overlay so
  // the auto-compute that fires on scenario load already applies it.
  const urlOverlayId = searchParams.get("overlayId");
  const parsedOverlayId = urlOverlayId ? parseInt(urlOverlayId, 10) : null;

  const { toast } = useToast();
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  const [intentOverridesOpen, setIntentOverridesOpen] = useState(false);
  const [activeOverlayId, setActiveOverlayId] = useState<number | null>(parsedOverlayId);

  // Local aliases for module-level helpers (defined after component).
  const formatCurrency = formatCurrencyLocal;
  const formatNumber   = formatNumberLocal;

  const { data: profiles, isLoading: isLoadingProfiles } = useListDistributionProfiles();
  const { data: modelCatalog } = useListModelCatalog();
  const { data: systemsCatalog } = useListSystems();
  const { refetch: refetchScenarios } = useListScenarios();
  const { data: overlays } = useListActualsOverlays();
  const { data: globalAssumptions } = useListAssumptions();
  const { data: flowClasses } = useListFlowClasses();
  const { data: intentList } = useListIntents();
  const computeRollupMutation = useComputeRollup();
  const importWorkbookMutation = useImportScenarioWorkbook();
  const sensitivityMutation = useComputeSensitivity();
  const [sensitivity, setSensitivity] = useState<SensitivityResult | null>(null);
  const sensitivityReqRef = useRef(0);
  const workbookFileRef = useRef<HTMLInputElement>(null);
  const createScenario = useCreateScenario();
  const updateScenario = useUpdateScenario();
  const { data: loadedScenario } = useGetScenario(parsedId as number, {
    query: {
      enabled: !!parsedId,
      queryKey: getGetScenarioQueryKey(parsedId as number),
    },
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues,
  });

  // Load scenario if ID in URL; auto-open Tune Assumptions if saved overrides exist.
  // fromApiInputs ensures assumptionOverrides / containmentOverrides never leak as
  // raw top-level form keys (the stale-override bug root cause).
  useEffect(() => {
    if (loadedScenario) {
      const formValues = fromApiInputs(loadedScenario.inputs as ScenarioInputs);
      const hasOverrides = Object.values(formValues._assumptionOverrides ?? {}).some(
        (v) => v !== "" && v !== undefined
      );
      if (hasOverrides) setAssumptionsOpen(true);
      form.reset(formValues);
      onSubmit(formValues);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedScenario]);

  const onSubmit = async (values: FormValues) => {
    try {
      const body: { inputs: ScenarioInputs; actualsOverlayId?: number } = {
        inputs: toApiInputs(values) as ScenarioInputs,
      };
      if (activeOverlayId !== null) body.actualsOverlayId = activeOverlayId;
      // Sensitivity runs in parallel; its failure must not block the rollup.
      // The request id guards against a stale response landing after a newer
      // compute. Overlay id is forwarded so the tornado matches the rollup.
      const reqId = ++sensitivityReqRef.current;
      setSensitivity(null);
      sensitivityMutation.mutateAsync({ data: { inputs: body.inputs, actualsOverlayId: body.actualsOverlayId } })
        .then((r) => { if (sensitivityReqRef.current === reqId) setSensitivity(r); })
        .catch(() => { if (sensitivityReqRef.current === reqId) setSensitivity(null); });
      const result = await computeRollupMutation.mutateAsync({ data: body });
      setRollup(result);
    } catch {
      toast({ title: "Computation Failed", description: "Could not compute rollup.", variant: "destructive" });
    }
  };

  const handleSave = form.handleSubmit(async (values) => {
    const name = `Scenario – ${values.employees} EEs, ${values.sector}`;
    try {
      if (parsedId) {
        await updateScenario.mutateAsync({ id: parsedId, data: { name, inputs: toApiInputs(values) } });
        toast({ title: "Saved", description: "Scenario updated successfully." });
      } else {
        await createScenario.mutateAsync({ data: { name, inputs: toApiInputs(values) } });
        toast({ title: "Saved", description: "New scenario created." });
        refetchScenarios();
      }
    } catch {
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

  // Excel shadow workbook: download prefilled from the current form; on import
  // the server reads ONLY the inputs and we reprice with the exact engine.
  // Direct-navigation download (GET + base64url payload): blob-based
  // programmatic downloads are blocked by mobile browsers in the preview iframe.
  const handleWorkbookExport = form.handleSubmit((values) => {
    const json = JSON.stringify({ inputs: toApiInputs(values) });
    const q = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const a = document.createElement("a");
    a.href = `/api/workbook/export?q=${q}`;
    a.download = "hro-cost-shadow.xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  const handleWorkbookImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const result = await importWorkbookMutation.mutateAsync({ data: { workbookFile: file } });
      const formValues = fromApiInputs(result.inputs as ScenarioInputs);
      form.reset(formValues);
      setActiveOverlayId(null);
      await onSubmit(formValues);
      toast({ title: "Workbook Imported", description: "Inputs loaded and repriced with the exact engine." });
    } catch (err) {
      toast({ title: "Import Failed", description: (err as { message?: string })?.message || "Could not read the workbook.", variant: "destructive" });
    }
  };

  const handleOverlaySelect = (id: number) => { setActiveOverlayId(id); setRollup(null); };
  const handleOverlayClear  = () => { setActiveOverlayId(null); setRollup(null); };

  // Show Variance tab when a calibrated rollup is present.
  const showVarianceTab = rollup?.calibrated === true;
  const defaultTab = showVarianceTab ? "variance" : "flowdiagram";

  // Lookup global defaults for custom-assumption highlighting.
  const globalDefaultMap = Object.fromEntries(
    (globalAssumptions ?? []).map((a) => [a.key, a.value])
  );

  return (
    <div className="flex flex-col lg:flex-row h-full gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20">

      {/* ── LEFT PANE: Form ─────────────────────────────────────────────── */}
      <div className="w-full lg:w-[420px] flex-shrink-0 flex flex-col gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Scenario Builder</h1>
          <p className="text-muted-foreground mt-1">Configure client landscape</p>
        </div>

        <Card className="shadow-sm border-border bg-card flex-1 overflow-hidden flex flex-col">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col h-full">
              <CardContent className="flex-1 overflow-y-auto p-5 space-y-5">

                {/* Scale & Scope */}
                <div className="space-y-4">
                  <SectionHeader icon={<Users className="w-4 h-4 text-primary" />} label="Scale & Scope" />
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
                          <SelectTrigger className="bg-background"><SelectValue placeholder="Select sector" /></SelectTrigger>
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

                {/* Landscape Complexity */}
                <div className="space-y-4">
                  <SectionHeader icon={<Database className="w-4 h-4 text-primary" />} label="Landscape Complexity" />
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
                          <SelectItem value="multi-country">Multi-Country (2–5)</SelectItem>
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

                {/* Cost Baseline */}
                <div className="space-y-4">
                  <SectionHeader icon={<DollarSign className="w-4 h-4 text-primary" />} label="Cost Baseline" />
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
                      <FormControl>
                        <Input type="number" step="0.5" {...field} value={field.value ?? ""} placeholder="default 0" className="bg-background" />
                      </FormControl>
                      <p className="text-[10px] text-muted-foreground">Share of transactions needing rework today; drives the error-reduction benefit</p>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                {/* Automation Fidelity */}
                <div className="space-y-4">
                  <SectionHeader icon={<ShieldCheck className="w-4 h-4 text-primary" />} label="Automation Fidelity" />

                  {/* Adoption Ramp */}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Adoption ramp (fraction automated per year)</p>
                    <div className="grid grid-cols-3 gap-2">
                      {(["adoptionRampY1", "adoptionRampY2", "adoptionRampY3"] as const).map((fieldName, i) => (
                        <FormField key={fieldName} control={form.control} name={fieldName} render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs text-center block">Year {i + 1}</FormLabel>
                            <FormControl>
                              <div className="relative">
                                <Input
                                  type="number" step="0.01" min="0" max="1"
                                  {...field}
                                  value={field.value ?? ""}
                                  placeholder={["0.40", "0.75", "1.00"][i]}
                                  className="bg-background pr-6 text-xs"
                                />
                                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">×</span>
                              </div>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">Fraction of annual volume entering the automated channel each year (0–1, non-decreasing). Default: 40/75/100%.</p>
                  </div>

                  {/* Containment Rates */}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Containment rate per flow class</p>
                    <div className="space-y-2">
                      {FLOW_CLASSES.map(({ key, label }) => (
                        <FormField
                          key={key}
                          control={form.control}
                          name={`containmentRates.${key}` as any}
                          render={({ field }) => (
                            <FormItem className="flex items-center gap-3">
                              <FormLabel className="text-xs w-36 shrink-0 text-muted-foreground">{label}</FormLabel>
                              <FormControl>
                                <Input
                                  type="number" step="0.01" min="0" max="1"
                                  {...field}
                                  value={field.value ?? ""}
                                  placeholder={({"fc1-deterministic": "0.95", "fc2-policy": "0.88", "fc3-multiagent": "0.80", "fc4-frontier": "0.70"} as Record<string, string>)[key]}
                                  className="bg-background h-7 text-xs"
                                />
                              </FormControl>
                              <span className="text-xs text-muted-foreground w-8 shrink-0">
                                {field.value !== undefined ? pct(Number(field.value)) : "—"}
                              </span>
                            </FormItem>
                          )}
                        />
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">Share of automated transactions that complete without human fallback. Supplying all 4 raises confidence. Non-contained transactions still incur AI/infra cost but fall back to full human handling.</p>
                  </div>

                  {/* Per-Intent Containment Targets (drift comparison only) */}
                  {(intentList ?? []).length > 0 && (
                    <Collapsible open={intentOverridesOpen} onOpenChange={setIntentOverridesOpen}>
                      <CollapsibleTrigger asChild>
                        <button
                          type="button"
                          className="w-full flex items-center justify-between gap-2 py-1.5 text-left"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                              Per-intent containment targets
                            </span>
                            <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-violet-500/40 text-violet-600 dark:text-violet-400 bg-violet-500/5">
                              Drift only
                            </Badge>
                            {(() => {
                              const ico = form.watch("_intentContainmentOverrides") ?? {};
                              const count = Object.values(ico).filter(v => v !== undefined && v !== null && v !== ("" as unknown)).length;
                              return count > 0 ? (
                                <Badge variant="secondary" className="text-[10px] h-4 px-1.5 bg-primary/15 text-primary border-primary/20">
                                  {count} set
                                </Badge>
                              ) : null;
                            })()}
                          </div>
                          <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 ${intentOverridesOpen ? "rotate-180" : ""}`} />
                        </button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="pt-2 space-y-3">
                        <p className="text-[10px] text-muted-foreground leading-relaxed">
                          Set a specific containment target per intent for drift comparison only — overrides the flow-class value as the reference line in the Drift tab. Does not affect the cost model. Leave blank to use the flow-class default.
                        </p>
                        {/* Group intents by flow class */}
                        {FLOW_CLASSES.map(({ key: fcKey, label: fcLabel }) => {
                          const fcIntents = (intentList ?? []).filter(i => i.flowClass === fcKey);
                          if (fcIntents.length === 0) return null;
                          return (
                            <div key={fcKey}>
                              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                                {fcLabel}
                              </div>
                              <div className="space-y-1">
                                {fcIntents.map(intent => {
                                  const fieldKey = `_intentContainmentOverrides.${intent.key}` as any;
                                  const watchedVal = form.watch(fieldKey);
                                  return (
                                    <div key={intent.key} className="flex items-center gap-2">
                                      <span className="text-xs text-foreground/80 truncate flex-1 min-w-0" title={intent.name}>
                                        {intent.name}
                                      </span>
                                      <Input
                                        type="number"
                                        step="0.01"
                                        min="0"
                                        max="1"
                                        value={watchedVal ?? ""}
                                        onChange={e => {
                                          const raw = e.target.value;
                                          if (raw === "") {
                                            form.setValue(fieldKey, undefined as any, { shouldDirty: true });
                                          } else {
                                            const n = parseFloat(raw);
                                            if (!isNaN(n) && n >= 0 && n <= 1) {
                                              form.setValue(fieldKey, n as any, { shouldDirty: true });
                                            }
                                          }
                                        }}
                                        placeholder={
                                          // Placeholder: FC-level override if set, otherwise FC default
                                          (() => {
                                            const fcOverride = form.watch(`containmentRates.${fcKey}` as any);
                                            const def = ({ "fc1-deterministic": "0.95", "fc2-policy": "0.88", "fc3-multiagent": "0.80", "fc4-frontier": "0.70" } as Record<string, string>)[fcKey] ?? "";
                                            return fcOverride !== undefined ? String(fcOverride) : def;
                                          })()
                                        }
                                        className="bg-background h-6 text-xs w-20 shrink-0"
                                      />
                                      <span className="text-xs text-muted-foreground w-8 shrink-0 text-right">
                                        {watchedVal !== undefined && watchedVal !== null && watchedVal !== ("" as unknown)
                                          ? pct(Number(watchedVal))
                                          : "—"}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                        <button
                          type="button"
                          className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                          onClick={() => {
                            const ico = form.getValues("_intentContainmentOverrides") ?? {};
                            const cleared = Object.fromEntries(Object.keys(ico).map(k => [k, undefined]));
                            form.setValue("_intentContainmentOverrides", cleared as any, { shouldDirty: true });
                          }}
                        >
                          Clear all per-intent targets
                        </button>
                      </CollapsibleContent>
                    </Collapsible>
                  )}

                  {/* HITL Sampling Rates */}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">HITL sampling rate per flow class</p>
                    <div className="space-y-2">
                      {FLOW_CLASSES.map(({ key, label }) => (
                        <FormField
                          key={key}
                          control={form.control}
                          name={`hitlSamplingRates.${key}` as any}
                          render={({ field }) => (
                            <FormItem className="flex items-center gap-3">
                              <FormLabel className="text-xs w-36 shrink-0 text-muted-foreground">{label}</FormLabel>
                              <FormControl>
                                <Input
                                  type="number" step="0.01" min="0" max="1"
                                  {...field}
                                  value={field.value ?? ""}
                                  placeholder={({"fc1-deterministic": "0.05", "fc2-policy": "0.15", "fc3-multiagent": "0.30", "fc4-frontier": "0.60"} as Record<string, string>)[key]}
                                  className="bg-background h-7 text-xs"
                                />
                              </FormControl>
                              <span className="text-xs text-muted-foreground w-8 shrink-0">
                                {field.value !== undefined ? pct(Number(field.value)) : "—"}
                              </span>
                            </FormItem>
                          )}
                        />
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">Fraction of contained transactions receiving human review (scales HITL cost). Default: 5/15/30/60%.</p>
                  </div>
                </div>

                {/* Delivery & Seasonality */}
                <div className="space-y-4">
                  <SectionHeader icon={<Settings2 className="w-4 h-4 text-primary" />} label="Delivery & Seasonality" />

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
                        <FormControl>
                          <Input type="number" {...field} value={field.value ?? ""} placeholder="default 3" className="bg-background" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="peakLoadFactor" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Peak Load Factor</FormLabel>
                        <FormControl>
                          <Input type="number" step="0.05" {...field} value={field.value ?? ""} placeholder="default 1.0" className="bg-background" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                  <p className="text-[10px] text-muted-foreground">Onboarding cost is amortized over the contract; peak factor values automation at seasonal demand spikes (1.0–1.5).</p>

                  <FormField control={form.control} name="nonIntegratedSystems" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Non-Integrated Systems</FormLabel>
                      <p className="text-[10px] text-muted-foreground -mt-0.5 mb-1.5">
                        Systems the client will NOT connect to the MCP layer. Their get/put actions stay manual: no MCP cost, but ~5 min per action, reducing the benefit for intents touching them.
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
                                field.onChange(selected ? cur.filter(k => k !== sys.key) : [...cur, sys.key]);
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

                {/* Tune Assumptions */}
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
                  <SectionHeader icon={<BrainCircuit className="w-4 h-4 text-primary" />} label="AI Model Stack" />
                  {(["router", "reasoning", "frontier", "data"] as const).map((role) => {
                    const fieldName = (
                      role === "router"    ? "modelRouter"    :
                      role === "reasoning" ? "modelReasoning" :
                      role === "frontier"  ? "modelFrontier"  : "modelData"
                    ) as keyof FormValues;
                    const options = (modelCatalog ?? []).filter(m => m.role === role);
                    const label = (
                      role === "router"    ? "Router / Classification (SLM)" :
                      role === "reasoning" ? "Reasoning / Grounded Answers (LLM)" :
                      role === "frontier"  ? "Frontier / High-Judgment Cases (LRM)" :
                                            "Data Access / Legacy Databases (LDM)"
                    );
                    return (
                      <FormField key={role} control={form.control} name={fieldName} render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs">{label}</FormLabel>
                          <Select onValueChange={field.onChange} value={(field.value as string) ?? ""}>
                            <FormControl>
                              <SelectTrigger className="bg-background">
                                <SelectValue placeholder="Default pricing (not confirmed)" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {options.map(m => (
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
                  <p className="text-[10px] text-muted-foreground">Confirming the model stack raises estimate confidence and reprices every AI step exactly.</p>
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
                  <Button type="submit" className="flex-1 font-semibold" disabled={computeRollupMutation.isPending}>
                    {computeRollupMutation.isPending ? "Computing…" : <><Play className="w-4 h-4 mr-2" /> {activeOverlayId ? "Compute (Calibrated)" : "Compute"}</>}
                  </Button>
                  <Button type="button" variant="outline" onClick={handleSave} disabled={computeRollupMutation.isPending}>
                    <Save className="w-4 h-4" />
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" className="flex-1 text-xs" onClick={handleWorkbookExport} data-testid="button-export-workbook">
                    <FileSpreadsheet className="w-3.5 h-3.5 mr-1.5" />
                    Excel Shadow
                  </Button>
                  <Button type="button" variant="outline" size="sm" className="flex-1 text-xs" onClick={() => workbookFileRef.current?.click()} disabled={importWorkbookMutation.isPending} data-testid="button-import-workbook">
                    <Upload className="w-3.5 h-3.5 mr-1.5" />
                    {importWorkbookMutation.isPending ? "Importing…" : "Import Workbook"}
                  </Button>
                  <input ref={workbookFileRef} type="file" accept=".xlsx" className="hidden" onChange={handleWorkbookImport} data-testid="input-workbook-file" />
                </div>
                <Link href={parsedId ? `/compare?ids=${parsedId}&baseline=${parsedId}` : "/compare"} className="w-full">
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

      {/* ── RIGHT PANE: Results ────────────────────────────────────────── */}
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

            {/* Header KPIs */}
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
                    <span>Year 1 of {formatNumber(form.getValues().annualTransactions)} tx/yr committed</span>
                    {rollup.appliedAssumptions.some(a =>
                      globalDefaultMap[a.key] !== undefined && a.value !== globalDefaultMap[a.key]
                    ) && (
                      <Badge className="bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px]">
                        custom assumptions
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-3xl font-bold text-emerald-400">
                    {formatCurrencyLocal(rollup.totals.netUsd, true)} Net
                  </div>
                  {rollup.calibrated && rollup.estimatedTotals && (
                    <div className="text-xs text-sidebar-foreground/60 mt-0.5">
                      Est. {formatCurrencyLocal(rollup.estimatedTotals.netUsd, true)} before calibration
                    </div>
                  )}
                  <div className="text-sm font-medium text-sidebar-foreground/80">
                    {rollup.totals.roi.toFixed(1)}x ROI · Year 1
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <KpiTile label="Total Run Cost"   value={formatCurrencyLocal(rollup.totals.runCostUsd, true)} color="blue" />
                <KpiTile label="Total Build Cost" value={formatCurrencyLocal(rollup.totals.buildCostUsd, true)} color="amber" />
                <KpiTile label="Gross Benefit"    value={formatCurrencyLocal(rollup.totals.benefitUsd, true)} color="emerald" />
                <KpiTile label="FTE Saved (Yr 1)" value={rollup.totals.fteEquivalent.toFixed(1)} accent color="emerald" />
              </div>

              {/* Confidence widget */}
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
                      rollup.confidence.level === "high"   ? "bg-emerald-400" :
                      rollup.confidence.level === "medium" ? "bg-amber-400"   : "bg-red-400"
                    }`}
                    style={{ width: `${Math.min(rollup.confidence.score, 100)}%` }}
                  />
                </div>
                {rollup.confidence.level === "calibrated" ? (
                  <p className="text-xs text-violet-300">
                    <CheckCircle2 className="w-3 h-3 inline mr-1" />
                    Fully calibrated — at least one assumption has been replaced by measured production data. The business case reflects actuals, not estimates.
                  </p>
                ) : (() => {
                  const absent  = rollup.confidence.factors.filter(f => f.fraction === 0);
                  const partial = rollup.confidence.factors.filter(f => f.fraction > 0 && f.fraction < 1);
                  if (absent.length === 0 && partial.length === 0) {
                    return <p className="text-xs text-sidebar-foreground/70">All client-specific parameters provided — the business case rests on client data rather than generic defaults.</p>;
                  }
                  return (
                    <div className="space-y-2">
                      {partial.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-xs text-sidebar-foreground/70 font-medium">Partial data — remaining flow classes use defaults:</p>
                          {partial.map(f => {
                            const remaining = Math.round(f.weight * (1 - f.fraction));
                            const suppliedCount = Math.round(f.fraction * 4);
                            return (
                              <div key={f.key} className="flex gap-2 text-xs text-sidebar-foreground/60">
                                <span className="font-mono text-sky-300/80 shrink-0">+{remaining}</span>
                                <span>
                                  <span className="font-medium text-sidebar-foreground/80">{f.label}</span>
                                  {" "}({suppliedCount}/4 flow classes){": "}
                                  {f.note}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {absent.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-xs text-sidebar-foreground/70 font-medium">Missing client data (each adds points when provided):</p>
                          {absent.map(f => (
                            <div key={f.key} className="flex gap-2 text-xs text-sidebar-foreground/60">
                              <span className="font-mono text-amber-300/80 shrink-0">+{f.weight}</span>
                              <span><span className="font-medium text-sidebar-foreground/80">{f.label}:</span> {f.note}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Orphaned-intent keys warning */}
            {rollup.orphanedIntentKeys && rollup.orphanedIntentKeys.length > 0 && (
              <div className="px-6 pt-4">
                <Alert className="border-amber-500/40 bg-amber-500/10">
                  <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                  <AlertDescription className="text-amber-800 dark:text-amber-200 text-xs">
                    <span className="font-semibold">
                      {rollup.orphanedIntentKeys.length === 1
                        ? "1 intent in this overlay no longer exists"
                        : `${rollup.orphanedIntentKeys.length} intents in this overlay no longer exist`}{" "}
                      and {rollup.orphanedIntentKeys.length === 1 ? "was" : "were"} skipped — the rollup used the valid remainder:
                    </span>{" "}
                    <span className="font-mono">{rollup.orphanedIntentKeys.join(", ")}</span>.
                    {" "}Edit the overlay on the{" "}
                    <Link href="/calibration" className="underline hover:no-underline">Calibration page</Link>
                    {" "}or restore the retired intents.
                  </AlertDescription>
                </Alert>
              </div>
            )}

            {/* Tabs */}
            <div className="flex-1 overflow-hidden flex flex-col">
              <Tabs defaultValue={defaultTab} key={defaultTab} className="flex-1 flex flex-col">
                <div className="px-6 pt-4 border-b border-border overflow-x-auto">
                  <TabsList className="bg-muted flex-wrap">
                    {showVarianceTab && (
                      <TabsTrigger value="variance" className="text-violet-700 dark:text-violet-300 data-[state=active]:bg-violet-500/20">
                        <FlaskConical className="w-4 h-4 mr-2" /> Variance
                      </TabsTrigger>
                    )}
                    <TabsTrigger value="flowdiagram"><GitBranch className="w-4 h-4 mr-2" />Flow Diagram</TabsTrigger>
                    <TabsTrigger value="distribution"><Database className="w-4 h-4 mr-2" />Intent Distribution</TabsTrigger>
                    <TabsTrigger value="3year"><TrendingUp className="w-4 h-4 mr-2" />3-Year View</TabsTrigger>
                    <TabsTrigger value="charts"><BarChart3 className="w-4 h-4 mr-2" />Breakdown</TabsTrigger>
                    <TabsTrigger value="build"><Settings2 className="w-4 h-4 mr-2" />Build Costs</TabsTrigger>
                    <TabsTrigger value="sensitivity" data-testid="tab-sensitivity"><Gauge className="w-4 h-4 mr-2" />Sensitivity</TabsTrigger>
                    <TabsTrigger value="assumptions">
                      <Settings2 className="w-4 h-4 mr-2" />Assumptions
                      {rollup.appliedAssumptions.some(a =>
                        globalDefaultMap[a.key] !== undefined && a.value !== globalDefaultMap[a.key]
                      ) && (
                        <Badge className="ml-2 bg-amber-500/20 text-amber-600 dark:text-amber-300 border border-amber-500/30 text-[10px] h-4 px-1">
                          {rollup.appliedAssumptions.filter(a =>
                            globalDefaultMap[a.key] !== undefined && a.value !== globalDefaultMap[a.key]
                          ).length} custom
                        </Badge>
                      )}
                    </TabsTrigger>
                  </TabsList>
                </div>

                <div className="flex-1 overflow-y-auto p-6">

                  {/* Variance tab */}
                  {showVarianceTab && (
                    <TabsContent value="variance" className="m-0">
                      <VarianceView rollup={rollup} />
                    </TabsContent>
                  )}

                  {/* Flow Diagram */}
                  <TabsContent value="flowdiagram" className="m-0 h-full">
                    <div className="space-y-6">
                      {(() => {
                        const formVals = form.getValues();
                        const adoptFrac = rollup.byYear[0]?.adoptionFraction ?? rollup.adoptionRate;
                        const fcVolumes: Record<string, number> = {};
                        for (const row of rollup.rows) {
                          fcVolumes[row.flowClass] = (fcVolumes[row.flowClass] ?? 0) + row.transactions;
                        }
                        return FLOW_CLASSES.map(fc => {
                          const fcSteps = flowClasses?.find(f => f.key === fc.key)?.steps ?? [];
                          const containFrac = formVals.containmentRates?.[fc.key] !== undefined
                            ? formVals.containmentRates![fc.key]!
                            : DEFAULT_CONTAINMENT[fc.key as FcKey];
                          const hitlFrac = formVals.hitlSamplingRates?.[fc.key] !== undefined
                            ? formVals.hitlSamplingRates![fc.key]!
                            : DEFAULT_SAMPLING[fc.key as FcKey];
                          const usingContainDefault = formVals.containmentRates?.[fc.key] === undefined;
                          const usingHitlDefault = formVals.hitlSamplingRates?.[fc.key] === undefined;
                          const usingAdoptDefault = formVals.adoptionRampY1 === undefined;
                          const usingDefaults = usingContainDefault || usingHitlDefault || usingAdoptDefault;
                          const fcTxn = fcVolumes[fc.key] ?? 0;
                          if (fcSteps.length === 0) return null;
                          return (
                            <div key={fc.key} className="space-y-3">
                              <div className="flex items-center gap-3">
                                <Badge variant="outline" className="font-mono text-xs bg-muted/50">{fc.key}</Badge>
                                <h3 className="font-semibold text-sm text-foreground">{fc.label}</h3>
                                {fcTxn > 0 && (
                                  <span className="text-xs text-muted-foreground ml-auto font-mono">
                                    {formatNumberLocal(fcTxn)} txn/yr allocated
                                  </span>
                                )}
                              </div>
                              <FlowDiagram
                                steps={fcSteps}
                                fcKey={fc.key}
                                annotations={{
                                  adoptionFraction: adoptFrac,
                                  containmentFraction: containFrac,
                                  hitlSamplingFraction: hitlFrac,
                                  annualTransactions: fcTxn > 0 ? fcTxn : undefined,
                                  usingDefaults,
                                }}
                              />
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </TabsContent>

                  {/* Intent Distribution */}
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
                          {rollup.rows.sort((a, b) => b.share - a.share).map(row => (
                            <tr key={row.intentKey} className="hover:bg-muted/30 transition-colors">
                              <td className="px-4 py-3 font-medium text-foreground">
                                {row.intentName}
                                {row.overridden && (
                                  <Badge className="ml-2 bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/30 text-[10px]">SME-adjusted</Badge>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                <Badge variant="outline" className="capitalize text-[10px] bg-background">{row.domain}</Badge>
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2 min-w-[100px]">
                                  <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                                    <div
                                      className="h-full rounded-full bg-primary/60"
                                      style={{ width: `${Math.min(row.share * 100 * 5, 100)}%` }}
                                    />
                                  </div>
                                  <span className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                                    {(row.share * 100).toFixed(1)}%
                                  </span>
                                </div>
                                <span className="font-mono text-[10px] text-muted-foreground">{formatNumber(row.transactions)} txn</span>
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

                  {/* 3-Year View */}
                  <TabsContent value="3year" className="m-0 h-full">
                    <div className="space-y-6">
                      <div className="rounded-md border border-border overflow-hidden">
                        <table className="w-full text-sm text-left">
                          <thead className="bg-muted/50 text-muted-foreground text-xs uppercase font-semibold">
                            <tr>
                              <th className="px-4 py-3">Year</th>
                              <th className="px-4 py-3 text-right">Adoption</th>
                              <th className="px-4 py-3 text-right">Total Cost</th>
                              <th className="px-4 py-3 text-right">Gross Benefit</th>
                              <th className="px-4 py-3 text-right">Net Value</th>
                              <th className="px-4 py-3 text-right">FTE Saved</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {rollup.byYear.map(y => (
                              <tr key={y.year} className="hover:bg-muted/30 transition-colors">
                                <td className="px-4 py-3 font-semibold">Year {y.year}</td>
                                <td className="px-4 py-3 text-right font-mono text-xs">{pct(y.adoptionFraction)}</td>
                                <td className="px-4 py-3 text-right font-mono text-xs">{formatCurrencyLocal(y.totalCostUsd, true)}</td>
                                <td className="px-4 py-3 text-right font-mono text-xs text-emerald-600 dark:text-emerald-400">
                                  {formatCurrencyLocal(y.benefitUsd, true)}
                                </td>
                                <td className="px-4 py-3 text-right font-mono font-semibold">
                                  <span className={y.netUsd >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>
                                    {y.netUsd >= 0 ? "+" : ""}{formatCurrencyLocal(y.netUsd, true)}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-right font-mono text-xs">{y.fteEquivalent.toFixed(1)}</td>
                              </tr>
                            ))}
                            {(() => {
                              const cum = rollup.byYear.reduce(
                                (a, y) => ({ cost: a.cost + y.totalCostUsd, benefit: a.benefit + y.benefitUsd, fte: a.fte + y.fteEquivalent }),
                                { cost: 0, benefit: 0, fte: 0 },
                              );
                              return (
                                <tr className="bg-muted/40 font-semibold">
                                  <td className="px-4 py-3">3-Yr Cumulative</td>
                                  <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">—</td>
                                  <td className="px-4 py-3 text-right font-mono text-xs">{formatCurrencyLocal(cum.cost, true)}</td>
                                  <td className="px-4 py-3 text-right font-mono text-xs text-emerald-600 dark:text-emerald-400">
                                    {formatCurrencyLocal(cum.benefit, true)}
                                  </td>
                                  <td className="px-4 py-3 text-right font-mono font-semibold">
                                    <span className={cum.benefit - cum.cost >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>
                                      {cum.benefit - cum.cost >= 0 ? "+" : ""}{formatCurrencyLocal(cum.benefit - cum.cost, true)}
                                    </span>
                                  </td>
                                  <td className="px-4 py-3 text-right font-mono text-xs">{cum.fte.toFixed(1)}</td>
                                </tr>
                              );
                            })()}
                          </tbody>
                        </table>
                      </div>

                      <Card className="shadow-none border-border">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm">Benefit vs. Cost Ramp</CardTitle>
                        </CardHeader>
                        <CardContent className="h-[260px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart
                              data={rollup.byYear.map(y => ({
                                name: `Year ${y.year}`,
                                benefit: y.benefitUsd,
                                cost:    y.totalCostUsd,
                                net:     y.netUsd,
                              }))}
                              margin={{ top: 10, right: 24, left: 10, bottom: 5 }}
                            >
                              <defs>
                                <linearGradient id="benefitGrad" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%"  stopColor="#10b981" stopOpacity={0.25} />
                                  <stop offset="95%" stopColor="#10b981" stopOpacity={0.04} />
                                </linearGradient>
                                <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.2} />
                                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.04} />
                                </linearGradient>
                              </defs>
                              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                              <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} />
                              <YAxis tickFormatter={(v) => formatCurrencyLocal(v, true)} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                              <Tooltip
                                formatter={(val: number, name: string) => [
                                  formatCurrencyLocal(val, false),
                                  name === "benefit" ? "Gross Benefit" : name === "cost" ? "Total Cost" : "Net Value",
                                ]}
                                contentStyle={{ borderRadius: 8, border: "1px solid hsl(var(--border))", fontSize: 12 }}
                              />
                              <Legend formatter={n => n === "benefit" ? "Gross Benefit" : n === "cost" ? "Total Cost" : "Net Value"} />
                              <Area type="monotone" dataKey="benefit" stroke="#10b981" strokeWidth={2} fill="url(#benefitGrad)" dot={{ r: 4, fill: "#10b981" }} />
                              <Area type="monotone" dataKey="cost" stroke="#3b82f6" strokeWidth={2} fill="url(#costGrad)" dot={{ r: 4, fill: "#3b82f6" }} />
                              <Line type="monotone" dataKey="net" stroke="#8b5cf6" strokeWidth={2.5} dot={{ r: 5, fill: "#8b5cf6", strokeWidth: 2, stroke: "#fff" }} />
                              <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="4 2" />
                            </ComposedChart>
                          </ResponsiveContainer>
                        </CardContent>
                      </Card>
                    </div>
                  </TabsContent>

                  {/* Breakdown Charts */}
                  <TabsContent value="charts" className="m-0 h-full">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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
                                dataKey="usd" nameKey="label"
                              >
                                {rollup.byCostComponent.map((_, index) => (
                                  <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                                ))}
                              </Pie>
                              <Tooltip formatter={(val: number) => formatCurrencyLocal(val, true)} />
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
                              <XAxis type="number" tickFormatter={formatNumberLocal} stroke="hsl(var(--muted-foreground))" fontSize={12} />
                              <YAxis type="category" dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                              <Tooltip formatter={(val: number) => formatCurrencyLocal(val, true)} />
                              <Bar dataKey="usd" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
                            </BarChart>
                          </ResponsiveContainer>
                        </CardContent>
                      </Card>
                    </div>
                  </TabsContent>

                  {/* Build Cost Breakdown */}
                  <TabsContent value="build" className="m-0 h-full">
                    <p className="text-xs text-muted-foreground mb-3">
                      Component-level build cost. One-time = engineering cost to stand the component up (platform components scale with landscape maturity). Annual = share amortized into this scenario — platform over expected volume, onboarding over the contract term. Annual amounts sum exactly to the scenario's total build cost.
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
                          {[...rollup.buildBreakdown].sort((a, b) => b.annualUsd - a.annualUsd).map(c => (
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
                              <td className="px-4 py-3 text-right font-mono text-xs">{formatCurrencyLocal(c.oneTimeUsd, true)}</td>
                              <td className="px-4 py-3 text-right font-mono text-xs font-semibold">{formatCurrencyLocal(c.annualUsd, true)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-muted/50">
                          <tr>
                            <td className="px-4 py-3 font-semibold text-xs uppercase text-muted-foreground" colSpan={2}>Total build cost in this scenario</td>
                            <td className="px-4 py-3 text-right font-mono text-xs">{formatCurrencyLocal(rollup.buildBreakdown.reduce((a, c) => a + c.oneTimeUsd, 0), true)}</td>
                            <td className="px-4 py-3 text-right font-mono text-xs font-bold">{formatCurrencyLocal(rollup.totals.buildCostUsd, true)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </TabsContent>

                  {/* Applied Assumptions */}
                  {/* Sensitivity (tornado) */}
                  <TabsContent value="sensitivity" className="m-0 h-full">
                    {!sensitivity ? (
                      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
                        {sensitivityMutation.isPending ? "Running sensitivity analysis…" : "Sensitivity analysis unavailable — recompute the scenario."}
                      </div>
                    ) : (
                      <div className="space-y-4" data-testid="sensitivity-panel">
                        <div>
                          <h3 className="text-lg font-semibold">What moves the business case</h3>
                          <p className="text-sm text-muted-foreground">
                            Each driver nudged ±{Math.round(sensitivity.nudgePct * 100)}% with everything else held constant, repriced with the exact engine.
                            Baseline net benefit: <span className="font-medium text-foreground">${Math.round(sensitivity.baselineNetUsd).toLocaleString()}</span>.
                            Wide bars are the assumptions worth validating with the client; narrow bars barely matter.
                          </p>
                        </div>
                        <ResponsiveContainer width="100%" height={Math.max(320, sensitivity.rows.length * 34)}>
                          <BarChart
                            layout="vertical"
                            data={sensitivity.rows.map((r) => ({
                              name: r.label,
                              low: Math.round(r.netLowUsd - sensitivity.baselineNetUsd),
                              high: Math.round(r.netHighUsd - sensitivity.baselineNetUsd),
                            }))}
                            margin={{ left: 8, right: 24 }}
                            stackOffset="sign"
                          >
                            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                            <XAxis type="number" tickFormatter={(v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v / 1000).toFixed(0)}k`} />
                            <YAxis type="category" dataKey="name" width={280} tick={{ fontSize: 11 }} />
                            <Tooltip formatter={(v: number, n: string) => [`${v >= 0 ? "+" : "-"}$${Math.abs(v).toLocaleString()}`, n === "low" ? `Driver -${Math.round(sensitivity.nudgePct * 100)}%` : `Driver +${Math.round(sensitivity.nudgePct * 100)}%`]} />
                            <ReferenceLine x={0} stroke="hsl(var(--foreground))" />
                            <Bar dataKey="low" fill="#f59e0b" stackId="t" />
                            <Bar dataKey="high" fill="#3b82f6" stackId="t" />
                          </BarChart>
                        </ResponsiveContainer>
                        <div className="text-xs text-muted-foreground flex gap-4">
                          <span><span className="inline-block w-3 h-3 rounded-sm align-middle mr-1" style={{ background: "#f59e0b" }} />Driver −{Math.round(sensitivity.nudgePct * 100)}%</span>
                          <span><span className="inline-block w-3 h-3 rounded-sm align-middle mr-1" style={{ background: "#3b82f6" }} />Driver +{Math.round(sensitivity.nudgePct * 100)}%</span>
                          <span>Bars show change in net benefit vs baseline.</span>
                        </div>
                        <div className="border border-border rounded-md overflow-hidden">
                          <table className="w-full text-sm">
                            <thead className="bg-muted/50 text-xs text-muted-foreground">
                              <tr>
                                <th className="text-left px-3 py-2">Driver</th>
                                <th className="text-right px-3 py-2">Base value</th>
                                <th className="text-right px-3 py-2">Net @ −{Math.round(sensitivity.nudgePct * 100)}%</th>
                                <th className="text-right px-3 py-2">Net @ +{Math.round(sensitivity.nudgePct * 100)}%</th>
                                <th className="text-right px-3 py-2">Max swing</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sensitivity.rows.map((r) => (
                                <tr key={r.key} className="border-t border-border">
                                  <td className="px-3 py-1.5">{r.label}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{r.baseValue < 10 ? r.baseValue.toFixed(r.baseValue < 1 ? 3 : 2) : Math.round(r.baseValue).toLocaleString()}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">${Math.round(r.netLowUsd).toLocaleString()}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">${Math.round(r.netHighUsd).toLocaleString()}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums font-medium">${Math.round(r.swingUsd).toLocaleString()}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
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
                                    <Badge className="bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30 text-[10px]">measured</Badge>
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
                                      <Badge className="bg-amber-500/20 text-amber-600 dark:text-amber-300 border border-amber-500/30 text-[10px] h-4 px-1.5">custom</Badge>
                                    )}
                                    {ass.source?.confidence === "client-confirmed" && (
                                      <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 text-[10px]">client-confirmed</Badge>
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
const CHART_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4"];
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

  const fmt = (v: number) => formatCurrencyLocal(v, true);
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

function KpiTile({ label, value, accent, color }: { label: string; value: string; accent?: boolean; color?: "blue" | "amber" | "emerald" }) {
  const styles = {
    blue:    { bg: "bg-blue-500/15 border-blue-500/30",   label: "text-blue-200",   val: "text-blue-100" },
    amber:   { bg: "bg-amber-500/15 border-amber-500/30", label: "text-amber-200",  val: "text-amber-100" },
    emerald: { bg: "bg-emerald-500/20 border-emerald-500/30", label: "text-emerald-200", val: "text-emerald-100" },
  };
  const s = color ? styles[color] : null;
  return (
    <div className={`rounded-lg p-3 border ${s ? s.bg : "bg-background/10 border-sidebar-border"}`}>
      <div className={`text-xs uppercase tracking-wider mb-1 ${s ? s.label : "text-sidebar-foreground/60"}`}>{label}</div>
      <div className={`text-xl font-semibold font-mono ${s ? s.val : ""}`}>{value}</div>
    </div>
  );
}

function formatNumberLocal(val: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(val);
}

function SectionHeader({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 pb-2 border-b border-border">
      {icon}
      <h3 className="font-semibold text-sm">{label}</h3>
    </div>
  );
}


function formatCurrencyLocal(val: number, compact = false) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD",
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 0,
  }).format(val);
}
