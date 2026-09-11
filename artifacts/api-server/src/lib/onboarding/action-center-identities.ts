import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { DEMO_ORGANIZATION_ID, onbSettings } from "@workspace/db/schema";

export const ACTION_CENTER_IDENTITIES_KEY = "action_center:identities";
export const ACTION_CENTER_IDENTITY_ROLES = [
  "hr",
  "bgvTeam",
  "recruiter",
  "hiringManager",
  "compliance",
] as const;
export type ActionCenterIdentityRole = (typeof ACTION_CENTER_IDENTITY_ROLES)[number];
export type ActionCenterMailboxType = "shared" | "individual" | "not-configured";
export type ActionCenterIdentity = {
  name: string | null;
  mailboxType: ActionCenterMailboxType;
  source: "configured" | "existing-profile" | "not-configured";
};
export type ActionCenterIdentitySnapshot = {
  version: number;
  identities: Record<ActionCenterIdentityRole, ActionCenterIdentity>;
};

export class ActionCenterIdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionCenterIdentityConflictError";
  }
}
export class ActionCenterIdentityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionCenterIdentityValidationError";
  }
}

const roles = [...ACTION_CENTER_IDENTITY_ROLES];
const emptyIdentity = (): ActionCenterIdentity => ({
  name: null,
  mailboxType: "not-configured",
  source: "not-configured",
});

function defaults(): ActionCenterIdentitySnapshot {
  return {
    version: 1,
    identities: Object.fromEntries(roles.map((role) => [role, emptyIdentity()])) as Record<
      ActionCenterIdentityRole,
      ActionCenterIdentity
    >,
  };
}

function parseSnapshot(raw: string | null): ActionCenterIdentitySnapshot {
  if (!raw) return defaults();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ActionCenterIdentityConflictError(
      "Named stakeholder identity settings are malformed; no update was applied.",
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ActionCenterIdentityConflictError(
      "Named stakeholder identity settings are malformed; no update was applied.",
    );
  }
  const value = parsed as { version?: unknown; identities?: unknown; stakeholders?: unknown };
  const rawIdentities = value.identities ?? value.stakeholders;
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1 || !rawIdentities || typeof rawIdentities !== "object") {
    throw new ActionCenterIdentityConflictError(
      "Named stakeholder identity settings are malformed; no update was applied.",
    );
  }
  const identities = {} as Record<ActionCenterIdentityRole, ActionCenterIdentity>;
  for (const role of roles) {
    const candidate = (rawIdentities as Record<string, unknown>)[role];
    if (!candidate || typeof candidate !== "object") {
      identities[role] = emptyIdentity();
      continue;
    }
    const item = candidate as Record<string, unknown>;
    const name = item.name;
    const mailboxType = item.mailboxType ??
      (typeof item.role === "string" && ["hr", "bgvTeam", "compliance"].includes(role)
        ? "shared"
        : "individual");
    if ((name !== null && typeof name !== "string") ||
        !["shared", "individual", "not-configured"].includes(String(mailboxType))) {
      throw new ActionCenterIdentityConflictError(
        "Named stakeholder identity settings are malformed; no update was applied.",
      );
    }
    const normalized = typeof name === "string" ? name.trim() : null;
    identities[role] = {
      name: normalized || null,
      mailboxType: mailboxType as ActionCenterMailboxType,
      source: normalized ? "configured" : "not-configured",
    };
  }
  return { version: value.version as number, identities };
}

async function load(organizationId: string): Promise<ActionCenterIdentitySnapshot> {
  const [row] = await db.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, organizationId),
    eq(onbSettings.key, ACTION_CENTER_IDENTITIES_KEY),
  ));
  return parseSnapshot(row?.value ?? null);
}

export async function getActionCenterIdentities(
  organizationId: string,
): Promise<ActionCenterIdentitySnapshot> {
  return load(organizationId);
}

export function canEditActionCenterIdentities(
  organizationId: string,
  organizationRole: string | undefined,
): boolean {
  return organizationId === DEMO_ORGANIZATION_ID ||
    organizationRole === "owner" ||
    organizationRole === "admin";
}

export async function updateActionCenterIdentities(input: {
  organizationId: string;
  expectedVersion: number;
  identities: Record<ActionCenterIdentityRole, { name: string | null; mailboxType: ActionCenterMailboxType }>;
}): Promise<ActionCenterIdentitySnapshot> {
  for (const role of roles) {
    const value = input.identities[role];
    if (!value) throw new ActionCenterIdentityValidationError(`Identity "${role}" is required.`);
    if (value.name !== null && value.name.trim().length > 120) {
      throw new ActionCenterIdentityValidationError(`Identity "${role}" name is too long.`);
    }
    if (!["shared", "individual", "not-configured"].includes(value.mailboxType)) {
      throw new ActionCenterIdentityValidationError(`Identity "${role}" mailboxType is invalid.`);
    }
    if (value.mailboxType === "not-configured" && value.name?.trim()) {
      throw new ActionCenterIdentityValidationError(
        `Identity "${role}" cannot have a name while mailboxType is not-configured.`,
      );
    }
  }
  return db.transaction(async (tx) => {
    // FOR UPDATE cannot lock a missing settings row. Serialize the first
    // write (and all subsequent writes) on a tenant/key advisory lock before
    // reading the current snapshot, so two version-1 writers cannot both
    // observe defaults and overwrite one another.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${input.organizationId}:${ACTION_CENTER_IDENTITIES_KEY}`}))`);
    const [row] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
      eq(onbSettings.organizationId, input.organizationId),
      eq(onbSettings.key, ACTION_CENTER_IDENTITIES_KEY),
    )).for("update");
    const current = parseSnapshot(row?.value ?? null);
    if (current.version !== input.expectedVersion) {
      throw new ActionCenterIdentityConflictError(
        `Named stakeholder identities changed since version ${input.expectedVersion}. Reload before saving.`,
      );
    }
    const next: ActionCenterIdentitySnapshot = {
      version: current.version + 1,
      identities: Object.fromEntries(roles.map((role) => {
        const value = input.identities[role];
        const name = value.name?.trim() || null;
        return [role, {
          name,
          mailboxType: value.mailboxType,
          source: name ? "configured" : "not-configured",
        }];
      })) as Record<ActionCenterIdentityRole, ActionCenterIdentity>,
    };
    await tx.insert(onbSettings).values({
      organizationId: input.organizationId,
      key: ACTION_CENTER_IDENTITIES_KEY,
      value: JSON.stringify(next),
    }).onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value: JSON.stringify(next), updatedAt: new Date() },
    });
    return next;
  });
}
