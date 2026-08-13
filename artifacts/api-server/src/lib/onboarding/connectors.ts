import { db } from "@workspace/db";
import { onbConnectors } from "@workspace/db/schema";

export const CONNECTOR_DEFAULTS = [
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
    vendor: "Cornerstone (simulated)",
    availableVendors: ["Cornerstone (simulated)", "SAP Litmos (simulated)", "Docebo (simulated)"],
    description: "Induction, compliance learning and role-readiness path assignment.",
    authoritativeFor: ["learning assignments", "compliance training status"],
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

let seeded = false;

/** Idempotently seed the pluggable connector slots. */
export async function ensureConnectorsSeeded() {
  if (seeded) return;
  const existing = await db.select({ key: onbConnectors.key }).from(onbConnectors);
  const have = new Set(existing.map((r) => r.key));
  const missing = CONNECTOR_DEFAULTS.filter((d) => !have.has(d.key));
  if (missing.length > 0) {
    await db.insert(onbConnectors).values(
      missing.map((d) => ({
        ...d,
        status: "connected",
        lastSyncAt: new Date(),
      })),
    );
  }
  seeded = true;
}
