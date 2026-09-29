import { test } from "node:test";
import assert from "node:assert/strict";
import {
  demoControllerLiveAllowed,
  externalProviderDispatchDenied,
  runWithDemoControllerLive,
  runWithProviderDeny,
} from "./provider-policy";
import { normalizedDemoWorkCountry } from "./demo-controller";
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