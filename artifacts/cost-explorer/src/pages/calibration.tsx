import { useState, useRef, useCallback } from "react";
import {
  useListActualsOverlays,
  useCreateActualsOverlay,
  useValidateActualsOverlay,
  useDeleteActualsOverlay,
  getListActualsOverlaysQueryKey,
  useListIntents,
  type ActualsOverlayInput,
  type ActualsValidationResult,
  type ActualsOverlayRecord,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import {
  FlaskConical,
  Upload,
  Download,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Plus,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  BarChart2,
  Users,
} from "lucide-react";

// ---------------------------------------------------------------------------
// CSV template helpers
// ---------------------------------------------------------------------------

const CSV_HEADER = "type,key,value1,value2,notes";
const CSV_TEMPLATE_ROWS = [
  `intent,payslip-copy,0.88,3.5,"containmentRate(0-1)=value1 | avgHitlMinutes=value2 — omit either with blank"`,
  `intent,leave-balance,,2.0,"blank value1 = skip containment for this intent"`,
  `flowclass,fc1-deterministic,0.90,,"flow-class containment (applies to all fc1 intents unless per-intent overrides)"`,
  `flowclass,fc2-policy,0.82,,`,
  `flowclass,fc3-multiagent,0.71,,`,
  `flowclass,fc4-frontier,0.58,,`,
  `global,hitlSamplingRate,0.35,,"fraction of HITL checkpoints actually reviewed (0 < x ≤ 1)"`,
  `tokenRole,router,900,120,"avgInputTokens=value1 | avgOutputTokens=value2"`,
  `tokenRole,reasoning,4500,700,`,
  `tokenRole,frontier,15000,3000,`,
  `tokenRole,data,3000,600,`,
];
const CSV_TEMPLATE = [CSV_HEADER, ...CSV_TEMPLATE_ROWS].join("\n");

function downloadTemplate() {
  const blob = new Blob([CSV_TEMPLATE], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "actuals-overlay-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// CSV parser
// ---------------------------------------------------------------------------

interface ParseRow { type: string; key: string; value1: string; value2: string }

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === "," && !inQuote) { fields.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  fields.push(cur.trim());
  return fields;
}

interface CsvParseResult {
  overlay: ActualsOverlayInput;
  errors: string[];
  rowCount: number;
}

function parseCsv(text: string): CsvParseResult {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const errors: string[] = [];
  const overlay: ActualsOverlayInput = {};
  let rowCount = 0;

  // Skip header
  const dataLines = lines.filter(l => !l.startsWith("type,"));

  for (let idx = 0; idx < dataLines.length; idx++) {
    const line = dataLines[idx]!;
    if (line.startsWith("#") || line.startsWith("//")) continue;
    const [type = "", key = "", value1 = "", value2 = ""] = parseCsvLine(line) as [string,string,string,string];
    const row: ParseRow = { type: type.toLowerCase(), key, value1, value2 };
    rowCount++;

    if (row.type === "intent") {
      const cont = row.value1 !== "" ? parseFloat(row.value1) : undefined;
      const hitl = row.value2 !== "" ? parseFloat(row.value2) : undefined;
      if (cont !== undefined && (isNaN(cont) || cont < 0 || cont > 1)) {
        errors.push(`Row ${idx + 2}: intent "${row.key}" — containmentRate must be 0–1, got "${row.value1}"`);
        continue;
      }
      if (hitl !== undefined && (isNaN(hitl) || hitl < 0 || hitl > 600)) {
        errors.push(`Row ${idx + 2}: intent "${row.key}" — avgHitlMinutes must be 0–600, got "${row.value2}"`);
        continue;
      }
      if (cont === undefined && hitl === undefined) {
        errors.push(`Row ${idx + 2}: intent "${row.key}" — at least one of value1 (containment) or value2 (hitlMinutes) required`);
        continue;
      }
      overlay.intents = overlay.intents ?? [];
      const existing = overlay.intents.find(i => i.intentKey === row.key);
      if (existing) {
        if (cont !== undefined) existing.measuredContainmentRate = cont;
        if (hitl !== undefined) existing.avgHitlMinutes = hitl;
      } else {
        overlay.intents.push({ intentKey: row.key, ...(cont !== undefined && { measuredContainmentRate: cont }), ...(hitl !== undefined && { avgHitlMinutes: hitl }) });
      }
    } else if (row.type === "flowclass") {
      const v = parseFloat(row.value1);
      if (isNaN(v) || v < 0 || v > 1) {
        errors.push(`Row ${idx + 2}: flowclass "${row.key}" — value1 must be 0–1, got "${row.value1}"`);
        continue;
      }
      overlay.measuredContainmentByFlowClass = overlay.measuredContainmentByFlowClass ?? {};
      overlay.measuredContainmentByFlowClass[row.key] = v;
    } else if (row.type === "global") {
      if (row.key === "hitlSamplingRate") {
        const v = parseFloat(row.value1);
        if (isNaN(v) || v <= 0 || v > 1) {
          errors.push(`Row ${idx + 2}: hitlSamplingRate must be > 0 and ≤ 1, got "${row.value1}"`);
          continue;
        }
        overlay.measuredHitlSamplingRate = v;
      } else {
        errors.push(`Row ${idx + 2}: unknown global key "${row.key}". Valid: hitlSamplingRate`);
      }
    } else if (row.type === "tokenrole") {
      const inp = parseFloat(row.value1);
      const out = parseFloat(row.value2);
      if (isNaN(inp) || inp < 0) { errors.push(`Row ${idx + 2}: tokenRole "${row.key}" — value1 (avgInputTokens) must be ≥ 0`); continue; }
      if (isNaN(out) || out < 0) { errors.push(`Row ${idx + 2}: tokenRole "${row.key}" — value2 (avgOutputTokens) must be ≥ 0`); continue; }
      overlay.tokenActualsByRole = overlay.tokenActualsByRole ?? {};
      overlay.tokenActualsByRole[row.key] = { avgInputTokens: inp, avgOutputTokens: out };
    } else {
      errors.push(`Row ${idx + 2}: unknown type "${row.type}". Valid: intent, flowclass, global, tokenRole`);
    }
  }

  return { overlay, errors, rowCount };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FC_LABELS: Record<string, string> = {
  "fc1-deterministic": "Deterministic (FC1)",
  "fc2-policy": "Policy Grounded (FC2)",
  "fc3-multiagent": "Multi-Agent (FC3)",
  "fc4-frontier": "Frontier (FC4)",
};
const FC_DEFAULTS: Record<string, number> = {
  "fc1-deterministic": 0.95,
  "fc2-policy": 0.85,
  "fc3-multiagent": 0.75,
  "fc4-frontier": 0.60,
};
const ROLES = ["router", "reasoning", "frontier", "data"] as const;
const ROLE_LABELS: Record<string, string> = {
  router: "Router / Classification (SLM)",
  reasoning: "Reasoning / Grounded Answers (LLM)",
  frontier: "Frontier / High-Judgment (LRM)",
  data: "Data Access / Legacy DB (LDM)",
};

function overlayMeasuredFields(p: ActualsOverlayInput): string[] {
  const f: string[] = [];
  const fcCount = Object.keys(p.measuredContainmentByFlowClass ?? {}).length;
  const intentCount = (p.intents ?? []).filter(i => i.measuredContainmentRate !== undefined).length;
  if (fcCount || intentCount) f.push(`containment (${fcCount} fc, ${intentCount} intents)`);
  if (p.measuredHitlSamplingRate !== undefined) f.push("HITL sampling");
  const tokenCount = Object.keys(p.tokenActualsByRole ?? {}).length;
  if (tokenCount) f.push(`tokens (${tokenCount} roles)`);
  const hm = (p.intents ?? []).filter(i => i.avgHitlMinutes !== undefined).length;
  if (hm) f.push(`HITL minutes (${hm} intents)`);
  return f;
}

// ---------------------------------------------------------------------------
// OverlayCard
// ---------------------------------------------------------------------------

function OverlayCard({
  overlay,
  onDelete,
}: {
  overlay: ActualsOverlayRecord;
  onDelete: (id: number) => void;
}) {
  const fields = overlayMeasuredFields(overlay.payload);
  return (
    <div className="flex items-start justify-between gap-3 p-4 rounded-lg border border-border bg-card hover:bg-muted/30 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm truncate">
            {overlay.clientLabel ?? `Overlay #${overlay.id}`}
          </span>
          <Badge variant="outline" className="font-mono text-[10px] bg-background shrink-0">#{overlay.id}</Badge>
        </div>
        {overlay.periodStart && (
          <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
            <Clock className="w-3 h-3" /> {overlay.periodStart}{overlay.periodEnd ? ` → ${overlay.periodEnd}` : ""}
          </div>
        )}
        <div className="flex flex-wrap gap-1 mt-2">
          {fields.map(f => (
            <Badge key={f} className="bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30 text-[10px]">
              {f}
            </Badge>
          ))}
          {fields.length === 0 && <span className="text-xs text-muted-foreground">No measurements</span>}
        </div>
        <div className="text-[10px] text-muted-foreground mt-1">
          Saved {new Date(overlay.createdAt).toLocaleDateString()}
        </div>
      </div>
      <button
        onClick={() => onDelete(overlay.id)}
        className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
        title="Delete overlay"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface FormState {
  clientLabel: string;
  periodStart: string;
  periodEnd: string;
  hitlSamplingRate: string;
  fcContainment: Record<string, string>;
  tokenActuals: Record<string, { input: string; output: string }>;
  intentContainment: Record<string, string>;
  intentHitlMin: Record<string, string>;
}

function emptyForm(): FormState {
  return {
    clientLabel: "",
    periodStart: "",
    periodEnd: "",
    hitlSamplingRate: "",
    fcContainment: {},
    tokenActuals: Object.fromEntries(ROLES.map(r => [r, { input: "", output: "" }])),
    intentContainment: {},
    intentHitlMin: {},
  };
}

function formToOverlay(form: FormState): ActualsOverlayInput {
  const overlay: ActualsOverlayInput = {};
  if (form.clientLabel) overlay.clientLabel = form.clientLabel;
  if (form.periodStart) overlay.periodStart = form.periodStart;
  if (form.periodEnd) overlay.periodEnd = form.periodEnd;

  // HITL sampling
  const sampling = parseFloat(form.hitlSamplingRate);
  if (!isNaN(sampling) && sampling > 0 && sampling <= 1) overlay.measuredHitlSamplingRate = sampling;

  // Flow class containment
  const fcMap: Record<string, number> = {};
  for (const [fc, val] of Object.entries(form.fcContainment)) {
    const v = parseFloat(val);
    if (!isNaN(v) && v >= 0 && v <= 1) fcMap[fc] = v;
  }
  if (Object.keys(fcMap).length > 0) overlay.measuredContainmentByFlowClass = fcMap;

  // Token actuals
  const tokenMap: Record<string, { avgInputTokens: number; avgOutputTokens: number }> = {};
  for (const [role, vals] of Object.entries(form.tokenActuals)) {
    const inp = parseFloat(vals.input);
    const out = parseFloat(vals.output);
    if (!isNaN(inp) && inp >= 0 && !isNaN(out) && out >= 0) {
      tokenMap[role] = { avgInputTokens: inp, avgOutputTokens: out };
    }
  }
  if (Object.keys(tokenMap).length > 0) overlay.tokenActualsByRole = tokenMap;

  // Per-intent
  const intentRows: ActualsOverlayInput["intents"] = [];
  const allKeys = new Set([...Object.keys(form.intentContainment), ...Object.keys(form.intentHitlMin)]);
  for (const key of allKeys) {
    const cont = parseFloat(form.intentContainment[key] ?? "");
    const hitl = parseFloat(form.intentHitlMin[key] ?? "");
    const row: { intentKey: string; measuredContainmentRate?: number; avgHitlMinutes?: number } = { intentKey: key };
    if (!isNaN(cont) && cont >= 0 && cont <= 1) row.measuredContainmentRate = cont;
    if (!isNaN(hitl) && hitl >= 0 && hitl <= 600) row.avgHitlMinutes = hitl;
    if (row.measuredContainmentRate !== undefined || row.avgHitlMinutes !== undefined) {
      intentRows.push(row);
    }
  }
  if (intentRows.length > 0) overlay.intents = intentRows;

  return overlay;
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Calibration() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(emptyForm());
  const [showAllIntents, setShowAllIntents] = useState(false);
  const [expandedIntents, setExpandedIntents] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<"form" | "csv">("form");
  const [validation, setValidation] = useState<ActualsValidationResult | null>(null);
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [csvParsed, setCsvParsed] = useState<ActualsOverlayInput | null>(null);
  const [csvRowCount, setCsvRowCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: overlays, refetch: refetchOverlays } = useListActualsOverlays();
  const { data: intents } = useListIntents();
  const createOverlay = useCreateActualsOverlay();
  const validateOverlay = useValidateActualsOverlay();
  const deleteOverlay = useDeleteActualsOverlay();

  // ---- helpers ----

  const patchForm = (patch: Partial<FormState>) =>
    setForm(prev => ({ ...prev, ...patch }));

  const setFc = (fc: string, val: string) =>
    patchForm({ fcContainment: { ...form.fcContainment, [fc]: val } });

  const setToken = (role: string, field: "input" | "output", val: string) =>
    patchForm({
      tokenActuals: {
        ...form.tokenActuals,
        [role]: { ...(form.tokenActuals[role] ?? { input: "", output: "" }), [field]: val },
      },
    });

  const setIntentField = (key: string, field: "containment" | "hitl", val: string) => {
    if (field === "containment") {
      patchForm({ intentContainment: { ...form.intentContainment, [key]: val } });
    } else {
      patchForm({ intentHitlMin: { ...form.intentHitlMin, [key]: val } });
    }
  };

  const toggleIntent = (key: string) => {
    setExpandedIntents(prev => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  };

  // ---- validate ----

  const handleValidate = async (overrideOverlay?: ActualsOverlayInput) => {
    const overlay = overrideOverlay ?? formToOverlay(form);
    try {
      const result = await validateOverlay.mutateAsync({ data: overlay });
      setValidation(result);
      return result;
    } catch {
      toast({ title: "Validation Error", description: "Could not reach the server.", variant: "destructive" });
      return null;
    }
  };

  // ---- save ----

  const handleSave = async (overrideOverlay?: ActualsOverlayInput) => {
    const overlay = overrideOverlay ?? formToOverlay(form);
    const result = await handleValidate(overlay);
    if (!result?.valid) {
      toast({ title: "Fix validation errors before saving", variant: "destructive" });
      return;
    }
    try {
      await createOverlay.mutateAsync({ data: overlay });
      queryClient.invalidateQueries({ queryKey: getListActualsOverlaysQueryKey() });
      refetchOverlays();
      toast({ title: "Overlay saved", description: `"${overlay.clientLabel ?? "Unnamed"}" is ready to apply in Scenario Builder.` });
      setForm(emptyForm());
      setValidation(null);
      setCsvParsed(null);
      setCsvErrors([]);
    } catch {
      toast({ title: "Save Failed", description: "Could not persist overlay.", variant: "destructive" });
    }
  };

  // ---- CSV ----

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = ev.target?.result as string;
      const { overlay, errors, rowCount } = parseCsv(text);
      setCsvErrors(errors);
      setCsvRowCount(rowCount);
      if (errors.length === 0) {
        setCsvParsed(overlay);
        // Auto-validate
        const result = await handleValidate(overlay);
        setValidation(result);
      } else {
        setCsvParsed(null);
        setValidation(null);
      }
    };
    reader.readAsText(file);
    // Reset so same file can be re-uploaded
    e.target.value = "";
  }, [form.clientLabel, form.periodStart, form.periodEnd]);

  // ---- delete ----

  const handleDelete = async (id: number) => {
    try {
      await deleteOverlay.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListActualsOverlaysQueryKey() });
      refetchOverlays();
      toast({ title: "Overlay deleted" });
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    }
  };

  // Intents shown in the form (paginated)
  const allIntents = intents ?? [];
  const visibleIntents = showAllIntents ? allIntents : allIntents.slice(0, 12);
  const touchedIntentKeys = new Set([
    ...Object.keys(form.intentContainment).filter(k => form.intentContainment[k] !== ""),
    ...Object.keys(form.intentHitlMin).filter(k => form.intentHitlMin[k] !== ""),
  ]);

  // Determine effective overlay for validation badge
  const activeOverlay = activeTab === "csv" ? csvParsed : formToOverlay(form);
  const hasAnyData = activeOverlay && overlayMeasuredFields(activeOverlay).length > 0;

  return (
    <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-3">
          <FlaskConical className="w-8 h-8 text-primary" />
          Calibration
        </h1>
        <p className="text-muted-foreground mt-1">
          Import observed production data to replace modelled assumptions with measured actuals.
          Apply a saved overlay in Scenario Builder to see the calibrated business case and per-assumption variance.
        </p>
      </div>

      <div className="flex flex-col xl:flex-row gap-6">
        {/* ---- LEFT: Import form ---- */}
        <div className="flex-1 min-w-0 flex flex-col gap-4">
          <Card className="shadow-sm border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">New Actuals Overlay</CardTitle>
              <CardDescription>
                Provide observed values — any combination of containment rates, HITL minutes, sampling rates, or token counts. All fields are optional; at least one measurement must be present to save.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">

              {/* Meta */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="sm:col-span-1 space-y-1.5">
                  <Label className="text-xs">Client label</Label>
                  <Input
                    value={form.clientLabel}
                    onChange={e => patchForm({ clientLabel: e.target.value })}
                    placeholder="e.g. Acme Q1 2025"
                    className="bg-background"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Period start</Label>
                  <Input
                    value={form.periodStart}
                    onChange={e => patchForm({ periodStart: e.target.value })}
                    placeholder="e.g. 2025-01-01"
                    className="bg-background"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Period end</Label>
                  <Input
                    value={form.periodEnd}
                    onChange={e => patchForm({ periodEnd: e.target.value })}
                    placeholder="e.g. 2025-03-31"
                    className="bg-background"
                  />
                </div>
              </div>

              <Tabs value={activeTab} onValueChange={v => { setActiveTab(v as "form" | "csv"); setValidation(null); }}>
                <TabsList className="bg-muted">
                  <TabsTrigger value="form">Form Entry</TabsTrigger>
                  <TabsTrigger value="csv">CSV Upload</TabsTrigger>
                </TabsList>

                {/* ---- FORM ENTRY ---- */}
                <TabsContent value="form" className="mt-4 space-y-6">

                  {/* HITL sampling */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 pb-1.5 border-b border-border">
                      <Users className="w-4 h-4 text-primary" />
                      <h3 className="font-semibold text-sm">Global HITL Sampling Rate</h3>
                    </div>
                    <div className="max-w-xs space-y-1.5">
                      <Label className="text-xs">Measured sampling rate (0–1)</Label>
                      <Input
                        type="number" step="0.05" min="0.01" max="1"
                        value={form.hitlSamplingRate}
                        onChange={e => patchForm({ hitlSamplingRate: e.target.value })}
                        placeholder="default 1.0 (review every checkpoint)"
                        className="bg-background"
                      />
                      <p className="text-[10px] text-muted-foreground">
                        Fraction of residual HITL checkpoints actually reviewed in production.
                      </p>
                    </div>
                  </div>

                  {/* Per-role token actuals */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 pb-1.5 border-b border-border">
                      <Cpu className="w-4 h-4 text-primary" />
                      <h3 className="font-semibold text-sm">Avg Token Counts by Model Role</h3>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      When provided, the model cost is recomputed from actual token consumption × published per-token rates, replacing the baked per-call profile.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {ROLES.map(role => (
                        <div key={role} className="space-y-1.5 p-3 rounded-lg border border-border bg-muted/20">
                          <p className="text-xs font-medium">{ROLE_LABELS[role]}</p>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <Label className="text-[10px] text-muted-foreground">Avg input tokens</Label>
                              <Input
                                type="number" min="0"
                                value={form.tokenActuals[role]?.input ?? ""}
                                onChange={e => setToken(role, "input", e.target.value)}
                                placeholder="e.g. 900"
                                className="bg-background mt-0.5"
                              />
                            </div>
                            <div>
                              <Label className="text-[10px] text-muted-foreground">Avg output tokens</Label>
                              <Input
                                type="number" min="0"
                                value={form.tokenActuals[role]?.output ?? ""}
                                onChange={e => setToken(role, "output", e.target.value)}
                                placeholder="e.g. 120"
                                className="bg-background mt-0.5"
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Flow class containment */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 pb-1.5 border-b border-border">
                      <BarChart2 className="w-4 h-4 text-primary" />
                      <h3 className="font-semibold text-sm">Containment by Flow Class</h3>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Applies to all intents in a flow class unless a per-intent measured rate overrides it below.
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {Object.entries(FC_LABELS).map(([fc, label]) => (
                        <div key={fc} className="space-y-1.5">
                          <Label className="text-[10px]">{label}</Label>
                          <Input
                            type="number" step="0.01" min="0" max="1"
                            value={form.fcContainment[fc] ?? ""}
                            onChange={e => setFc(fc, e.target.value)}
                            placeholder={`default ${FC_DEFAULTS[fc]}`}
                            className="bg-background"
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Per-intent */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between pb-1.5 border-b border-border">
                      <div className="flex items-center gap-2">
                        <FlaskConical className="w-4 h-4 text-primary" />
                        <h3 className="font-semibold text-sm">Per-Intent Measurements</h3>
                        {touchedIntentKeys.size > 0 && (
                          <Badge className="bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30 text-[10px]">
                            {touchedIntentKeys.size} filled
                          </Badge>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        Per-intent containment overrides the flow-class rate
                      </span>
                    </div>

                    <div className="space-y-1">
                      {visibleIntents.map(intent => {
                        const hasCont = !!form.intentContainment[intent.key];
                        const hasHitl = !!form.intentHitlMin[intent.key];
                        const isExpanded = expandedIntents.has(intent.key) || hasCont || hasHitl;
                        return (
                          <div key={intent.key} className={`rounded-md border transition-colors ${(hasCont || hasHitl) ? "border-blue-500/40 bg-blue-500/5" : "border-border"}`}>
                            <button
                              type="button"
                              onClick={() => toggleIntent(intent.key)}
                              className="w-full flex items-center justify-between px-3 py-2 text-left"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                                <span className="text-sm font-medium truncate">{intent.name}</span>
                                <Badge variant="outline" className="text-[9px] capitalize bg-background shrink-0 hidden sm:inline-flex">{intent.domain}</Badge>
                              </div>
                              <div className="flex gap-1 shrink-0">
                                {hasCont && <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 text-[9px]">containment</Badge>}
                                {hasHitl && <Badge className="bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30 text-[9px]">HITL min</Badge>}
                              </div>
                            </button>
                            {isExpanded && (
                              <div className="px-3 pb-3 grid grid-cols-2 gap-3">
                                <div className="space-y-1">
                                  <Label className="text-[10px] text-muted-foreground">Containment rate (0–1)</Label>
                                  <Input
                                    type="number" step="0.01" min="0" max="1"
                                    value={form.intentContainment[intent.key] ?? ""}
                                    onChange={e => setIntentField(intent.key, "containment", e.target.value)}
                                    placeholder="flow-class default"
                                    className="bg-background h-8 text-sm"
                                  />
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-[10px] text-muted-foreground">Avg HITL minutes</Label>
                                  <Input
                                    type="number" step="0.5" min="0" max="600"
                                    value={form.intentHitlMin[intent.key] ?? ""}
                                    onChange={e => setIntentField(intent.key, "hitl", e.target.value)}
                                    placeholder="intent default"
                                    className="bg-background h-8 text-sm"
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {allIntents.length > 12 && (
                      <button
                        type="button"
                        onClick={() => setShowAllIntents(v => !v)}
                        className="text-xs text-primary hover:underline mt-1"
                      >
                        {showAllIntents ? "Show fewer intents" : `Show all ${allIntents.length} intents…`}
                      </button>
                    )}
                  </div>
                </TabsContent>

                {/* ---- CSV UPLOAD ---- */}
                <TabsContent value="csv" className="mt-4 space-y-5">
                  <div className="flex flex-col sm:flex-row gap-3 p-4 rounded-lg border border-dashed border-border bg-muted/30">
                    <div className="flex-1 space-y-1">
                      <p className="text-sm font-medium">Upload a completed CSV file</p>
                      <p className="text-xs text-muted-foreground">
                        Supports <code className="font-mono">intent</code>, <code className="font-mono">flowclass</code>, <code className="font-mono">global</code>, and <code className="font-mono">tokenRole</code> row types. Download the template to see the format.
                      </p>
                    </div>
                    <div className="flex flex-col sm:items-end gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={downloadTemplate}>
                        <Download className="w-3.5 h-3.5 mr-1.5" />
                        Download Template
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => fileInputRef.current?.click()}
                        className="w-full sm:w-auto"
                      >
                        <Upload className="w-3.5 h-3.5 mr-1.5" />
                        Choose File
                      </Button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv,text/csv"
                        className="hidden"
                        onChange={handleFileChange}
                      />
                    </div>
                  </div>

                  {/* CSV parse errors */}
                  {csvErrors.length > 0 && (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>
                        <p className="font-medium mb-1">{csvErrors.length} error{csvErrors.length !== 1 ? "s" : ""} in file — fix and re-upload:</p>
                        <ul className="text-xs space-y-0.5 list-disc list-inside">
                          {csvErrors.map((e, i) => <li key={i}>{e}</li>)}
                        </ul>
                      </AlertDescription>
                    </Alert>
                  )}

                  {/* CSV parsed summary */}
                  {csvParsed && csvErrors.length === 0 && (
                    <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
                      <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4" />
                        Parsed {csvRowCount} rows successfully
                      </p>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {overlayMeasuredFields(csvParsed).map(f => (
                          <Badge key={f} className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 text-[10px]">{f}</Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* CSV Template reference */}
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer font-medium mb-2">CSV format reference</summary>
                    <pre className="bg-muted rounded p-3 overflow-x-auto text-[10px] font-mono leading-relaxed whitespace-pre">
{`${CSV_HEADER}
intent,<intentKey>,<containmentRate>,<avgHitlMinutes>,[notes]
flowclass,<fc-key>,<containmentRate>,,
global,hitlSamplingRate,<0..1>,,
tokenRole,<role>,<avgInputTokens>,<avgOutputTokens>,

Valid flow class keys: fc1-deterministic, fc2-policy, fc3-multiagent, fc4-frontier
Valid roles: router, reasoning, frontier, data
Blank cells skip that field (not treated as zero).`}
                    </pre>
                  </details>
                </TabsContent>
              </Tabs>

              {/* Validation result */}
              {validation && (
                <div className={`p-3 rounded-lg border ${validation.valid ? "border-emerald-500/30 bg-emerald-500/10" : "border-destructive/30 bg-destructive/10"}`}>
                  <div className="flex items-center gap-2 mb-1">
                    {validation.valid
                      ? <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      : <AlertCircle className="w-4 h-4 text-destructive" />}
                    <span className={`text-sm font-semibold ${validation.valid ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"}`}>
                      {validation.valid ? "Validation passed" : `${validation.errors.length} validation error${validation.errors.length !== 1 ? "s" : ""}`}
                    </span>
                  </div>
                  {!validation.valid && (
                    <ul className="text-xs text-destructive space-y-0.5 list-disc list-inside mt-1">
                      {validation.errors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  )}
                  {validation.valid && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {validation.measuredFields.map(f => (
                        <Badge key={f} className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 text-[10px]">{f}</Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-col sm:flex-row gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleValidate(activeTab === "csv" ? csvParsed ?? undefined : undefined)}
                  disabled={validateOverlay.isPending || !hasAnyData}
                  className="flex-1 sm:flex-none"
                >
                  {validateOverlay.isPending ? "Validating…" : "Validate"}
                </Button>
                <Button
                  type="button"
                  onClick={() => handleSave(activeTab === "csv" ? csvParsed ?? undefined : undefined)}
                  disabled={createOverlay.isPending || !hasAnyData}
                  className="flex-1"
                >
                  <Plus className="w-4 h-4 mr-1.5" />
                  {createOverlay.isPending ? "Saving…" : "Save Overlay"}
                </Button>
              </div>

            </CardContent>
          </Card>
        </div>

        {/* ---- RIGHT: Saved overlays ---- */}
        <div className="xl:w-[360px] shrink-0 flex flex-col gap-4">
          <Card className="shadow-sm border-border flex-1">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between">
                Saved Overlays
                <Badge variant="outline" className="font-mono text-xs">{overlays?.length ?? 0}</Badge>
              </CardTitle>
              <CardDescription>
                Select an overlay in Scenario Builder to apply it and see the calibrated business case.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {!overlays || overlays.length === 0 ? (
                <div className="text-center py-10 text-muted-foreground">
                  <FlaskConical className="w-10 h-10 mx-auto mb-3 opacity-20" />
                  <p className="text-sm">No overlays saved yet.</p>
                  <p className="text-xs mt-1">Create one using the form or CSV upload.</p>
                </div>
              ) : (
                overlays.map(overlay => (
                  <OverlayCard
                    key={overlay.id}
                    overlay={overlay}
                    onDelete={handleDelete}
                  />
                ))
              )}
            </CardContent>
          </Card>

          {/* How it works */}
          <Card className="shadow-sm border-border bg-muted/20">
            <CardContent className="pt-4 space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">How calibration works</p>
              <ol className="text-xs text-muted-foreground space-y-2 list-decimal list-inside">
                <li>Enter measured values (form or CSV) and save an overlay.</li>
                <li>Open Scenario Builder and select the overlay in the Calibration panel.</li>
                <li>Compute — the rollup runs twice: once estimated, once calibrated.</li>
                <li>The Variance tab shows per-assumption estimated vs. measured, and the headline shifts from estimate to actuals.</li>
              </ol>
              <Separator />
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">Measurement priority:</span> per-intent measured containment → flow-class measured → scenario override → assumption default.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
