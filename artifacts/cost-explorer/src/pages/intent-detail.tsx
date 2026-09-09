import { useEffect, useState } from "react";
import { useRoute, Link, useLocation } from "wouter";
import {
  useListIntents,
  useListFlowClasses,
  useListSystems,
  useListFlowOverrides,
  useCreateFlowOverride,
  useApproveFlowOverride,
  useDeleteFlowOverride,
  useRevokeFlowOverride,
  useUpdateCustomIntent,
  useRetireCustomIntent,
  useGetCustomIntent,
  getGetCustomIntentQueryKey,
  getListFlowOverridesQueryKey,
  getListIntentsQueryKey,
} from "@workspace/api-client-react";
import type { CustomIntentUpdate, Intent } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, ShieldCheck, Activity, BrainCircuit,
  Database, User, Layers, ArrowRight, Zap, Info, DollarSign, Clock,
  PenLine, CheckCircle2, Trash2, Sparkles, Pencil, Archive,
  ChevronDown, ChevronRight, AlertTriangle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AnimatePresence } from "framer-motion";
import { FlowDiagram, FlowStepDetail } from "@/components/flow-diagram";
import { CustomIntentRoutingEditor } from "@/components/custom-intent-routing-editor";
import { IntentCorpusStatus } from "@/components/intent-corpus-status";
import { useProcessViewPreference } from "@/hooks/use-process-view";
const FLOW_CLASSES = [
  "fc1-deterministic",
  "fc2-policy",
  "fc3-multiagent",
  "fc4-frontier",
];

const KNOWN_DOMAINS = [
  "pay", "leave", "time", "benefits", "hire", "develop",
  "mobility", "retire", "data-admin", "policy",
];

const circledNumbers: Record<string, string> = {
  "1": "①", "2": "②", "3": "③", "4": "④",
  "5": "⑤", "6": "⑥", "7": "⑦", "8": "⑧", "9": "⑨",
};

export default function IntentDetail() {
  const [, params] = useRoute("/intents/:key");
  const intentKey = params?.key;
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [showDiagram, setShowDiagram] = useState(true);
  const [processView, setProcessView] = useProcessViewPreference();

  const {
    data: corpus,
    isLoading: isLoadingIntents,
    isError: isIntentError,
    error: intentError,
    refetch: refetchIntents,
    isFetching: isFetchingIntents,
  } = useListIntents();
  const intents = corpus?.intents;
  const { data: flowClasses, isLoading: isLoadingFlows } = useListFlowClasses();
  const { data: allFlowOverrides } = useListFlowOverrides();

  const intent = intents?.find((i) => i.key === intentKey);
  const activeFlowOverride = (allFlowOverrides ?? [])
    .filter((override) => override.intentKey === intentKey && override.status === "approved")
    .sort((a, b) => b.version - a.version)[0];
  const effectiveFlowClassKey = activeFlowOverride?.flowClass ?? intent?.flowClass;
  const flowClass = flowClasses?.find((fc) => fc.key === effectiveFlowClassKey);
  const isCustom = intent ? (intent as { isCustom?: boolean }).isCustom === true : false;

  const handleStepClick = (stepId: string | null) => {
    setExpandedStepId((prev) => (prev === stepId ? null : stepId));
  };

  if (isLoadingIntents || isLoadingFlows) {
    return (
      <div className="space-y-6 animate-in fade-in duration-300">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }

  if (isIntentError) {
    return (
      <IntentCorpusStatus
        isLoading={false}
        isError
        error={intentError}
        isFetching={isFetchingIntents}
        onRetry={() => { void refetchIntents(); }}
        loading={null}
        errorTitle="Intent details could not be loaded"
      >
        {null}
      </IntentCorpusStatus>
    );
  }

  if (!intent) {
    if (corpus?.customIntentsAvailable === false) {
      return (
        <div className="space-y-5 py-16 text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-amber-600" />
          <h2 className="text-2xl font-bold text-foreground">This intent may be temporarily unavailable</h2>
          <p className="mx-auto max-w-xl text-muted-foreground">
            The built-in reference corpus loaded, but custom intents could not be checked. Retry before treating this intent as missing.
          </p>
          <Button onClick={() => { void refetchIntents(); }} disabled={isFetchingIntents}>
            {isFetchingIntents ? "Retrying…" : "Try again"}
          </Button>
          <div>
            <Link href="/intents" className="text-primary hover:underline">Return to Catalog</Link>
          </div>
        </div>
      );
    }
    return (
      <div className="text-center py-20">
        <h2 className="text-2xl font-bold text-foreground">Intent Not Found</h2>
        <p className="text-muted-foreground mt-2">Could not find intent with key: {intentKey}</p>
        <Link href="/intents" className="text-primary mt-4 inline-block hover:underline">
          Return to Catalog
        </Link>
      </div>
    );
  }

  const expandedStep = flowClass?.steps.find((s) => s.id === expandedStepId) ?? null;

  return (
    <div className="space-y-6 pb-20 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <Link href="/intents" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-primary transition-colors">
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to Intents
      </Link>
      {corpus?.customIntentsAvailable === false && (
        <div role="status" className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-muted-foreground">{corpus.warning}</p>
        </div>
      )}

      {/* Hero header */}
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
        <div className="space-y-2 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {isCustom && (
              <Badge className="bg-teal-500/15 text-teal-700 dark:text-teal-300 border border-teal-500/30">
                <Sparkles className="w-3 h-3 mr-1" /> custom
              </Badge>
            )}
            <Badge variant="secondary" className="capitalize">{intent.domain}</Badge>
            <Badge variant="outline" className="font-mono bg-card">{intent.flowClass}</Badge>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{intent.name}</h1>
          <p className="text-lg text-muted-foreground leading-relaxed max-w-3xl">{intent.description}</p>
          <div className="flex items-center gap-3 pt-2 text-sm flex-wrap">
            <div className="flex items-center gap-1.5 text-muted-foreground bg-card px-3 py-1.5 rounded-md border border-border">
              <ShieldCheck className="w-4 h-4 text-primary" />
              Source: <span className="font-medium text-foreground ml-1">{intent.source.name}</span>
            </div>
            <div className="flex items-center gap-1.5 text-muted-foreground bg-card px-3 py-1.5 rounded-md border border-border">
              <span className="font-semibold">Weight:</span>
              <span className="font-mono text-foreground ml-1">{intent.baseWeight}x</span>
            </div>
            <div className="flex items-center gap-1.5 text-muted-foreground bg-card px-3 py-1.5 rounded-md border border-border">
              <span className="font-semibold">Actions:</span>
              <span className="text-blue-600 dark:text-blue-400 font-mono ml-1">{intent.actGetActions} GET</span>
              <span>/</span>
              <span className="text-amber-600 dark:text-amber-400 font-mono">{intent.actPutActions} PUT</span>
            </div>
            {intent.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="bg-muted/50 font-normal">#{tag}</Badge>
            ))}
          </div>
        </div>

        <div className="flex gap-3 flex-col items-end">
          <div className="flex gap-3">
            <Card className="bg-card shadow-sm border-border min-w-[130px]">
              <CardContent className="p-4 flex flex-col items-center justify-center text-center h-full">
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1">
                  <Activity className="w-3.5 h-3.5" /> As-Is
                </div>
                <div className="text-3xl font-mono font-bold text-foreground">
                  {intent.asIsHandlingMin}<span className="text-lg text-muted-foreground font-sans font-normal ml-1">m</span>
                </div>
              </CardContent>
            </Card>
            <Card className="bg-card shadow-sm border-border min-w-[130px]">
              <CardContent className="p-4 flex flex-col items-center justify-center text-center h-full">
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1">
                  <BrainCircuit className="w-3.5 h-3.5" /> To-Be Human
                </div>
                <div className="text-3xl font-mono font-bold text-primary">
                  {intent.toBeHumanMin}<span className="text-lg text-muted-foreground font-sans font-normal ml-1">m</span>
                </div>
              </CardContent>
            </Card>
          </div>
          {isCustom && (
            <CustomIntentActions intentKey={intent.key} intent={intent} />
          )}
        </div>
      </div>

      {/* ── Flow Tracer ────────────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-primary" />
            <h2 className="text-2xl font-bold tracking-tight">Flow Tracer</h2>
            <span className="text-sm text-muted-foreground">
              — {activeFlowOverride?.flowClass
                ? `approved override v${activeFlowOverride.version}: ${effectiveFlowClassKey}`
                : `${isCustom ? "inherited from " : ""}${effectiveFlowClassKey} template`}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground text-xs gap-1.5"
            onClick={() => setShowDiagram((d) => !d)}
          >
            {showDiagram ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            {showDiagram ? "Collapse diagram" : "Show diagram"}
          </Button>
        </div>

        {!flowClass ? (
          <div className="p-6 border border-dashed border-border rounded-xl text-center text-muted-foreground">
            Flow architecture details not available for {intent.flowClass}.
          </div>
        ) : (
          <div className="space-y-4">
            {/* SVG process-flow diagram with inline step detail */}
            {showDiagram && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Click a step node to see its systems, costs, and value delivered.
                </p>
                <FlowDiagram
                  steps={flowClass.steps}
                  fcKey={flowClass.key}
                  annotations={{ usingDefaults: true }}
                  onStepClick={handleStepClick}
                  expandedStepId={expandedStepId}
                  viewMode={processView}
                  onViewModeChange={setProcessView}
                />
                <AnimatePresence>
                  {processView === "technical" && expandedStep && (
                    <FlowStepDetail key={expandedStep.id} step={expandedStep} />
                  )}
                </AnimatePresence>
              </div>
            )}

            {/* Compact step list */}
            {processView === "technical" && <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">All Steps</h3>
              <div className="space-y-2">
                {flowClass.steps.map((step, idx) => {
                  const isHitl = step.human;
                  const isSelected = expandedStepId === step.id;
                  return (
                    <button
                      key={step.id}
                      className={`w-full text-left transition-all rounded-lg border px-4 py-3 flex items-center gap-3 hover:border-primary/30 hover:bg-muted/30 ${
                        isSelected
                          ? "border-primary/40 bg-primary/5"
                          : isHitl
                          ? "border-amber-200 dark:border-amber-500/30 bg-amber-50/50 dark:bg-amber-500/5"
                          : "border-border bg-card"
                      }`}
                      onClick={() => handleStepClick(isSelected ? null : step.id)}
                    >
                      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                        isHitl
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
                          : "bg-primary/10 text-primary"
                      }`}>
                        {idx + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm text-foreground">{step.label}</span>
                          <Badge variant="outline" className="text-[9px] uppercase font-mono px-1.5 h-4">{step.stage}</Badge>
                          {isHitl && (
                            <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300 border-amber-200 dark:border-amber-500/30 text-[9px] uppercase h-4 px-1.5 gap-1">
                              <User className="w-2.5 h-2.5" /> HITL
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {step.agents.length > 0 ? step.agents.join(", ") : "System"}
                          {step.componentRefs.length > 0 && (
                            <span className="ml-2 font-mono text-primary">
                              {step.componentRefs.map((r) => circledNumbers[r] || r).join(" ")}
                            </span>
                          )}
                        </div>
                      </div>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${isSelected ? "rotate-180" : ""}`} />
                    </button>
                  );
                })}
              </div>
            </div>}
          </div>
        )}
      </div>

      {/* ── SME Flow Adjustments ────────────────────────────────────────────────── */}
      <FlowOverridePanel
        intentKey={intent.key}
        currentFlowClass={intent.flowClass}
        flowClasses={(flowClasses ?? []).map((fc) => fc.key)}
      />
    </div>
  );
}

// ── Custom intent management actions ────────────────────────────────────────

function CustomIntentActions({ intentKey, intent }: {
  intentKey: string;
  intent: Intent;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const retireMutation = useRetireCustomIntent();
  const customIntentQuery = useGetCustomIntent(intentKey);
  const [editOpen, setEditOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListIntentsQueryKey() });
  };

  const handleRetire = async () => {
    try {
      await retireMutation.mutateAsync({ key: intentKey });
      toast({
        title: "Intent retired",
        description: "Removed from roll-ups. Flow-override history is preserved.",
      });
      refresh();
      navigate("/intents");
    } catch {
      toast({ title: "Retire failed", variant: "destructive" });
    }
  };

  return (
    <div className="flex gap-2">
      <Button size="sm" className="gap-1.5" onClick={() => setRoutingOpen(true)}>
        <Zap className="w-3.5 h-3.5" /> Configure route
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        onClick={() => setEditOpen(true)}
      >
        <Pencil className="w-3.5 h-3.5" /> Edit
      </Button>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button size="sm" variant="outline" className="gap-1.5 text-amber-600 border-amber-600/30 hover:bg-amber-600/10">
            <Archive className="w-3.5 h-3.5" /> Retire
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire this intent?</AlertDialogTitle>
            <AlertDialogDescription>
              Retiring <strong>{intent.name}</strong> removes it from all roll-up calculations immediately — its share, cost, and benefit will no longer be counted. Flow-override history is preserved and the intent page remains accessible. This cannot be undone via the UI (contact support to reactivate).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRetire}
              className="bg-amber-600 hover:bg-amber-700"
            >
              Retire intent
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <EditIntentDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        intent={intent}
        expectedUpdatedAt={customIntentQuery.data?.updatedAt}
        onSaved={refresh}
      />
      <CustomIntentRoutingEditor
        intentKey={intentKey}
        open={routingOpen}
        onOpenChange={setRoutingOpen}
      />
    </div>
  );
}

// ── Edit dialog ──────────────────────────────────────────────────────────────

function EditIntentDialog({
  open,
  onOpenChange,
  intent,
  expectedUpdatedAt,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  intent: Intent;
  expectedUpdatedAt?: string;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateMutation = useUpdateCustomIntent();
  const [editVersion, setEditVersion] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: intent.name,
    domain: intent.domain,
    flowClass: intent.flowClass,
    description: intent.description,
    asIsHandlingMin: String(intent.asIsHandlingMin),
    toBeHumanMin: String(intent.toBeHumanMin),
    baseWeight: String(intent.baseWeight),
    actGetActions: String(intent.actGetActions),
    actPutActions: String(intent.actPutActions),
    systemsTouchedBase: String(intent.systemsTouchedBase),
    source: intent.source.name,
  });
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setEditVersion(null);
    } else if (editVersion === null && expectedUpdatedAt) {
      setEditVersion(expectedUpdatedAt);
    }
  }, [editVersion, expectedUpdatedAt, open]);

  const set = (field: keyof typeof form) => (val: string) =>
    setForm((prev) => ({ ...prev, [field]: val }));
  const onInput = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    set(field)(e.target.value);

  const handleSave = async () => {
    const asIs = Number(form.asIsHandlingMin);
    const toBe = Number(form.toBeHumanMin);
    if (!form.name.trim()) { setFormError("Name is required"); return; }
    if (!Number.isFinite(asIs) || asIs < 0 || asIs > 600) { setFormError("As-is must be 0–600"); return; }
    if (!Number.isFinite(toBe) || toBe < 0 || toBe > 600) { setFormError("To-be must be 0–600"); return; }
    if (toBe > asIs) { setFormError("To-be must not exceed as-is"); return; }
    const w = Number(form.baseWeight);
    if (!Number.isFinite(w) || w < 0.1 || w > 20) { setFormError("Weight must be 0.1–20"); return; }
    setFormError(null);

    try {
      if (!editVersion) {
        setFormError("The latest edit version is still loading. Close this editor, then try again.");
        return;
      }
      const patch: CustomIntentUpdate = {
        expectedUpdatedAt: editVersion,
        name: form.name.trim(),
        domain: form.domain.trim(),
        flowClass: form.flowClass,
        description: form.description.trim(),
        asIsHandlingMin: asIs,
        toBeHumanMin: toBe,
        baseWeight: w,
        actGetActions: Number(form.actGetActions),
        actPutActions: Number(form.actPutActions),
        systemsTouchedBase: Number(form.systemsTouchedBase),
        source: form.source.trim(),
      };
      const saved = await updateMutation.mutateAsync({ key: intent.key, data: patch });
      queryClient.setQueryData(getGetCustomIntentQueryKey(intent.key), saved);
      toast({ title: "Intent updated" });
      onSaved();
      onOpenChange(false);
    } catch (e) {
      const apiError = e as { data?: { error?: string }; message?: string };
      setFormError(apiError.data?.error ?? apiError.message ?? "Update failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="w-4 h-4" /> Edit intent
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Name</Label>
              <Input value={form.name} onChange={onInput("name")} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Domain</Label>
              <Input value={form.domain} onChange={onInput("domain")} list="edit-domain-suggestions" />
              <datalist id="edit-domain-suggestions">
                {KNOWN_DOMAINS.map((d) => <option key={d} value={d} />)}
              </datalist>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Flow class</Label>
            <Select value={form.flowClass} onValueChange={set("flowClass")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {FLOW_CLASSES.map((fc) => <SelectItem key={fc} value={fc}>{fc}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Description</Label>
            <Textarea value={form.description} onChange={onInput("description")} rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">As-is (min)</Label>
              <Input type="number" value={form.asIsHandlingMin} onChange={onInput("asIsHandlingMin")} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">To-be (min)</Label>
              <Input type="number" value={form.toBeHumanMin} onChange={onInput("toBeHumanMin")} />
            </div>
          </div>
          <div className="grid grid-cols-4 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">GET actions</Label>
              <Input type="number" value={form.actGetActions} onChange={onInput("actGetActions")} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">PUT actions</Label>
              <Input type="number" value={form.actPutActions} onChange={onInput("actPutActions")} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Weight</Label>
              <Input type="number" step={0.1} value={form.baseWeight} onChange={onInput("baseWeight")} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Systems</Label>
              <Input type="number" value={form.systemsTouchedBase} onChange={onInput("systemsTouchedBase")} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Source / rationale</Label>
            <Textarea value={form.source} onChange={onInput("source")} rows={2} />
          </div>
          {formError && (
            <p className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">{formError}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateMutation.isPending}>
            {updateMutation.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── SME Flow Overrides panel (unchanged) ────────────────────────────────────

function FlowOverridePanel({
  intentKey,
  currentFlowClass,
  flowClasses,
}: {
  intentKey: string;
  currentFlowClass: string;
  flowClasses: string[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: allOverrides, isLoading } = useListFlowOverrides();
  const createOverride = useCreateFlowOverride();
  const approveOverride = useApproveFlowOverride();
  const deleteOverride = useDeleteFlowOverride();
  const revokeOverride = useRevokeFlowOverride();

  const [author, setAuthor] = useState("");
  const [rationale, setRationale] = useState("");
  const [flowClass, setFlowClass] = useState<string>("");
  const [toBeHumanMin, setToBeHumanMin] = useState("");
  const [actGet, setActGet] = useState("");
  const [actPut, setActPut] = useState("");

  const versions = (allOverrides ?? []).filter((o) => o.intentKey === intentKey);
  const active = versions.filter((o) => o.status === "approved").sort((a, b) => b.version - a.version)[0];

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListFlowOverridesQueryKey() });

  const handlePropose = async () => {
    if (!author.trim() || !rationale.trim()) {
      toast({ title: "Author and rationale are required", variant: "destructive" });
      return;
    }
    const payload = {
      intentKey,
      author: author.trim(),
      rationale: rationale.trim(),
      ...(flowClass && { flowClass }),
      ...(toBeHumanMin !== "" && { toBeHumanMin: Number(toBeHumanMin) }),
      ...(actGet !== "" && { actGetActions: Number(actGet) }),
      ...(actPut !== "" && { actPutActions: Number(actPut) }),
    };
    if (!payload.flowClass && payload.toBeHumanMin === undefined && payload.actGetActions === undefined && payload.actPutActions === undefined) {
      toast({ title: "Change at least one flow property", variant: "destructive" });
      return;
    }
    try {
      await createOverride.mutateAsync({ data: payload });
      toast({ title: "Draft proposed", description: "Approve it below to apply it to scenario roll-ups." });
      setRationale(""); setFlowClass(""); setToBeHumanMin(""); setActGet(""); setActPut("");
      refresh();
    } catch (e) {
      toast({ title: "Could not save the proposal", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  return (
    <div className="mt-10">
      <div className="flex items-center gap-2 mb-2">
        <PenLine className="w-5 h-5 text-primary" />
        <h2 className="text-2xl font-bold tracking-tight">SME Flow Adjustments</h2>
        {active && (
          <Badge className="bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/30">
            Active override v{active.version}
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-6 max-w-3xl">
        Subject matter experts can adjust how this intent flows — reassign it to a different flow class, change residual human minutes, or the system actions taken. Every change is a new version; only approved versions affect scenario roll-ups, and the reference flow is never modified.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Propose a change</CardTitle>
            <CardDescription>Creates a draft version for review</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Your name</Label>
                <Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="e.g. Maria (Payroll SME)" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Flow class (current: {currentFlowClass})</Label>
                <Select value={flowClass} onValueChange={setFlowClass}>
                  <SelectTrigger><SelectValue placeholder="Keep current" /></SelectTrigger>
                  <SelectContent>
                    {flowClasses.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">To-be human (min)</Label>
                <Input type="number" value={toBeHumanMin} onChange={(e) => setToBeHumanMin(e.target.value)} placeholder="keep" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">GET actions</Label>
                <Input type="number" value={actGet} onChange={(e) => setActGet(e.target.value)} placeholder="keep" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">PUT actions</Label>
                <Input type="number" value={actPut} onChange={(e) => setActPut(e.target.value)} placeholder="keep" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Rationale (required)</Label>
              <Textarea value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Why should this flow change?" rows={3} />
            </div>
            <Button onClick={handlePropose} disabled={createOverride.isPending} className="w-full">
              {createOverride.isPending ? "Saving..." : "Propose draft"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Version history</CardTitle>
            <CardDescription>Latest approved version is applied to roll-ups</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : versions.length === 0 ? (
              <p className="text-sm text-muted-foreground italic py-6 text-center">No adjustments proposed yet — this intent uses the reference flow.</p>
            ) : (
              <div className="space-y-3">
                {versions.sort((a, b) => b.version - a.version).map((v) => (
                  <div key={v.id} className={`p-3 rounded-lg border text-sm ${v.status === "approved" ? "border-violet-500/30 bg-violet-500/5" : "border-border bg-muted/30"}`}>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="font-mono text-[10px]">v{v.version}</Badge>
                        <Badge className={v.status === "approved" ? "bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/30" : v.status === "superseded" ? "bg-muted text-muted-foreground border-border" : "bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30"}>
                          {v.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{v.author} · {new Date(v.createdAt).toLocaleDateString()}</span>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        {v.status === "draft" && (
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={approveOverride.isPending}
                            onClick={async () => { try { await approveOverride.mutateAsync({ id: v.id }); toast({ title: `v${v.version} approved`, description: "It now applies to scenario roll-ups; any prior approval was superseded." }); refresh(); } catch { toast({ title: "Approval failed", variant: "destructive" }); } }}>
                            <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Approve
                          </Button>
                        )}
                        {v.status === "approved" && (
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={revokeOverride.isPending}
                            onClick={async () => { try { await revokeOverride.mutateAsync({ id: v.id }); toast({ title: `v${v.version} revoked`, description: "The intent reverts to the reference flow; history is kept." }); refresh(); } catch { toast({ title: "Revoke failed", variant: "destructive" }); } }}>
                            Revoke
                          </Button>
                        )}
                        {v.status === "draft" && (
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" disabled={deleteOverride.isPending}
                            onClick={async () => { try { await deleteOverride.mutateAsync({ id: v.id }); toast({ title: `v${v.version} deleted` }); refresh(); } catch { toast({ title: "Delete failed", variant: "destructive" }); } }}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs font-mono text-foreground/80 mb-1">
                      {v.flowClass && <span>flow → {v.flowClass}</span>}
                      {v.toBeHumanMin != null && <span>human → {v.toBeHumanMin}m</span>}
                      {v.actGetActions != null && <span>GET → {v.actGetActions}</span>}
                      {v.actPutActions != null && <span>PUT → {v.actPutActions}</span>}
                    </div>
                    <p className="text-xs text-muted-foreground">{v.rationale}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
