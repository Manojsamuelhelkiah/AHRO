import type { EaPhaseProgress } from "@workspace/api-client-react";

const assessmentUpdateQueues = new Map<number, Promise<void>>();

export function enqueueAssessmentUpdate(
  assessmentId: number,
  task: () => Promise<void>,
): Promise<void> {
  const previous = assessmentUpdateQueues.get(assessmentId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  assessmentUpdateQueues.set(assessmentId, next);
  void next
    .finally(() => {
      if (assessmentUpdateQueues.get(assessmentId) === next) {
        assessmentUpdateQueues.delete(assessmentId);
      }
    })
    .catch(() => undefined);
  return next;
}

export async function waitForAssessmentUpdates(assessmentId: number): Promise<void> {
  await assessmentUpdateQueues.get(assessmentId)?.catch(() => undefined);
}

export function mergePhaseProgress(
  current: EaPhaseProgress[],
  phase: EaPhaseProgress["phase"],
  changes: Partial<Pick<EaPhaseProgress, "status" | "completionPercent" | "notes">>,
): EaPhaseProgress[] {
  return current.map((item) => item.phase === phase ? { ...item, ...changes } : item);
}
