import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type EaAssessment,
  type EaPhase,
  type EaPhaseProgress,
  EaPhaseProgressStatus,
  getEaAssessment,
  getGetEaAssessmentQueryKey,
  useUpdateEaAssessment,
} from "@workspace/api-client-react";
import { CheckCircle2, Compass, Flag, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { enqueueAssessmentUpdate, mergePhaseProgress } from "./assessment-concurrency";
import { useEditRecovery } from "./edit-recovery";

const phaseGuidance: Record<"preliminary" | "architecture-vision", {
  title: string;
  purpose: string;
  prompts: string[];
}> = {
  preliminary: {
    title: "Preliminary",
    purpose: "Establish the architecture mandate, decision rights, working method, principles, and evidence expectations for this client assessment.",
    prompts: [
      "Confirm sponsors, decision owners, and review cadence.",
      "Record scope boundaries, architecture principles, constraints, and evidence gaps.",
      "Agree how requirements, decisions, waivers, and changes will be governed.",
    ],
  },
  "architecture-vision": {
    title: "Architecture Vision",
    purpose: "Describe the client outcome, scope, stakeholders, constraints, and measurable success criteria that guide the target architecture.",
    prompts: [
      "Summarize the business outcome and affected workforce journeys.",
      "Identify stakeholders, concerns, regulatory constraints, and material assumptions.",
      "Define target-state success measures and secure approval to continue.",
    ],
  },
};

type DirtyPhaseField = "status" | "completionPercent" | "notes";

type PhaseConflict = {
  latest: EaPhaseProgress | null;
  latestCurrentPhase: EaPhase | null;
  makeCurrent: boolean;
  latestIsArchived: boolean;
  refreshFailed: boolean;
};

export function PhaseCharter({
  assessment,
  phase,
  isReadOnly,
}: {
  assessment: EaAssessment;
  phase: "preliminary" | "architecture-vision";
  isReadOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateAssessment = useUpdateEaAssessment();
  const source = assessment.content.phaseProgress.find((item) => item.phase === phase)!;
  const [draft, setDraft] = useState<EaPhaseProgress>(source);
  const [dirtyFields, setDirtyFields] = useState<Set<DirtyPhaseField>>(() => new Set());
  const [conflict, setConflict] = useState<PhaseConflict | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const isSavingRef = useRef(false);
  const { trackUnsaved } = useEditRecovery();
  const hasUnsaved = dirtyFields.size > 0 || conflict !== null || isSaving;
  useEffect(() => {
    const key = `phase:${phase}`;
    trackUnsaved(key, hasUnsaved);
    return () => trackUnsaved(key, false);
  }, [phase, hasUnsaved, trackUnsaved]);
  const dirtyRevisions = useRef<Record<DirtyPhaseField, number>>({
    status: 0,
    completionPercent: 0,
    notes: 0,
  });

  useEffect(() => {
    setDraft((current) => ({
      ...source,
      ...(dirtyFields.has("status") ? { status: current.status } : {}),
      ...(dirtyFields.has("completionPercent") ? { completionPercent: current.completionPercent } : {}),
      ...(dirtyFields.has("notes") ? { notes: current.notes } : {}),
    }));
  }, [source]);

  const guidance = phaseGuidance[phase];
  const markDirty = (field: DirtyPhaseField) => {
    dirtyRevisions.current[field] += 1;
    setDirtyFields((current) => new Set(current).add(field));
  };

  const refreshLatest = async (makeCurrent: boolean) => {
    const queryKey = getGetEaAssessmentQueryKey(assessment.id);
    try {
      const latestAssessment = await queryClient.fetchQuery({
        queryKey,
        queryFn: () => getEaAssessment(assessment.id, { signal: AbortSignal.timeout(15_000) }),
        staleTime: 0,
        retry: false,
      });
      const latestPhase = latestAssessment.content.phaseProgress.find((item) => item.phase === phase);
      if (!latestPhase) throw new Error("The latest assessment does not contain this phase.");
      setConflict({
        latest: latestPhase,
        latestCurrentPhase: latestAssessment.currentPhase,
        makeCurrent,
        latestIsArchived: latestAssessment.status === "archived",
        refreshFailed: false,
      });
      return true;
    } catch {
      setConflict((current) => ({
        latest: null,
        latestCurrentPhase: null,
        makeCurrent: current?.makeCurrent ?? makeCurrent,
        latestIsArchived: false,
        refreshFailed: true,
      }));
      toast({
        title: "Could not reload latest version",
        description: "Your draft is preserved. Reload the latest version before retrying.",
        variant: "destructive",
      });
      return false;
    }
  };

  const save = async (makeCurrent = false, isConflictRetry = false) => {
    if (isSavingRef.current || (conflict && !isConflictRetry)) return;

    const queryKey = getGetEaAssessmentQueryKey(assessment.id);
    const latestCachedAssessment = queryClient.getQueryData<EaAssessment>(queryKey);
    if (assessment.status === "archived" || latestCachedAssessment?.status === "archived") {
      toast({ title: "Archived", description: "Cannot modify archived assessments.", variant: "destructive" });
      return;
    }
    const dirty = new Set(dirtyFields);
    const savedRevisions = { ...dirtyRevisions.current };
    const dirtyValues: Partial<Pick<EaPhaseProgress, DirtyPhaseField>> = {};
    if (dirty.has("status")) dirtyValues.status = draft.status;
    if (dirty.has("completionPercent")) dirtyValues.completionPercent = draft.completionPercent;
    if (dirty.has("notes")) dirtyValues.notes = draft.notes;

    isSavingRef.current = true;
    setIsSaving(true);
    try {
      await enqueueAssessmentUpdate(assessment.id, async () => {
        const cachedAssessment = queryClient.getQueryData<EaAssessment>(queryKey) || assessment;
        if (cachedAssessment.status === "archived") {
          toast({ title: "Archived", description: "Cannot modify archived assessments.", variant: "destructive" });
          return;
        }
        const transformProgress = (current: EaPhaseProgress[]) =>
          mergePhaseProgress(current, phase, dirtyValues);
        try {
          const result = await updateAssessment.mutateAsync({
            id: assessment.id,
            data: {
              expectedVersion: cachedAssessment.version,
              ...(makeCurrent ? { currentPhase: phase as EaPhase } : {}),
              content: {
                ...cachedAssessment.content,
                phaseProgress: transformProgress(cachedAssessment.content.phaseProgress),
              },
            },
          });
          queryClient.setQueryData(queryKey, result);
          setConflict(null);
          setDirtyFields((current) => {
            const next = new Set(current);
            dirty.forEach((field) => {
              if (dirtyRevisions.current[field] === savedRevisions[field]) next.delete(field);
            });
            return next;
          });
          toast({
            title: makeCurrent ? `${guidance.title} is now current` : `${guidance.title} saved`,
            description: "The assessment lifecycle has been updated.",
          });
        } catch (error) {
          const status = typeof error === "object" && error !== null
            ? ("status" in error ? error.status : "response" in error && typeof error.response === "object" && error.response !== null && "status" in error.response ? error.response.status : undefined)
            : undefined;
          if (status === 409) {
            setConflict({
              latest: null,
              latestCurrentPhase: null,
              makeCurrent,
              latestIsArchived: false,
              refreshFailed: false,
            });
            toast({
              title: "Save conflict",
              description: "Your draft is preserved while the latest saved version is reloaded.",
              variant: "destructive",
            });
            await refreshLatest(makeCurrent);
          } else {
            toast({ title: "Error", description: "Failed to save phase.", variant: "destructive" });
          }
        }
      });
    } catch {
      // Errors are reported above; consume queue rejections so event handlers never leak them.
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  };

  const discardConflict = () => {
    const cachedAssessment = queryClient.getQueryData<EaAssessment>(getGetEaAssessmentQueryKey(assessment.id));
    const cachedPhase = cachedAssessment?.content.phaseProgress.find((item) => item.phase === phase);
    if (cachedPhase) {
      setDraft(cachedPhase);
    } else {
      toast({
        title: "Latest version unavailable",
        description: "Could not find a cached phase to restore. Your draft was kept.",
        variant: "destructive",
      });
      return;
    }
    dirtyRevisions.current.status += 1;
    dirtyRevisions.current.completionPercent += 1;
    dirtyRevisions.current.notes += 1;
    setDirtyFields(new Set());
    setConflict(null);
  };

  const reloadLatest = async () => {
    if (isSavingRef.current || !conflict) return;
    isSavingRef.current = true;
    setIsSaving(true);
    try {
      await refreshLatest(conflict.makeCurrent);
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6" data-testid={`phase-charter-${phase}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Compass className="h-5 w-5 text-teal-600" />
            <h2 className="text-2xl font-bold">{guidance.title}</h2>
            {assessment.currentPhase === phase && <Badge data-testid={`status-current-${phase}`}>Current phase</Badge>}
          </div>
          <p className="mt-1 max-w-3xl text-muted-foreground">{guidance.purpose}</p>
        </div>
        <div className="flex flex-wrap gap-2 print:hidden">
          {dirtyFields.size > 0 && !conflict && <Button
            variant="outline"
            disabled={isSaving}
            onClick={() => {
              if (window.confirm("Discard your unsaved phase edits and use the saved values?")) discardConflict();
            }}
          >Discard draft</Button>}
          {assessment.currentPhase !== phase && (
            <Button
              variant="outline"
              onClick={() => void save(true)}
              disabled={isReadOnly || isSaving || conflict !== null}
              data-testid={`button-make-current-${phase}`}
            >
              <Flag className="mr-2 h-4 w-4" />
              Make current
            </Button>
          )}
          <Button
            onClick={() => void save(false)}
            disabled={isReadOnly || isSaving || conflict !== null}
            data-testid={`button-save-${phase}`}
          >
            <Save className="mr-2 h-4 w-4" />
            {isSaving ? "Saving…" : "Save phase"}
          </Button>
        </div>
      </div>

      {dirtyFields.size > 0 && !conflict && <p role="status" className="text-sm text-amber-800">
        Unsaved phase edits. Save or discard before leaving. For privacy, drafts are kept only in this open workspace and cannot be restored after a reload.
      </p>}
      {conflict && (
        <Card className="border-destructive/50" data-testid={`phase-conflict-${phase}`}>
          <CardHeader>
            <CardTitle className="text-base text-destructive">Resolve save conflict</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This phase changed after you opened it. Your draft is preserved. Compare it with the latest saved
              version before retrying or discarding your changes.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              {conflict.latest && [
                { title: "Latest saved", value: conflict.latest },
                { title: "Your draft", value: draft },
              ].map(({ title, value }) => (
                <div key={title} className="space-y-3 rounded-md border p-4">
                  <h3 className="font-semibold">{title}</h3>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <div className="text-muted-foreground">Status</div>
                      <div className="font-medium">{value.status.replace("-", " ")}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Completion</div>
                      <div className="font-medium">{value.completionPercent}%</div>
                    </div>
                  </div>
                  <div className="text-sm">
                    <div className="text-muted-foreground">Notes</div>
                    <div className="mt-1 whitespace-pre-wrap break-words">{value.notes || "No notes"}</div>
                  </div>
                </div>
              ))}
            </div>
            {conflict.refreshFailed && (
              <p className="text-sm font-medium text-destructive">
                Reloading the latest saved version failed. Retry is unavailable until it loads.
              </p>
            )}
            {conflict.makeCurrent && conflict.latest && (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-md border p-4 text-sm">
                  <div className="text-muted-foreground">Latest saved current phase</div>
                  <div className="mt-1 font-medium">{conflict.latestCurrentPhase}</div>
                </div>
                <div className="rounded-md border p-4 text-sm">
                  <div className="text-muted-foreground">Your requested current phase</div>
                  <div className="mt-1 font-medium">{phase}</div>
                </div>
              </div>
            )}
            {conflict.latestIsArchived && (
              <p className="text-sm font-medium text-destructive">
                The latest assessment is archived and cannot be modified.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void save(conflict.makeCurrent, true)}
                disabled={isReadOnly || isSaving || !conflict.latest || conflict.refreshFailed || conflict.latestIsArchived}
                data-testid={`button-retry-conflict-${phase}`}
              >
                {isSaving ? "Retrying…" : "Retry"}
              </Button>
              <Button
                variant="outline"
                onClick={() => void reloadLatest()}
                disabled={isSaving}
                data-testid={`button-reload-conflict-${phase}`}
              >
                {isSaving ? "Reloading…" : "Reload latest"}
              </Button>
              <Button
                variant="outline"
                onClick={discardConflict}
                disabled={isSaving}
                data-testid={`button-discard-conflict-${phase}`}
              >
                Discard
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.4fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Phase charter and working record</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`status-${phase}`}>Status</Label>
                <Select
                  value={draft.status}
                  onValueChange={(status) => {
                    markDirty("status");
                    setDraft((current) => ({
                      ...current,
                      status: status as EaPhaseProgress["status"],
                    }));
                  }}
                  disabled={isReadOnly}
                >
                  <SelectTrigger id={`status-${phase}`} data-testid={`select-charter-status-${phase}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(EaPhaseProgressStatus).map((status) => (
                      <SelectItem key={status} value={status}>
                        {status.replace("-", " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`completion-${phase}`}>Completion</Label>
                <div className="flex items-center gap-3">
                  <Input
                    id={`completion-${phase}`}
                    type="number"
                    min={0}
                    max={100}
                    value={draft.completionPercent}
                    onChange={(event) => {
                      markDirty("completionPercent");
                      setDraft((current) => ({
                        ...current,
                        completionPercent: Math.min(100, Math.max(0, Number(event.target.value))),
                      }));
                    }}
                    disabled={isReadOnly}
                    data-testid={`input-charter-completion-${phase}`}
                    className="w-24"
                  />
                  <Progress value={draft.completionPercent} className="flex-1" />
                  <span className="w-11 text-right text-sm font-medium">{draft.completionPercent}%</span>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`notes-${phase}`}>Scope, outcomes, constraints, evidence, and open questions</Label>
              <Textarea
                id={`notes-${phase}`}
                value={draft.notes ?? ""}
                onChange={(event) => {
                  markDirty("notes");
                  setDraft((current) => ({ ...current, notes: event.target.value }));
                }}
                disabled={isReadOnly}
                data-testid={`textarea-charter-notes-${phase}`}
                className="min-h-56"
                placeholder="Capture the working agreement, decisions still needed, known constraints, evidence reviewed, and the outcomes required to complete this phase."
              />
            </div>
          </CardContent>
        </Card>

        <Card className="border-teal-200 bg-teal-50/60 dark:border-teal-900 dark:bg-teal-950/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-4 w-4 text-teal-600" />
              Completion prompts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm">
              {guidance.prompts.map((prompt) => (
                <li key={prompt} className="flex gap-2">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-teal-600" />
                  <span>{prompt}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}