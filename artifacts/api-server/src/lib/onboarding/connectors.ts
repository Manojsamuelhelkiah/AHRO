import { db } from "@workspace/db";
import { onbConnectors } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";

/**
 * These are registry requirements, not provider adapters. They remain
 * activation-pending until an accountable owner completes the documented
 * approval, privacy, least-privilege and source-confirmation checks.
 */
export const ACTIVATION_PENDING_CONNECTOR_REQUIREMENTS = {
  lms: [
    "Approved vendor and onboarding-learning purpose",
    "Least-privilege service account and field mapping",
    "Privacy, retention, and voluntary-survey review",
    "Authenticated sandbox/source confirmation",
  ],
  calendar: [
    "Approved calendar provider and check-in purpose",
    "Least-privilege service account and organizer/attendee mapping",
    "Privacy, retention, and scheduling-consent review",
    "Authenticated sandbox/source confirmation",
  ],
} as const;

type ConnectorDefault = {
  key: string;
  label: string;
  vendor: string;
  availableVendors: string[];
  status?: string;
  description: string;
  authoritativeFor: string[];
};

export const CONNECTOR_DEFAULTS: readonly ConnectorDefault[] = [
  {
    key: "ats",
    label: "ATS / Recruiting",
    vendor: "Greenhouse (simulated)",
    availableVendors: ["Greenhouse (simulated)", "Lever (simulated)", "SAP SuccessFactors Recruiting (simulated)"],
    description: "Authoritative trigger source: offer accepted / pre-hire record created.",
    authoritativeFor: ["offer status", "joining date", "recruiter"],
  },
  {
    key: "hris",
    label: "HRIS / Core HR",
    vendor: "Workday (simulated)",
    availableVendors: ["Workday (simulated)", "SAP SuccessFactors (simulated)", "BambooHR (simulated)"],
    description: "System of record for worker identity, category, role and org placement.",
    authoritativeFor: ["worker identity", "worker category", "role", "manager", "legal entity"],
  },
  {
    key: "identity",
    label: "Identity & Access (IAM)",
    vendor: "Okta (simulated)",
    availableVendors: ["Okta (simulated)", "Microsoft Entra ID (simulated)", "Ping Identity (simulated)"],
    description: "Corporate identity, SSO and application access provisioning coordination.",
    authoritativeFor: ["corporate identity", "application access", "email account"],
  },
  {
    key: "payroll",
    label: "Payroll & Benefits",
    vendor: "ADP GlobalView (simulated)",
    availableVendors: ["ADP GlobalView (simulated)", "SAP Payroll (simulated)", "Local payroll bureau (simulated)"],
    description: "Payroll, bank, tax and benefits activation readiness per geography.",
    authoritativeFor: ["payroll readiness", "bank & tax inputs", "benefits enrolment"],
  },
  {
    key: "itsm",
    label: "ITSM / Ticketing",
    vendor: "ServiceNow (simulated)",
    availableVendors: ["ServiceNow (simulated)", "Jira Service Management (simulated)", "BMC Helix (simulated)"],
    description: "Access provisioning tickets; System Watcher polls request status on a schedule.",
    authoritativeFor: ["access provisioning status", "ticket state"],
  },
  {
    key: "lms",
    label: "Learning (LMS)",
    vendor: "Not activated",
    availableVendors: [],
    status: "activation-pending",
    description: "Activation-pending LMS requirement. No provider adapter, credential, polling, webhook, or simulated completion is configured. Requires: approved vendor/purpose; least-privilege mapping; privacy/retention/voluntary-survey review; authenticated sandbox/source confirmation.",
    authoritativeFor: ["learning assignments", "compliance training status"],
  },
  {
    key: "calendar",
    label: "Calendar / Check-ins",
    vendor: "Not activated",
    availableVendors: [],
    status: "activation-pending",
    description: "Activation-pending calendar requirement. No provider adapter, credential, polling, webhook, or simulated completion is configured. Requires: approved provider/purpose; least-privilege organizer/attendee mapping; privacy/retention/scheduling-consent review; authenticated sandbox/source confirmation.",
    authoritativeFor: ["manager check-in scheduling", "check-in delivery confirmation"],
  },
  {
    key: "bgv",
    label: "Background Verification",
    vendor: "HireRight (simulated)",
    availableVendors: ["HireRight (simulated)", "First Advantage (simulated)", "Sterling (simulated)"],
    description: "BGV status feed; exceptions hard-block readiness for human review.",
    authoritativeFor: ["BGV status"],
  },
  {
    key: "esignature",
    label: "E-Signature & Documents",
    vendor: "DocuSign (simulated)",
    availableVendors: ["DocuSign (simulated)", "Adobe Sign (simulated)"],
    description: "Statutory forms, policy acknowledgements and contract signature tracking.",
    authoritativeFor: ["document completion status"],
  },
];

/** Idempotently seed the pluggable connector slots. */
export async function ensureConnectorsSeeded(organizationId: string) {
  const existing = await db.select({ key: onbConnectors.key }).from(onbConnectors)
    .where(eq(onbConnectors.organizationId, organizationId));
  const have = new Set(existing.map((r) => r.key));
  const missing = CONNECTOR_DEFAULTS.filter((d) => !have.has(d.key));
  if (missing.length > 0) {
    await db.insert(onbConnectors).values(
      missing.map((d) => ({
        ...d,
        organizationId,
        status: d.status ?? "connected",
        configurationProvenance: "simulated" as const,
        // No integration exists for activation-pending registry requirements,
        // so a synthetic sync timestamp would be misleading.
        lastSyncAt: d.status === "activation-pending" ? null : new Date(),
      })),
    );
  }
  // Earlier demo data exposed a simulated LMS as connected. It was never a
  // provider adapter, so convert only that explicitly simulated registry row
  // to the activation-pending contract; a trusted provider configuration is
  // never overwritten by seed maintenance.
  await Promise.all(
    CONNECTOR_DEFAULTS
      .filter((definition) => definition.status === "activation-pending")
      .map((definition) => db
        .update(onbConnectors)
        .set({
          vendor: definition.vendor,
          availableVendors: definition.availableVendors,
          status: definition.status!,
          description: definition.description,
          authoritativeFor: definition.authoritativeFor,
          lastSyncAt: null,
        })
        .where(and(
          eq(onbConnectors.organizationId, organizationId),
          eq(onbConnectors.key, definition.key),
          eq(onbConnectors.configurationProvenance, "simulated"),
        )),
      ),
  );
}
