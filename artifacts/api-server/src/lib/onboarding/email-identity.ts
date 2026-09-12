/**
 * Shared identity/copy primitives for onboarding email.  An email address is
 * a delivery mechanism, not a person's identity: callers must provide the
 * intended stakeholder name and role independently and must never derive a
 * name from an address.
 */

export type EmailDeliveryMode = "real" | "simulated";
export type RequesterKind = "human" | "agent" | "shared-mailbox";

export type NamedStakeholder = {
  /** A configured display name. Never infer this from deliveryAddress. */
  name: string;
  /** The stakeholder's intended business role. */
  role: string;
};

export type ActionIdentityStakeholderKey =
  | "approver"
  | "hr"
  | "bgvTeam"
  | "recruiter"
  | "hiringManager"
  | "compliance"
  | "candidate";

export type NamedStakeholders = Partial<
  Record<ActionIdentityStakeholderKey, NamedStakeholder>
>;

export type ActionIdentityConfig = {
  version: 1;
  stakeholders: NamedStakeholders;
};

// Kept in sync with the additive Action Center GET/PUT identity contract.
export const ACTION_IDENTITY_SETTING_KEY = "action_center:identities";
export const DEFAULT_ACTION_PATH = "/approvals";
/** Verified published origin for the current application (not a dev domain). */
export const VERIFIED_PUBLIC_APP_ORIGIN = "https://hro-agent-nexus.replit.app";
export const PUBLIC_APP_ORIGIN_ENV_KEY = "ONBOARDING_PUBLIC_APP_ORIGIN";

function clean(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

/**
 * Parse the additive named-stakeholder setting without turning malformed
 * optional configuration into an invented identity. Invalid entries are
 * ignored and therefore continue to require explicit configuration in copy.
 */
export function parseActionIdentityConfig(raw: string | null | undefined): ActionIdentityConfig {
  if (!raw) return { version: 1, stakeholders: {} };
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      stakeholders?: unknown;
      identities?: unknown;
    };
    const source = parsed.stakeholders ?? parsed.identities;
    if (!Number.isSafeInteger(parsed.version) || (parsed.version as number) < 1 ||
        !source || typeof source !== "object") {
      return { version: 1, stakeholders: {} };
    }
    const stakeholders: NamedStakeholders = {};
    for (const key of [
      "approver",
      "hr",
      "bgvTeam",
      "recruiter",
      "hiringManager",
      "compliance",
      "candidate",
    ] as const) {
      const candidate = (source as Record<string, unknown>)[key];
      if (!candidate || typeof candidate !== "object") continue;
      const value = candidate as Record<string, unknown>;
      if (typeof value.name !== "string" || !value.name.trim()) {
        continue;
      }
      stakeholders[key] = {
        name: value.name.trim(),
        // The Action Center contract stores roles as keys and mailbox type;
        // copy callers supply a more precise role label where appropriate.
        role: typeof value.role === "string" && value.role.trim()
          ? value.role.trim()
          : key,
      };
    }
    return { version: 1, stakeholders };
  } catch {
    return { version: 1, stakeholders: {} };
  }
}

export function identityForRole(
  role: ActionIdentityStakeholderKey,
  configured: NamedStakeholders | undefined,
  existingName?: string | null,
  existingRole?: string,
): NamedStakeholder {
  const configuredIdentity = configured?.[role];
  const configuredRole = clean(configuredIdentity?.role);
  return {
    name: clean(configuredIdentity?.name) || clean(existingName) || "",
    // Action Center's role-keyed snapshot commonly stores the key itself
    // (for example "hr"), which is not a human-readable role label.
    role: configuredRole && configuredRole !== role
      ? configuredRole
      : clean(existingRole) || role,
  };
}

/** Resolve the approval persona from the tenant Action Center snapshot. */
export function approvalStakeholderFromActionIdentity(
  raw: string | null | undefined,
): NamedStakeholder {
  const configured = parseActionIdentityConfig(raw).stakeholders;
  const stakeholder = configured.hr ?? configured.approver;
  if (!stakeholder) {
    return { name: "", role: "HR approval stakeholder" };
  }
  return {
    name: stakeholder.name,
    role: stakeholder.role === "hr" || stakeholder.role === "approver"
      ? "HR approval stakeholder"
      : stakeholder.role,
  };
}

function validatedPublicOrigin(value: string | null | undefined): string | null {
  const raw = clean(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase();
    const privateIpv4 = /^(10|127|169\.254|192\.168)\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
        parsed.pathname !== "/" || parsed.search || parsed.hash ||
        hostname === "localhost" ||
        hostname === "[::1]" ||
        hostname === "::1" ||
        hostname.endsWith(".local") ||
        hostname.endsWith(".internal") ||
        privateIpv4) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function publicAppOrigin(): string {
  return validatedPublicOrigin(
    typeof process === "undefined"
      ? null
      : process.env[PUBLIC_APP_ORIGIN_ENV_KEY],
  ) ?? VERIFIED_PUBLIC_APP_ORIGIN;
}

/**
 * Produce a clickable published Action Center URL. Absolute HTTPS inputs are
 * accepted after validation; relative paths resolve against the configured
 * published origin. Unsafe/protocol-relative values fall back to the safe
 * default instead of being emitted into an email.
 */
export function formatAppLink(path = DEFAULT_ACTION_PATH): string {
  const trimmed = clean(path);
  if (/^https:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (validatedPublicOrigin(parsed.origin)) return parsed.toString();
    } catch {
      // Fall through to the safe published default.
    }
  }
  const relative = trimmed && !trimmed.startsWith("//") &&
    !/^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ? (trimmed.startsWith("/") ? trimmed : `/${trimmed}`)
    : DEFAULT_ACTION_PATH;
  return `${publicAppOrigin()}${relative}`;
}

export type EmailIdentityLinesInput = {
  stakeholder: NamedStakeholder;
  /** The actual address used (or intended) for delivery, kept separate. */
  deliveryAddress?: string | null;
  requestedBy: string;
  requestedByKind: RequesterKind;
  deliveryMode: EmailDeliveryMode;
  /** Human-readable action, not a generic "review this" if a specific action is known. */
  actionRequired: string;
  reference: string;
  appPath?: string;
  /** Use a safe in-app navigation instruction instead of inventing an origin. */
  appNavigation?: string;
  /** `queued` is useful before a provider reports its outcome. */
  deliveryState?: "queued" | "sent" | "not-sent";
};

/**
 * Return a stable, plain-text identity block for all outbound copy.
 *
 * A missing configured name remains explicit and points at the named
 * stakeholder settings contract; it is never replaced with a guessed person.
 */
export function formatEmailIdentityLines(input: EmailIdentityLinesInput): string[] {
  const name = clean(input.stakeholder.name);
  const role = clean(input.stakeholder.role) || "stakeholder";
  const address = clean(input.deliveryAddress);
  const requestedBy = clean(input.requestedBy) || "unnamed requester";
  const state = input.deliveryState ?? (input.deliveryMode === "simulated" ? "not-sent" : "queued");
  const modeLabel = input.deliveryMode === "simulated"
    ? "SIMULATED — no email was sent"
    : state === "sent"
      ? "REAL — provider reported sent"
      : state === "not-sent"
        ? "REAL PATH — not sent (authorization or policy blocked)"
      : "REAL PATH — provider delivery pending";
  return [
    `Intended stakeholder: ${name || "Name not configured"} — ${role}`,
    ...(name
      ? []
      : ["Configure the named stakeholder in the Action identity settings (name and role); do not infer it from the delivery address."]),
    `Actual delivery address: ${address || (input.deliveryMode === "simulated" ? "none — simulation only" : "not available")}`,
    `Requested by: ${requestedBy} (${input.requestedByKind})`,
    `Delivery status: ${modeLabel}`,
    `Action required: ${input.actionRequired}`,
    `Reference: ${input.reference}`,
    input.appNavigation
      ? `App navigation: ${input.appNavigation}`
      : `App link: ${formatAppLink(input.appPath)}`,
  ];
}

/**
 * Inbound approval mail comes from the configured shared mailbox. This label
 * deliberately does not claim that a verified named human authored the reply.
 */
export function sharedMailboxResponderIdentity(address: string): string {
  const actual = clean(address);
  return actual
    ? `Shared mailbox responder (${actual}; exact allowlisted sender)`
    : "Shared mailbox responder (exact allowlisted sender)";
}