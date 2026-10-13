import { and, eq, isNull } from "drizzle-orm";
import {
  db, onbSettings, organizationsTable, accessUserGroups,
  accessGovernanceHistory, organizationMembershipsTable,
} from "@workspace/db";
import { UpdateClientOperationsSettingsBody } from "@workspace/api-zod";
import { isPlatformSuperAdmin } from "../private-platform-admin";
import { HRO_BATCH_TEMPLATES, findHroTemplate, readHroBatchRequest } from "./hro-batch-templates";
import type { OnboardingDbTransaction } from "./settings";

export const CLIENT_OPERATIONS_KEY = "client_operations_configuration";
export const CASE_FAMILIES = [...new Set(HRO_BATCH_TEMPLATES.map(template => template.family))];
export type ClientOperationsConfiguration = ReturnType<typeof UpdateClientOperationsSettingsBody.parse>["configuration"];
type Reader = Pick<OnboardingDbTransaction, "select">;
export class ClientOperationsError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function defaultClientOperations(): ClientOperationsConfiguration {
  return {
    defaults: {
      timezone: "Etc/UTC", dateFormat: "MMM d, yyyy",
      businessDays: [1, 2, 3, 4, 5], holidays: [],
    },
    families: CASE_FAMILIES.map(family => ({
      family, batchEnabled: true,
      defaultTemplateId: HRO_BATCH_TEMPLATES.find(template => template.family === family)!.id,
    })),
    routingRules: [], fallbackOwner: "hr",
  };
}

export function validateClientOperations(value: unknown): ClientOperationsConfiguration {
  const parsed = UpdateClientOperationsSettingsBody.safeParse({ expectedVersion: 0, configuration: value });
  if (!parsed.success) throw new ClientOperationsError("Invalid client operations configuration.");
  const configuration = parsed.data.configuration;
  const { defaults, families, routingRules } = configuration;
  try { new Intl.DateTimeFormat("en", { timeZone: defaults.timezone }).format(); }
  catch { throw new ClientOperationsError("Choose a valid IANA time zone."); }
  if (!defaults.businessDays.length || defaults.businessDays.length > 7 ||
      defaults.businessDays.some(day => !Number.isInteger(day) || day < 0 || day > 6) ||
      new Set(defaults.businessDays).size !== defaults.businessDays.length) {
    throw new ClientOperationsError("Choose unique business weekdays from Sunday (0) to Saturday (6).");
  }
  if (defaults.holidays.length > 366 || new Set(defaults.holidays).size !== defaults.holidays.length ||
      defaults.holidays.some(day => !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)) {
    throw new ClientOperationsError("Holidays must be unique valid YYYY-MM-DD dates (maximum 366).");
  }
  if (families.length !== CASE_FAMILIES.length ||
      new Set(families.map(item => item.family)).size !== CASE_FAMILIES.length ||
      families.some(item => !CASE_FAMILIES.includes(item.family) ||
        findHroTemplate(item.defaultTemplateId)?.family !== item.family)) {
    throw new ClientOperationsError("Each case family needs exactly one default template from that family.");
  }
  if (routingRules.length > 100) throw new ClientOperationsError("Use at most 100 routing rules.");
  const keys = new Set<string>();
  for (const rule of routingRules) {
    if ((rule.family !== null && !CASE_FAMILIES.includes(rule.family)) ||
        (rule.country !== null && !/^[A-Z]{2}$/.test(rule.country)) ||
        (rule.groupId !== null && (!rule.groupId.trim() || rule.groupId.length > 150))) {
      throw new ClientOperationsError("Routing requires a known family, a two-letter uppercase country code and a valid group.");
    }
    const key = `${rule.family ?? "*"}:${rule.country ?? "*"}`;
    if (keys.has(key)) throw new ClientOperationsError("Only one routing rule is allowed per family/country combination.");
    keys.add(key);
  }
  return configuration;
}

export async function loadClientOperations(organizationId: string, reader: Reader = db) {
  const [row] = await reader.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, CLIENT_OPERATIONS_KEY),
  )).limit(1);
  if (!row) return { version: 0, configuration: defaultClientOperations(), source: "product-defaults" as const };
  try {
    const stored = JSON.parse(row.value);
    if (!Number.isInteger(stored.version) || stored.version < 1) throw new Error();
    return {
      version: stored.version as number, configuration: validateClientOperations(stored.configuration),
      source: "client-override" as const,
    };
  } catch {
    throw new ClientOperationsError("Stored client operations settings are invalid. Contact your administrator.", 500);
  }
}

export async function clientRoutingGroups(organizationId: string, reader: Reader = db) {
  // These are responsibility labels, not authority or membership grants.
  return reader.select({ id: accessUserGroups.id, name: accessUserGroups.name })
    .from(accessUserGroups).where(and(
      eq(accessUserGroups.organizationId, organizationId),
      eq(accessUserGroups.status, "active"),
    ));
}

export async function currentClientOperationsAccess(organizationId: string, actorUserId: string, reader: Reader = db) {
  if (isPlatformSuperAdmin(actorUserId, organizationId)) return { canRead: true, canEdit: true };
  const [membership] = await reader.select({ role: organizationMembershipsTable.role })
    .from(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      eq(organizationMembershipsTable.clerkUserId, actorUserId),
      isNull(organizationMembershipsTable.revokedAt),
    )).limit(1);
  return { canRead: !!membership, canEdit: membership?.role === "owner" };
}

export async function saveClientOperations(
  organizationId: string, actorUserId: string, expectedVersion: number, value: unknown,
) {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new ClientOperationsError("expectedVersion must be a non-negative integer.");
  }
  const configuration = validateClientOperations(value);
  return db.transaction(async tx => {
    // Lock the tenant parent even before the settings row exists.
    const [tenant] = await tx.select({ id: organizationsTable.id }).from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId)).for("update");
    if (!tenant) throw new ClientOperationsError("Client workspace not found.", 404);
    const current = await loadClientOperations(organizationId, tx);
    if (current.version !== expectedVersion) {
      throw new ClientOperationsError("Settings changed in another session. Reload before saving; your draft was not applied.", 409);
    }
    const groups = await clientRoutingGroups(organizationId, tx);
    if (configuration.routingRules.some(rule => rule.groupId && !groups.some(group => group.id === rule.groupId))) {
      throw new ClientOperationsError("A routing group is inactive or belongs to another client.");
    }
    if (!isPlatformSuperAdmin(actorUserId, organizationId)) {
      const [owner] = await tx.select({ id: organizationMembershipsTable.id }).from(organizationMembershipsTable).where(and(
        eq(organizationMembershipsTable.organizationId, organizationId),
        eq(organizationMembershipsTable.clerkUserId, actorUserId),
        eq(organizationMembershipsTable.role, "owner"), isNull(organizationMembershipsTable.revokedAt),
      )).for("share").limit(1);
      if (!owner) throw new ClientOperationsError("Current owner or active Super Admin access is required.", 403);
    }
    const version = current.version + 1;
    await tx.insert(onbSettings).values({
      organizationId, key: CLIENT_OPERATIONS_KEY, value: JSON.stringify({ version, configuration }),
    }).onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value: JSON.stringify({ version, configuration }), updatedAt: new Date() },
    });
    await tx.insert(accessGovernanceHistory).values({
      organizationId, actorUserId, eventType: "client-operations.updated",
      entityType: "client-settings", entityId: CLIENT_OPERATIONS_KEY,
      detail: { version, previousVersion: current.version, familyCount: configuration.families.length,
        routingRuleCount: configuration.routingRules.length },
    });
    return { version, configuration, source: "client-override" as const };
  });
}

export async function assertBatchFamilyEnabled(organizationId: string, templateId: string) {
  const definition = findHroTemplate(templateId);
  if (!definition) throw new ClientOperationsError("Unknown batch template.");
  const { configuration } = await loadClientOperations(organizationId);
  if (!configuration.families.find(family => family.family === definition.family)?.batchEnabled) {
    throw new ClientOperationsError(`${definition.family} batch intake is paused in this client's Settings.`, 409);
  }
}

export function nextClientBusinessDate(date: string, defaults: ClientOperationsConfiguration["defaults"]) {
  const cursor = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(cursor.getTime())) throw new ClientOperationsError("Invalid calendar date.");
  for (let attempts = 0; attempts < 740; attempts++) {
    const day = cursor.toISOString().slice(0, 10);
    if (defaults.businessDays.includes(cursor.getUTCDay()) && !defaults.holidays.includes(day)) return day;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  throw new ClientOperationsError("No working date is available in the configured calendar.");
}

export function selectClientRoutingRule(configuration: ClientOperationsConfiguration, family: string | null, country: string | null) {
  return configuration.routingRules
    .filter(rule => (rule.family === null || rule.family === family) &&
      (rule.country === null || rule.country === country))
    .sort((a, b) => ((b.family ? 2 : 0) + (b.country ? 1 : 0)) -
      ((a.family ? 2 : 0) + (a.country ? 1 : 0)))[0];
}

export async function resolveClientActionRouting(
  organizationId: string,
  row: { hireType: string; processPolicySnapshot: unknown },
  reader: Reader = db,
) {
  const { configuration, version } = await loadClientOperations(organizationId, reader);
  const batch = readHroBatchRequest(row.processPolicySnapshot);
  const snapshot = row.processPolicySnapshot as { workforceContext?: { workCountry?: string } } | null;
  const family = batch?.family ?? (row.hireType === "offboarding" || row.hireType === "separation"
    ? "Offboarding" : row.hireType === "internal-transfer" ? "Employee Changes"
      : HRO_BATCH_TEMPLATES.some(template => template.hireType === row.hireType) ? "Onboarding" : null);
  const country = batch?.data.work_country ?? snapshot?.workforceContext?.workCountry ?? null;
  const rule = selectClientRoutingRule(configuration, family, country);
  const group = rule?.groupId
    ? (await clientRoutingGroups(organizationId, reader)).find(item => item.id === rule.groupId) : null;
  const unavailableGroup = Boolean(rule?.groupId && !group);
  return {
    settingsVersion: version,
    groupId: unavailableGroup ? null : group?.id ?? null,
    owner: unavailableGroup ? configuration.fallbackOwner : rule?.owner ?? configuration.fallbackOwner,
    assignee: unavailableGroup ? null : group?.name ?? null,
    reason: unavailableGroup
      ? `Configured routing group is unavailable; assigned to the fallback queue (settings v${version}).`
      : `Assigned using client routing defaults (settings v${version}); no access or email identity was granted.`,
  };
}
