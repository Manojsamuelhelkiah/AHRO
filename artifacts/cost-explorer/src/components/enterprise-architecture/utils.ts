import { useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EaAssessment, useUpdateEaAssessment, getGetEaAssessmentQueryKey } from "@workspace/api-client-react";
import type { EaAssessmentContent, EaAssessmentInput } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
export {
  enqueueAssessmentUpdate,
  waitForAssessmentUpdates,
} from "./assessment-concurrency";
import { enqueueAssessmentUpdate } from "./assessment-concurrency";

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
) {
  const queryClient = useQueryClient();
  const updateMutation = useUpdateEaAssessment();
  const mutateAsyncRef = useRef(updateMutation.mutateAsync);
  mutateAsyncRef.current = updateMutation.mutateAsync;
  const { toast } = useToast();

  return useCallback((update: AssessmentUpdate<T>) => {
    if (!assessment || assessment.status === 'archived') {
      if (assessment?.status === 'archived') {
        toast({ title: "Archived", description: "Cannot modify archived assessments.", variant: "destructive" });
      }
      return;
    }

    const queryKey = getGetEaAssessmentQueryKey(assessment.id);
    void enqueueAssessmentUpdate(assessment.id, async () => {
      const cachedAssessment = queryClient.getQueryData<EaAssessment>(queryKey) || assessment;
      if (cachedAssessment.status === "archived") return;
      const content = cachedAssessment.content;
      const currentValue = (subfield
        ? (content[field as keyof EaAssessment["content"]] as unknown as Record<string, T>)[subfield]
        : field === "currentPhase"
          ? cachedAssessment.currentPhase
          : content[field]) as T;
      const newData = typeof update === "function"
        ? (update as (current: T) => T)(currentValue)
        : update;
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
      } catch (error) {
        if (getErrorStatus(error) === 409) {
          toast({
            title: "Conflict",
            description: "This assessment changed elsewhere. Your edit was not applied; the latest version is being loaded.",
            variant: "destructive",
          });
          await queryClient.invalidateQueries({ queryKey });
        } else {
          toast({
            title: "Error",
            description: "Failed to save changes.",
            variant: "destructive",
          });
        }
        throw error;
      }
    }).catch(() => undefined);
  }, [assessment, field, subfield, queryClient, toast]);
}
