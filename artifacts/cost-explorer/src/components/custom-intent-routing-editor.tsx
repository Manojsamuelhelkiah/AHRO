import { useEffect, useMemo, useState } from "react";
import {
  getGetCustomIntentQueryKey,
  getGetIntentRegistryQueryKey,
  getListIntentsQueryKey,
  useGetCustomIntent,
  useGetIntentRegistry,
  useUpdateCustomIntent,
} from "@workspace/api-client-react";
import type {
  CustomIntent,
  CustomIntentUpdate,
  IntentExecutorRegistration,
  RegisteredAction,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Plus, RefreshCw, Route, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

type Maturity = "catalogued" | "simulated" | "integrated" | "verified" | "unsupported";
type Risk = "low" | "medium" | "high" | "consequential";
type Parent = { key: string; name: string };
type FormAction = RegisteredAction;

type FormState = {
  expectedUpdatedAt: string;
  parentIntentKey: string;
  exactAliases: string;
  accountableSpecialist: string;
  riskClass: Risk;
  maturity: Maturity;
  completionEvidence: string;
  requiredEvidence: string;
  actions: FormAction[];
};

const MATURITY_LABELS: Record<Maturity, string> = {
  catalogued: "Catalogued — documented, not executable",
  simulated: "Simulated — executable in a safe environment",
  integrated: "Integrated — connected to live systems",
  verified: "Verified — proven in production",
  unsupported: "Unsupported — no approved route",
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toForm(intent: CustomIntent): FormState {
  return {
    expectedUpdatedAt: intent.updatedAt,
    parentIntentKey: intent.parentIntentKey ?? "",
    exactAliases: intent.exactAliases.join("\n"),
    accountableSpecialist: intent.accountableSpecialist,
    riskClass: intent.riskClass,
    maturity: intent.maturity,
    completionEvidence:
      typeof intent.evidenceContract.completionEvidence === "string"
        ? intent.evidenceContract.completionEvidence
        : intent.description,
    requiredEvidence: asStringArray(intent.evidenceContract.required).join("\n"),
    actions: intent.actionSchema.actions,
  };
}

function blankAction(): FormAction {
  return {
    type: "workflow",
    name: "",
    description: "",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["requestId", "subjectId"],
      properties: {
        requestId: { type: "string" },
        subjectId: { type: "string" },
      },
    },
    executorKey: null,
  };
}

function lines(value: string): string[] {
  return [...new Set(value.split(/\n|,/).map((item) => item.trim()).filter(Boolean))];
}

function readiness(form: FormState, ownedExecutors: IntentExecutorRegistration[]): string[] {
  const missing: string[] = [];
  if (!form.parentIntentKey) missing.push("Choose the parent outcome family.");
  if (!form.accountableSpecialist.trim()) missing.push("Choose an accountable specialist.");
  if (!form.completionEvidence.trim()) missing.push("Describe what proves completion.");
  if (lines(form.requiredEvidence).length === 0) missing.push("Add at least one required evidence field.");
  if (form.actions.length === 0) missing.push("Add at least one action.");
  form.actions.forEach((action, index) => {
    if (!action.name.trim() || !action.description.trim()) missing.push(`Complete action ${index + 1}'s name and description.`);
  });
  if (["simulated", "integrated", "verified"].includes(form.maturity)) {
    if (ownedExecutors.length === 0) missing.push("The selected specialist has no registered executors.");
    form.actions.forEach((action, index) => {
      if (!action.executorKey) missing.push(`Choose an approved executor for action ${index + 1}.`);
      const executor = ownedExecutors.find((candidate) => candidate.key === action.executorKey);
      const rank = { simulated: 1, integrated: 2, verified: 3 };
      if (executor && rank[form.maturity as keyof typeof rank] > rank[executor.maximumMaturity]) {
        missing.push(
          `Action ${index + 1}'s executor is proven to ${executor.maximumMaturity}, not ${form.maturity}.`,
        );
      }
    });
  }
  return missing;
}

function routeReadiness(form: FormState, ownedExecutors: IntentExecutorRegistration[]): string[] {
  const missing = readiness(form, ownedExecutors);
  if (!["simulated", "integrated", "verified"].includes(form.maturity)) {
    missing.push("Move routing maturity to Simulated or higher.");
  }
  if (ownedExecutors.length === 0 && form.accountableSpecialist.trim()) {
    missing.push("Choose a specialist who owns a registered executor.");
  }
  form.actions.forEach((action, index) => {
    if (!action.executorKey) missing.push(`Assign an approved executor to action ${index + 1}.`);
  });
  return [...new Set(missing)];
}

function errorMessage(error: unknown): string {
  const candidate = error as { status?: number; data?: { error?: string }; message?: string };
  if (candidate.status === 409) {
    return candidate.data?.error ?? "Someone else changed this outcome. Reload the latest version before saving again.";
  }
  return candidate.data?.error ?? candidate.message ?? "The routing changes could not be saved.";
}

export function CustomIntentRoutingEditor({
  intentKey,
  open,
  onOpenChange,
}: {
  intentKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const intentQuery = useGetCustomIntent(intentKey, {
    query: { enabled: open, queryKey: getGetCustomIntentQueryKey(intentKey) },
  });
  const registryQuery = useGetIntentRegistry({
    query: { enabled: open, queryKey: getGetIntentRegistryQueryKey() },
  });
  const update = useUpdateCustomIntent();
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setForm(null);
      setError(null);
    } else if (intentQuery.data && form === null) {
      setForm(toForm(intentQuery.data));
      setError(null);
    }
  }, [form, open, intentQuery.data]);

  const parents = useMemo(() => {
    return (registryQuery.data?.groupingParents ?? [])
      .map((item) => item as Partial<Parent>)
      .filter((item): item is Parent => typeof item.key === "string" && typeof item.name === "string")
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [registryQuery.data]);

  const owners = useMemo(
    () => [...new Set((registryQuery.data?.executors ?? []).map((executor) => executor.owner))].sort(),
    [registryQuery.data],
  );
  const ownedExecutors = useMemo(
    () => (registryQuery.data?.executors ?? []).filter((executor) => executor.owner === form?.accountableSpecialist),
    [form?.accountableSpecialist, registryQuery.data],
  );
  const saveBlockers = form ? readiness(form, ownedExecutors) : [];
  const routeBlockers = form ? routeReadiness(form, ownedExecutors) : [];
  const executableMaturity = form ? ["simulated", "integrated", "verified"].includes(form.maturity) : false;

  const patchAction = (index: number, patch: Partial<FormAction>) => {
    setForm((current) => current && ({
      ...current,
      actions: current.actions.map((action, actionIndex) => actionIndex === index ? { ...action, ...patch } : action),
    }));
  };

  const reload = async () => {
    const result = await intentQuery.refetch();
    if (result.data) setForm(toForm(result.data));
    setError(null);
  };

  const save = async () => {
    if (!form) return;
    const blockers = readiness(form, ownedExecutors);
    if (blockers.length > 0) {
      setError(`Before this route can be saved: ${blockers.join(" ")}`);
      return;
    }
    const patch: CustomIntentUpdate = {
      expectedUpdatedAt: form.expectedUpdatedAt,
      parentIntentKey: form.parentIntentKey,
      exactAliases: lines(form.exactAliases),
      accountableSpecialist: form.accountableSpecialist,
      riskClass: form.riskClass,
      maturity: form.maturity,
      actionSchema: {
        actions: form.actions.map((action) => ({
          ...action,
          executorKey: form.maturity === "unsupported" ? null : action.executorKey,
        })),
      },
      evidenceContract: {
        completionEvidence: form.completionEvidence.trim(),
        required: lines(form.requiredEvidence),
      },
    };
    try {
      const saved = await update.mutateAsync({ key: intentKey, data: patch });
      queryClient.setQueryData(getGetCustomIntentQueryKey(intentKey), saved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetIntentRegistryQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListIntentsQueryKey() }),
      ]);
      toast({
        title: executableMaturity ? "Specialist route saved" : "Routing definition saved",
        description: executableMaturity
          ? "This outcome now has an approved executable route."
          : "The outcome remains non-executable until its maturity and executors are approved.",
      });
      onOpenChange(false);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Route className="h-5 w-5" /> Configure specialist route</DialogTitle>
        </DialogHeader>
        {intentQuery.isError || registryQuery.isError ? (
          <Alert variant="destructive" className="my-4">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Could not load the routing editor</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{intentQuery.isError ? errorMessage(intentQuery.error) : errorMessage(registryQuery.error)}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void Promise.all([intentQuery.refetch(), registryQuery.refetch()])}>
                <RefreshCw className="mr-1 h-4 w-4" /> Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : !form || intentQuery.isLoading || registryQuery.isLoading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading the latest routing contract…</p>
        ) : (
          <div className="space-y-6 py-2">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Parent outcome family</Label>
                <Select value={form.parentIntentKey} onValueChange={(value) => setForm({ ...form, parentIntentKey: value })}>
                  <SelectTrigger><SelectValue placeholder="Choose the closest outcome family" /></SelectTrigger>
                  <SelectContent>{parents.map((parent) => <SelectItem key={parent.key} value={parent.key}>{parent.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Accountable specialist</Label>
                <Select
                  value={form.accountableSpecialist}
                  onValueChange={(value) => setForm({
                    ...form,
                    accountableSpecialist: value,
                    actions: form.actions.map((action) => ({ ...action, executorKey: null })),
                  })}
                >
                  <SelectTrigger><SelectValue placeholder="Choose the owner" /></SelectTrigger>
                  <SelectContent>{owners.map((owner) => <SelectItem key={owner} value={owner}>{owner}</SelectItem>)}</SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Only specialists with registered executors can own executable routes.</p>
              </div>
              <div className="space-y-1.5">
                <Label>Risk level</Label>
                <Select value={form.riskClass} onValueChange={(value: Risk) => setForm({ ...form, riskClass: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{(["low", "medium", "high", "consequential"] as const).map((risk) => <SelectItem key={risk} value={risk} className="capitalize">{risk}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Routing maturity</Label>
                <Select value={form.maturity} onValueChange={(value: Maturity) => setForm({ ...form, maturity: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{(Object.keys(MATURITY_LABELS) as Maturity[]).map((value) => <SelectItem key={value} value={value}>{MATURITY_LABELS[value]}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Exact aliases</Label>
              <Textarea value={form.exactAliases} onChange={(event) => setForm({ ...form, exactAliases: event.target.value })} rows={3} placeholder="One approved exact label per line" />
              <p className="text-xs text-muted-foreground">Use only labels that mean exactly the same outcome. Broader examples belong in intake guidance, not routing aliases.</p>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Executable actions</Label>
                  <p className="text-xs text-muted-foreground">Define what the specialist route does and which approved executor performs it.</p>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={() => setForm({ ...form, actions: [...form.actions, blankAction()] })}>
                  <Plus className="mr-1 h-4 w-4" /> Add action
                </Button>
              </div>
              {form.actions.map((action, index) => (
                <div key={index} className="space-y-3 rounded-lg border p-4">
                  <div className="flex items-center justify-between"><span className="text-sm font-medium">Action {index + 1}</span>
                    <Button type="button" size="icon" variant="ghost" aria-label={`Remove action ${index + 1}`} onClick={() => setForm({ ...form, actions: form.actions.filter((_, i) => i !== index) })}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1.5"><Label>Name</Label><Input value={action.name} onChange={(event) => patchAction(index, { name: event.target.value })} placeholder="e.g. open-onboarding-case" /></div>
                    <div className="space-y-1.5"><Label>Action type</Label><Input value={action.type} onChange={(event) => patchAction(index, { type: event.target.value })} placeholder="workflow or typed-tool" /></div>
                  </div>
                  <div className="space-y-1.5"><Label>Description</Label><Input value={action.description} onChange={(event) => patchAction(index, { description: event.target.value })} placeholder="What this action changes or produces" /></div>
                  <div className="space-y-1.5">
                    <Label>Approved executor</Label>
                    <Select value={action.executorKey ?? "none"} onValueChange={(value) => patchAction(index, { executorKey: value === "none" ? null : value })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No executor — intake only</SelectItem>
                        {ownedExecutors.map((executor) => <SelectItem key={executor.key} value={executor.key}>{executor.key} · proven to {executor.maximumMaturity}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5"><Label>Completion evidence</Label><Textarea value={form.completionEvidence} onChange={(event) => setForm({ ...form, completionEvidence: event.target.value })} rows={3} placeholder="What proves the requested outcome is complete?" /></div>
              <div className="space-y-1.5"><Label>Required evidence fields</Label><Textarea value={form.requiredEvidence} onChange={(event) => setForm({ ...form, requiredEvidence: event.target.value })} rows={3} placeholder={"One field per line\ne.g. authoritativeSourceState"} /></div>
            </div>

            <Alert variant={routeBlockers.length ? "destructive" : "default"}>
              {routeBlockers.length ? <AlertCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
              <AlertTitle>{routeBlockers.length ? "Not ready to route" : "Ready to route"}</AlertTitle>
              <AlertDescription>
                {routeBlockers.length
                  ? <><p>You can save a non-executable definition, but these items are still needed before requests can run:</p><ul className="mt-1 list-disc pl-5">{routeBlockers.map((item) => <li key={item}>{item}</li>)}</ul></>
                  : "Every action has an executor owned by the accountable specialist at the selected maturity."}
              </AlertDescription>
            </Alert>
            {error && <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertTitle>Could not save</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          {error?.includes("changed") && <Button variant="outline" onClick={reload}><RefreshCw className="mr-1 h-4 w-4" /> Reload latest</Button>}
          <Button onClick={save} disabled={!form || update.isPending || saveBlockers.length > 0}>{update.isPending ? "Saving…" : "Save routing"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}