import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type EaAssessment,
  type EaPhase,
  type EaPhaseProgress,
  EaPhaseProgressStatus,
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
import { enqueueAssessmentUpdate } from "./utils";

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

  const save = async (makeCurrent = false) => {
    if (assessment.status === 'archived') {
      toast({ title: "Archived", description: "Cannot modify archived assessments.", variant: "destructive" });
      return;
    }
    const dirty = new Set(dirtyFields);
    const savedRevisions = { ...dirtyRevisions.current };
    const dirtyValues: Partial<Pick<EaPhaseProgress, DirtyPhaseField>> = {};
    if (dirty.has("status")) dirtyValues.status = draft.status;
    if (dirty.has("completionPercent")) dirtyValues.completionPercent = draft.completionPercent;
    if (dirty.has("notes")) dirtyValues.notes = draft.notes;

    await enqueueAssessmentUpdate(assessment.id, async () => {
      const queryKey = getGetEaAssessmentQueryKey(assessment.id);
      const cachedAssessment = queryClient.getQueryData<EaAssessment>(queryKey) || assessment;
       const transformProgress = (current: EaPhaseProgress[]) => current.map((item) =>
        item.phase === phase
           ? { ...item, ...dirtyValues }
          : item,
      );
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
          toast({ title: "Conflict", description: "Modified elsewhere. Reloading...", variant: "destructive" });
          await queryClient.invalidateQueries({ queryKey });
        } else {
          toast({ title: "Error", description: "Failed to save phase.", variant: "destructive" });
        }
        throw error;
      }
    });
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
          {assessment.currentPhase !== phase && (
            <Button
              variant="outline"
              onClick={() => void save(true)}
              disabled={isReadOnly || updateAssessment.isPending}
              data-testid={`button-make-current-${phase}`}
            >
              <Flag className="mr-2 h-4 w-4" />
              Make current
            </Button>
          )}
          <Button
            onClick={() => void save(false)}
            disabled={isReadOnly || updateAssessment.isPending}
            data-testid={`button-save-${phase}`}
          >
            <Save className="mr-2 h-4 w-4" />
            {updateAssessment.isPending ? "Saving…" : "Save phase"}
          </Button>
        </div>
      </div>

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