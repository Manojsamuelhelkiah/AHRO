import assert from "node:assert/strict";
import test from "node:test";
import {
  clientSetupDataSchema,
  clientSetupSchema,
  demoDraft,
  initialDraft,
  resolveInitialDraft,
} from "./schema";

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

test("the demo organization opens with a complete synthetic profile that remains editable", () => {
  const freshDemo = resolveInitialDraft(null, true);
  assert.equal(clientSetupSchema.safeParse(freshDemo).success, true);
  assert.deepEqual(freshDemo, demoDraft);
  assert.match(freshDemo.clientName, /Synthetic Demo/);
  assert.ok(freshDemo.personas.every(({ name, email }) => name && email.endsWith("@example.com")));
  assert.ok(freshDemo.systems.every(({ name, vendor, ownerEmail }) => name && vendor && ownerEmail.endsWith("@example.com")));

  const editedDemo = resolveInitialDraft(
    { ...freshDemo, clientName: "Edited Demo Company", employees: 24000 },
    true,
  );
  assert.equal(editedDemo.clientName, "Edited Demo Company");
  assert.equal(editedDemo.employees, 24000);
  assert.equal(clientSetupSchema.safeParse(editedDemo).success, true);
});

test("old incomplete demo drafts are replaced, while normal workspaces stay blank", () => {
  const recoveredDemo = resolveInitialDraft(initialDraft, true);
  assert.equal(recoveredDemo.clientName, demoDraft.clientName);
  assert.equal(clientSetupSchema.safeParse(recoveredDemo).success, true);

  const normalDraft = resolveInitialDraft(null, false);
  assert.equal(normalDraft.clientName, "");
  assert.equal(clientSetupSchema.safeParse(normalDraft).success, false);
});