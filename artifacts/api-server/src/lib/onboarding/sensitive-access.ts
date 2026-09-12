import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { OnbAuthorityScope } from "@workspace/db/schema";
import { hasCurrentAuthorityScope } from "./decision-authority";

/**
 * Sensitive-record access is deliberately independent from an organization
 * membership role.  A tenant owner, admin, member, and demo persona can enter
 * a tenant but none of those facts is evidence that they may read a medical,
 * payroll, identity, or background-verification record.
 */
export type SensitiveRecordClass = "identity" | "medical" | "payroll" | "bgv";

export const SENSITIVE_SCOPE_BY_CLASS: Readonly<Record<SensitiveRecordClass, OnbAuthorityScope>> = {
  identity: "hr-compliance-approve",
  medical: "occupational-health-approve",
  payroll: "payroll-approve",
  bgv: "hr-compliance-approve",
};

export type SensitiveAccess = Readonly<Record<SensitiveRecordClass, boolean>>;
export const ALL_SENSITIVE_RECORD_CLASSES: readonly SensitiveRecordClass[] = [
  "identity", "medical", "payroll", "bgv",
];

export const NO_SENSITIVE_ACCESS: SensitiveAccess = {
  identity: false,
  medical: false,
  payroll: false,
  bgv: false,
};

export class SensitiveAuthorityRequiredError extends Error {
  constructor() {
    super("SENSITIVE_RECORD_ACCESS_REQUIRED");
    this.name = "SensitiveAuthorityRequiredError";
  }
}

const MEDICAL = /\b(?:medical|health|occupational|ohs|ehs|fitness|disability|clinic|physician|injury|vaccin)/i;
const PAYROLL = /\b(?:payroll|bank(?:ing)?|salary|compensation|tax|withholding|pan(?:\s+card)?|uan|epf|account\s*(?:number|details)?)/i;
const BGV = /\b(?:bgv|background(?:\s+verification|\s+check)?|criminal|adverse|discrepancy|screening)\b/i;
const IDENTITY = /\b(?:passport|national\s+id|photo\s+id|address\s+proof|right[-\s]?to[-\s]?work|work\s+authorization|identity\s+document)/i;

/** Classification is for detection only; it must never create an access grant. */
export function classifySensitiveText(value: string | null | undefined): SensitiveRecordClass[] {
  const text = value ?? "";
  const classes: SensitiveRecordClass[] = [];
  if (MEDICAL.test(text)) classes.push("medical");
  if (PAYROLL.test(text)) classes.push("payroll");
  if (BGV.test(text)) classes.push("bgv");
  if (IDENTITY.test(text)) classes.push("identity");
  return classes;
}

const TRUSTED_DOCUMENT_TAXONOMY: ReadonlyArray<Readonly<{
  key: string;
  label: string;
  category: string;
  classification: SensitiveRecordClass;
}>> = [
  { key: "id-proof", label: "Government photo ID (passport / national ID)", category: "identity", classification: "identity" },
  { key: "address-proof", label: "Proof of current address", category: "identity", classification: "identity" },
  { key: "education-certs", label: "Highest education certificate", category: "identity", classification: "identity" },
  { key: "prior-employment", label: "Relieving / experience letter from previous employer", category: "identity", classification: "identity" },
  { key: "pan-card", label: "PAN card (tax identification)", category: "statutory", classification: "payroll" },
  { key: "uan-epf", label: "UAN / EPF details for provident fund transfer", category: "statutory", classification: "payroll" },
  { key: "tax-form", label: "Tax withholding form for payroll", category: "statutory", classification: "payroll" },
  { key: "bank-details", label: "Bank account details for salary/fee disbursement", category: "statutory", classification: "payroll" },
  { key: "work-authorization", label: "Work authorization / right-to-work evidence", category: "statutory", classification: "identity" },
  { key: "signed-sow", label: "Countersigned statement of work", category: "contract", classification: "identity" },
  { key: "signed-offer", label: "Signed offer letter & employment contract", category: "contract", classification: "identity" },
  { key: "nda-coc", label: "Signed NDA & code-of-conduct acknowledgement", category: "policy", classification: "identity" },
  { key: "policy-ack", label: "IT & data-protection policy acknowledgement", category: "policy", classification: "identity" },
];

/** Only immutable server-owned pack triples can receive a class-scoped
 * metadata projection. A custom/legacy key or label is an opaque envelope. */
export function trustedSensitiveClassForDocument(input: {
  key?: string | null;
  label?: string | null;
  category?: string | null;
}): SensitiveRecordClass | null {
  return TRUSTED_DOCUMENT_TAXONOMY.find((entry) =>
    entry.key === input.key &&
    entry.label === input.label &&
    entry.category === input.category,
  )?.classification ?? null;
}

export function sensitiveClassForDocument(input: {
  key?: string | null;
  label?: string | null;
  category?: string | null;
}): SensitiveRecordClass[] {
  const trustedClass = trustedSensitiveClassForDocument(input);
  // Unknown/custom metadata is not evidence of an identity-only envelope.
  // It may contain every sensitive class, so only the all-class authority
  // can read its metadata or perform a staff-sensitive operation on it.
  return trustedClass ? [trustedClass] : [...ALL_SENSITIVE_RECORD_CLASSES];
}

export function hasSensitiveAccess(
  access: SensitiveAccess,
  classes: readonly SensitiveRecordClass[],
): boolean {
  return classes.every((classification) => access[classification]);
}

/** Free-form onboarding narratives are unclassified opaque envelopes. A
 * keyword hit can identify a reason to restrict, never a reason to grant. */
export function hasOpaqueNarrativeAccess(access: SensitiveAccess): boolean {
  return hasSensitiveAccess(access, ALL_SENSITIVE_RECORD_CLASSES);
}

/**
 * Resolve every class from live, tenant- and case-scoped authority
 * assignments.  This deliberately does not accept membership role, display
 * persona, demo mode, or a client-provided role as an input.
 */
export async function resolveSensitiveAccess(input: {
  organizationId: string;
  caseId: number;
  actorUserId?: string | null;
}): Promise<SensitiveAccess> {
  if (!input.actorUserId || !Number.isSafeInteger(input.caseId) || input.caseId < 1) {
    return NO_SENSITIVE_ACCESS;
  }
  return db.transaction(async (tx) => {
    const result = { ...NO_SENSITIVE_ACCESS };
    for (const classification of Object.keys(SENSITIVE_SCOPE_BY_CLASS) as SensitiveRecordClass[]) {
      result[classification] = await hasCurrentAuthorityScope(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId!,
        scope: SENSITIVE_SCOPE_BY_CLASS[classification],
        caseId: input.caseId,
      });
    }
    return result;
  });
}

/**
 * Serializes a sensitive mutation with authority grant/revocation changes.
 * The callback runs while the same tenant advisory transaction lock used by
 * authority administration remains held; it may use its own transaction for
 * the actual domain mutation without reopening a revocation window.
 */
export async function withSensitiveAuthorityFence<T>(input: {
  organizationId: string;
  caseId: number;
  actorUserId: string;
  classification: SensitiveRecordClass;
  additionalClassifications?: readonly SensitiveRecordClass[];
  mutate: () => Promise<T>;
}): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.organizationId}))`);
    for (const classification of [input.classification, ...(input.additionalClassifications ?? [])]) {
      if (!(await hasCurrentAuthorityScope(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        scope: SENSITIVE_SCOPE_BY_CLASS[classification],
        caseId: input.caseId,
      }))) {
        throw new SensitiveAuthorityRequiredError();
      }
    }
    return input.mutate();
  });
}

export function restrictedState(classes: readonly SensitiveRecordClass[]): string {
  const label = classes.includes("medical")
    ? "medical"
    : classes.includes("payroll")
      ? "payroll"
      : classes.includes("bgv")
        ? "background-verification"
        : "identity";
  return `Restricted ${label} record`;
}

export function redactSensitiveText(
  value: string | null | undefined,
  access: SensitiveAccess,
  options: { forceRestricted?: boolean } = {},
): string | null | undefined {
  if (value === null || value === undefined) return value;
  // Absence of a keyword—or a keyword for a class the actor happens to
  // hold—is not evidence that an arbitrary narrative excludes other classes.
  if (options.forceRestricted || !hasOpaqueNarrativeAccess(access)) {
    return "Restricted confidential onboarding record.";
  }
  return value;
}

export function restrictedDocumentView<T extends {
  id: number;
  caseId: number;
  key: string;
  label: string;
  category: string;
  status: string;
  required: boolean;
  note?: string | null;
  reminderCount?: number;
  lastReminderAt?: string | null;
  reminderNextAt?: string | null;
  updatedAt?: string;
}>(document: T, access: SensitiveAccess): {
  id: number;
  caseId: number;
  key: string;
  label: string;
  category: string;
  status: string;
  required: boolean;
  note: string | null;
  reminderCount?: number;
  lastReminderAt?: string | null;
  reminderNextAt?: string | null;
  updatedAt?: string;
  restricted?: boolean;
} {
  const classes = sensitiveClassForDocument(document);
  const trustedClass = trustedSensitiveClassForDocument(document);
  const publicOperationalProjection = {
    id: document.id,
    caseId: document.caseId,
    key: document.key,
    label: document.label,
    category: document.category,
    status: document.status,
    required: document.required,
    note: redactSensitiveText(document.note, access) ?? null,
    ...(document.reminderCount === undefined ? {} : { reminderCount: document.reminderCount }),
    ...(document.lastReminderAt === undefined ? {} : { lastReminderAt: document.lastReminderAt }),
    ...(document.reminderNextAt === undefined ? {} : { reminderNextAt: document.reminderNextAt }),
    ...(document.updatedAt === undefined ? {} : { updatedAt: document.updatedAt }),
  };
  if (hasSensitiveAccess(access, classes)) return publicOperationalProjection;
  return {
    id: document.id,
    caseId: document.caseId,
    key: "restricted",
    label: trustedClass ? restrictedState(classes) : "Restricted confidential document",
    category: "restricted",
    status: document.status,
    required: document.required,
    note: "Details are restricted to the assigned specialist.",
    ...(document.reminderCount === undefined ? {} : { reminderCount: document.reminderCount }),
    ...(document.lastReminderAt === undefined ? {} : { lastReminderAt: document.lastReminderAt }),
    ...(document.reminderNextAt === undefined ? {} : { reminderNextAt: document.reminderNextAt }),
    ...(document.updatedAt === undefined ? {} : { updatedAt: document.updatedAt }),
    restricted: true,
  };
}

/** Case context may carry an accessibility accommodation. Never expose it to
 * a general tenant member merely because the case itself is visible. */
export function redactCaseWorkforceContext<T extends Record<string, unknown> | null | undefined>(
  context: T,
  access: SensitiveAccess,
): T {
  if (!context || hasOpaqueNarrativeAccess(access)) {
    return context;
  }
  // Do not spread an opaque/custom workforce object. These are the only
  // operational workplace fields a general tenant member needs.
  const safe = Object.fromEntries(
    ["workEnvironment", "site", "siteExposure", "safetyCritical"]
      .flatMap((key) => Object.prototype.hasOwnProperty.call(context, key) ? [[key, context[key]]] : []),
  );
  return safe as T;
}

/** Checklist/readiness is an operational surface. Preserve its state while
 * suppressing an assigned specialist's medical/payroll/BGV item wording. */
export function redactOperationalItems<T extends readonly Record<string, unknown>[] | null | undefined>(
  items: T,
  access: SensitiveAccess,
): T {
  if (!items) return items;
  return items.map((item) => {
    if (hasOpaqueNarrativeAccess(access)) return item;
    // Preserve only typed operational state. Custom keys, labels, notes, and
    // source context are arbitrary author-controlled narratives.
    const typed = Object.fromEntries(
      ["status", "order", "mandatory", "enabled", "enforcementStage", "evidenceRequired", "completionAuthority", "executor"]
        .flatMap((key) => Object.prototype.hasOwnProperty.call(item, key) ? [[key, item[key]]] : []),
    );
    return {
      key: "restricted",
      label: "Restricted confidential operational item",
      ...typed,
      restricted: true,
    };
  }) as unknown as T;
}