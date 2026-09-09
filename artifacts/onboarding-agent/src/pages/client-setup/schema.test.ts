import assert from "node:assert/strict";
import test from "node:test";
import { clientSetupDataSchema, clientSetupSchema, initialDraft } from "./schema";

test("hybrid and custom client setups require real uploaded file IDs", () => {
  const hybrid = { ...initialDraft, clientName: "Acme", processMode: "hybrid" as const, personas: initialDraft.personas.map((p) => ({ ...p, name: "Owner", email: "owner@example.com" })), systems: initialDraft.systems.map((s) => ({ ...s, name: "System", vendor: "Vendor" })) };
  assert.equal(clientSetupSchema.safeParse(hybrid).success, false);
  const processFiles = [{
    id: 42,
    scenarioId: null,
    originalName: "process.json",
    contentType: "application/json",
    sizeBytes: 24,
    createdAt: new Date(0).toISOString(),
  }];
  assert.equal(clientSetupSchema.safeParse({ ...hybrid, processFiles }).success, true);
  assert.equal(clientSetupSchema.safeParse({ ...hybrid, processMode: "custom", processFiles }).success, true);
});

test("persisted setup data is complete and excludes transient process files", () => {
  const { processFiles: _processFiles, ...setupData } = initialDraft;
  assert.equal(clientSetupDataSchema.safeParse(setupData).success, false);
  const complete = {
    ...setupData,
    clientName: "Acme",
    personas: setupData.personas.map((p) => ({ ...p, name: "Owner", email: "owner@example.com" })),
    systems: setupData.systems.map((s) => ({ ...s, name: "System", vendor: "Vendor" })),
  };
  const parsed = clientSetupDataSchema.parse({ ...complete, processFiles: [{ id: 1 }] });
  assert.equal("processFiles" in parsed, false);
});