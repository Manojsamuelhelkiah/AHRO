import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateReadinessSlaActionTiming,
  calculateReadinessSlaScore,
  defaultReadinessSlaPolicy,
  deriveStreamResult,
  readinessSlaApplicability,
  validateReadinessSlaPolicy,
} from "./readiness-sla";

describe("weighted connected readiness", () => {
  test("uses five product streams and binary weighted scoring", () => {
    const policy = defaultReadinessSlaPolicy();
    assert.deepEqual(policy.streams.map((stream) => stream.key), [
      "documentation",
      "bgv",
      "hris",
      "it-assets",
      "payroll",
    ]);
    assert.equal(policy.streams.reduce((sum, stream) => sum + stream.weight, 0), 100);
    const streams = policy.streams.map((stream) => deriveStreamResult({
      key: stream.key,
      label: stream.label,
      weight: stream.weight,
      applicability: {
        key: stream.key,
        applicable: true,
        reason: "required",
      },
      complete: stream.key === "documentation" || stream.key === "bgv" || stream.key === "it-assets",
      reason: "test",
    }));
    const score = calculateReadinessSlaScore(streams);
    assert.equal(score.score, 65);
    assert.equal(score.band, "red");
    assert.equal(score.passes, false);
  });

  test("shows N/A and reweights the denominator for internal/nonemployee paths", () => {
    const applicability = readinessSlaApplicability({
      hireType: "internal-transfer",
      workerCategory: "contractor",
    });
    assert.equal(applicability.find((item) => item.key === "bgv")?.applicable, false);
    assert.equal(applicability.find((item) => item.key === "payroll")?.applicable, false);
    const policy = defaultReadinessSlaPolicy();
    const streams = policy.streams.map((stream) => deriveStreamResult({
      key: stream.key,
      label: stream.label,
      weight: stream.weight,
      applicability: applicability.find((item) => item.key === stream.key)!,
      complete: stream.key === "documentation" || stream.key === "hris" || stream.key === "it-assets",
      reason: "test",
    }));
    const score = calculateReadinessSlaScore(streams);
    // BGV is N/A for internal transfer and HRIS/payroll are N/A for the
    // non-employee category, so only documentation (20) and IT/assets (20)
    // remain in the normalized denominator.
    assert.equal(score.includedWeight, 40);
    assert.equal(score.score, 100);
    assert.equal(score.band, "green");
    assert.equal(streams.find((stream) => stream.key === "bgv")?.status, "not-applicable");
  });

  test("does not fabricate a payroll deadline without a case cutoff", () => {
    const action = defaultReadinessSlaPolicy().actions.find((item) => item.key === "payroll")!;
    const timing = calculateReadinessSlaActionTiming({
      action,
      joiningDate: "2026-09-18",
      payrollCutoff: null,
    });
    assert.equal(timing.status, "needs-configuration");
    assert.equal(timing.dueAt, null);
  });

  test("preserves the exact payroll cutoff instant across timezone boundaries", () => {
    const action = defaultReadinessSlaPolicy().actions.find((item) => item.key === "payroll")!;
    const cutoff = new Date("2026-09-18T23:30:00-07:00");
    const timing = calculateReadinessSlaActionTiming({
      action,
      joiningDate: "2026-09-19",
      payrollCutoff: cutoff,
    });
    assert.equal(timing.dueAt?.getTime(), cutoff.getTime());
    const offsetTiming = calculateReadinessSlaActionTiming({
      action: { ...action, offsetDays: -1 },
      joiningDate: "2026-09-19",
      payrollCutoff: cutoff,
    });
    assert.equal(offsetTiming.dueAt?.getTime(), cutoff.getTime() - 24 * 3600_000);
  });

  test("calculates an India-local deadline and business-day offsets", () => {
    const action = {
      ...defaultReadinessSlaPolicy().actions[0]!,
      calendar: "businessDays" as const,
      offsetDays: -1,
      holidayDates: ["2026-09-17"],
    };
    const timing = calculateReadinessSlaActionTiming({
      action,
      joiningDate: "2026-09-18",
    });
    // Thursday is a holiday; J-1 business day is Wednesday, 17:00 IST.
    assert.equal(timing.dueAt?.toISOString(), "2026-09-16T11:30:00.000Z");
  });

  test("action-start never falls back to case creation time", () => {
    const action = {
      ...defaultReadinessSlaPolicy().actions[0]!,
      anchor: "action-start" as const,
    };
    const joiningSnapshotMissing = calculateReadinessSlaActionTiming({
      action: defaultReadinessSlaPolicy().actions[0]!,
      joiningDate: null,
    });
    assert.equal(joiningSnapshotMissing.status, "needs-configuration");
    assert.match(joiningSnapshotMissing.reason, /explicitly rebase/);
    const missing = calculateReadinessSlaActionTiming({
      action,
      joiningDate: "2026-09-18",
    });
    assert.equal(missing.status, "needs-configuration");
    assert.match(missing.reason, /initiated timestamp/);
    const started = calculateReadinessSlaActionTiming({
      action,
      joiningDate: "2026-09-18",
      actionStartedAt: new Date("2026-09-15T12:00:00.000Z"),
    });
    assert.notEqual(started.dueAt, null);
  });

  test("rejects malformed policy weights", () => {
    const policy = defaultReadinessSlaPolicy();
    assert.throws(() => validateReadinessSlaPolicy({
      ...policy,
      streams: policy.streams.map((stream) => ({ ...stream, weight: 10 })),
    }), /total 100/);
  });
});