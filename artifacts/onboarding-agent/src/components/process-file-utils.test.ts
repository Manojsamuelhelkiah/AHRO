import assert from "node:assert/strict";
import test from "node:test";
import type { ScenarioFile } from "@workspace/api-client-react";
import {
  applyProcessFileMutation,
  processFileContentType,
} from "./process-file-utils";

const file = (id: number, name = `file-${id}.json`): ScenarioFile => ({
  id,
  scenarioId: null,
  originalName: name,
  contentType: "application/json",
  sizeBytes: 12,
  createdAt: new Date(0).toISOString(),
});

test("supported extensions receive a canonical MIME when browsers omit or vary File.type", () => {
  assert.equal(processFileContentType("flow.bpmn"), "application/xml");
  assert.equal(processFileContentType("notes.MD"), "text/markdown");
  assert.equal(processFileContentType("payroll.csv"), "text/csv");
  assert.equal(processFileContentType("program.exe"), null);
});

test("file completions apply to current state instead of restoring removed entries", () => {
  const afterRemove = applyProcessFileMutation([file(1)], { kind: "remove", id: 1 });
  const afterUpload = applyProcessFileMutation(afterRemove, { kind: "add", file: file(2) });
  assert.deepEqual(afterUpload.map(({ id }) => id), [2]);

  const afterMissingReplace = applyProcessFileMutation(afterRemove, {
    kind: "replace",
    id: 1,
    file: file(3),
  });
  assert.deepEqual(afterMissingReplace, []);
});