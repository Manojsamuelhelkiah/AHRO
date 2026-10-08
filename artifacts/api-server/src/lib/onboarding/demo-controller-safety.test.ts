import { test } from "node:test";
import assert from "node:assert/strict";
import {
  demoControllerLiveAllowed,
  externalProviderDispatchDenied,
  runWithDemoControllerLive,
  runWithProviderDeny,
} from "./provider-policy";
import { isEligibleHybridDemoSimulation, normalizedDemoWorkCountry } from "./demo-controller";
import { DEMO_ORGANIZATION_ID, onbCases, db } from "@workspace/db";
import { isSyntheticOfflineCase, SYNTHETIC_OFFLINE_MARKER } from "./synthetic-offline";

test("demo live provider scope is exact and does not become an org-wide bypass", () => {
  const context = {
    organizationId: "demo",
    caseId: 42,
    channel: "email" as const,
    recipient: "approved@example.com",
  };
  assert.equal(demoControllerLiveAllowed("demo", 42, "email", "approved@example.com"), false);
  runWithDemoControllerLive(context, () => {
    assert.equal(demoControllerLiveAllowed("demo", 42, "email", "approved@example.com"), true);
    assert.equal(demoControllerLiveAllowed("demo", 42, "email", "other@example.com"), false);
    assert.equal(demoControllerLiveAllowed("demo", 42, "call", "approved@example.com"), false);
    assert.equal(demoControllerLiveAllowed("other", 42, "email", "approved@example.com"), false);
  });
  assert.equal(demoControllerLiveAllowed("demo", 42, "email", "approved@example.com"), false);
});

test("ordinary provider-deny policy remains authoritative inside a demo scope", () => {
  runWithProviderDeny(() => {
    assert.equal(externalProviderDispatchDenied(), true);
    runWithDemoControllerLive({
      organizationId: "demo",
      caseId: 42,
      channel: "email",
      recipient: "approved@example.com",
    }, () => {
      assert.equal(externalProviderDispatchDenied(), true);
    });
  });
});

test("synthetic offline boundary requires durable provenance and the marker", () => {
  assert.equal(isSyntheticOfflineCase({ notes: SYNTHETIC_OFFLINE_MARKER }), false);
  assert.equal(isSyntheticOfflineCase({
    notes: SYNTHETIC_OFFLINE_MARKER,
    syntheticProvenance: "synthetic-reset",
  }), true);
  assert.equal(isSyntheticOfflineCase({ notes: "edited name only" }), false);
});

test("demo lifecycle jurisdiction accepts only explicit country geography", () => {
  assert.equal(normalizedDemoWorkCountry("US"), "US");
  assert.equal(normalizedDemoWorkCountry("United States"), "US");
  assert.equal(normalizedDemoWorkCountry("India"), "IN");
  assert.equal(normalizedDemoWorkCountry("Europe"), null);
  assert.equal(normalizedDemoWorkCountry("HRO Europe GmbH"), null);
  assert.equal(normalizedDemoWorkCountry(""), null);
});

test("hybrid simulation requires an exact durable run and volunteer pin, not just notes", async () => {
  const caseRow = {
    id: 42,
    organizationId: DEMO_ORGANIZATION_ID,
    notes: "[demo-controller-run:test-run]",
    scenarioKey: null,
    candidateEmailAuthorizedAt: new Date(),
    candidateEmailAuthorizedBy: "demo-controller",
    workerEmail: "volunteer@example.com",
  } as typeof onbCases.$inferSelect;
  const run = {
    runId: "test-run", caseId: 42, version: 0, activity: [],
    mode: "hybrid", status: "active",
    selectedVolunteerId: "test-volunteer",
    selectedVolunteer: { id: "test-volunteer", email: "volunteer@example.com" },
  };
  const storedRun = (value: unknown) => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ value: JSON.stringify(value) }] }) }),
    }),
  }) as unknown as Pick<typeof db, "select">;
  const missingRun = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  } as unknown as Pick<typeof db, "select">;
  assert.equal(await isEligibleHybridDemoSimulation(missingRun, caseRow), false);
  assert.equal(await isEligibleHybridDemoSimulation(storedRun(run), {
    ...caseRow, candidateEmailAuthorizedBy: "ordinary-administrator",
  }), false);
  assert.equal(await isEligibleHybridDemoSimulation(storedRun(run), {
    ...caseRow, organizationId: "different-organization",
  }), false);
  assert.equal(await isEligibleHybridDemoSimulation(storedRun(run), {
    ...caseRow, notes: "[demo-controller-run:test-run] [demo-controller-run:second-run]",
  }), false);
  for (const invalid of [
    { ...run, caseId: 43 },
    { ...run, runId: "other-run" },
    { ...run, status: "restarted" },
    { ...run, selectedVolunteerId: "other-volunteer" },
    { ...run, selectedVolunteer: { id: "test-volunteer", email: "other@example.com" } },
    { ...run, selectedVolunteer: { id: "test-volunteer", email: null } },
  ]) {
    assert.equal(await isEligibleHybridDemoSimulation(storedRun(invalid), caseRow), false);
  }
});