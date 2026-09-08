import { useRef, useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EaAssessment, useUpdateEaAssessment, getEaAssessment, getGetEaAssessmentQueryKey, getListEaAssessmentsQueryKey } from "@workspace/api-client-react";
import type { EaAssessmentContent, EaAssessmentInput } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
export {
  enqueueAssessmentUpdate,
  waitForAssessmentUpdates,
} from "./assessment-concurrency";
import { enqueueAssessmentUpdate } from "./assessment-concurrency";
import { useEditRecovery } from "./edit-recovery";
import { rebaseEdit } from "./rebase-edit";

function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("status" in error && typeof error.status === "number") return error.status;
  if (
    "response" in error &&
    typeof error.response === "object" &&
    error.response !== null &&
    "status" in error.response &&
    typeof error.response.status === "number"
  ) {
    return error.response.status;
  }
  return undefined;
}

export const EMPTY_ASSESSMENT_CONTENT: EaAssessmentContent = {
  phaseProgress: [
    { phase: "preliminary", status: "not-started", completionPercent: 0, notes: "" },
    { phase: "architecture-vision", status: "not-started", completionPercent: 0, notes: "" },
    { phase: "business", status: "not-started", completionPercent: 0, notes: "" },
    { phase: "data", status: "not-started", completionPercent: 0, notes: "" },
    { phase: "application", status: "not-started", completionPercent: 0, notes: "" },
    { phase: "technology", status: "not-started", completionPercent: 0, notes: "" },
    { phase: "opportunities-solutions", status: "not-started", completionPercent: 0, notes: "" },
    { phase: "migration-planning", status: "not-started", completionPercent: 0, notes: "" },
    { phase: "implementation-governance", status: "not-started", completionPercent: 0, notes: "" },
    { phase: "architecture-change-management", status: "not-started", completionPercent: 0, notes: "" },
  ],
  requirements: [],
  currentState: {
    business: [],
    data: [],
    application: [],
    technology: [],
    integration: [],
    ai: [],
    security: [],
    operatingModel: [],
  },
  gaps: [],
  targetArchitecture: {
    components: [],
    relationships: [],
  },
  opportunities: {
    solutionOptions: [],
    transitionArchitectures: [],
  },
  roadmap: {
    workPackages: [],
    waves: [],
    dependencies: [],
    prioritization: [],
  },
  governance: {
    contracts: [],
    reviews: [],
    deviations: [],
    waivers: [],
    remediation: [],
  },
  changeManagement: {
    requests: [],
    versionHistory: [],
  },
  decisions: [],
  risks: [],
  costLinks: [],
};

export const createEmptyAssessment = (name: string, clientName: string): EaAssessmentInput => ({
  name,
  clientName,
  currentPhase: "preliminary",
  content: EMPTY_ASSESSMENT_CONTENT,
});

type AssessmentUpdate<T> = T | ((current: T) => T);

/**
 * Persists a subfield using the value that is in the cache when its queued turn
 * arrives.  Callers should pass a transform for mutable collections so edits
 * made while another request is in flight compose rather than overwrite.
 */
export function useAssessmentUpdater<T>(
  assessment: EaAssessment,
  field: keyof EaAssessment["content"] | "currentPhase",
  subfield?: string,
  onResolved?: (latest: T) => void,
) {
  const queryClient = useQueryClient();
  // An interrupted response may already have committed. Recovery, not the
  // mutation library, must decide when to write again.
  const updateMutation = useUpdateEaAssessment({ mutation: { retry: false } });
  const mutateAsyncRef = useRef(updateMutation.mutateAsync);
  mutateAsyncRef.current = updateMutation.mutateAsync;
  const { toast } = useToast();
  const recovery = useEditRecovery();
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;
  const fieldKey = [field, subfield].filter(Boolean).join(".");
  const resolution = recovery.resolvedFields[fieldKey] ?? 0;
  const projectionRef = useRef<{ value: T; pending: number } | null>(null);
  useEffect(() => {
    if (!assessment || !onResolvedRef.current) return;
    const latest = queryClient.getQueryData<EaAssessment>(getGetEaAssessmentQueryKey(assessment.id)) || assessment;
    const value = subfield
      ? (latest.content[field as keyof EaAssessment["content"]] as unknown as Record<string, T>)[subfield]
      : field === "currentPhase" ? latest.currentPhase : latest.content[field];
    onResolvedRef.current(value as T);
  }, [resolution, fieldKey, assessment?.id, queryClient]);

  return useCallback((update: AssessmentUpdate<T>, recoveryId = crypto.randomUUID()) => {
    if (!assessment || assessment.status === 'archived') {
      if (assessment?.status === 'archived') {
        toast({ title: "Archived", description: "Cannot modify archived assessments.", variant: "destructive" });
      }
      return;
    }

    const queryKey = getGetEaAssessmentQueryKey(assessment.id);
    const getValue = (value: EaAssessment): T => (subfield
      ? (value.content[field as keyof EaAssessment["content"]] as unknown as Record<string, T>)[subfield]
      : field === "currentPhase" ? value.currentPhase : value.content[field]) as T;
    // Capture intent before a conflict refresh can remove a pending new record.
    const projectedBase = projectionRef.current?.value
      ?? getValue(queryClient.getQueryData<EaAssessment>(queryKey) || assessment);
    const snapshot = {
      base: structuredClone(projectedBase),
      draft: structuredClone(typeof update === "function" ? (update as (current: T) => T)(projectedBase) : update),
    };
    // A repeated blur with the same value is not a second edit to recover.
    if (JSON.stringify(snapshot.base) === JSON.stringify(snapshot.draft)) return;
    projectionRef.current = { value: snapshot.draft, pending: (projectionRef.current?.pending ?? 0) + 1 };
    const order = recovery.nextOrder();
    let rejected = false;
    const resolveLocal = () => recovery.resolveField(fieldKey);
    const reload = async () => {
      retain(undefined, true, false);
      try {
        const latest = await queryClient.fetchQuery({
          queryKey, queryFn: () => getEaAssessment(assessment.id, { signal: AbortSignal.timeout(15_000) }), staleTime: 0, retry: false,
        });
        retain(latest, false, false);
      } catch {
        retain(undefined, false, true);
      }
    };
    const retain = (latest: EaAssessment | undefined, loading: boolean, loadFailed: boolean) => {
      recovery.retain({
        id: recoveryId,
        order,
        label: [field, subfield].filter(Boolean).join(" / ").replace(/([a-z])([A-Z])/g, "$1 $2"),
        draft: snapshot.draft,
        latest: latest ? getValue(latest) : undefined,
        archived: latest?.status === "archived",
        loading, loadFailed, reload,
        onDiscard: resolveLocal,
        retry: () => execute(true),
      });
    };
    const execute = (isRetry = false) => enqueueAssessmentUpdate(assessment.id, async () => {
      const cachedAssessment = queryClient.getQueryData<EaAssessment>(queryKey) || assessment;
      const content = cachedAssessment.content;
      const currentValue = getValue(cachedAssessment);
      if (cachedAssessment.status === "archived") {
        rejected = true;
        retain(cachedAssessment, false, false);
        toast({ title: "Archived", description: "Your draft cannot be saved to an archived assessment.", variant: "destructive" });
        return;
      }
      if (!isRetry && recovery.hasConflicts()) {
        rejected = true;
        await reload();
        return;
      }
      const newData = rebaseEdit(snapshot.base, snapshot.draft, currentValue) as T;
      const updatedContent = field === "currentPhase"
        ? content
        : subfield
        ? {
            ...content,
            [field]: {
              ...(content[field] as Record<string, unknown>),
              [subfield]: newData,
            },
          }
        : {
            ...content,
            [field]: newData,
          };

      try {
        const data = await mutateAsyncRef.current({
          id: assessment.id,
          data: {
            expectedVersion: cachedAssessment.version,
            ...(field === "currentPhase" ? { currentPhase: newData as EaAssessment["currentPhase"] } : {}),
            content: updatedContent,
          },
        });
        queryClient.setQueryData(queryKey, data);
        void queryClient.invalidateQueries({ queryKey: getListEaAssessmentsQueryKey() });
        if (rejected) resolveLocal();
        recovery.discard(recoveryId);
      } catch (error) {
        // Preserve intent and pause the queue for every failed mutation, including
        // ambiguous network/5xx outcomes. Reload never authorizes another write.
        rejected = true;
        if (getErrorStatus(error) === 409) {
          toast({
            title: "Conflict",
            description: "Your draft is preserved. Compare it with the latest saved value, then retry or discard.",
            variant: "destructive",
          });
        } else {
          toast({
            title: "Save interrupted",
            description: "Your draft is preserved. Reload the latest saved value, then retry or discard.",
            variant: "destructive",
          });
        }
        await reload();
      }
    }).catch(() => undefined);
    void execute().finally(() => {
      if (projectionRef.current && --projectionRef.current.pending === 0) projectionRef.current = null;
    });
  }, [assessment, field, subfield, queryClient, toast, recovery]);
}
