import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { applyStintFilter, executePlan, type StintFilter, type StintRow } from "./records-agent";

const stint = (over: Partial<StintRow>): StintRow => ({
  id: 1,
  workerEmail: "x@example.com",
  workerName: "X",
  role: "Analyst",
  department: "Consulting",
  startDate: "2019-06-03",
  endDate: "2024-02-29",
  exitReason: "Resignation",
  noticeRequiredDays: 90,
  noticeServedDays: 90,
  performanceRating: "4.0",
  rehireEligible: true,
  notes: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

describe("LDM records agent — deterministic plan execution", () => {
  const stints = [
    stint({ id: 1, startDate: "2016-04-11", endDate: "2018-10-31", noticeRequiredDays: 60, noticeServedDays: 60, performanceRating: "3.8" }),
    stint({ id: 2, startDate: "2019-06-03", endDate: "2024-02-29", noticeRequiredDays: 90, noticeServedDays: 62, performanceRating: "4.3" }),
  ];

  test("notice served in full: reports the shortfall stint with exact days", () => {
    const out = executePlan({ metric: "notice_served_in_full_all_stints" }, stints);
    assert.match(out, /^No — shortfall in 1 of 2 stints/);
    assert.match(out, /62\/90 days/);
  });

  test("notice fully served across all stints answers yes", () => {
    const out = executePlan({ metric: "notice_served_in_full_all_stints" }, [stints[0]]);
    assert.match(out, /^Yes — full notice served in all 1 stints/);
  });

  test("average performance rating is computed from the rows", () => {
    const out = executePlan({ metric: "avg_performance_rating" }, stints);
    assert.match(out, /4\.05\/5 across 2 of 2 stints/);
  });

  test("rehire eligibility flags the ineligible exit", () => {
    const rows = [stints[0], stint({ id: 3, rehireEligible: false })];
    const out = executePlan({ metric: "rehire_eligible_all_exits" }, rows);
    assert.match(out, /^No — not rehire-eligible after/);
  });

  test("total tenure sums both stints in months", () => {
    const out = executePlan({ metric: "total_tenure_months" }, stints);
    const m = out.match(/≈ (\d+) months/);
    assert.ok(m, out);
    const total = Number(m![1]);
    assert.ok(total > 80 && total < 100, `expected ~87 months, got ${total}`);
  });

  test("list_stints includes every decision-relevant field", () => {
    const out = executePlan({ metric: "list_stints" }, stints);
    for (const needle of ["exit:", "notice 62/90d", "rating 4.3/5", "rehire-eligible: yes"]) {
      assert.ok(out.includes(needle), `missing "${needle}" in: ${out}`);
    }
  });
});

describe("LDM records agent — stint filter", () => {
  const stints = [
    stint({ id: 1, startDate: "2016-04-11", endDate: "2018-10-31", noticeRequiredDays: 60, noticeServedDays: 60, performanceRating: "3.8" }),
    stint({ id: 2, startDate: "2019-06-03", endDate: "2024-02-29", noticeRequiredDays: 90, noticeServedDays: 62, performanceRating: "4.3" }),
  ];

  test("latest scopes the metric to the most recent stint", () => {
    const out = executePlan({ metric: "notice_shortfall_by_stint", filter: { stint: "latest" } }, stints);
    assert.ok(out.includes("62/90"), out);
    assert.ok(!out.includes("60/60"), out);
    assert.ok(out.includes("scoped to the most recent stint"), out);
  });

  test("earliest scopes the metric to the first stint", () => {
    const out = executePlan({ metric: "avg_performance_rating", filter: { stint: "earliest" } }, stints);
    assert.match(out, /3\.80\/5 across 1 of 1 stints/);
    assert.ok(out.includes("scoped to the earliest stint"), out);
  });

  test("yearRange matches the overlapping stint", () => {
    const out = executePlan(
      { metric: "notice_served_in_full_all_stints", filter: { stint: { yearRange: { from: 2019, to: 2024 } } } },
      stints,
    );
    assert.match(out, /^No — shortfall in 1 of 1 stints/);
    assert.ok(out.includes("scoped to the 2019–2024 stint"), out);
  });

  test("open-ended yearRange (from only) works", () => {
    const { stints: filtered, note } = applyStintFilter(stints, { stint: { yearRange: { from: 2019 } } });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].startDate, "2019-06-03");
    assert.ok(note?.includes("from 2019"), String(note));
  });

  test("non-matching yearRange falls back to all stints with a note", () => {
    const out = executePlan(
      { metric: "stint_count", filter: { stint: { yearRange: { from: 2001, to: 2003 } } } },
      stints,
    );
    assert.match(out, /^2 archived stints/);
    assert.ok(out.includes("no stint matched the requested years"), out);
  });

  test("unrecognized filter shapes fall back to all stints with a note", () => {
    const out = executePlan(
      { metric: "stint_count", filter: { stint: "middle" as unknown as StintFilter } },
      stints,
    );
    assert.match(out, /^2 archived stints/);
    assert.ok(out.includes("unrecognized stint filter"), out);
  });

  test("no filter leaves behavior unchanged", () => {
    const out = executePlan({ metric: "stint_count" }, stints);
    assert.equal(out, "2 archived stints.");
  });
});
