import assert from "node:assert/strict";
import test from "node:test";
import {
  clientSetupDataSchema,
  clientSetupSchema,
  demoDraft,
  initialDraft,
  migrateLegacyClientSetupDraft,
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
  const { processFiles: _processFiles, ...setupData } = demoDraft;
  assert.equal(clientSetupDataSchema.safeParse(setupData).success, false);
  const complete = {
    ...demoDraft,
    systems: demoDraft.systems.map((system) => ({ ...system })),
  };
  const parsed = clientSetupDataSchema.parse({
    ...demoDraft,
    systems: demoDraft.systems.map((system) => ({ ...system, needsReview: true })),
  });
  assert.equal("processFiles" in parsed, false);
  const watched = clientSetupDataSchema.parse({
    ...complete,
    systems: complete.systems.map((system) => system.key === "bgv"
      ? { ...system, mode: "email-watch" }
      : system),
  });
  assert.equal(watched.systems.find((system) => system.key === "bgv")?.mode, "email-watch");
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
  const recoveredDemo = resolveInitialDraft({
    ...demoDraft,
    systems: [
      {
        ...demoDraft.systems[0]!,
        key: "",
        mode: "",
      },
    ],
  }, true);
  assert.equal(recoveredDemo.clientName, demoDraft.clientName);
  assert.equal(clientSetupSchema.safeParse(recoveredDemo).success, true);

  const normalDraft = resolveInitialDraft(null, false);
  const complete = {
    ...demoDraft,
    systems: demoDraft.systems.map((system) => ({ ...system })),
  };
  assert.equal(clientSetupSchema.safeParse(complete).success, true);
  assert.equal(clientSetupSchema.safeParse({
    ...complete,
    systems: complete.systems.map((system, index) => index === 0
      ? { ...system, mode: "arbitrary-mode" }
      : system),
  }).success, false);
  assert.equal(clientSetupSchema.safeParse({
    ...complete,
    systems: complete.systems.map((system, index) => index === 1
      ? { ...system, key: complete.systems[0]!.key }
      : system),
  }).success, false);
  assert.equal(clientSetupSchema.safeParse({
    ...complete,
    systems: [
      ...complete.systems,
      { ...complete.systems.find((system) => system.key === "payroll")!, id: "payroll-second", name: "Second payroll" },
    ],
  }).success, true);
  assert.equal(clientSetupSchema.safeParse({
    ...complete,
    systems: [
      ...complete.systems,
      { ...complete.systems.find((system) => system.key === "payroll")!, id: "payroll-second", mode: "email-watch" },
    ],
  }).success, false);
});

test("saved setup reload preserves every instance ID and upgrades legacy rows deterministically", () => {
  const { processFiles: _processFiles, ...setupData } = demoDraft;
  const multiEstate = {
    ...setupData,
    systems: [
      ...setupData.systems,
      { ...setupData.systems.find((system) => system.key === "payroll")!, id: "payroll-emea", name: "EMEA Payroll" },
    ],
  };
  const parsed = clientSetupDataSchema.parse({
    ...demoDraft,
    systems: demoDraft.systems.map((system) => ({ ...system, needsReview: true })),
  });
  assert.deepEqual(parsed.systems.map((system) => system.id), multiEstate.systems.map((system) => system.id));
  const legacy = clientSetupDataSchema.parse({
    ...multiEstate,
    systems: multiEstate.systems.map(({ id: _id, ...system }) => system),
  });
  assert.deepEqual(
    legacy.systems.map((system) => system.id),
    legacy.systems.map((system, index) => `legacy-${system.key}-${index + 1}`),
  );
});

test("resumed browser drafts upgrade ID-less rows before a second estate can be added", () => {
  const legacySystems = demoDraft.systems.map(({ id: _id, ...system }) => system);
  const resumed = resolveInitialDraft({ ...demoDraft, systems: legacySystems } as any, false);
  assert.deepEqual(
    resumed.systems.map((system) => system.id),
    resumed.systems.map((system, index) => `legacy-${system.key}-${index + 1}`),
  );
  assert.equal(clientSetupSchema.safeParse({
    ...resumed,
    systems: [
      ...resumed.systems,
      { ...resumed.systems.find((system) => system.key === "payroll")!, id: "payroll-second" },
    ],
  }).success, true);
});

test('unsupported migrated system choices are marked for review without leaking UI metadata into setup data', () => {
  const migrated = migrateLegacyClientSetupDraft({
    ...demoDraft,
    systems: [
      { domain: 'Learning', name: 'Cornerstone', vendor: 'Cornerstone', mode: 'API', ownerEmail: 'lms@example.com' },
      { domain: 'Compliance', name: 'Policy Hub', vendor: 'Internal', mode: 'Manual', ownerEmail: 'policy@example.com' },
    ],
  });
  assert.ok(migrated);
  assert.equal(migrated.systems?.[0]?.needsReview, true);
  assert.equal(migrated.systems?.[1]?.needsReview, undefined);

  const parsed = clientSetupDataSchema.parse({
    ...demoDraft,
    systems: demoDraft.systems.map((system) => ({ ...system, needsReview: true })),
  });
  assert.equal('needsReview' in parsed.systems[0]!, false);
});
