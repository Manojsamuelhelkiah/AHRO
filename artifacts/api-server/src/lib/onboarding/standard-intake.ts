import { createHash } from "node:crypto";
import type { OnbWorkforceContext } from "@workspace/db/schema";

export const STANDARD_INTAKE_EVENT_TYPES = ["accepted-offer", "scheduled-preboarding"] as const;
export type StandardIntakeEventType = typeof STANDARD_INTAKE_EVENT_TYPES[number];

export type StandardIntakePerson = {
  personKey: string;
  workerName: string;
  workerEmail: string;
  workerPhone?: string;
  channelPreference?: "email" | "whatsapp" | "both";
  hireType: string;
  workerCategory: string;
  workerBand?: string;
  role: string;
  department: string;
  geography: string;
  legalEntity: string;
  managerName: string;
  recruiterName: string;
  joiningDate: string;
  urgency?: string;
  jobProfileId?: string;
  workforceContext?: OnbWorkforceContext;
};

export type StandardIntakeEvent = {
  sourceEventId: string;
  eventType: StandardIntakeEventType;
  acceptanceEvidenceReference: string;
  occurredAt?: string;
  person: StandardIntakePerson;
};

export type IntakeValidation = {
  index: number;
  event?: StandardIntakeEvent;
  errors: string[];
};

const WORKFORCE_CONTEXT_TEXT_FIELDS = [
  "roleFamily", "band", "department", "legalEntity", "businessUnit", "industry",
  "workCountry", "workState", "site", "employmentArrangement", "workerCategory",
  "payBasis", "shiftPattern",
] as const;
const WORKFORCE_CONTEXT_BOOLEAN_FIELDS = ["assistedIntake", "siteExposure", "safetyCritical"] as const;
const WORKFORCE_CONTEXT_ARRAY_FIELDS = ["hazards", "requiredLicenses"] as const;
const WORKFORCE_CONTEXT_ALLOWED_FIELDS = new Set<string>([
  ...WORKFORCE_CONTEXT_TEXT_FIELDS, ...WORKFORCE_CONTEXT_BOOLEAN_FIELDS,
  ...WORKFORCE_CONTEXT_ARRAY_FIELDS, "workEnvironment", "hiringMode", "batchId",
]);

const text = (value: unknown, field: string, errors: string[], max = 120): string | undefined => {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${field} is required.`);
    return undefined;
  }
  if (value.trim().length > max) {
    errors.push(`${field} must be at most ${max} characters.`);
    return undefined;
  }
  return value.trim();
};

function optionalText(value: unknown, field: string, errors: string[], max = 120): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, field, errors, max);
}

/**
 * Intake accepts a bounded operational context only. It has no generic JSON
 * escape hatch: medical/accessibility, language, identity, or free-form
 * fields belong in specialized governed workflows, never a TA event payload.
 */
export function validateIntakeWorkforceContext(value: unknown, errors: string[]): OnbWorkforceContext | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push("person.workforceContext must be an object.");
    return undefined;
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key === "accessibilityNeeds" || key === "languagePreference") {
      errors.push(`person.workforceContext.${key} is not accepted in standard intake; use the authorized specialist workflow.`);
    } else if (!WORKFORCE_CONTEXT_ALLOWED_FIELDS.has(key)) {
      errors.push(`person.workforceContext.${key} is not a supported operational context field.`);
    }
  }
  const context: OnbWorkforceContext = {};
  for (const key of WORKFORCE_CONTEXT_TEXT_FIELDS) {
    const field = input[key];
    if (field === undefined) continue;
    if (typeof field !== "string" || !field.trim() || field.trim().length > 120) {
      errors.push(`person.workforceContext.${key} must be a non-empty string of at most 120 characters.`);
    } else context[key] = field.trim();
  }
  for (const key of WORKFORCE_CONTEXT_BOOLEAN_FIELDS) {
    const field = input[key];
    if (field === undefined) continue;
    if (typeof field !== "boolean") errors.push(`person.workforceContext.${key} must be a boolean.`);
    else context[key] = field;
  }
  for (const key of WORKFORCE_CONTEXT_ARRAY_FIELDS) {
    const field = input[key];
    if (field === undefined) continue;
    if (!Array.isArray(field) || field.length > 20 || field.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > 120)) {
      errors.push(`person.workforceContext.${key} must contain at most 20 non-empty strings of at most 120 characters.`);
    } else context[key] = field.map((item) => item.trim());
  }
  const environment = input.workEnvironment;
  if (environment !== undefined) {
    if (!["office", "remote", "site", "field", "mixed"].includes(environment as string)) {
      errors.push("person.workforceContext.workEnvironment must be office, remote, site, field, or mixed.");
    } else context.workEnvironment = environment as OnbWorkforceContext["workEnvironment"];
  }
  const hiringMode = input.hiringMode;
  if (hiringMode !== undefined) {
    if (!["individual", "batch", "seasonal"].includes(hiringMode as string)) {
      errors.push("person.workforceContext.hiringMode must be individual, batch, or seasonal.");
    } else context.hiringMode = hiringMode as OnbWorkforceContext["hiringMode"];
  }
  const batchId = input.batchId;
  if (batchId !== undefined) {
    if (typeof batchId !== "string" || !batchId.trim() || batchId.trim().length > 160) {
      errors.push("person.workforceContext.batchId must be a non-empty string of at most 160 characters.");
    } else context.batchId = batchId.trim();
  }
  return context;
}

export function standardIntakeEventMetadata(event: StandardIntakeEvent): Record<string, unknown> {
  return {
    schemaVersion: 2,
    sourceEventId: event.sourceEventId,
    eventType: event.eventType,
    ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
    personIdentityFingerprint: createHash("sha256")
      .update(canonicalJson({ personKey: event.person.personKey, workerEmail: event.person.workerEmail }))
      .digest("hex"),
    acceptanceEvidenceFingerprint: createHash("sha256")
      .update(event.acceptanceEvidenceReference)
      .digest("hex"),
    dataHandling: "No raw person facts; canonical event fingerprint binds source retry.",
  };
}

export function standardIntakeWorkerIdentityFingerprint(organizationId: string, workerEmail: string): string {
  return createHash("sha256")
    .update(`${organizationId}\n${workerEmail.trim().toLowerCase()}`)
    .digest("hex");
}

/** Removes unsupported/special-category fields before the intake-register copy. */
export function minimizedWorkforceContextSnapshot(
  value: OnbWorkforceContext | null | undefined,
): OnbWorkforceContext {
  if (!value) return {};
  const snapshot: OnbWorkforceContext = {};
  for (const key of WORKFORCE_CONTEXT_TEXT_FIELDS) {
    if (typeof value[key] === "string") snapshot[key] = value[key];
  }
  for (const key of WORKFORCE_CONTEXT_BOOLEAN_FIELDS) {
    if (typeof value[key] === "boolean") snapshot[key] = value[key];
  }
  for (const key of WORKFORCE_CONTEXT_ARRAY_FIELDS) {
    if (Array.isArray(value[key])) snapshot[key] = [...value[key]];
  }
  if (value.workEnvironment) snapshot.workEnvironment = value.workEnvironment;
  if (value.hiringMode) snapshot.hiringMode = value.hiringMode;
  if (value.batchId) snapshot.batchId = value.batchId;
  return snapshot;
}

/**
 * Parses only the stable, non-special-category facts necessary to select a
 * checklist. Offer artifacts remain in the source system; this boundary stores
 * a traceable evidence reference only.
 */
export function validateStandardIntakeEvent(value: unknown, index = 0): IntakeValidation {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { index, errors: ["Row must be an object."] };
  }
  const input = value as Record<string, unknown>;
  const sourceEventId = text(input.sourceEventId, "sourceEventId", errors, 160);
  const eventType = input.eventType;
  if (!STANDARD_INTAKE_EVENT_TYPES.includes(eventType as StandardIntakeEventType)) {
    errors.push("eventType must be accepted-offer or scheduled-preboarding.");
  }
  const acceptanceEvidenceReference = text(
    input.acceptanceEvidenceReference,
    "acceptanceEvidenceReference",
    errors,
    500,
  );
  if (acceptanceEvidenceReference && (/\s/.test(acceptanceEvidenceReference) || !/^[a-z][a-z0-9+.-]{1,30}:/i.test(acceptanceEvidenceReference))) {
    errors.push("acceptanceEvidenceReference must be an opaque, whitespace-free source-system URI/reference.");
  }
  const occurredAt = optionalText(input.occurredAt, "occurredAt", errors, 64);
  if (occurredAt && Number.isNaN(Date.parse(occurredAt))) errors.push("occurredAt must be an ISO-8601 timestamp.");

  const personInput = input.person;
  if (!personInput || typeof personInput !== "object" || Array.isArray(personInput)) {
    return { index, errors: [...errors, "person is required."] };
  }
  const person = personInput as Record<string, unknown>;
  const personKey = text(person.personKey, "person.personKey", errors, 160);
  const workerName = text(person.workerName, "person.workerName", errors);
  const workerEmail = text(person.workerEmail, "person.workerEmail", errors, 254)?.toLowerCase();
  if (workerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(workerEmail)) errors.push("person.workerEmail must be an email address.");
  const hireType = text(person.hireType, "person.hireType", errors);
  const workerCategory = text(person.workerCategory, "person.workerCategory", errors);
  const role = text(person.role, "person.role", errors);
  const department = text(person.department, "person.department", errors);
  const geography = text(person.geography, "person.geography", errors);
  const legalEntity = text(person.legalEntity, "person.legalEntity", errors);
  const managerName = text(person.managerName, "person.managerName", errors);
  const recruiterName = text(person.recruiterName, "person.recruiterName", errors);
  const joiningDate = text(person.joiningDate, "person.joiningDate", errors, 20);
  if (joiningDate && !/^\d{4}-\d{2}-\d{2}$/.test(joiningDate)) errors.push("person.joiningDate must be YYYY-MM-DD.");
  if (joiningDate && /^\d{4}-\d{2}-\d{2}$/.test(joiningDate) && !isValidIsoDate(joiningDate)) {
    errors.push("person.joiningDate must be a valid calendar date.");
  }
  if (eventType === "scheduled-preboarding" && joiningDate && !scheduledPreboardingCanActivate("scheduled-preboarding", joiningDate)) {
    errors.push("Scheduled preboarding requires a future joiningDate.");
  }
  const rawChannelPreference = person.channelPreference;
  const channelPreference = rawChannelPreference === "email" || rawChannelPreference === "whatsapp" || rawChannelPreference === "both"
    ? rawChannelPreference
    : undefined;
  if (rawChannelPreference !== undefined && !channelPreference) errors.push("person.channelPreference must be email, whatsapp, or both.");
  const workforceContext = validateIntakeWorkforceContext(person.workforceContext, errors);
  if (errors.length || !sourceEventId || !acceptanceEvidenceReference || !personKey || !workerName || !workerEmail ||
    !hireType || !workerCategory || !role || !department || !geography || !legalEntity || !managerName || !recruiterName || !joiningDate) {
    return { index, errors };
  }
  const workerPhone = optionalText(person.workerPhone, "person.workerPhone", errors, 32);
  const workerBand = optionalText(person.workerBand, "person.workerBand", errors);
  const urgency = optionalText(person.urgency, "person.urgency", errors);
  const jobProfileId = optionalText(person.jobProfileId, "person.jobProfileId", errors, 160);
  if (errors.length) return { index, errors };
  return {
    index,
    errors,
    event: {
      sourceEventId,
      eventType: eventType as StandardIntakeEventType,
      acceptanceEvidenceReference,
      ...(occurredAt ? { occurredAt } : {}),
      person: {
        personKey, workerName, workerEmail, hireType, workerCategory, role, department, geography,
        legalEntity, managerName, recruiterName, joiningDate,
        ...(workerPhone ? { workerPhone } : {}),
        ...(channelPreference ? { channelPreference } : {}),
        ...(workerBand ? { workerBand } : {}),
        ...(urgency ? { urgency } : {}),
        ...(jobProfileId ? { jobProfileId } : {}),
        ...(workforceContext ? { workforceContext } : {}),
      },
    },
  };
}

function isValidIsoDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Scheduled-preboarding source events are a future scheduling instruction,
 * not authorization to revive an already-due case. Check again at release in
 * case a held case waits past its scheduled date.
 */
export function scheduledPreboardingCanActivate(
  eventType: StandardIntakeEventType,
  joiningDate: string,
  now = new Date(),
): boolean {
  return eventType !== "scheduled-preboarding" ||
    (isValidIsoDate(joiningDate) && joiningDate > now.toISOString().slice(0, 10));
}

/** The durable review due point is midnight UTC on the calendar day before joining. */
export function scheduledPreboardingDueAt(joiningDate: string): Date | null {
  if (!isValidIsoDate(joiningDate)) return null;
  const joining = new Date(`${joiningDate}T00:00:00.000Z`);
  return new Date(joining.getTime() - 24 * 60 * 60 * 1000);
}

export function scheduledPreboardingReviewIsDue(
  eventType: StandardIntakeEventType,
  dueAt: Date | null | undefined,
  now = new Date(),
): boolean {
  return eventType === "scheduled-preboarding" && Boolean(dueAt) && dueAt!.getTime() <= now.getTime();
}

export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, normalize(nested)]));
    }
    return item;
  };
  return JSON.stringify(normalize(value)) ?? "null";
}

/** Binds a source event retry to precisely the accepted event snapshot. */
export function standardIntakeEventFingerprint(event: StandardIntakeEvent): string {
  return createHash("sha256").update(canonicalJson(event)).digest("hex");
}

export function validateStandardIntakeRows(values: unknown[]): IntakeValidation[] {
  const parsed = values.map((value, index) => validateStandardIntakeEvent(value, index));
  const indexesByEvent = new Map<string, number[]>();
  for (const row of parsed) {
    if (row.event) indexesByEvent.set(row.event.sourceEventId, [...(indexesByEvent.get(row.event.sourceEventId) ?? []), row.index]);
  }
  for (const indexes of indexesByEvent.values()) {
    if (indexes.length > 1) {
      for (const index of indexes) parsed[index]!.errors.push("sourceEventId is duplicated in this submission.");
    }
  }
  return parsed;
}