import { db } from "@workspace/db";
import { onbCases, onbDocuments } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

/**
 * Document checklist ("documentation pack") — real per-case records for
 * the identity/statutory/contract/policy items every hire must submit.
 * Seeded when a case starts; idempotently backfilled at startup so demo
 * cases created before this feature also get a pack.
 */

type CaseRow = typeof onbCases.$inferSelect;
export type DocumentSeedCase = Pick<
  CaseRow,
  "id" | "organizationId" | "workerCategory" | "geography" | "hireType" | "lifecycleStage"
>;
export type DocumentRow = typeof onbDocuments.$inferSelect;

type PackItem = {
  key: string;
  label: string;
  category: "identity" | "statutory" | "contract" | "policy";
  required: boolean;
};

/** The pack varies by worker category and geography. */
export function documentPackFor(c: Pick<DocumentSeedCase, "workerCategory" | "geography" | "hireType">): PackItem[] {
  const nonEmployee = c.workerCategory === "contractor" || c.workerCategory === "vendor";
  const india = /india/i.test(c.geography);
  const items: PackItem[] = [
    { key: "id-proof", label: "Government photo ID (passport / national ID)", category: "identity", required: true },
    { key: "address-proof", label: "Proof of current address", category: "identity", required: true },
    { key: "education-certs", label: "Highest education certificate", category: "identity", required: !nonEmployee },
    { key: "prior-employment", label: "Relieving / experience letter from previous employer", category: "identity", required: c.hireType === "external" },
    ...(india
      ? [
          { key: "pan-card", label: "PAN card (tax identification)", category: "statutory", required: !nonEmployee } as PackItem,
          { key: "uan-epf", label: "UAN / EPF details for provident fund transfer", category: "statutory", required: !nonEmployee } as PackItem,
        ]
      : [
          { key: "tax-form", label: "Tax withholding form for payroll", category: "statutory", required: !nonEmployee } as PackItem,
        ]),
    { key: "bank-details", label: "Bank account details for salary/fee disbursement", category: "statutory", required: true },
    { key: "work-authorization", label: "Work authorization / right-to-work evidence", category: "statutory", required: true },
    {
      key: nonEmployee ? "signed-sow" : "signed-offer",
      label: nonEmployee ? "Countersigned statement of work" : "Signed offer letter & employment contract",
      category: "contract",
      required: true,
    },
    { key: "nda-coc", label: "Signed NDA & code-of-conduct acknowledgement", category: "policy", required: true },
    { key: "policy-ack", label: "IT & data-protection policy acknowledgement", category: "policy", required: false },
  ];
  return items;
}

/** Seed the pack for one case. Idempotent per (caseId, key). */
export async function seedDocumentsForCase(c: DocumentSeedCase): Promise<void> {
  const pack = documentPackFor(c);
  // Demo realism for already-progressed cases: earlier-stage docs arrive
  // first. Deterministic per case+key (no randomness) so restarts agree.
  const progressed = c.lifecycleStage !== "intake" && c.lifecycleStage !== "profile-validated";
  await db
    .insert(onbDocuments)
    .values(
      pack.map((p, i) => {
        const seeded = progressed && (c.id + i) % 3 !== 0;
        const verified = seeded && (c.id + i) % 3 === 1;
        return {
          organizationId: c.organizationId,
          caseId: c.id,
          key: p.key,
          label: p.label,
          category: p.category,
          required: p.required,
          status: verified ? "verified" : seeded ? "received" : "pending",
          note: verified
            ? "Checked against source and accepted"
            : seeded
              ? "Received from new hire — verification queued"
              : p.required
                ? "Requested in the documentation pack email"
                : "Optional — requested, not blocking",
        };
      }),
    )
    .onConflictDoNothing();
}

/** Backfill packs for any existing case that has none (startup, idempotent). */
export async function backfillDocumentPacks(): Promise<void> {
  const missing = await db
    .select()
    .from(onbCases)
    .where(
      sql`not exists (select 1 from ${onbDocuments} d where d.case_id = ${onbCases.id})`,
    );
  for (const c of missing) await seedDocumentsForCase(c);
  if (missing.length > 0) {
    console.log(`[onboarding documents] seeded document packs for ${missing.length} existing case(s)`);
  }
}

export async function listDocuments(caseId: number): Promise<DocumentRow[]> {
  return db
    .select()
    .from(onbDocuments)
    .where(eq(onbDocuments.caseId, caseId))
    .orderBy(onbDocuments.id);
}

/** Compact one-line-per-doc summary for LLM context. */
export function documentsSummary(docs: DocumentRow[]): string {
  if (docs.length === 0) return "No document checklist on file.";
  return docs
    .map(
      (d) =>
        `- ${d.label} [${d.status}${d.required ? "" : ", optional"}]${d.status === "pending" && d.required ? " — still needed from the new hire" : ""}`,
    )
    .join("\n");
}
