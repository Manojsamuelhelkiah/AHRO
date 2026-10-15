import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, onbHrPolicyImports, onbHrPolicySources, onbHrPolicyVersions, onbSettings,
  accessNamedGrants, organizationsTable, organizationMembershipsTable,
} from "@workspace/db";
import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import { uploadPolicyImport, getPolicyImport, authorizePolicyImport } from "./hr-policy-imports";
import { createPolicy, revisePolicy, publishPolicy, getPolicyVersion } from "./hr-policy-library";
import { getPolicyUploadSettings, savePolicyUploadSettings } from "./hr-policy-upload-settings";
import { policyDocumentFormat, POLICY_IMPORT_MAX_BYTES } from "./hr-policy-document-extraction";

const org = `policy-import-${randomUUID()}`;
const otherOrg = `policy-import-other-${randomUUID()}`;
const author = `maintainer-${randomUUID()}`;
const member = `member-${randomUUID()}`;
const file = { originalname: "Fictional leave.pdf", mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.7\nfixture-only") };
const clean = {
  store: async () => {},
  scan: async () => "clean",
  extract: async () => ({ text: "Fictional employees receive five days of leave.", extractor: "fixture", warnings: ["Fixture extraction"] }),
};
const draft = (importId: string) => ({
  importId, expectedUploadSettingsRevision: 1, title: "Fictional leave", sourceReference: "FIXTURE-POLICY", text: "Fictional employees receive five days of leave.",
  audience: ["owner", "member"], applicability: {}, reviewAuthorityRole: "hr-compliance",
  effectiveFrom: new Date().toISOString().slice(0, 10),
});
before(async () => {
  await db.insert(organizationsTable).values([org, otherOrg].map(id => ({
    id, name: "Isolated importer fixture", slug: id, joinCodeHash: id, createdByUserId: author,
  })));
  await db.insert(organizationMembershipsTable).values([
    { organizationId: org, clerkUserId: author, role: "owner" },
    { organizationId: org, clerkUserId: member, role: "member" },
    { organizationId: otherOrg, clerkUserId: author, role: "member" },
  ]);
  await db.insert(accessNamedGrants).values({
    organizationId: org, principalType: "human", principalId: author, scope: "tenant", resourceType: "tool",
    resourceKey: "tool.policy.manage", source: "named", effect: "allow", status: "active",
    createdByUserId: "fixture-grantor", approvedByUserId: "fixture-independent-grantor", approvedAt: new Date(),
  });
});
after(async () => {
  const scoped = (table: { organizationId: any }) => inArray(table.organizationId, [org, otherOrg]);
  await db.delete(onbHrPolicyVersions).where(scoped(onbHrPolicyVersions));
  await db.delete(onbHrPolicySources).where(scoped(onbHrPolicySources));
  await db.delete(onbHrPolicyImports).where(scoped(onbHrPolicyImports));
  await db.delete(onbSettings).where(scoped(onbSettings));
  await deleteTestOrganizations(inArray(organizationsTable.id, [org, otherOrg]));
});

test("validates actual size, MIME, extension and magic bytes", () => {
  assert.equal(policyDocumentFormat("source.pdf", "application/pdf", file.buffer), "pdf");
  assert.throws(() => policyDocumentFormat("source.exe", "application/pdf", file.buffer));
  assert.throws(() => policyDocumentFormat("source.doc", "application/pdf", file.buffer));
  assert.throws(() => policyDocumentFormat("source.pdf", "application/pdf", Buffer.from("not a pdf")));
  assert.throws(() => policyDocumentFormat("source.pdf", "application/pdf", Buffer.alloc(POLICY_IMPORT_MAX_BYTES + 1)));
});
test("membership alone and another tenant cannot upload or view an import", async () => {
  await assert.rejects(() => authorizePolicyImport(org, member), /permission|authority/i);
  await assert.rejects(() => authorizePolicyImport(otherOrg, author), /permission|authority/i);
  const preview = await uploadPolicyImport(org, author, file, clean);
  await assert.rejects(() => getPolicyImport(org, member, preview.importId));
  await assert.rejects(() => getPolicyImport(otherOrg, author, preview.importId));
  assert.equal(JSON.stringify(preview).includes("/objects/"), false);
});
test("unsafe and unavailable scans never run extraction or attach drafts", async () => {
  for (const verdict of ["infected", "unavailable", "timeout", "indeterminate"]) {
    const preview = await uploadPolicyImport(org, author, file, {
      ...clean, scan: async () => verdict, extract: async () => { throw new Error("Must never extract"); },
    });
    assert.equal(preview.status, "quarantined");
    assert.equal(preview.text, null);
    assert.equal(preview.malwareVerdict, verdict);
    await assert.rejects(() => createPolicy(org, author, draft(preview.importId)), /safely extracted/);
  }
});
test("parser failures stay quarantined even after a clean malware scan", async () => {
  const preview = await uploadPolicyImport(org, author, file, {
    ...clean, extract: async () => { throw new Error("private parser error"); },
  });
  assert.equal(preview.status, "quarantined");
  assert.equal(preview.malwareVerdict, "clean");
  assert.equal(preview.text, null);
});
test("authorized uploads are approved once, attributed to the uploader and safely replace earlier versions", async () => {
  assert.deepEqual(await getPolicyUploadSettings(org, author), { revision: 1, requiresSeparateReview: false });
  const preview = await uploadPolicyImport(org, author, file, clean);
  await assert.rejects(() => createPolicy(org, author, { ...draft(preview.importId), text: "Unrelated substituted source." }), /exact extracted text/);
  assert.equal((await getPolicyImport(org, author, preview.importId)).status, "ready");
  const attempts = await Promise.allSettled([
    createPolicy(org, author, draft(preview.importId)),
    createPolicy(org, author, draft(preview.importId)),
  ]);
  assert.equal(attempts.filter(x => x.status === "fulfilled").length, 1);
  const created = attempts.find(x => x.status === "fulfilled");
  assert.ok(created?.status === "fulfilled");
  const policy = created.value;
  assert.equal(policy.status, "published");
  assert.equal(policy.reviewOutcome, "approved");
  assert.equal(policy.reviewedByUserId, author);
  assert.equal(policy.publisherUserId, author);
  assert.match(policy.publicationVerificationReference!, /^authorized-upload:/);
  assert.equal(policy.importProvenance?.sha256, preview.sha256);
  assert.equal(policy.importProvenance?.authenticity, "not_verified");
  assert.equal((await getPolicyVersion(org, author, policy.policyId, 1)).text, draft(preview.importId).text);
  await assert.rejects(() => publishPolicy(org, author, policy.policyId, { expectedVersion: 1, publicationVerificationReference: "fixture-unreviewed" }), /publish|authority|review/i);
  const revised = await revisePolicy(org, author, policy.policyId, { ...draft(""), importId: undefined, expectedVersion: 1 });
  assert.equal(revised.importProvenance?.importId, preview.importId);
  const newImport = await uploadPolicyImport(org, author, file, clean);
  const replaced = await revisePolicy(org, author, policy.policyId, { ...draft(newImport.importId), expectedVersion: 2 });
  assert.equal(replaced.importProvenance?.importId, newImport.importId);
  assert.equal(replaced.status, "published");
  assert.equal((await getPolicyVersion(org, author, policy.policyId, 1)).policy.status, "superseded");
});
test("client-enabled separate review and configuration revisions are enforced at upload", async () => {
  await assert.rejects(() => savePolicyUploadSettings(org, member, { expectedRevision: 1, requiresSeparateReview: true }));
  const setting = await savePolicyUploadSettings(org, author, { expectedRevision: 1, requiresSeparateReview: true });
  assert.equal(setting.revision, 2);
  assert.equal((await getPolicyUploadSettings(otherOrg, author).catch(() => null)), null);
  await assert.rejects(() => savePolicyUploadSettings(org, author, { expectedRevision: 1, requiresSeparateReview: false }), /changed/);
  const preview = await uploadPolicyImport(org, author, file, clean);
  await assert.rejects(() => createPolicy(org, author, draft(preview.importId)), /settings changed/);
  assert.equal((await getPolicyImport(org, author, preview.importId)).status, "ready");
  const policy = await createPolicy(org, author, { ...draft(preview.importId), expectedUploadSettingsRevision: setting.revision });
  assert.equal(policy.status, "in_review");
  assert.equal(policy.reviewOutcome, null);
  assert.equal(policy.publisherUserId, null);
  await assert.rejects(() => publishPolicy(org, author, policy.policyId, { expectedVersion: 1, publicationVerificationReference: "unreviewed" }), /review/);
});
test("expiration and live authority revocation fence draft attachment and late extraction", async () => {
  const expired = await uploadPolicyImport(org, author, file, clean);
  await db.update(onbHrPolicyImports).set({ createdAt: new Date(Date.now() - 2 * 86400000) }).where(eq(onbHrPolicyImports.id, expired.importId));
  await assert.rejects(() => createPolicy(org, author, draft(expired.importId)), /recent/);
  await assert.rejects(() => uploadPolicyImport(org, author, file, {
    ...clean, scan: async () => {
      await db.update(organizationMembershipsTable).set({ revokedAt: new Date() }).where(and(
        eq(organizationMembershipsTable.organizationId, org),
        eq(organizationMembershipsTable.clerkUserId, author),
      ));
      return "clean";
    },
  }), /permission|membership|authority/i);
});
