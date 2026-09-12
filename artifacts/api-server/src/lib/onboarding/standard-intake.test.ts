import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  standardIntakeEventFingerprint,
  scheduledPreboardingCanActivate,
  scheduledPreboardingDueAt,
  scheduledPreboardingReviewIsDue,
  validateStandardIntakeRows,
} from "./standard-intake";

const event = {
  sourceEventId: "offer-42",
  eventType: "accepted-offer",
  acceptanceEvidenceReference: "ta://offers/42/acceptance",
  person: {
    personKey: "candidate-42",
    workerName: "Ada Lovelace",
    workerEmail: "ADA@EXAMPLE.TEST",
    hireType: "external-fte",
    workerCategory: "employee",
    role: "Engineer",
    department: "Platform",
    geography: "US",
    legalEntity: "Example Inc",
    managerName: "Manager",
    recruiterName: "Recruiter",
    joiningDate: "2030-01-01",
    workforceContext: { workCountry: "US", hiringMode: "batch" },
  },
};

describe("standard onboarding intake validation", () => {
  test("normalizes an event and detects repeated source event IDs before writes", () => {
    const rows = validateStandardIntakeRows([event, event]);
    assert.equal(rows[0]?.event?.person.workerEmail, "ada@example.test");
    assert.match(rows[0]?.errors.join(" ") ?? "", /duplicated/);
    assert.match(rows[1]?.errors.join(" ") ?? "", /duplicated/);
  });

  test("fences retries on evidence and candidate details", () => {
    const parsed = validateStandardIntakeRows([event])[0]?.event;
    assert.ok(parsed);
    const changed = structuredClone(parsed);
    changed.acceptanceEvidenceReference = "ta://offers/42/revised";
    assert.notEqual(standardIntakeEventFingerprint(parsed), standardIntakeEventFingerprint(changed));
  });

  test("allows scheduled preboarding activation only before its scheduled start date", () => {
    const now = new Date("2030-01-10T12:00:00.000Z");
    assert.equal(scheduledPreboardingCanActivate("scheduled-preboarding", "2030-01-11", now), true);
    assert.equal(scheduledPreboardingCanActivate("scheduled-preboarding", "2030-01-10", now), false);
    assert.equal(scheduledPreboardingCanActivate("accepted-offer", "2030-01-10", now), true);
  });

  test("derives a durable review due point before a scheduled joining date", () => {
    const due = scheduledPreboardingDueAt("2030-01-11");
    assert.equal(due?.toISOString(), "2030-01-10T00:00:00.000Z");
    assert.equal(scheduledPreboardingReviewIsDue("scheduled-preboarding", due, new Date("2030-01-09T23:59:59.999Z")), false);
    assert.equal(scheduledPreboardingReviewIsDue("scheduled-preboarding", due, new Date("2030-01-10T00:00:00.000Z")), true);
  });

  test("rejects special-category and arbitrary workforce fields at intake", () => {
    const sensitive = {
      ...event,
      person: {
        ...event.person,
        workforceContext: {
          workCountry: "US",
          accessibilityNeeds: "wheelchair accommodation",
          arbitraryPayload: "not accepted",
        },
      },
    };
    const row = validateStandardIntakeRows([sensitive])[0]!;
    assert.equal(row.event, undefined);
    assert.match(row.errors.join(" "), /accessibilityNeeds/);
    assert.match(row.errors.join(" "), /arbitraryPayload/);
  });
});