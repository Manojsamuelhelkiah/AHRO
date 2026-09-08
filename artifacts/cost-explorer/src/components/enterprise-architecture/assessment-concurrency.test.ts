import test from "node:test";
import assert from "node:assert/strict";
import {
  enqueueAssessmentUpdate,
  mergePhaseProgress,
  waitForAssessmentUpdates,
} from "./assessment-concurrency.js";

test("rapid edits to different collection records compose from latest state", async () => {
  let records = [{ id: "a", value: 0 }, { id: "b", value: 0 }];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = enqueueAssessmentUpdate(41, async () => {
    await firstBlocked;
    records = records.map((record) => record.id === "a" ? { ...record, value: 1 } : record);
  });
  const second = enqueueAssessmentUpdate(41, async () => {
    records = records.map((record) => record.id === "b" ? { ...record, value: 2 } : record);
  });

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(records, [{ id: "a", value: 1 }, { id: "b", value: 2 }]);
});

test("saving charter notes preserves a concurrent phase status and completion update", () => {
  const latest = [{
    phase: "preliminary" as const,
    status: "complete" as const,
    completionPercent: 100,
    notes: "old notes",
  }];

  assert.deepEqual(mergePhaseProgress(latest, "preliminary", { notes: "new notes" }), [{
    phase: "preliminary",
    status: "complete",
    completionPercent: 100,
    notes: "new notes",
  }]);
});

test("edit then immediate archive waits for and preserves the edit", async () => {
  const assessment = { version: 1, notes: "old", status: "active" };
  let releaseEdit!: () => void;
  const editBlocked = new Promise<void>((resolve) => { releaseEdit = resolve; });

  void enqueueAssessmentUpdate(42, async () => {
    await editBlocked;
    assessment.notes = "saved";
    assessment.version += 1;
  });
  const archive = (async () => {
    await waitForAssessmentUpdates(42);
    await enqueueAssessmentUpdate(42, async () => {
      assessment.status = "archived";
      assessment.version += 1;
    });
  })();

  releaseEdit();
  await archive;
  assert.deepEqual(assessment, { version: 3, notes: "saved", status: "archived" });
});
