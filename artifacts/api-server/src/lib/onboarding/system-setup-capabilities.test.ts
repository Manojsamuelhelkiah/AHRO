import assert from "node:assert/strict";
import test from "node:test";
import {
  canActivateSystemSetup,
  connectorUpdateForSetupSelection,
  selectedWatcherConfigurations,
  SYSTEM_SETUP_CAPABILITIES,
  validateSystemSetup,
} from "./system-setup-capabilities";

const setup = (systems: Array<{ id?: string; key: string; mode: any }>) => ({
  clientName: "Acme",
  sector: "Technology",
  employees: 100,
  countries: 1,
  annualTransactions: 1000,
  companyType: "single-country" as const,
  isolationTier: "pooled" as const,
  landscapeMaturity: "mixed" as const,
  hrHourlyCostUsd: 50,
  hitlHourlyCostUsd: 65,
  processMode: "recommended" as const,
  selectedDomains: ["Hire"],
  personas: [{ role: "Owner", name: "A Person", email: "owner@example.com" }],
  systems: systems.map((system) => ({ ...system, name: "System", vendor: "Vendor", ownerEmail: "" })),
  notes: "",
});

test("email watch is exposed only for the three server-watched systems", () => {
  assert.deepEqual(
    SYSTEM_SETUP_CAPABILITIES.filter((entry) => entry.modes.some(({ mode }) => mode === "email-watch")).map(({ key }) => key),
    ["itsm", "payroll", "bgv"],
  );
});

test("only organization owners and admins may activate tenant-wide system choices", () => {
  assert.equal(canActivateSystemSetup("owner"), true);
  assert.equal(canActivateSystemSetup("admin"), true);
  assert.equal(canActivateSystemSetup("member"), false);
  assert.equal(canActivateSystemSetup(undefined), false);
});

test("unsupported systems and system-mode combinations are rejected", () => {
  assert.throws(() => validateSystemSetup(setup([{ key: "unknown", mode: "manual" }])), /Unsupported/);
  assert.throws(() => validateSystemSetup(setup([{ key: "hris", mode: "email-watch" }])), /does not support/);
  assert.throws(() => validateSystemSetup(setup([{ key: "bgv", mode: "made-up" }])), /does not support/);
});

test("payroll and ticketing allow stable multi-estate identities while other system types remain singular", () => {
  assert.doesNotThrow(() => validateSystemSetup(setup([
    { id: "payroll-us", key: "payroll", mode: "direct-integration" },
    { id: "payroll-de", key: "payroll", mode: "direct-integration" },
    { id: "itsm-emea", key: "itsm", mode: "manual" },
    { id: "itsm-apac", key: "itsm", mode: "manual" },
  ])));
  assert.throws(() => validateSystemSetup(setup([
    { id: "hris-1", key: "hris", mode: "manual" },
    { id: "hris-2", key: "hris", mode: "manual" },
  ])), /selected more than once/);
  assert.throws(() => validateSystemSetup(setup([
    { id: "same-id", key: "payroll", mode: "manual" },
    { id: "same-id", key: "payroll", mode: "manual" },
  ])), /instance ID/);
  assert.throws(() => validateSystemSetup(setup([
    { key: "payroll", mode: "manual" },
    { id: "payroll-de", key: "payroll", mode: "manual" },
  ])), /stable instance ID/);
  assert.throws(() => validateSystemSetup(setup([
    { key: "itsm", mode: "manual" },
    { key: "itsm", mode: "manual" },
  ])), /stable instance ID/);
  assert.doesNotThrow(() => validateSystemSetup(setup([
    { key: "payroll", mode: "manual" },
  ])));
});

test("multi-estate watcher choices cannot disagree over connector-wide tracking", () => {
  assert.throws(() => validateSystemSetup(setup([
    { id: "payroll-us", key: "payroll", mode: "direct-integration" },
    { id: "payroll-de", key: "payroll", mode: "email-watch" },
  ])), /connector-wide tracking mode/);
  assert.throws(() => validateSystemSetup(setup([
    { id: "itsm-us", key: "itsm", mode: "direct-integration" },
    { id: "itsm-de", key: "itsm", mode: "manual" },
  ])), /connector-wide tracking mode/);
});

test("the three watcher selections map direct, email, and manual choices without treating manual as mailbox monitoring", () => {
  const selections = selectedWatcherConfigurations(setup([
    { key: "bgv", mode: "email-watch" },
    { key: "itsm", mode: "direct-integration" },
    { key: "payroll", mode: "email-watch" },
    { key: "hris", mode: "manual" },
  ]));
  assert.deepEqual(selections, [
    { connectorKey: "bgv", system: "bgv", trackingMode: "email", status: "connected" },
    { connectorKey: "itsm", system: "itsm", trackingMode: "api", status: "connected" },
    { connectorKey: "payroll", system: "payroll", trackingMode: "email", status: "connected" },
  ]);
  assert.deepEqual(selectedWatcherConfigurations(setup([{ key: "bgv", mode: "manual" }])), [
    { connectorKey: "bgv", system: "bgv", trackingMode: "api", status: "disconnected" },
  ]);
});

test("matching multi-estate watcher choices produce one connector update", () => {
  const selections = selectedWatcherConfigurations(setup([
    { id: "payroll-us", key: "payroll", mode: "email-watch" },
    { id: "payroll-de", key: "payroll", mode: "email-watch" },
  ]));
  assert.deepEqual(selections, [
    { connectorKey: "payroll", system: "payroll", trackingMode: "email", status: "connected" },
  ]);
});

test("activation preserves trusted provenance when transport is unchanged and deactivates manual monitoring", () => {
  const direct = selectedWatcherConfigurations(setup([{ key: "bgv", mode: "direct-integration" }]))[0]!;
  assert.deepEqual(
    connectorUpdateForSetupSelection(
      { trackingMode: "api", configurationProvenance: "trusted-provider" },
      direct,
    ),
    { trackingMode: "api", status: "connected", configurationProvenance: "trusted-provider" },
  );

  const manual = selectedWatcherConfigurations(setup([{ key: "bgv", mode: "manual" }]))[0]!;
  assert.deepEqual(
    connectorUpdateForSetupSelection(
      { trackingMode: "email", configurationProvenance: "trusted-provider" },
      manual,
    ),
    { trackingMode: "api", status: "disconnected", configurationProvenance: "simulated" },
  );
});