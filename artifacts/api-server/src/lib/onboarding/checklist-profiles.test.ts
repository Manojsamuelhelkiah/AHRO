import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, pool } from "@workspace/db";
import {
  onbCases,
  onbChecklistProfiles,
  onbChecklistTemplates,
  organizationsTable,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { ChecklistProfileVersion } from "./checklist-profiles";
import {
  activeReplacementDecision,
  applyChecklistOverrides,
  checklistProfileMatchingAttributes,
  criteriaOverlap,
  establishedChecklistBoundary,
  invalidateEvidenceReadinessForContextChange,
  mergeChecklistReadiness,
  normalizeCriteria,
  profileMatches,
  profilesCouldOverlap,
  resolveChecklistProfileInTransaction,
  resolveFromProfiles,
  validateProfilesAgainstBase,
} from "./checklist-profiles";
import {
  acquireChecklistPolicyLock,
  checklistStageBlockers,
  LEGACY_CHECKLIST,
  readinessFromChecklist,
} from "./settings";

const profile = (
  profileId: string,
  criteria: ChecklistProfileVersion["criteria"],
  priority: number,
  overrides: ChecklistProfileVersion["overrides"] = [],
): ChecklistProfileVersion => ({
  organizationId: "org-a",
  profileId,
  version: 1,
  name: profileId,
  criteria,
  overrides,
  processPolicy: {},
  priority,
  enabled: true,
  createdBy: "owner",
  createdAt: new Date("2026-01-01T00:00:00Z"),
});

const employee = {
  band: "Senior",
  role: "Engineer",
  employmentType: "External FTE",
  location: "New York",
};

describe("targeted checklist profiles", () => {
  test("normalizes criteria and matches each supported dimension independently", () => {
    assert.equal(normalizeCriteria({ band: "  SENIOR " }).band, "senior");
    assert.equal(profileMatches({ band: "senior" }, employee), true);
    assert.equal(profileMatches({ band: "junior" }, employee), false);
    assert.equal(profileMatches({ role: "engineer" }, employee), true);
    assert.equal(profileMatches({ role: "designer" }, employee), false);
    assert.equal(profileMatches({ employmentType: "external fte" }, employee), true);
    assert.equal(profileMatches({ employmentType: "contractor" }, employee), false);
    assert.equal(profileMatches({ location: "new york" }, employee), true);
    assert.equal(profileMatches({ location: "london" }, employee), false);
  });

  test("one context mapper preserves legacy attributes and makes safety-critical tri-state explicit", () => {
    const base = {
      workerBand: "Senior",
      role: "Engineer",
      hireType: "External FTE",
      workerCategory: "employee",
      geography: "New York",
      department: "Engineering",
      legalEntity: "Legacy Co",
    };
    const context = {
      roleFamily: "Operations",
      department: "Field Operations",
      legalEntity: "Operating Co",
      businessUnit: "Delivery",
      industry: "Logistics",
      workCountry: "US",
      workState: "NY",
      site: "Yard A",
      employmentArrangement: "union",
      workerCategory: "frontline",
      payBasis: "hourly",
      shiftPattern: "night",
      workEnvironment: "site" as const,
      hiringMode: "batch" as const,
      safetyCritical: true,
    };
    const enrollment = checklistProfileMatchingAttributes(context, base);
    // Preview and enrollment provide the same two fact shapes to the sole
    // mapper, so they cannot silently diverge on safety policy selection.
    const preview = checklistProfileMatchingAttributes({ ...context }, { ...base });
    assert.deepEqual(preview, enrollment);
    assert.deepEqual(enrollment, {
      band: "Senior", role: "Engineer", employmentType: "External FTE", location: "New York",
      roleFamily: "Operations", department: "Field Operations", legalEntity: "Operating Co",
      businessUnit: "Delivery", industry: "Logistics", workCountry: "US", workState: "NY",
      site: "Yard A", employmentArrangement: "union", workerCategory: "frontline",
      payBasis: "hourly", shiftPattern: "night", workEnvironment: "site", hiringMode: "batch",
      safetyCritical: "true",
    });
    assert.equal(checklistProfileMatchingAttributes({}, base).safetyCritical, null);
    assert.equal(checklistProfileMatchingAttributes({ safetyCritical: false }, base).safetyCritical, "false");
  });

  test("profiles cannot disable or make an immutable safety item optional", () => {
    const base = LEGACY_CHECKLIST.map((item) => item.id === "documentation"
      ? { ...item, nonWaivableSafety: true }
      : { ...item });
    const [protectedItem] = applyChecklistOverrides(base, [{
      id: "documentation", enabled: false, mandatory: false,
    }]).filter((item) => item.id === "documentation");
    assert.equal(protectedItem.nonWaivableSafety, true);
    assert.equal(protectedItem.enabled, true);
    assert.equal(protectedItem.mandatory, true);
  });

  test("profiles preserve migration-review holds for partial and all-item overlays", () => {
    const base = LEGACY_CHECKLIST.map((item) => ({
      ...item,
      ...(item.id === "documentation" ? { migrationReviewHold: true } : {}),
    }));
    const partial = applyChecklistOverrides(base, [{
      id: "documentation", label: "Renamed historical control",
    }]).find((item) => item.id === "documentation");
    const all = applyChecklistOverrides(base, base.map((item) => ({
      id: item.id, enabled: false, mandatory: false, label: `Overlay ${item.id}`,
    }))).find((item) => item.id === "documentation");
    assert.equal(partial?.migrationReviewHold, true);
    assert.equal(all?.migrationReviewHold, true);
  });

  test("combined criteria are ANDed and unmatched employees fall back", () => {
    const combined = profile("combined", { band: "senior", role: "engineer" }, 10);
    const resolved = resolveFromProfiles(
      { version: 7, items: [...LEGACY_CHECKLIST] },
      [combined],
      { ...employee, role: "Designer" },
    );
    assert.equal(resolved.profileId, "default");
    assert.equal(resolved.profileVersion, 7);
    assert.match(resolved.explanation, /default selected/);
  });

  test("highest priority wins deterministically and overlap identifies ambiguous ties", () => {
    const broad = profile("broad", { role: "engineer" }, 5);
    const narrow = profile("narrow", { role: "engineer", band: "senior" }, 20);
    assert.equal(resolveFromProfiles({ version: 1, items: [...LEGACY_CHECKLIST] }, [broad, narrow], employee).profileId, "narrow");
    assert.equal(criteriaOverlap(broad.criteria, narrow.criteria), true);
    assert.equal(criteriaOverlap({ role: "engineer" }, { role: "designer" }), false);
    const tieA = profile("a-profile", { role: "engineer" }, 5);
    const tieZ = profile("z-profile", { role: "engineer" }, 5);
    assert.equal(resolveFromProfiles({ version: 1, items: [...LEGACY_CHECKLIST] }, [tieZ, tieA], employee).profileId, "a-profile");
  });

  test("policy match groups support AND/OR selection and conservatively flag ambiguous OR conflicts", () => {
    const anyLocation = { match: { operator: "any", rules: [{ field: "location", values: ["new york", "london"] }] } };
    const allLocationAndBand = { match: { operator: "all", rules: [{ field: "location", values: ["new york"] }, { field: "band", values: ["senior"] }] } };
    assert.equal(profileMatches({ role: "engineer" }, employee, anyLocation), true);
    assert.equal(profileMatches({ role: "engineer" }, { ...employee, location: "Paris" }, anyLocation), false);
    assert.equal(profileMatches({ role: "engineer" }, employee, allLocationAndBand), true);
    assert.equal(profilesCouldOverlap({ role: "engineer" }, anyLocation, { role: "engineer" }, allLocationAndBand), true);
    assert.equal(profilesCouldOverlap({ role: "engineer" }, { match: { operator: "all", rules: [{ field: "location", values: ["Paris"] }] } }, { role: "engineer" }, allLocationAndBand), false);
  });

  test("disabled profiles never match, and pure resolution can enforce tenant separation", () => {
    const disabled = { ...profile("disabled", { role: "engineer" }, 100), enabled: false };
    const otherOrg = { ...profile("other-org", { role: "engineer" }, 100), organizationId: "org-b" };
    assert.equal(resolveFromProfiles({ version: 1, items: [...LEGACY_CHECKLIST] }, [disabled], employee).profileId, "default");
    assert.equal(resolveFromProfiles({ version: 1, items: [...LEGACY_CHECKLIST] }, [otherOrg], employee, "org-a").profileId, "default");
    assert.equal(resolveFromProfiles({ version: 1, items: [...LEGACY_CHECKLIST] }, [otherOrg], employee, "org-b").profileId, "other-org");
  });

  test("inheritance can add, change, disable and strengthen items and stages", () => {
    const effective = applyChecklistOverrides(LEGACY_CHECKLIST, [
      { id: "profile", label: "Enhanced profile", enforcementStage: "before-workstreams" },
      {
        id: "security-training",
        label: "Security training",
        order: 7,
        enabled: true,
        mandatory: true,
        enforcementStage: "before-employee-communications",
      },
    ]);
    assert.equal(effective.find((item) => item.id === "profile")?.label, "Enhanced profile");
    assert.throws(
      () => applyChecklistOverrides(LEGACY_CHECKLIST, [{ id: "documentation", enabled: false }]),
      /cannot be disabled or weakened/i,
    );
    assert.equal(effective.find((item) => item.id === "security-training")?.mandatory, true);
    const baseBefore = structuredClone(LEGACY_CHECKLIST);
    const profileBefore = profile("immutable", { role: "engineer" }, 1, [{ id: "profile", label: "Changed" }]);
    resolveFromProfiles({ version: 1, items: [...LEGACY_CHECKLIST] }, [profileBefore], employee);
    assert.deepEqual(LEGACY_CHECKLIST, baseBefore);
    assert.deepEqual(profileBefore.overrides, [{ id: "profile", label: "Changed" }]);
    const original = [...LEGACY_CHECKLIST];
    const overrides = [{ id: "profile", label: "Changed" }];
    applyChecklistOverrides(original, overrides);
    assert.equal(original[0].label, LEGACY_CHECKLIST[0].label);
    assert.equal(overrides[0].label, "Changed");
    assert.doesNotThrow(() => validateProfilesAgainstBase({ items: LEGACY_CHECKLIST }, [profile("valid", {}, 1)]));
    assert.throws(
      () => validateProfilesAgainstBase({ items: LEGACY_CHECKLIST.slice(1) }, [profile("invalid", { role: "engineer" }, 1, [{ id: "profile", enabled: true }])]),
      /profile "invalid".*invalid/i,
    );
  });

  test("legacy published overrides remain resolvable while v2 rejects weakening", () => {
    const weakening = [{ id: "documentation", enabled: false }];
    const legacy = { ...profile("legacy", { role: "engineer" }, 1, weakening), processPolicy: {} };
    assert.equal(resolveFromProfiles({ version: 1, items: [...LEGACY_CHECKLIST] }, [legacy], employee).items
      .find((item) => item.id === "documentation")?.enabled, false);
    assert.throws(() => applyChecklistOverrides(LEGACY_CHECKLIST, weakening, true), /cannot be disabled/i);
  });

  test("context correction invalidates all evidence gates even with unchanged definitions", () => {
    const items = applyChecklistOverrides(LEGACY_CHECKLIST, [{
      id: "site-clearance", label: "Site clearance", order: 7, enabled: true, mandatory: true,
      evidenceRequired: true, enforcementStage: "before-workstreams",
    }]);
    const changed = invalidateEvidenceReadinessForContextChange(items, [
      { key: "site-clearance", label: "Site clearance", status: "ready" },
      { key: "profile", label: "Profile", status: "ready" },
    ]);
    assert.equal(changed.find((item) => item.key === "site-clearance")?.status, "pending");
    assert.equal(changed.find((item) => item.key === "profile")?.status, "ready");
  });

  test("profile publication rejects deadlocking prerequisite graphs and accepts ordered independent gates", () => {
    const gates = [
      { id: "safety-proof", label: "Safety", order: 7, enabled: true, mandatory: true, evidenceRequired: true, enforcementStage: "before-workstreams" as const },
      { id: "medical-proof", label: "Medical", order: 8, enabled: true, mandatory: true, evidenceRequired: true, enforcementStage: "before-workstreams" as const, prerequisites: ["safety-proof"] },
    ];
    assert.doesNotThrow(() => applyChecklistOverrides(LEGACY_CHECKLIST, gates));
    assert.throws(() => applyChecklistOverrides(LEGACY_CHECKLIST, [{ ...gates[0], prerequisites: ["missing"] }]), /unknown prerequisite/i);
    assert.throws(() => applyChecklistOverrides(LEGACY_CHECKLIST, [{ ...gates[0], prerequisites: ["safety-proof"] }]), /depend on itself/i);
    assert.throws(() => applyChecklistOverrides(LEGACY_CHECKLIST, [{ ...gates[0], prerequisites: ["medical-proof"] }, gates[1]]), /must be earlier/i);
    assert.throws(() => applyChecklistOverrides(LEGACY_CHECKLIST, [
      { ...gates[0], enforcementStage: "before-day1-review" },
      gates[1],
    ]), /cannot be enforced later/i);
  });

  test("strict profiles cannot weaken any hard-gate dimension", () => {
    const hard = [{
      id: "hard-gate", label: "Hard gate", order: 1, enabled: true, mandatory: true,
      evidenceRequired: true, enforcementStage: "before-workstreams" as const,
      completionAuthority: "designated-human" as const, responsibleRole: "hse",
      executor: "human-task" as const, prerequisites: ["prior"],
    }, {
      id: "prior", label: "Prior", order: 0, enabled: true, mandatory: false,
      enforcementStage: "before-workstreams" as const,
    }];
    assert.throws(() => applyChecklistOverrides(hard, [{ id: "hard-gate", enforcementStage: "before-day1-review" }]), /later stage/i);
    assert.throws(() => applyChecklistOverrides(hard, [{ id: "hard-gate", evidenceRequired: false }]), /required evidence/i);
    assert.throws(() => applyChecklistOverrides(hard, [{ id: "hard-gate", completionAuthority: "hr-admin" }]), /completion authority/i);
    assert.throws(() => applyChecklistOverrides(hard, [{ id: "hard-gate", responsibleRole: "payroll-operations" }]), /responsible role/i);
    assert.throws(() => applyChecklistOverrides(hard, [{ id: "hard-gate", executor: "existing-workflow" }]), /executor/i);
    assert.throws(() => applyChecklistOverrides(hard, [{ id: "hard-gate", prerequisites: [] }]), /remove a prerequisite/i);
    assert.doesNotThrow(() => applyChecklistOverrides(hard, [{ id: "hard-gate", evidenceRequired: false }], false));
  });

  test("stage gates continue to enforce the selected snapshot, not a changed profile", () => {
    const snapshot = applyChecklistOverrides(LEGACY_CHECKLIST, [{
      id: "manual-security-review",
      label: "Manual security review",
      order: 7,
      enabled: true,
      mandatory: true,
      enforcementStage: "before-workstreams",
    }]);
    const readiness = readinessFromChecklist(snapshot);
    const readinessForReplacement = structuredClone(readiness);
    readinessForReplacement[0].status = "ready";
    const laterProfile = applyChecklistOverrides(LEGACY_CHECKLIST, []);
    const merged = mergeChecklistReadiness([...laterProfile.filter((item) => item.id !== "documentation"), {
      id: "new-item", label: "New", order: 7, enabled: true, mandatory: true,
      enforcementStage: "before-day1-review" as const,
    }], readinessForReplacement);
    assert.equal(merged.find((item) => item.key === "profile")?.status, "ready");
    assert.equal(merged.find((item) => item.key === "new-item")?.status, "pending");
    assert.equal(merged.some((item) => item.key === "documentation"), false);
    assert.equal(checklistStageBlockers({ checklistSnapshot: snapshot, readiness }, "before-employee-communications").length, 1);
    assert.equal(snapshot[0].mandatory, true);
    assert.equal(readiness[0].status, "pending");
  });

  test("active replacement never silently introduces a requirement behind orchestration", () => {
    const snapshot = applyChecklistOverrides(LEGACY_CHECKLIST, [{
      id: "manual-security-review",
      label: "Manual security review",
      order: 7,
      enabled: true,
      mandatory: true,
      enforcementStage: "before-workstreams",
    }]);
    const readiness = readinessFromChecklist(snapshot);
    assert.deepEqual(
      activeReplacementDecision(
        { lifecycleStage: "preboarding", orchestrationCheckpoint: "blocked:before-workstreams" },
        snapshot,
        readiness,
      ),
      { ok: true, forceReReview: false },
    );
    const lateReplacement = activeReplacementDecision(
      { lifecycleStage: "preboarding", orchestrationCheckpoint: "workstreams-complete" },
      snapshot,
      readiness,
    );
    assert.equal(lateReplacement.ok, false);
    if (!lateReplacement.ok) assert.match(lateReplacement.reason, /already passed/i);
    assert.equal(
      activeReplacementDecision(
        { lifecycleStage: "day1-review", orchestrationCheckpoint: "review-complete" },
        snapshot,
        readiness,
      ).ok,
      false,
    );
  });

  test("execution boundaries are monotonic even when a replacement has no tasks", () => {
    assert.equal(
      establishedChecklistBoundary({ lifecycleStage: "preboarding", orchestrationCheckpoint: "workstreams-complete" }),
      1,
    );
    const postWorkstreams = activeReplacementDecision(
      { lifecycleStage: "preboarding", orchestrationCheckpoint: "workstreams-complete" },
      [],
      [],
    );
    assert.equal(postWorkstreams.ok, false);
    if (!postWorkstreams.ok) assert.match(postWorkstreams.reason, /execution boundary/i);
    const completedLegacy = activeReplacementDecision(
      { lifecycleStage: "complete", orchestrationCheckpoint: "blocked:before-workstreams" },
      [],
      [],
    );
    assert.equal(completedLegacy.ok, false);
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);

describe("targeted checklist policy concurrency", { skip: !hasDb }, () => {
  test("case creation waits for publication and snapshots one coherent policy", async () => {
    const suffix = randomUUID();
    const organizationId = `checklist-concurrency-${suffix}`;
    const profileId = `profile-${suffix}`;
    const newItem = {
      id: "policy-acknowledgement",
      label: "Policy acknowledgement",
      order: LEGACY_CHECKLIST.length,
      enabled: true,
      mandatory: true,
      enforcementStage: "before-day1-review" as const,
    };
    let releasePublication!: () => void;
    const publicationRelease = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let signalPublicationReady!: () => void;
    let rejectPublicationReady!: (error: unknown) => void;
    const publicationReady = new Promise<void>((resolve, reject) => {
      signalPublicationReady = resolve;
      rejectPublicationReady = reject;
    });
    let publication: Promise<void> | undefined;
    let creation: Promise<typeof onbCases.$inferSelect> | undefined;

    try {
      await db.insert(organizationsTable).values({
        id: organizationId,
        name: "Checklist concurrency test",
        slug: `checklist-concurrency-${suffix}`,
        joinCodeHash: `checklist-concurrency-${suffix}`,
        createdByUserId: "integration-test",
      });
      await db.insert(onbChecklistTemplates).values({
        organizationId,
        version: 1,
        items: [...LEGACY_CHECKLIST],
        createdBy: "integration-test",
      });
      await db.insert(onbChecklistProfiles).values({
        organizationId,
        profileId,
        version: 1,
        name: "Engineers",
        criteria: { role: "engineer" },
        overrides: [],
        priority: 10,
        enabled: true,
        createdBy: "integration-test",
      });

      publication = db.transaction(async (tx) => {
        await acquireChecklistPolicyLock(tx, organizationId);
        await tx.insert(onbChecklistTemplates).values({
          organizationId,
          version: 2,
          items: [...LEGACY_CHECKLIST, newItem],
          createdBy: "integration-test",
        });
        await tx.insert(onbChecklistProfiles).values({
          organizationId,
          profileId,
          version: 2,
          name: "Engineers",
          criteria: { role: "engineer" },
          overrides: [{ id: newItem.id, mandatory: false }],
          priority: 10,
          enabled: true,
          createdBy: "integration-test",
        });
        signalPublicationReady();
        await publicationRelease;
      }).catch((error) => {
        rejectPublicationReady(error);
        throw error;
      });
      await publicationReady;

      creation = db.transaction(async (tx) => {
        const resolved = await resolveChecklistProfileInTransaction(tx, organizationId, employee);
        const [created] = await tx.insert(onbCases).values({
          organizationId,
          workerName: "Concurrent Hire",
          workerEmail: `concurrent-${suffix}@example.com`,
          hireType: employee.employmentType,
          workerCategory: employee.band,
          workerBand: employee.band,
          role: employee.role,
          department: "Engineering",
          geography: employee.location,
          legalEntity: "Integration Test",
          managerName: "Manager",
          recruiterName: "Recruiter",
          joiningDate: "2026-09-30",
          checklistTemplateVersion: resolved.templateVersion,
          checklistSnapshot: resolved.items,
          checklistProfileId: resolved.profileId,
          checklistProfileName: resolved.profileName,
          checklistProfileVersion: resolved.profileVersion,
          checklistMatchedCriteria: resolved.matchedCriteria,
          checklistMatchExplanation: resolved.explanation,
          readiness: readinessFromChecklist(resolved.items),
        }).returning();
        return created;
      });

      let waitingOnPolicyLock = false;
      for (let attempt = 0; attempt < 50 && !waitingOnPolicyLock; attempt += 1) {
        const result = await pool.query<{ waiting: boolean }>(`
          with advisory_key as (
            select hashtext($1)::bigint as value
          )
          select exists (
            select 1
            from pg_locks, advisory_key
            where locktype = 'advisory'
              and granted = false
              and classid::bigint = ((advisory_key.value >> 32) & 4294967295)
              and objid::bigint = (advisory_key.value & 4294967295)
              and objsubid = 1
          ) as waiting
        `, [`checklist-policy:${organizationId}`]);
        waitingOnPolicyLock = result.rows[0]?.waiting === true;
        if (!waitingOnPolicyLock) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        waitingOnPolicyLock,
        true,
        "case creation should wait for the organization checklist policy lock",
      );

      releasePublication();
      await publication;
      const created = await creation;
      assert.equal(created.checklistTemplateVersion, 2);
      assert.equal(created.checklistProfileId, profileId);
      assert.equal(created.checklistProfileVersion, 2);
      assert.equal(
        created.checklistSnapshot.find((item) => item.id === newItem.id)?.mandatory,
        false,
      );
    } finally {
      releasePublication();
      await Promise.allSettled([
        ...(publication ? [publication] : []),
        ...(creation ? [creation] : []),
      ]);
      await db.delete(onbCases).where(eq(onbCases.organizationId, organizationId));
      await db.delete(onbChecklistProfiles).where(eq(onbChecklistProfiles.organizationId, organizationId));
      await db.delete(onbChecklistTemplates).where(eq(onbChecklistTemplates.organizationId, organizationId));
      await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    }
  });
});
