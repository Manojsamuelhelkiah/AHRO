import { and, eq, sql } from "drizzle-orm";
import { db, onbSettings, organizationMembershipsTable, organizationsTable } from "@workspace/db";
import {
  SENSITIVE_DATA_CLASSES,
  type SensitiveDataClass,
  SensitiveLifecycleConflictError,
  SensitiveLifecyclePermissionError,
  SensitiveLifecycleValidationError,
} from "./sensitive-lifecycle";

/**
 * Starter proposals are deliberately kept outside the approved policy table.
 * They are editable review material only; runtime lifecycle gates never read
 * this setting.
 */
export const STARTER_LIFECYCLE_POLICY_KEY = "privacy:lifecycle:starter-policy";
const MAX_TEXT = 2_000;
const MAX_RETENTION_DAYS = 365_000;

export type StarterPolicyProposal = {
  dataClass: SensitiveDataClass;
  jurisdiction: string;
  purpose: string;
  lawfulBasis: string;
  retentionDays: number;
  providerSharingApproved: false;
  permittedProviders: [];
  policyReference: string;
  approvalReference: string;
};

export type StarterPolicySnapshot = {
  inactive: true;
  reviewRequired: true;
  country: string;
  version: number;
  proposals: StarterPolicyProposal[];
};

type StoredStarterPolicy = Omit<StarterPolicySnapshot, "inactive" | "reviewRequired">;

const COUNTRY_ALIASES: Record<string, string> = {
  "united states": "US",
  usa: "US",
  "united kingdom": "GB",
  uk: "GB",
  uae: "AE",
  "united arab emirates": "AE",
  "south korea": "KR",
  "korea, republic of": "KR",
  russia: "RU",
  "russian federation": "RU",
  vietnam: "VN",
  "czech republic": "CZ",
  "czechia": "CZ",
  holland: "NL",
};
const ISO_3166_ALPHA_2 = new Set(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" "),
);

function countryText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) {
    throw new SensitiveLifecycleValidationError("country is required.");
  }
  return value.trim();
}

/**
 * Accept an ISO 3166-1 alpha-2 code or a country name. Intl.DisplayNames
 * supplies the maintained list of country names while aliases cover common
 * business-form variants (including India/IN).
 */
export function canonicalStarterCountry(value: unknown): string {
  const input = countryText(value);
  const upper = input.toUpperCase();
  if (ISO_3166_ALPHA_2.has(upper)) return upper;
  const normalized = input.toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
  const alias = COUNTRY_ALIASES[normalized];
  if (alias) return alias;
  const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
  for (const code of ISO_3166_ALPHA_2) {
    if (displayNames.of(code)?.toLowerCase() === normalized) return code;
  }
  throw new SensitiveLifecycleValidationError("country must be a known country name or ISO 3166-1 alpha-2 code.");
}

function proposalText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > MAX_TEXT) {
    throw new SensitiveLifecycleValidationError(`${field} is required and must be at most ${MAX_TEXT} characters.`);
  }
  return value.trim();
}

function defaultProposal(dataClass: SensitiveDataClass, country: string): StarterPolicyProposal {
  const label = dataClass.replace(/-/g, " ");
  return {
    dataClass,
    jurisdiction: country,
    purpose: `REVIEW REQUIRED: define the specific purpose for ${label} data in ${country}.`,
    lawfulBasis: `REVIEW REQUIRED: confirm the applicable lawful basis for ${label} data in ${country}.`,
    retentionDays: 0,
    providerSharingApproved: false,
    permittedProviders: [],
    policyReference: `REVIEW REQUIRED: identify the applicable ${country} privacy and retention policy.`,
    approvalReference: "REVIEW REQUIRED: no legal approval recorded; adoption requires verified privacy or legal authority.",
  };
}

export function starterPolicyDefaults(country: string): StarterPolicySnapshot {
  return {
    inactive: true,
    reviewRequired: true,
    country,
    version: 0,
    proposals: SENSITIVE_DATA_CLASSES.map((dataClass) => defaultProposal(dataClass, country)),
  };
}

function parseProposal(value: unknown, country: string, index: number): StarterPolicyProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SensitiveLifecycleValidationError(`Starter proposal ${index + 1} is invalid.`);
  }
  const input = value as Record<string, unknown>;
  if (!SENSITIVE_DATA_CLASSES.includes(input.dataClass as SensitiveDataClass)) {
    throw new SensitiveLifecycleValidationError(`Starter proposal ${index + 1} has an unsupported data class.`);
  }
  if (canonicalStarterCountry(input.jurisdiction) !== country) {
    throw new SensitiveLifecycleValidationError(`Starter proposal ${index + 1} must use jurisdiction ${country}.`);
  }
  if (typeof input.retentionDays !== "number" || !Number.isInteger(input.retentionDays) ||
    input.retentionDays < 0 || input.retentionDays > MAX_RETENTION_DAYS) {
    throw new SensitiveLifecycleValidationError("retentionDays must be a non-negative integer.");
  }
  if (input.providerSharingApproved !== false ||
    !Array.isArray(input.permittedProviders) || input.permittedProviders.length !== 0) {
    throw new SensitiveLifecycleValidationError("Starter proposals cannot approve provider sharing or list providers.");
  }
  const approvalReference = proposalText(input.approvalReference, "approvalReference");
  if (!/review required|no legal approval/i.test(approvalReference) ||
    /\blegal approval\s*[:=]\s*(yes|true|approved|granted)/i.test(approvalReference)) {
    throw new SensitiveLifecycleValidationError("Starter approvalReference must continue to state that review is required and legal approval is not recorded.");
  }
  return {
    dataClass: input.dataClass as SensitiveDataClass,
    jurisdiction: country,
    purpose: proposalText(input.purpose, "purpose"),
    lawfulBasis: proposalText(input.lawfulBasis, "lawfulBasis"),
    retentionDays: input.retentionDays,
    providerSharingApproved: false,
    permittedProviders: [],
    policyReference: proposalText(input.policyReference, "policyReference"),
    approvalReference,
  };
}

function parseStored(value: string, requestedCountry?: string): StoredStarterPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SensitiveLifecycleValidationError("Stored starter policy is invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SensitiveLifecycleValidationError("Stored starter policy is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  const country = canonicalStarterCountry(record.country);
  if (requestedCountry && country !== requestedCountry) {
    if (typeof record.version !== "number" || !Number.isSafeInteger(record.version) || record.version < 0) {
      throw new SensitiveLifecycleValidationError("Stored starter policy has an invalid version.");
    }
    return {
      country: requestedCountry,
      version: record.version,
      proposals: starterPolicyDefaults(requestedCountry).proposals,
    };
  }
  if (typeof record.version !== "number" || !Number.isSafeInteger(record.version) || record.version < 0 ||
    !Array.isArray(record.proposals) || record.proposals.length !== SENSITIVE_DATA_CLASSES.length) {
    throw new SensitiveLifecycleValidationError("Stored starter policy has an invalid version or proposal set.");
  }
  const proposals = record.proposals.map((proposal, index) => parseProposal(proposal, country, index));
  const classes = proposals.map((proposal) => proposal.dataClass);
  if (new Set(classes).size !== SENSITIVE_DATA_CLASSES.length ||
    SENSITIVE_DATA_CLASSES.some((dataClass) => !classes.includes(dataClass))) {
    throw new SensitiveLifecycleValidationError("Starter policy must contain exactly one proposal for every sensitive data class.");
  }
  return { country, version: record.version, proposals };
}

async function assertStarterMember(tx: any, organizationId: string, actorUserId: string): Promise<void> {
  const [membership] = await tx.select({ id: organizationMembershipsTable.id })
    .from(organizationMembershipsTable)
    .where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      eq(organizationMembershipsTable.clerkUserId, actorUserId),
      sql`${organizationMembershipsTable.revokedAt} is null`,
    ));
  if (!membership) throw new SensitiveLifecyclePermissionError("A current tenant membership is required.");
}

export async function getStarterSensitiveLifecyclePolicy(input: {
  organizationId: string;
  actorUserId: string;
  country?: unknown;
}): Promise<StarterPolicySnapshot> {
  const requestedCountry = input.country === undefined || input.country === "" ?
    undefined : canonicalStarterCountry(input.country);
  return db.transaction(async (tx) => {
    await assertStarterMember(tx, input.organizationId, input.actorUserId);
    const [organization] = await tx.select({ primaryCountry: organizationsTable.primaryCountry })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, input.organizationId));
    if (!organization) throw new SensitiveLifecyclePermissionError("Organization not found.");
    const [row] = await tx.select({ value: onbSettings.value })
      .from(onbSettings)
      .where(and(
        eq(onbSettings.organizationId, input.organizationId),
        eq(onbSettings.key, STARTER_LIFECYCLE_POLICY_KEY),
      ));
    const stored = row ? parseStored(row.value, requestedCountry) :
      starterPolicyDefaults(requestedCountry ?? organization.primaryCountry);
    return { inactive: true, reviewRequired: true, ...stored };
  });
}

export async function saveStarterSensitiveLifecyclePolicy(input: {
  organizationId: string;
  actorUserId: string;
  policy: unknown;
}): Promise<StarterPolicySnapshot> {
  if (!input.policy || typeof input.policy !== "object" || Array.isArray(input.policy)) {
    throw new SensitiveLifecycleValidationError("A starter policy object is required.");
  }
  const body = input.policy as Record<string, unknown>;
  const country = canonicalStarterCountry(body.country);
  if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
    throw new SensitiveLifecycleValidationError("expectedVersion must be a non-negative integer.");
  }
  if (!Array.isArray(body.proposals) || body.proposals.length !== SENSITIVE_DATA_CLASSES.length) {
    throw new SensitiveLifecycleValidationError("A complete proposal is required for every sensitive data class.");
  }
  const proposals = body.proposals.map((proposal, index) => parseProposal(proposal, country, index));
  const classes = proposals.map((proposal) => proposal.dataClass);
  if (new Set(classes).size !== SENSITIVE_DATA_CLASSES.length ||
    SENSITIVE_DATA_CLASSES.some((dataClass) => !classes.includes(dataClass))) {
    throw new SensitiveLifecycleValidationError("Starter policy must contain exactly one proposal for every sensitive data class.");
  }
  return db.transaction(async (tx) => {
    await assertStarterMember(tx, input.organizationId, input.actorUserId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`starter-lifecycle-policy:${input.organizationId}`}))`);
    const [row] = await tx.select({ value: onbSettings.value })
      .from(onbSettings)
      .where(and(
        eq(onbSettings.organizationId, input.organizationId),
        eq(onbSettings.key, STARTER_LIFECYCLE_POLICY_KEY),
      )).for("update");
    const [organization] = await tx.select({ primaryCountry: organizationsTable.primaryCountry })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, input.organizationId));
    if (!organization) throw new SensitiveLifecyclePermissionError("Organization not found.");
    const current = row ? parseStored(row.value) : {
      country: organization.primaryCountry,
      version: 0,
      proposals: starterPolicyDefaults(organization.primaryCountry).proposals,
    };
    if (body.expectedVersion !== current.version) {
      throw new SensitiveLifecycleConflictError(`Starter policy changed since it was loaded (current version ${current.version}).`);
    }
    const next: StoredStarterPolicy = { country, version: current.version + 1, proposals };
    await tx.insert(onbSettings).values({
      organizationId: input.organizationId,
      key: STARTER_LIFECYCLE_POLICY_KEY,
      value: JSON.stringify(next),
    }).onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value: JSON.stringify(next), updatedAt: sql`now()` },
    });
    return { inactive: true, reviewRequired: true, ...next };
  });
}