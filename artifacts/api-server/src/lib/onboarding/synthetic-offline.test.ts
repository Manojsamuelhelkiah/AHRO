import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSyntheticOfflineCase,
  isUatRunIsolatedCase,
} from "./synthetic-offline";

test("clearing mutable notes cannot reactivate a reserved UAT scenario", () => {
  const minimizedUatCase = {
    scenarioKey: "UAT-STD-01",
    notes: null,
  };
  assert.equal(isUatRunIsolatedCase(minimizedUatCase), true);
  assert.equal(isSyntheticOfflineCase(minimizedUatCase), true);
});