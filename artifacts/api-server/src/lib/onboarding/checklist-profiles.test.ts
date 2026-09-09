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
  criteriaOverlap,
  mergeChecklistReadiness,
  normalizeCriteria,
  profileMatches,
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
      { id: "documentation", enabled: false },
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
    assert.equal(effective.find((item) => item.id === "documentation")?.enabled, false);
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

  test("stage gates continue to enforce the selected snapshot, not a changed profile", () => {
    const snapshot = applyChecklistOverrides(LEGACY_CHECKLIST, [{
      id: "profile",
      enforcementStage: "before-employee-communications",
    }]);
    const readiness = readinessFromChecklist(snapshot);
    const readinessForReplacement = structuredClone(readiness);
    readinessForReplacement[0].status = "ready";
    const laterProfile = applyChecklistOverrides(LEGACY_CHECKLIST, [{ id: "profile", mandatory: false }]);
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
    assert.deepEqual(
      activeReplacementDecision(
        { lifecycleStage: "day1-review", orchestrationCheckpoint: "review-complete" },
        snapshot,
        readiness,
      ),
      { ok: true, forceReReview: true },
    );
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