import test from "node:test";
import assert from "node:assert/strict";
import { formatRateSetReference } from "./pricing-format";

test("formatRateSetReference", async (t) => {
  await t.test("returns empty string when ref is missing", () => {
    assert.equal(formatRateSetReference(undefined), "");
  });

  await t.test("formats valid rate set reference", () => {
    const ref = {
      rateSetId: 3,
      effectiveDate: "2026-08-20",
      rationale: "Update 3",
      createdBy: "system",
      createdAt: "2026-08-20T00:00:00.000Z",
    };
    const formatted = formatRateSetReference(ref);
    // Depending on timezone this might vary slightly in a real browser but in node with en-GB it should be consistent
    assert.ok(formatted.includes("Rate set v3 · effective 20 Aug 2026"));
  });
});
