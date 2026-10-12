import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, onbHrPolicyImports, onbHrPolicySources, onbHrPolicyVersions,
  onbGovernanceAuthorityAssignments, organizationsTable, organizationMembershipsTable,
} from "@workspace/db";
import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import { uploadPolicyImport, getPolicyImport, authorizePolicyImport } from "./hr-policy-imports";
import { createPolicy, revisePolicy, publishPolicy, answerPolicyQuestion, getPolicyVersion } from "./hr-policy-library";
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
  importId, title: "Fictional leave", sourceReference: "FIXTURE-POLICY", text: "Corrected fictional leave policy.",
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
    { organizationId: otherOrg, clerkUserId: author, role: "owner" },
  ]);
  await db.insert(onbGovernanceAuthorityAssignments).values({
    organizationId: org, authorityRole: "hr-policy-maintain", assigneeUserId: author,
    verifiedByUserId: "fixture-independent-verifier", verificationReference: "fictional-verification",
  });
});
after(async () => {
  const scoped = (table: { organizationId: any }) => inArray(table.organizationId, [org, otherOrg]);
  await db.delete(onbHrPolicyVersions).where(scoped(onbHrPolicyVersions));
  await db.delete(onbHrPolicySources).where(scoped(onbHrPolicySources));
  await db.delete(onbHrPolicyImports).where(scoped(onbHrPolicyImports));
  await db.delete(onbGovernanceAuthorityAssignments).where(scoped(onbGovernanceAuthorityAssignments));
  await db.delete(organizationMembershipsTable).where(scoped(organizationMembershipsTable));
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
  await assert.rejects(() => authorizePolicyImport(org, member), /authority/i);
  await assert.rejects(() => authorizePolicyImport(otherOrg, author), /authority/i);
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
test("corrected imported drafts persist provenance, consume once and never become guidance", async () => {
  const preview = await uploadPolicyImport(org, author, file, clean);
  const attempts = await Promise.allSettled([
    createPolicy(org, author, draft(preview.importId)),
    createPolicy(org, author, draft(preview.importId)),
  ]);
  assert.equal(attempts.filter(x => x.status === "fulfilled").length, 1);
  const created = attempts.find(x => x.status === "fulfilled");
  assert.ok(created?.status === "fulfilled");
  const policy = created.value;
  assert.equal(policy.status, "draft");
  assert.equal(policy.importProvenance?.sha256, preview.sha256);
  assert.equal(policy.importProvenance?.authenticity, "not_verified");
  assert.equal((await getPolicyVersion(org, author, policy.policyId, 1)).text, draft(preview.importId).text);
  await assert.rejects(() => publishPolicy(org, author, policy.policyId, { expectedVersion: 1, publicationVerificationReference: "fixture-unreviewed" }), /publish|authority|review/i);
  const answer = await answerPolicyQuestion(org, member, { question: "How much leave?", appliesOn: draft("").effectiveFrom });
  assert.equal(answer.answer, null);
  const revised = await revisePolicy(org, author, policy.policyId, { ...draft(""), importId: undefined, expectedVersion: 1 });
  assert.equal(revised.importProvenance?.importId, preview.importId);
  const newImport = await uploadPolicyImport(org, author, file, clean);
  const replaced = await revisePolicy(org, author, policy.policyId, { ...draft(newImport.importId), expectedVersion: 2 });
  assert.equal(replaced.importProvenance?.importId, newImport.importId);
});
test("expiration and live authority revocation fence draft attachment and late extraction", async () => {
  const expired = await uploadPolicyImport(org, author, file, clean);
  await db.update(onbHrPolicyImports).set({ createdAt: new Date(Date.now() - 2 * 86400000) }).where(eq(onbHrPolicyImports.id, expired.importId));
  await assert.rejects(() => createPolicy(org, author, draft(expired.importId)), /recent/);
  await assert.rejects(() => uploadPolicyImport(org, author, file, {
    ...clean, scan: async () => {
      await db.update(onbGovernanceAuthorityAssignments).set({ revokedAt: new Date() }).where(and(
        eq(onbGovernanceAuthorityAssignments.organizationId, org),
        eq(onbGovernanceAuthorityAssignments.assigneeUserId, author),
      ));
      return "clean";
    },
  }), /authority/i);
});
