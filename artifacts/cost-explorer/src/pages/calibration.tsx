import { useState, useRef, useCallback, useMemo, Fragment, useEffect } from "react";
import {
  useListActualsOverlays,
  useCreateActualsOverlay,
  useValidateActualsOverlay,
  useDeleteActualsOverlay,
  useParseActualsLog,
  getListActualsOverlaysQueryKey,
  useListIntents,
  useListModelCatalog,
  useListScenarios,
  type ActualsOverlayInput,
  type ActualsValidationResult,
  type ActualsOverlayRecord,
  type ActualsLogParseResult,
  type Scenario,
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
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
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
  TrendingUp,
  TrendingDown,
  Minus,
  GitMerge,
  FileText,
  Info,
  Loader2,
} from "lucide-react";
import {
  computeDrift,
  scenarioToEstimateMap,
  type DriftSeries,
  type DriftOverlayInput,
} from "@/lib/drift";
import { formatUsdPerCall, type RolePricingMap, type RolePricingEntry } from "@/lib/token-pricing";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { IntentCorpusAvailability } from "@/components/intent-corpus-status";
import {
  isIntentCorpusUnavailable,
  overlayRequiresCompleteCorpus,
} from "@/lib/intent-corpus-safety";

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

function overlayToForm(overlay: ActualsOverlayInput): Partial<FormState> {
  const patch: Partial<FormState> = {};

  if (overlay.clientLabel) patch.clientLabel = overlay.clientLabel;
  if (overlay.periodStart) patch.periodStart = overlay.periodStart;
  if (overlay.periodEnd) patch.periodEnd = overlay.periodEnd;

  if (overlay.measuredHitlSamplingRate !== undefined) {
    patch.hitlSamplingRate = String(overlay.measuredHitlSamplingRate);
  }

  if (overlay.measuredContainmentByFlowClass) {
    patch.fcContainment = Object.fromEntries(
      Object.entries(overlay.measuredContainmentByFlowClass).map(([k, v]) => [k, String(v)]),
    );
  }

  if (overlay.tokenActualsByRole) {
    patch.tokenActuals = Object.fromEntries(
      Object.entries(overlay.tokenActualsByRole).map(([role, t]) => [
        role,
        { input: String(t.avgInputTokens), output: String(t.avgOutputTokens) },
      ]),
    );
  }

  if (overlay.intents) {
    const contMap: Record<string, string> = {};
    const hitlMap: Record<string, string> = {};
    for (const row of overlay.intents) {
      if (row.measuredContainmentRate !== undefined) {
        contMap[row.intentKey] = String(row.measuredContainmentRate);
      }
      if (row.avgHitlMinutes !== undefined) {
        hitlMap[row.intentKey] = String(row.avgHitlMinutes);
      }
    }
    if (Object.keys(contMap).length) patch.intentContainment = contMap;
    if (Object.keys(hitlMap).length) patch.intentHitlMin = hitlMap;
  }

  return patch;
}
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
  // Outer tab: Import & Manage vs Drift Analysis (task-23)
  const [outerTab, setOuterTab] = useState<"manage" | "drift">(() =>
    new URLSearchParams(window.location.search).get("tab") === "drift" ? "drift" : "manage"
  );
  // Inner import-method tab: form, csv, or raw call-log (task-22)
  const [activeTab, setActiveTab] = useState<"form" | "csv" | "rawlog">("form");
  const [validation, setValidation] = useState<ActualsValidationResult | null>(null);
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [csvParsed, setCsvParsed] = useState<ActualsOverlayInput | null>(null);
  const [csvRowCount, setCsvRowCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Raw call-log import state (task-22)
  const [logParseResult, setLogParseResult] = useState<ActualsLogParseResult | null>(null);
  const logFileInputRef = useRef<HTMLInputElement>(null);

  const { data: overlays, refetch: refetchOverlays } = useListActualsOverlays();
  const {
    data: intentCorpus,
    isError: isIntentError,
    error: intentError,
    refetch: refetchIntents,
    isFetching: isFetchingIntents,
  } = useListIntents();
  const intents = intentCorpus?.intents;
  const referenceIntentKeys = useMemo(
    () => new Set((intents ?? []).filter((intent) => !intent.isCustom).map((intent) => intent.key)),
    [intents],
  );
  const corpusUnavailable = isIntentCorpusUnavailable(
    isIntentError,
    intentCorpus?.customIntentsAvailable,
  );
  const { data: scenarios, isLoading: scenariosLoading } = useListScenarios();
  const createOverlay = useCreateActualsOverlay();
  const validateOverlay = useValidateActualsOverlay();
  const deleteOverlay = useDeleteActualsOverlay();
  const parseActualsLogMutation = useParseActualsLog();

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
    if (corpusUnavailable && overlayRequiresCompleteCorpus(overlay, referenceIntentKeys)) return null;
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
    if (corpusUnavailable && overlayRequiresCompleteCorpus(overlay, referenceIntentKeys)) return;
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
      setLogParseResult(null);
      parseActualsLogMutation.reset();
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

  // ---- Raw call-log upload (task-22) ----

  /**
   * Merge period/label metadata from the form (user-typed values take precedence)
   * and the log parse result (auto-detected fallback) into the proposed overlay.
   * This ensures Save and Validate carry the full period even if the user edited
   * the date fields after uploading.
   */
  const buildRawLogOverlay = useCallback(
    (proposed: ActualsOverlayInput): ActualsOverlayInput => {
      const r = logParseResult;
      return {
        ...proposed,
        ...(form.clientLabel ? { clientLabel: form.clientLabel } : {}),
        ...(form.periodStart || r?.periodStart
          ? { periodStart: form.periodStart || r?.periodStart || undefined }
          : {}),
        ...(form.periodEnd || r?.periodEnd
          ? { periodEnd: form.periodEnd || r?.periodEnd || undefined }
          : {}),
      };
    },
    [logParseResult, form.clientLabel, form.periodStart, form.periodEnd],
  );

  const handleLogFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setLogParseResult(null);
    setValidation(null);
    try {
      const result = await parseActualsLogMutation.mutateAsync({ data: { logFile: file } });
      setLogParseResult(result);
      // Auto-validate with the auto-detected period
      if (result.proposedOverlay && Object.keys(result.proposedOverlay).length > 0) {
        await handleValidate({
          ...result.proposedOverlay as ActualsOverlayInput,
          ...(result.periodStart ? { periodStart: result.periodStart } : {}),
          ...(result.periodEnd ? { periodEnd: result.periodEnd } : {}),
        });
      }
    } catch (err: unknown) {
      setLogParseResult(null);
      console.error("Log parse failed:", err);
    }
  }, [parseActualsLogMutation]);

  // Pre-fill the Form Entry tab from the log parse result
  const handlePrefillForm = useCallback(() => {
    if (!logParseResult) return;
    const patch = overlayToForm(logParseResult.proposedOverlay as ActualsOverlayInput);
    // Don't overwrite dates the user has already typed
    if (form.periodStart && patch.periodStart) delete patch.periodStart;
    if (form.periodEnd && patch.periodEnd) delete patch.periodEnd;
    setForm(prev => ({ ...emptyForm(), ...prev, ...patch }));
    setActiveTab("form");
    toast({ title: "Form pre-filled", description: "Review and adjust, then save." });
  }, [logParseResult, form.periodStart, form.periodEnd]);

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

  // Effective overlay for the validation badge — rawlog merges period via buildRawLogOverlay
  const activeOverlay =
    activeTab === "csv"
      ? csvParsed
      : activeTab === "rawlog"
        ? logParseResult
          ? buildRawLogOverlay(logParseResult.proposedOverlay as ActualsOverlayInput)
          : null
        : formToOverlay(form);
  const hasAnyData = activeOverlay && overlayMeasuredFields(activeOverlay).length > 0;
  const activeOverlayNeedsCorpus = overlayRequiresCompleteCorpus(activeOverlay, referenceIntentKeys);
  const corpusBlocksActiveOverlay = corpusUnavailable && activeOverlayNeedsCorpus;

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
      <IntentCorpusAvailability
        isError={isIntentError}
        error={intentError}
        customIntentsAvailable={intentCorpus?.customIntentsAvailable}
        warning={intentCorpus?.warning}
        isFetching={isFetchingIntents}
        onRetry={() => { void refetchIntents(); }}
        unavailableActions="Built-in reference measurements remain available. Custom or unknown intent work pauses until recovery."
      />

      {/* Outer tabs: Import & Manage | Drift Analysis */}
      <Tabs
        value={outerTab}
        onValueChange={(v) => setOuterTab(v as "manage" | "drift")}
        className="w-full"
      >
        <TabsList className="bg-muted w-full sm:w-auto">
          <TabsTrigger value="manage">Import &amp; Manage</TabsTrigger>
          <TabsTrigger value="drift" className="flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5" />
            Drift Analysis
          </TabsTrigger>
        </TabsList>

        <TabsContent value="manage" className="mt-4">
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

                  {/* Inner import-method tabs: Form | CSV | Call Log */}
                  <Tabs value={activeTab} onValueChange={v => { setActiveTab(v as "form" | "csv" | "rawlog"); setValidation(null); }}>
                    <TabsList className="bg-muted">
                      <TabsTrigger value="form">Form Entry</TabsTrigger>
                      <TabsTrigger value="csv">CSV Upload</TabsTrigger>
                      <TabsTrigger value="rawlog" className="gap-1.5">
                        <FileText className="w-3.5 h-3.5" />
                        Call Log Import
                      </TabsTrigger>
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
                                  disabled={corpusUnavailable && intent.isCustom}
                                  title={corpusUnavailable && intent.isCustom ? "Custom intent data is unavailable" : undefined}
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
                                         disabled={corpusUnavailable && intent.isCustom}
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
                                         disabled={corpusUnavailable && intent.isCustom}
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

                    {/* ---- CALL LOG IMPORT (task-22) ---- */}
                    <TabsContent value="rawlog" className="mt-4 space-y-5">

                      {/* Upload affordance */}
                      <div className="flex flex-col sm:flex-row gap-3 p-4 rounded-lg border border-dashed border-border bg-muted/30">
                        <div className="flex-1 space-y-1">
                          <p className="text-sm font-medium">Upload a raw call-log CSV</p>
                          <p className="text-xs text-muted-foreground">
                            One row per call/transaction. The server aggregates it into a proposed overlay that you can review, adjust, and save. Max 20 MB.
                          </p>
                        </div>
                        <div className="flex flex-col sm:items-end gap-2">
                          <Button type="button" variant="outline" size="sm" onClick={downloadLogTemplate}>
                            <Download className="w-3.5 h-3.5 mr-1.5" />
                            Download Template
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => logFileInputRef.current?.click()}
                            disabled={parseActualsLogMutation.isPending}
                            className="w-full sm:w-auto"
                          >
                            {parseActualsLogMutation.isPending
                              ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Parsing…</>
                              : <><Upload className="w-3.5 h-3.5 mr-1.5" />Choose File</>}
                          </Button>
                          <input
                            ref={logFileInputRef}
                            type="file"
                            accept=".csv,text/csv,.tsv,text/tab-separated-values"
                            className="hidden"
                            onChange={handleLogFileChange}
                          />
                        </div>
                      </div>

                      {/* Upload error */}
                      {parseActualsLogMutation.error && (
                        <Alert variant="destructive">
                          <AlertCircle className="h-4 w-4" />
                          <AlertDescription>
                            {parseActualsLogMutation.error instanceof Error
                              ? parseActualsLogMutation.error.message
                              : "Upload failed — check the file and try again."}
                          </AlertDescription>
                        </Alert>
                      )}

                      {/* Parse results */}
                      {logParseResult && (
                        <div className="space-y-4">

                          {/* Summary bar */}
                          <div className="flex flex-wrap gap-2 items-center p-3 rounded-lg bg-blue-500/10 border border-blue-500/30">
                            <CheckCircle2 className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
                            <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
                              Parsed {logParseResult.totalRows.toLocaleString()} rows
                              {logParseResult.duplicateCount > 0 && (
                                <> · {logParseResult.duplicateCount} duplicate{logParseResult.duplicateCount !== 1 ? "s" : ""} removed</>
                              )}
                              {logParseResult.invalidRowSkips > 0 && (
                                <> · {logParseResult.invalidRowSkips} invalid row{logParseResult.invalidRowSkips !== 1 ? "s" : ""} skipped</>
                              )}
                            </span>
                            <div className="flex flex-wrap gap-1 ml-auto">
                              {overlayMeasuredFields(logParseResult.proposedOverlay as ActualsOverlayInput).map(f => (
                                <Badge key={f} className="bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30 text-[10px]">{f}</Badge>
                              ))}
                            </div>
                          </div>

                          {/* Period dates (pre-filled but editable) */}
                          {(logParseResult.periodStart || logParseResult.periodEnd) && (
                            <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-2">
                              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                                <Clock className="w-3.5 h-3.5" /> Detected period
                              </p>
                              <div className="grid grid-cols-2 gap-3">
                                <div className="space-y-1">
                                  <Label className="text-[10px] text-muted-foreground">Period start</Label>
                                  <Input
                                    value={form.periodStart || logParseResult.periodStart || ""}
                                    onChange={e => patchForm({ periodStart: e.target.value })}
                                    placeholder={logParseResult.periodStart ?? ""}
                                    className="bg-background h-8 text-sm"
                                  />
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-[10px] text-muted-foreground">Period end</Label>
                                  <Input
                                    value={form.periodEnd || logParseResult.periodEnd || ""}
                                    onChange={e => patchForm({ periodEnd: e.target.value })}
                                    placeholder={logParseResult.periodEnd ?? ""}
                                    className="bg-background h-8 text-sm"
                                  />
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Unknown intents warning */}
                          {logParseResult.unknownIntents.length > 0 && (
                            <Alert>
                              <AlertCircle className="h-4 w-4 text-amber-500" />
                              <AlertDescription>
                                <p className="font-medium text-sm mb-1">
                                  {logParseResult.unknownIntents.length} unknown intent key{logParseResult.unknownIntents.length !== 1 ? "s" : ""} excluded from per-intent and flow-class aggregates
                                </p>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {logParseResult.unknownIntents.map(u => (
                                    <Badge key={u.intentKey} variant="outline" className="font-mono text-[10px] bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300">
                                      {u.intentKey} ({u.rowCount})
                                    </Badge>
                                  ))}
                                </div>
                              </AlertDescription>
                            </Alert>
                          )}

                          {/* Parse warnings */}
                          {logParseResult.parseWarnings.length > 0 && (
                            <details className="text-xs">
                              <summary className="cursor-pointer font-medium text-muted-foreground mb-1.5">
                                {logParseResult.parseWarnings.length} parse warning{logParseResult.parseWarnings.length !== 1 ? "s" : ""}
                              </summary>
                              <ul className="space-y-0.5 list-disc list-inside text-muted-foreground">
                                {logParseResult.parseWarnings.map((w, i) => <li key={i}>{w}</li>)}
                              </ul>
                            </details>
                          )}

                          {/* Intent stats table */}
                          {logParseResult.intentStats.length > 0 && (
                            <details>
                              <summary className="cursor-pointer text-xs font-medium text-muted-foreground mb-2">
                                Intent detail ({logParseResult.intentStats.length} intents)
                              </summary>
                              <div className="rounded-lg border border-border overflow-hidden">
                                <table className="w-full text-xs">
                                  <thead className="bg-muted/50">
                                    <tr>
                                      <th className="text-left px-3 py-2 font-medium">Intent</th>
                                      <th className="text-right px-3 py-2 font-medium">Rows</th>
                                      <th className="text-right px-3 py-2 font-medium">Containment</th>
                                      <th className="text-right px-3 py-2 font-medium">Status</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-border">
                                    {logParseResult.intentStats.map(stat => {
                                      const intentRow = logParseResult.proposedOverlay.intents?.find(r => r.intentKey === stat.intentKey);
                                      return (
                                        <tr key={stat.intentKey} className="hover:bg-muted/30">
                                          <td className="px-3 py-1.5 font-mono">{stat.intentKey}</td>
                                          <td className="px-3 py-1.5 text-right">{stat.rowCount}</td>
                                          <td className="px-3 py-1.5 text-right">
                                            {intentRow?.measuredContainmentRate !== undefined
                                              ? `${(intentRow.measuredContainmentRate * 100).toFixed(1)}%`
                                              : "—"}
                                          </td>
                                          <td className="px-3 py-1.5 text-right">
                                            {stat.belowMinThreshold
                                              ? <Badge className="bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30 text-[9px]">thin sample</Badge>
                                              : <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 text-[9px]">ok</Badge>}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </details>
                          )}

                          {/* Pre-fill form button */}
                          <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/30 border border-border">
                            <Info className="w-4 h-4 text-muted-foreground shrink-0" />
                            <p className="text-xs text-muted-foreground flex-1">
                              Want to tweak individual values before saving? Pre-fill the Form Entry tab from this result.
                            </p>
                            <Button type="button" variant="outline" size="sm" onClick={handlePrefillForm}>
                              Pre-fill Form
                            </Button>
                          </div>
                        </div>
                      )}

                      {/* Aggregation rules */}
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer font-medium mb-2">Log format &amp; aggregation rules</summary>
                        <div className="space-y-3 mt-2">
                          <div>
                            <p className="font-medium text-foreground mb-1">Column definitions (comma-separated, header row required)</p>
                            <table className="w-full text-[10px] border border-border rounded overflow-hidden">
                              <thead className="bg-muted/50">
                                <tr>
                                  <th className="text-left px-2 py-1 font-medium">Column</th>
                                  <th className="text-left px-2 py-1 font-medium">Required</th>
                                  <th className="text-left px-2 py-1 font-medium">Description</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border font-mono">
                                {[
                                  ["call_id", "Yes", "Unique call identifier — duplicates are skipped (first kept)"],
                                  ["timestamp", "No", "ISO-8601 datetime — used to derive period start/end"],
                                  ["intent_key", "Yes", "Must match a key in the intent corpus (see /intents)"],
                                  ["contained", "Yes", "true/false/1/0 — whether the call resolved without escalation"],
                                  ["hitl_reviewed", "No", "true/false/1/0 — whether this uncontained call was HITL-sampled"],
                                  ["hitl_minutes", "No", "Minutes spent in HITL review (blank = not reviewed)"],
                                  ["flow_class", "No", "fc1-deterministic | fc2-policy | fc3-multiagent | fc4-frontier — overrides corpus lookup"],
                                  ["router_input_tokens / router_output_tokens", "No", "Token counts for the router/SLM role (blank = role not invoked)"],
                                  ["reasoning_input_tokens / reasoning_output_tokens", "No", "Token counts for the reasoning/LLM role"],
                                  ["frontier_input_tokens / frontier_output_tokens", "No", "Token counts for the frontier/LRM role"],
                                  ["data_input_tokens / data_output_tokens", "No", "Token counts for the data/LDM role"],
                                ].map(([col, req, desc]) => (
                                  <tr key={col} className="hover:bg-muted/30">
                                    <td className="px-2 py-1 whitespace-nowrap">{col}</td>
                                    <td className="px-2 py-1">{req}</td>
                                    <td className="px-2 py-1 font-sans">{desc}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <div>
                            <p className="font-medium text-foreground mb-1">Aggregation rules</p>
                            <ul className="space-y-1 list-disc list-inside">
                              <li><span className="font-medium">Per-intent containment:</span> count(contained=true) / count(all rows for intent). Intents with &lt;30 rows are flagged as thin samples but still emitted.</li>
                              <li><span className="font-medium">Per-intent avg HITL minutes:</span> mean(hitl_minutes where contained=true AND hitl_minutes not blank).</li>
                              <li><span className="font-medium">Flow-class containment:</span> count(contained=true) / count(all rows in FC). FC resolved from the flow_class column if present, otherwise looked up from the intent corpus. Unknown intents with no FC are excluded.</li>
                              <li><span className="font-medium">Global HITL sampling rate:</span> count(hitl_reviewed=true AND contained=false) / count(contained=false). Omitted if all calls were contained.</li>
                              <li><span className="font-medium">Token averages:</span> mean only over rows where the column is non-blank — blank means the role was not invoked on that call and is excluded from the average.</li>
                              <li><span className="font-medium">Unknown intents:</span> collected and reported; never silently dropped. They do not contribute to per-intent or FC aggregates but their token columns do contribute to role averages.</li>
                              <li><span className="font-medium">Duplicate call_id:</span> first occurrence kept; subsequent occurrences skipped and counted in warnings.</li>
                            </ul>
                          </div>
                        </div>
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

                  {/* Actions — dispatch per active tab */}
                  <div className="flex flex-col sm:flex-row gap-2 pt-1">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        if (activeTab === "csv") handleValidate(csvParsed ?? undefined);
                        else if (activeTab === "rawlog" && logParseResult)
                          handleValidate(buildRawLogOverlay(logParseResult.proposedOverlay as ActualsOverlayInput));
                        else handleValidate();
                      }}
                      disabled={validateOverlay.isPending || !hasAnyData || corpusBlocksActiveOverlay}
                      title={corpusBlocksActiveOverlay ? "Complete intent data is required for per-intent validation" : undefined}
                      className="flex-1 sm:flex-none"
                    >
                      {validateOverlay.isPending ? "Validating…" : "Validate"}
                    </Button>
                    <Button
                      type="button"
                      onClick={() => {
                        if (activeTab === "csv") handleSave(csvParsed ?? undefined);
                        else if (activeTab === "rawlog" && logParseResult)
                          handleSave(buildRawLogOverlay(logParseResult.proposedOverlay as ActualsOverlayInput));
                        else handleSave();
                      }}
                      disabled={createOverlay.isPending || !hasAnyData || corpusBlocksActiveOverlay}
                      title={corpusBlocksActiveOverlay ? "Complete intent data is required for per-intent overlays" : undefined}
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
                      <p className="text-xs mt-1">Create one using the form, CSV, or call log.</p>
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
                    <li>Enter measured values (form, CSV, or call log) and save an overlay.</li>
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
        </TabsContent>

        <TabsContent value="drift" className="mt-4">
          <DriftTab
            overlays={overlays ?? []}
            intentList={allIntents}
            scenarios={scenarios ?? []}
            scenariosLoading={scenariosLoading}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DriftTab — multi-period calibration drift analysis
// ---------------------------------------------------------------------------

const TREND_CONFIG = {
  improving: {
    label: "Improving",
    icon: TrendingUp,
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  },
  degrading: {
    label: "Degrading",
    icon: TrendingDown,
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
  },
  stable: {
    label: "Stable",
    icon: Minus,
    className: "bg-muted text-muted-foreground border-border",
  },
  mixed: {
    label: "Mixed",
    icon: GitMerge,
    className: "bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30",
  },
} as const;

function TrendBadge({ trend }: { trend: DriftSeries["trend"] }) {
  const cfg = TREND_CONFIG[trend];
  const Icon = cfg.icon;
  return (
    <Badge className={`flex items-center gap-1 text-[10px] font-medium ${cfg.className}`}>
      <Icon className="w-3 h-3 shrink-0" />
      {cfg.label}
    </Badge>
  );
}

/** Tiny sparkline for the summary table — no axes, just the line shape. */
function Sparkline({
  series,
  width = 100,
  height = 36,
}: {
  series: DriftSeries;
  width?: number;
  height?: number;
}) {
  const data = series.points.map((p) => ({
    name: p.periodLabel,
    value: p.measuredValue,
  }));
  const hasEstimate = series.estimate !== null;
  const lineColor =
    series.trend === "improving"
      ? "#10b981"
      : series.trend === "degrading"
        ? "#f59e0b"
        : "#6366f1";

  return (
    <LineChart width={width} height={height} data={data} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
      {hasEstimate && (
        <ReferenceLine y={series.estimate!} stroke="#94a3b8" strokeDasharray="3 3" strokeWidth={1} />
      )}
      <Line
        type="monotone"
        dataKey="value"
        stroke={lineColor}
        strokeWidth={1.5}
        dot={false}
        connectNulls={false}
      />
    </LineChart>
  );
}

/** Full expanded line chart for one assumption series. */
function FullDriftChart({ series }: { series: DriftSeries }) {
  const data = series.points.map((p) => ({
    name: p.periodLabel,
    measured: p.measuredValue,
  }));
  const hasEstimate = series.estimate !== null;
  const lineColor =
    series.trend === "improving"
      ? "#10b981"
      : series.trend === "degrading"
        ? "#f59e0b"
        : "#6366f1";

  // Y-axis domain: bracket both measured values and estimate with some padding
  const allValues = series.points
    .filter((p) => p.measuredValue !== null)
    .map((p) => p.measuredValue!);
  if (hasEstimate) allValues.push(series.estimate!);
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const pad = Math.max((maxVal - minVal) * 0.15, 0.02);
  const domainMin = Math.max(0, minVal - pad);
  const domainMax = maxVal + pad;

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-foreground">{series.label}</span>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 h-0.5 rounded" style={{ background: lineColor }} />
            Measured
          </span>
          {hasEstimate && (
            <span className="flex items-center gap-1">
              <span className="inline-block w-4 border-t border-dashed border-slate-400" />
              Estimate (
              {series.unit === "USD"
                ? formatUsdPerCall(series.estimate!)
                : series.unit === "minutes"
                  ? `${series.estimate!.toFixed(1)} min`
                  : series.estimate!.toFixed(4)}
              )
            </span>
          )}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            tickLine={false}
          />
          <YAxis
            domain={[domainMin, domainMax]}
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            tickLine={false}
            tickFormatter={(v: number) => {
              if (series.unit === "fraction") return v.toFixed(2);
              if (series.unit === "USD") return formatUsdPerCall(v);
              return v.toFixed(1);
            }}
            width={series.unit === "USD" ? 62 : 44}
          />
          <Tooltip
            formatter={(value: unknown) => {
              const v = typeof value === "number" ? value : null;
              if (v === null) return "—";
              if (series.unit === "USD") return formatUsdPerCall(v);
              return `${v.toFixed(series.unit === "minutes" ? 1 : 4)} ${series.unit}`;
            }}
            labelStyle={{ fontWeight: 600, fontSize: 11 }}
            contentStyle={{
              fontSize: 11,
              borderRadius: 6,
              border: "1px solid hsl(var(--border))",
              background: "hsl(var(--card))",
              color: "hsl(var(--foreground))",
            }}
          />
          {hasEstimate && (
            <ReferenceLine
              y={series.estimate!}
              stroke="#94a3b8"
              strokeDasharray="4 3"
              strokeWidth={1.5}
              label={{
                value: "estimate",
                position: "insideTopRight",
                fontSize: 10,
                fill: "#94a3b8",
              }}
            />
          )}
          <Line
            type="monotone"
            dataKey="measured"
            stroke={lineColor}
            strokeWidth={2}
            dot={{ r: 3.5, fill: lineColor, strokeWidth: 0 }}
            activeDot={{ r: 5 }}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TokenCostExplainPopover — explains estimate baseline vs measured token usage
// ---------------------------------------------------------------------------

interface TokenCostPeriodDatum {
  periodLabel: string;
  inputTokens: number | null;
  outputTokens: number | null;
  measuredUsd: number | null;
}

/**
 * ⓘ icon that opens a popover explaining why a measured token cost can legitimately
 * exceed the baked estimate.  Receives all data via props so the calling site
 * (DriftTab) controls the pricing source — no direct DEFAULT_ROLE_PRICING import here.
 */
function TokenCostExplainPopover({
  pricing,
  estimateUsd,
  periodData,
}: {
  pricing: RolePricingEntry;
  /** Effective estimate shown in the table (may be scenario-overridden). */
  estimateUsd: number;
  periodData: TokenCostPeriodDatum[];
}) {
  // Most recent period that has raw token counts
  const latestWithTokens = [...periodData]
    .reverse()
    .find((p) => p.inputTokens !== null && p.outputTokens !== null) ?? null;

  const latestMeasuredUsd = latestWithTokens?.measuredUsd ?? null;

  // How much heavier is measured vs estimate?
  const multiplier =
    latestMeasuredUsd !== null && estimateUsd > 0
      ? latestMeasuredUsd / estimateUsd
      : null;
  const gap = latestMeasuredUsd !== null ? latestMeasuredUsd - estimateUsd : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center justify-center w-4 h-4 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
          onClick={(e) => e.stopPropagation()}
          aria-label="Why does measured cost differ from the estimate?"
        >
          <Info className="w-3 h-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[22rem] text-xs space-y-3 p-4" align="start" side="right">
        <p className="font-semibold text-sm text-foreground">
          Why does measured cost differ from the estimate?
        </p>

        {/* Estimate basis */}
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Estimate basis
          </p>
          <p className="text-foreground">
            Baked at{" "}
            <span className="font-mono font-semibold">{formatUsdPerCall(estimateUsd)}/call</span>{" "}
            — set before production token counts were available.
          </p>
          <p className="text-muted-foreground">Model: {pricing.label}</p>
          <p className="text-muted-foreground">
            Published rates:{" "}
            <span className="font-mono">
              ${pricing.inputPricePerMillionTokens}/M&nbsp;input&nbsp;·&nbsp;
              ${pricing.outputPricePerMillionTokens}/M&nbsp;output
            </span>
          </p>
          <p className="text-muted-foreground italic text-[11px]">
            The exact token profile behind this estimate wasn't recorded — it was derived
            from an assumed call shape before logs were available.
          </p>
        </div>

        <Separator />

        {/* Measured usage */}
        {latestWithTokens ? (
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Measured usage ({latestWithTokens.periodLabel})
            </p>
            <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5">
              <span className="text-muted-foreground">Avg input tokens</span>
              <span className="font-mono font-semibold text-right">
                {latestWithTokens.inputTokens!.toLocaleString()}
              </span>
              <span className="text-muted-foreground">Avg output tokens</span>
              <span className="font-mono font-semibold text-right">
                {latestWithTokens.outputTokens!.toLocaleString()}
              </span>
              {latestMeasuredUsd !== null && (
                <>
                  <span className="text-muted-foreground">Cost at same rates</span>
                  <span className="font-mono font-semibold text-right">
                    {formatUsdPerCall(latestMeasuredUsd)}
                  </span>
                </>
              )}
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground italic">
            No token breakdown available for the selected periods.
          </p>
        )}

        {/* Gap explanation */}
        {gap !== null && multiplier !== null && (
          <>
            <Separator />
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Gap
              </p>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Measured vs estimate</span>
                <span
                  className={`font-mono font-semibold ${
                    gap > 0
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-emerald-600 dark:text-emerald-400"
                  }`}
                >
                  {gap >= 0 ? "+" : ""}
                  {formatUsdPerCall(gap)}{" "}
                  <span className="text-muted-foreground font-normal">
                    ({multiplier.toFixed(1)}×)
                  </span>
                </span>
              </div>
              <div className="rounded bg-muted/60 p-2.5 leading-relaxed text-muted-foreground">
                {Math.abs(gap) < 0.0005 ? (
                  <span>Usage closely matches the estimate — no significant gap.</span>
                ) : gap > 0 ? (
                  <>
                    <span className="font-semibold text-foreground">
                      Usage-profile driven, not a pricing change.
                    </span>{" "}
                    Published rates are unchanged from when the estimate was set. Your
                    measured calls consume roughly{" "}
                    <span className="font-semibold text-foreground">
                      {multiplier.toFixed(1)}× as many token-weighted units
                    </span>{" "}
                    as the estimate assumed — meaning clients send heavier prompts or
                    receive longer responses than the baseline expected.
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-foreground">
                      Lighter usage than assumed.
                    </span>{" "}
                    Published rates are unchanged. Your calls consume fewer tokens than the
                    estimate assumed — the business case is conservative on this cost.
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// TokenProfileBreakdownTable — per-period token counts in the expanded chart row
// ---------------------------------------------------------------------------

function TokenProfileBreakdownTable({
  series,
  periodData,
  pricing,
  estimateUsd,
}: {
  series: DriftSeries;
  periodData: TokenCostPeriodDatum[];
  pricing: RolePricingEntry;
  estimateUsd: number;
}) {
  const hasAnyTokens = periodData.some((r) => r.inputTokens !== null);
  if (!hasAnyTokens) return null;

  return (
    <div className="mt-5 space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Token profile by period
      </p>
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Period</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                Avg Input Tokens
              </th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                Avg Output Tokens
              </th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                Cost/call
              </th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                vs Estimate
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {periodData.map((row) => {
              const gap =
                row.measuredUsd !== null ? row.measuredUsd - estimateUsd : null;
              const mult =
                row.measuredUsd !== null && estimateUsd > 0
                  ? row.measuredUsd / estimateUsd
                  : null;
              return (
                <tr key={row.periodLabel} className="hover:bg-muted/30">
                  <td className="px-3 py-2 font-medium">{row.periodLabel}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {row.inputTokens !== null
                      ? row.inputTokens.toLocaleString()
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {row.outputTokens !== null
                      ? row.outputTokens.toLocaleString()
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {row.measuredUsd !== null ? formatUsdPerCall(row.measuredUsd) : "—"}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-mono font-semibold ${
                      gap === null
                        ? "text-muted-foreground"
                        : gap > 0
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-emerald-600 dark:text-emerald-400"
                    }`}
                  >
                    {gap !== null ? (
                      <>
                        {gap >= 0 ? "+" : ""}
                        {formatUsdPerCall(gap)}
                        {mult !== null && (
                          <span className="text-[10px] font-normal text-muted-foreground ml-1">
                            ({mult.toFixed(1)}×)
                          </span>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Rates: <span className="font-mono">
          ${pricing.inputPricePerMillionTokens}/M input ·{" "}
          ${pricing.outputPricePerMillionTokens}/M output
        </span>{" "}
        ({pricing.label}). Published rates are unchanged from the estimate — gaps are
        driven by token usage, not pricing changes.
      </p>
    </div>
  );
}

interface DriftTabProps {
  overlays: ActualsOverlayRecord[];
  intentList: { key: string; name: string; flowClass: string }[];
  scenarios: Scenario[];
  scenariosLoading: boolean;
}

/**
 * Role → human-readable prefix used in drift series labels.
 * Matches the display strings previously hardcoded in DEFAULT_ROLE_PRICING.
 */
const ROLE_PREFIXES: Record<string, string> = {
  router:    "Router / Classification",
  reasoning: "Reasoning / Grounded Answers",
  frontier:  "Frontier / High-Judgment",
  data:      "Data Access / Legacy DB",
};
function DriftTab({ overlays, intentList, scenarios, scenariosLoading }: DriftTabProps) {
  // ----- Model catalog (live pricing source of truth) -----
  const {
    data: catalogData,
    isLoading: catalogLoading,
    isError: catalogError,
  } = useListModelCatalog();

  // Derive RolePricingMap from the default model per role in the catalog.
  const rolePricingMap = useMemo<RolePricingMap | undefined>(() => {
    if (!catalogData) return undefined;
    const result: RolePricingMap = {};
    for (const m of catalogData) {
      if (m.isDefault) {
        const prefix = ROLE_PREFIXES[m.role] ?? m.role;
        result[m.role] = {
          label: `${prefix} (${m.label})`,
          inputPricePerMillionTokens: m.inputPricePerMillionTokens,
          outputPricePerMillionTokens: m.outputPricePerMillionTokens,
          defaultPricePerCallUsd: m.pricePerCallUsd,
        };
      }
    }
    return result;
  }, [catalogData]);

  // ----- Client groups -----
  // null key = unlabeled group (clientLabel is null/undefined).
  // Drift is always per single client — no cross-client mixing allowed.
  const clientGroups = useMemo<Array<{ key: string | null; label: string; count: number }>>(() => {
    const map = new Map<string | null, number>();
    for (const o of overlays) {
      const k = o.clientLabel ?? null;
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([key, count]) => ({
        key,
        label: key ?? "(Unlabeled)",
        count,
      }))
      .sort((a, b) => {
        // Named clients first, alphabetically; unlabeled last
        if (a.key === null) return 1;
        if (b.key === null) return -1;
        return a.key.localeCompare(b.key);
      });
  }, [overlays]);

  // selectedClient: null = not yet chosen (waiting for overlays to load).
  // Initialised by effect once clientGroups first becomes non-empty.
  const [selectedClient, setSelectedClient] = useState<string | null | "__unset__">("__unset__");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // selectedScenarioId: null = "Global defaults" (no scenario selected).
  // Resets to null whenever the client changes (different client → different scenario context).
  // Initialised from ?scenario=<id> URL param on mount for deep-linking.
  const [selectedScenarioId, setSelectedScenarioId] = useState<number | null>(() => {
    const raw = new URLSearchParams(window.location.search).get("scenario");
    const parsed = raw !== null ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  });

  // Once clientGroups loads, pick the first group and select all its overlays.
  useEffect(() => {
    if (selectedClient === "__unset__" && clientGroups.length > 0) {
      const firstKey = clientGroups[0]!.key;
      setSelectedClient(firstKey);
      const firstGroupOverlays = overlays.filter((o) =>
        firstKey === null
          ? (o.clientLabel ?? null) === null
          : o.clientLabel === firstKey,
      );
      setSelectedIds(new Set(firstGroupOverlays.map((o) => o.id)));
    }
  }, [clientGroups, selectedClient, overlays]);

  // The effective client key to use for filtering (treat "__unset__" as no match)
  const activeClient = selectedClient === "__unset__" ? null : selectedClient;

  // Overlays belonging to the currently selected client group
  const clientOverlays = useMemo(
    () =>
      selectedClient === "__unset__"
        ? []
        : overlays.filter((o) =>
            activeClient === null
              ? (o.clientLabel ?? null) === null
              : o.clientLabel === activeClient,
          ),
    [overlays, selectedClient, activeClient],
  );

  // When client changes: switch selection to all overlays in the new group
  // and reset scenario picker to "Global defaults"
  const handleClientChange = (key: string | null) => {
    setSelectedClient(key);
    const newClientOverlays = overlays.filter((o) =>
      key === null ? (o.clientLabel ?? null) === null : o.clientLabel === key,
    );
    setSelectedIds(new Set(newClientOverlays.map((o) => o.id)));
    setExpandedKey(null);
    setSelectedScenarioId(null); // reset to global defaults on client change
  };

  // toggleId: only allowed for overlays that belong to the current client group
  const toggleId = (id: number) => {
    // Verify the overlay is in the current client group (defence-in-depth)
    const belongs = clientOverlays.some((o) => o.id === id);
    if (!belongs) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const selectedOverlays = useMemo(
    () => clientOverlays.filter((o) => selectedIds.has(o.id)),
    [clientOverlays, selectedIds],
  );

  const intentLabels = useMemo(
    () => Object.fromEntries(intentList.map((i) => [i.key, i.name])),
    [intentList],
  );

  // intentFlowClasses: intentKey → flowClass — used by scenarioToEstimateMap (Option 3)
  const intentFlowClasses = useMemo(
    () => Object.fromEntries(intentList.map((i) => [i.key, i.flowClass])),
    [intentList],
  );

  // Resolve the currently selected scenario object (null if "Global defaults" or not found)
  const selectedScenario = useMemo(
    () => (selectedScenarioId !== null ? (scenarios.find((s) => s.id === selectedScenarioId) ?? null) : null),
    [scenarios, selectedScenarioId],
  );

  // If the scenario was deleted / is no longer in the list, treat as missing
  const scenarioMissing = selectedScenarioId !== null && selectedScenario === null && !scenariosLoading;

  // Build estimateMap from selected scenario; {} = global defaults (fall-through)
  const estimateMap = useMemo(() => {
    if (!selectedScenario) return {};
    return scenarioToEstimateMap(
      {
        // Pass both field names — scenarioToEstimateMap merges them, current wins.
        containmentRates:    selectedScenario.inputs.containmentRates    as Record<string, number> | undefined,
        containmentOverrides: selectedScenario.inputs.containmentOverrides as Record<string, number> | undefined,
        hitlSamplingRate: selectedScenario.inputs.hitlSamplingRate,
        intentContainmentOverrides: selectedScenario.inputs.intentContainmentOverrides as Record<string, number> | undefined,
      },
      intentFlowClasses,
    );
  }, [selectedScenario, intentFlowClasses]);

  const driftSeries = useMemo(() => {
    if (selectedOverlays.length < 2) return [];
    try {
      return computeDrift(
        selectedOverlays as unknown as DriftOverlayInput[],
        estimateMap,
        intentLabels,
        // rolePricingMap is undefined while catalog loads — computeDrift
        // simply omits token-cost series when the map is not provided.
        rolePricingMap,
      );
    } catch {
      // MixedClientError: should not happen given the UI filters, but
      // fail safe rather than crashing the component
      return [];
    }
  }, [selectedOverlays, estimateMap, intentLabels, rolePricingMap]);

  const canCompare = selectedOverlays.length >= 2;

  if (overlays.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
        <FlaskConical className="w-10 h-10 opacity-20" />
        <p className="text-sm font-medium">No overlays saved yet.</p>
        <p className="text-xs">
          Create at least two overlays in <span className="font-medium">Import &amp; Manage</span> to compare drift across periods.
        </p>
      </div>
    );
  }

  if (clientGroups.length === 0) return null;

  return (
    <div className="flex flex-col gap-5">
      {/* -- Selection panel -- */}
      <Card className="shadow-sm border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Select Overlays to Compare</CardTitle>
          <CardDescription>
            Pick a client, then choose which of their overlays to include. Drift tracks one client's measurements across time — cross-client comparison is not supported.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Client picker — one button per distinct clientLabel group */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Client
            </Label>
            <div className="flex gap-2 flex-wrap">
              {clientGroups.map((grp) => (
                <button
                  key={grp.key ?? "__unlabeled__"}
                  type="button"
                  onClick={() => handleClientChange(grp.key)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors flex items-center gap-1.5 ${
                    selectedClient === grp.key
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background border-border hover:bg-muted"
                  }`}
                >
                  {grp.label}
                  <span
                    className={`text-[10px] rounded-full px-1.5 py-0 font-normal ${
                      selectedClient === grp.key
                        ? "bg-primary-foreground/20 text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {grp.count}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Scenario picker — choose estimate reference source */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Compare estimates against
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              {/* "Global defaults" option */}
              <button
                type="button"
                onClick={() => setSelectedScenarioId(null)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                  selectedScenarioId === null
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background border-border hover:bg-muted"
                }`}
              >
                Global defaults
              </button>

              {/* Scenario buttons */}
              {scenariosLoading && (
                <span className="text-xs text-muted-foreground italic">Loading scenarios…</span>
              )}
              {!scenariosLoading && scenarios.length === 0 && (
                <span className="text-xs text-muted-foreground">
                  No scenarios saved — create one in{" "}
                  <a href="/cost-explorer/scenario" className="text-primary underline underline-offset-2">
                    Scenario Builder
                  </a>{" "}
                  to use it as a reference.
                </span>
              )}
              {!scenariosLoading &&
                scenarios.map((sc) => (
                  <button
                    key={sc.id}
                    type="button"
                    onClick={() => setSelectedScenarioId(sc.id)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors flex items-center gap-1.5 ${
                      selectedScenarioId === sc.id
                        ? "bg-violet-600 text-white border-violet-600"
                        : "bg-background border-border hover:bg-muted"
                    }`}
                  >
                    {sc.name}
                  </button>
                ))}
            </div>

            {/* Missing scenario notice */}
            {scenarioMissing && (
              <Alert variant="destructive" className="py-2 mt-1">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  The selected scenario was deleted. Estimates are falling back to global defaults.
                </AlertDescription>
              </Alert>
            )}
          </div>

          {/* Overlay checkboxes — only for the selected client */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Periods to include
              </Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedIds(new Set(clientOverlays.map((o) => o.id)))}
                  className="text-xs h-6 px-2"
                >
                  All
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedIds(new Set())}
                  className="text-xs h-6 px-2"
                >
                  None
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {clientOverlays.map((ov) => {
                const checked = selectedIds.has(ov.id);
                const period =
                  ov.periodStart
                    ? `${ov.periodStart}${ov.periodEnd ? ` → ${ov.periodEnd}` : ""}`
                    : "No period";
                return (
                  <label
                    key={ov.id}
                    className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${
                      checked
                        ? "border-violet-500/40 bg-violet-500/5"
                        : "border-border hover:bg-muted/30"
                    }`}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleId(ov.id)}
                      className="mt-0.5 shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Clock className="w-3 h-3 shrink-0" />
                        {period}
                      </div>
                      <Badge
                        variant="outline"
                        className="font-mono text-[9px] bg-background mt-1"
                      >
                        #{ov.id}
                      </Badge>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Selection status */}
          <div className="flex items-center gap-2">
            <Badge
              variant={canCompare ? "default" : "outline"}
              className={canCompare ? "bg-violet-600 hover:bg-violet-600" : ""}
            >
              {selectedOverlays.length} selected
            </Badge>
            {!canCompare && (
              <span className="text-xs text-muted-foreground">
                Select at least 2 periods to see drift.
              </span>
            )}
            {canCompare && driftSeries.length === 0 && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                No shared measurements found across the selected periods.
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* -- Catalog pricing notice (loading / error) -- */}
      {canCompare && catalogLoading && (
        <Alert className="border-blue-200 bg-blue-50/50 dark:bg-blue-950/20">
          <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
          <AlertDescription className="text-xs text-blue-700 dark:text-blue-300">
            Loading model catalog… token cost/call series will appear once pricing data is available.
          </AlertDescription>
        </Alert>
      )}
      {canCompare && catalogError && (
        <Alert className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/20">
          <AlertCircle className="w-4 h-4 text-amber-500" />
          <AlertDescription className="text-xs text-amber-700 dark:text-amber-300">
            Could not load the model catalog — token cost/call series are unavailable.
            Other drift metrics are unaffected. Reload the page to retry.
          </AlertDescription>
        </Alert>
      )}

      {/* -- Drift table -- */}
      {canCompare && driftSeries.length > 0 && (
        <Card className="shadow-sm border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center justify-between flex-wrap gap-2">
              <span>Per-Assumption Drift</span>
              <div className="flex items-center gap-2 flex-wrap">
                {/* Estimate source indicator */}
                {selectedScenario ? (
                  <Badge className="bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30 font-normal">
                    Estimates: {selectedScenario.name}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    Estimates: Global defaults
                  </Badge>
                )}
                <span className="text-xs font-normal text-muted-foreground">
                  {selectedOverlays.length} periods · click a row to expand chart
                </span>
              </div>
            </CardTitle>
            <CardDescription>
              Measured values vs.{" "}
              {selectedScenario
                ? `"${selectedScenario.name}" scenario estimates`
                : "global assumptions register defaults"}{" "}
              (dashed reference line). Trend is relative to the estimate across the selected periods.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="rounded-b-lg overflow-hidden">
              {/* Table header */}
              <div className="grid gap-0 overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide w-[28%]">
                        Assumption
                      </th>
                      <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide text-right">
                        Estimate
                      </th>
                      {/* Period columns — one per selected overlay (sorted) */}
                      {driftSeries[0]!.points.map((p) => (
                        <th
                          key={p.overlayId}
                          className="px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide text-right"
                        >
                          {p.periodLabel}
                        </th>
                      ))}
                      <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide text-center">
                        Trend
                      </th>
                      <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide text-center w-[90px]">
                        Sparkline
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {driftSeries.map((series) => {
                      const isExpanded = expandedKey === series.assumptionKey;
                      const fmtVal = (v: number | null) => {
                        if (v === null) return "—";
                        if (series.unit === "fraction") return v.toFixed(3);
                        if (series.unit === "minutes") return `${v.toFixed(1)} min`;
                        if (series.unit === "USD") return formatUsdPerCall(v);
                        return v.toFixed(4);
                      };

                      // Token-cost series extras — built here so both the label
                      // popover and the expanded breakdown can share the same data.
                      const isTokenCost =
                        series.unit === "USD" &&
                        series.assumptionKey.startsWith("token-cost-");
                      const tokenRole = isTokenCost
                        ? series.assumptionKey.slice("token-cost-".length)
                        : null;
                      // Pricing sourced from the live catalog-derived rolePricingMap;
                      // components receive it as a prop (no direct import inside them).
                      const tokenPricing =
                        tokenRole && rolePricingMap
                          ? rolePricingMap[tokenRole] ?? null
                          : null;
                      const tokenPeriodData: TokenCostPeriodDatum[] | null =
                        isTokenCost && tokenRole
                          ? series.points.map((p) => {
                              const ov = selectedOverlays.find(
                                (o) => o.id === p.overlayId,
                              );
                              const actuals =
                                ov?.payload.tokenActualsByRole?.[tokenRole!];
                              return {
                                periodLabel: p.periodLabel,
                                inputTokens: actuals?.avgInputTokens ?? null,
                                outputTokens: actuals?.avgOutputTokens ?? null,
                                measuredUsd: p.measuredValue,
                              };
                            })
                          : null;

                      return (
                        <Fragment key={series.assumptionKey}>
                          <tr
                            className={`hover:bg-muted/30 transition-colors cursor-pointer ${
                              isExpanded ? "bg-muted/20" : ""
                            }`}
                            onClick={() =>
                              setExpandedKey(isExpanded ? null : series.assumptionKey)
                            }
                          >
                            <td className="px-4 py-3">
                              <div className="font-medium text-xs text-foreground leading-snug flex items-center gap-1">
                                {series.label}
                                {isTokenCost &&
                                  tokenPricing &&
                                  tokenPeriodData &&
                                  series.estimate !== null && (
                                    <TokenCostExplainPopover
                                      pricing={tokenPricing}
                                      estimateUsd={series.estimate}
                                      periodData={tokenPeriodData}
                                    />
                                  )}
                              </div>
                              <div className="text-[10px] text-muted-foreground font-mono mt-0.5 flex items-center gap-1">
                                {series.polarity === "higher-is-better" ? (
                                  <TrendingUp className="w-2.5 h-2.5 text-emerald-500" />
                                ) : (
                                  <TrendingDown className="w-2.5 h-2.5 text-amber-500" />
                                )}
                                {series.polarity === "higher-is-better"
                                  ? "higher is better"
                                  : "lower is better"}{" "}
                                · {series.unit}
                              </div>
                            </td>
                            <td className="px-3 py-3 text-right font-mono text-xs text-muted-foreground">
                              {series.estimate !== null ? fmtVal(series.estimate) : "N/A"}
                            </td>
                            {series.points.map((p) => {
                              const isNull = p.measuredValue === null;
                              const aboveEstimate =
                                !isNull &&
                                series.estimate !== null &&
                                series.polarity === "higher-is-better"
                                  ? p.measuredValue! >= series.estimate
                                  : series.estimate !== null && !isNull
                                    ? p.measuredValue! <= series.estimate
                                    : null;
                              return (
                                <td
                                  key={p.overlayId}
                                  className={`px-3 py-3 text-right font-mono text-xs font-semibold ${
                                    isNull
                                      ? "text-muted-foreground"
                                      : aboveEstimate === true
                                        ? "text-emerald-600 dark:text-emerald-400"
                                        : aboveEstimate === false
                                          ? "text-amber-600 dark:text-amber-400"
                                          : "text-foreground"
                                  }`}
                                >
                                  {fmtVal(p.measuredValue)}
                                </td>
                              );
                            })}
                            <td className="px-3 py-3 text-center">
                              <TrendBadge trend={series.trend} />
                            </td>
                            <td className="px-3 py-3">
                              <div className="flex justify-center">
                                <Sparkline series={series} width={90} height={34} />
                              </div>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr>
                              <td colSpan={series.points.length + 4} className="px-4 pb-4">
                                <FullDriftChart series={series} />
                                {isTokenCost &&
                                  tokenPricing &&
                                  tokenPeriodData &&
                                  series.estimate !== null && (
                                    <TokenProfileBreakdownTable
                                      series={series}
                                      periodData={tokenPeriodData}
                                      pricing={tokenPricing}
                                      estimateUsd={series.estimate}
                                    />
                                  )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* -- Legend / notes -- */}
      {canCompare && driftSeries.length > 0 && (
        <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground px-1">
          <span>
            <span className="font-medium text-foreground">Trend rules:</span> improving = quality moving in the favorable direction;
            degrading = moving away; stable = variation &lt; {(0.05 * 100).toFixed(0)}% of estimate; mixed = direction reverses.
          </span>
          <span>
            <span className="font-medium text-foreground">Reference line:</span>{" "}
            {selectedScenario
              ? `"${selectedScenario.name}" scenario estimate. Per-intent rows use the scenario's flow-class override for their class (Option 3 expansion).`
              : "global assumptions register default."}{" "}
            "N/A" = no estimate available for this row from the active source (trend still computed from measured values).
          </span>
        </div>
      )}
    </div>
  );
}

const LOG_HEADER =
  "call_id,timestamp,intent_key,contained,hitl_reviewed,hitl_minutes,flow_class,router_input_tokens,router_output_tokens,reasoning_input_tokens,reasoning_output_tokens,frontier_input_tokens,frontier_output_tokens,data_input_tokens,data_output_tokens";

function downloadLogTemplate() {
  const content = [LOG_HEADER, ...LOG_TEMPLATE_ROWS].join("\n");
  const blob = new Blob([content], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "call-log-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

const LOG_TEMPLATE_ROWS = [
  "call-001,2025-03-01T09:00:00Z,payslip-copy,true,false,,,900,120,,,,,,",
  "call-002,2025-03-01T09:05:00Z,leave-balance,false,true,4.5,,900,120,,,,,,",
  "call-003,2025-03-01T09:12:00Z,payroll-discrepancy,true,false,2.0,fc3-multiagent,900,120,4500,700,,,3000,600",
  "call-004,2025-03-01T09:20:00Z,payslip-copy,true,false,,,900,120,,,,,,",
];
