/**
 * Working register derived from the uploaded source document
 * BRD_Employee_Onboarding_AHRO_V1_1789151771455.docx.
 *
 * This is a seed catalog, not a tenant policy. In particular, its provisional
 * values do not overwrite a tenant's approved settings or authorize a live
 * provider or employment action.
 */

export type GovernancePriority = "must" | "should" | "conditional";
export type GovernanceCoverage = "gap" | "partial" | "covered";
export type GovernanceImplementationState = "not-implemented" | "partial" | "implemented";
export type GovernanceTestState = "not-tested" | "test-source-present";
export type GovernanceConfigurationState = "not-configured" | "tenant-configured";
export type GovernanceLiveApprovalState = "not-approved" | "approved";
export type GovernanceDecisionStatus =
  | "draft"
  | "provisional"
  | "approved"
  | "rejected"
  | "superseded";
export type GovernanceActivationScope =
  | "development-and-simulation"
  | "affected-live-actions-blocked";

/** Deliberately independent delivery facts: one affirmative state implies none of the others. */
export type GovernanceDeliveryState = {
  implementation: GovernanceImplementationState;
  tested: GovernanceTestState;
  configured: GovernanceConfigurationState;
  approvedForLive: GovernanceLiveApprovalState;
};

export type GovernanceRequirement = {
  id: string;
  title: string;
  priority: GovernancePriority;
  /** Stable human-readable source-document references, including appendix section/table rows. */
  sourceRefs: readonly string[];
  coverage: GovernanceCoverage;
  implementationRefs: readonly string[];
  /** Evidence references point to source tests or controls; they do not claim tests were run. */
  evidenceRefs: readonly string[];
  reviewOwner: string;
  deliveryState: GovernanceDeliveryState;
};

export type GovernanceDecisionRevision = {
  revision: number;
  status: GovernanceDecisionStatus;
  proposedValue: string;
  rationale: string;
  risks: readonly string[];
  accountableReviewRole: string;
  reviewDueDate: string | null;
  approvedRevision: number | null;
  impactedWorkflows: readonly string[];
};

export type GovernanceDecision = {
  id: string;
  title: string;
  proposedValue: string;
  rationale: string;
  risks: readonly string[];
  accountableReviewRole: string;
  status: GovernanceDecisionStatus;
  reviewDueDate: string | null;
  /** Null means that no revision has been approved for live use. */
  approvedRevision: number | null;
  impactedWorkflows: readonly string[];
  sourceRefs: readonly string[];
  activationScope: GovernanceActivationScope;
  revisions: readonly GovernanceDecisionRevision[];
};

const NOT_STARTED: GovernanceDeliveryState = {
  implementation: "not-implemented",
  tested: "not-tested",
  configured: "not-configured",
  approvedForLive: "not-approved",
};

const PARTIAL_WITH_TEST_SOURCE: GovernanceDeliveryState = {
  implementation: "partial",
  tested: "test-source-present",
  configured: "not-configured",
  approvedForLive: "not-approved",
};

const IMPLEMENTED_WITH_TEST_SOURCE: GovernanceDeliveryState = {
  implementation: "implemented",
  tested: "test-source-present",
  configured: "not-configured",
  approvedForLive: "not-approved",
};

function requirement(
  id: string,
  title: string,
  priority: GovernancePriority,
  sourceRefs: readonly string[],
  coverage: GovernanceCoverage,
  implementationRefs: readonly string[],
  evidenceRefs: readonly string[],
  reviewOwner: string,
  deliveryState: GovernanceDeliveryState,
): GovernanceRequirement {
  return {
    id,
    title,
    priority,
    sourceRefs,
    coverage,
    implementationRefs,
    evidenceRefs,
    reviewOwner,
    deliveryState,
  };
}

/**
 * Core source-document requirements plus every operational, data, hard-gate, and
 * compliance obligation stated in Appendices A and B.  A "partial" entry
 * identifies reusable implementation only; it never represents production
 * configuration, legal applicability, provider activation, or live approval.
 */
export const GOVERNANCE_REQUIREMENTS: readonly GovernanceRequirement[] = [
  requirement("REQ-01", "Create an onboarding case and pre-boarding checklist on offer acceptance.", "must",
    ["BRD §8, REQ-01"], "partial",
    ["src/lib/onboarding/batch-intake.ts", "src/lib/onboarding/documents.ts"],
    ["src/lib/onboarding/batch-intake.test.ts"], "HR Operations",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("REQ-02", "Validate mandatory new-hire documents and chase deficiencies.", "must",
    ["BRD §8, REQ-02", "BRD §4.2, Steps 02–03"], "partial",
    ["src/lib/onboarding/documents.ts", "src/lib/onboarding/document-readiness-guard.ts", "src/lib/onboarding/document-validation-policy.ts"],
    ["src/lib/onboarding/document-validation.test.ts", "src/lib/onboarding/document-malware.test.ts"], "HR Operations",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("REQ-03", "Initiate and track BGV against SLA with reminders.", "must",
    ["BRD §8, REQ-03", "BRD §4.6, Background Verification"], "partial",
    ["src/lib/onboarding/workstream-connectors.ts", "src/lib/onboarding/bgv-notifications.ts", "src/lib/onboarding/readiness-sla-policy.ts"],
    ["src/lib/onboarding/bgv-notifications.test.ts", "src/lib/onboarding/readiness-sla-worker.test.ts"], "HR Operations / BGV owner",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("REQ-04", "Route BGV discrepancies to HR/Compliance for human disposition.", "must",
    ["BRD §8, REQ-04", "BRD §10, BR-05"], "partial",
    ["src/lib/onboarding/bgv-notifications.ts", "src/lib/onboarding/approval-decisions.ts"],
    ["src/lib/onboarding/bgv-notifications.test.ts", "src/lib/onboarding/approver-email.test.ts"], "HR Compliance",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("REQ-05", "Create an Oracle HCM employee record on clearance.", "must",
    ["BRD §8, REQ-05", "BRD §9.1, Oracle HCM"], "gap",
    [], [], "HRIS owner", NOT_STARTED),
  requirement("REQ-06", "Raise IT, asset, and role-based access requests through the service catalogue.", "must",
    ["BRD §8, REQ-06", "BRD §9.1, IT Service Catalogue / ITSM"], "partial",
    ["src/lib/onboarding/workstream-connectors.ts", "src/lib/onboarding/dispatch-guard.ts"],
    ["src/lib/onboarding/workstream-connectors.test.ts", "src/lib/onboarding/gateway-guards.test.ts"], "IT / Asset Management",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("REQ-07", "Configure payroll and benefits enrolment validated against HRIS.", "must",
    ["BRD §8, REQ-07", "BRD §4.2, Step 08"], "partial",
    ["src/lib/onboarding/workstream-connectors.ts", "src/lib/onboarding/readiness-sla-policy.ts"],
    ["src/lib/onboarding/workstream-connectors.test.ts", "src/lib/onboarding/readiness-sla.test.ts"], "Payroll & Benefits",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("REQ-08", "Maintain a live five-workstream readiness score.", "must",
    ["BRD §8, REQ-08", "BRD §4.6"], "covered",
    ["src/lib/onboarding/readiness-sla.ts", "src/lib/onboarding/readiness-sla-policy.ts"],
    ["src/lib/onboarding/readiness-sla.test.ts", "src/lib/onboarding/readiness-sla-worker.test.ts"], "HR Operations",
    IMPLEMENTED_WITH_TEST_SOURCE),
  requirement("REQ-09", "Enforce a Day-1 readiness checkpoint with BGV clearance.", "must",
    ["BRD §8, REQ-09", "BRD §10, BR-04"], "partial",
    ["src/lib/onboarding/readiness-sla-policy.ts", "src/lib/onboarding/approval-version.ts"],
    ["src/lib/onboarding/gateway-guards.test.ts", "src/lib/onboarding/approval-versioning.test.ts"], "HR Process Owner",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("REQ-10", "Provide guided Day-1 induction and mandatory compliance-training enrolment.", "should",
    ["BRD §8, REQ-10", "BRD §4.2, Step 10"], "gap",
    [], [], "HR Operations / Learning owner", NOT_STARTED),
  requirement("REQ-11", "Assign a buddy and schedule the structured manager connect.", "should",
    ["BRD §8, REQ-11", "BRD §4.2, Step 11"], "gap",
    [], [], "Hiring Manager", NOT_STARTED),
  requirement("REQ-12", "Schedule 30-60-90 check-ins and record probation confirmation.", "should",
    ["BRD §8, REQ-12", "BRD §4.2, Step 12"], "gap",
    [], [], "HRBP", NOT_STARTED),
  requirement("REQ-13", "Alert on workstream SLA breaches relative to joining date.", "must",
    ["BRD §8, REQ-13", "BRD §4.6"], "covered",
    ["src/lib/onboarding/readiness-sla.ts", "src/lib/onboarding/readiness-sla-worker.ts", "src/lib/onboarding/connected-readiness-automation.ts"],
    ["src/lib/onboarding/readiness-sla.test.ts", "src/lib/onboarding/readiness-sla-worker.test.ts"], "HR Operations",
    IMPLEMENTED_WITH_TEST_SOURCE),
  requirement("REQ-14", "Support rehire/conversion with policy-controlled reduced re-collection.", "should",
    ["BRD §8, REQ-14", "BRD §4.5.3"], "partial",
    ["src/lib/onboarding/documents.ts", "src/lib/onboarding/readiness-sla.ts"],
    ["src/lib/onboarding/readiness-sla.test.ts"], "HR Operations / HRBP",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("REQ-15", "Minimise sensitive data and restrict it by role-based need-to-know.", "must",
    ["BRD §8, REQ-15", "BRD §10, BR-03"], "partial",
    ["src/middlewares/tenant-context.ts", "src/lib/onboarding/bgv-notifications.ts"],
    ["src/routes/organization-isolation.test.ts", "src/lib/onboarding/bgv-notifications.test.ts"], "Privacy / Security",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("REQ-16", "Keep an immutable audit trail of steps, approvals, owners, and timestamps.", "must",
    ["BRD §8, REQ-16", "BRD §10, BR-06"], "partial",
    ["src/lib/onboarding/approval-version.ts", "src/lib/onboarding/effect-journal.ts", "src/lib/onboarding/action-center.ts"],
    ["src/lib/onboarding/approval-versioning.test.ts", "src/lib/onboarding/effect-journal.test.ts"], "HR Operations / Audit",
    PARTIAL_WITH_TEST_SOURCE),

  requirement("APP-A-01", "Capture role, site, shift, and skill category for frontline intake.", "conditional",
    ["BRD Appendix A §A.4, B1"], "partial",
    ["src/lib/onboarding/workforce-policies.ts", "src/lib/onboarding/checklist-profiles.ts"],
    ["src/lib/onboarding/workforce-policies.test.ts"], "Site HR", PARTIAL_WITH_TEST_SOURCE),
  requirement("APP-A-02", "Require ID, age proof, and applicable skill/trade evidence before regulated deployment.", "conditional",
    ["BRD Appendix A §A.4, GW-A", "BRD Appendix A §A.5, Age Proof and Trade / Skill Certificate"], "partial",
    ["src/lib/onboarding/workforce-policies.ts", "src/lib/onboarding/document-readiness-guard.ts"],
    ["src/lib/onboarding/workforce-safety.integration.test.ts"], "Site HR / Compliance", PARTIAL_WITH_TEST_SOURCE),
  requirement("APP-A-03", "Perform police verification only where policy and lawful applicability require it.", "conditional",
    ["BRD Appendix A §A.4, B3", "BRD Appendix A §A.5, Police Verification"], "gap",
    [], [], "Legal / Site Security", NOT_STARTED),
  requirement("APP-A-04", "Require medical fitness evidence before floor/site deployment.", "conditional",
    ["BRD Appendix A §A.4, B4 and GW-B", "BRD Appendix A §A.5, Medical Fitness Certificate", "BRD Appendix A §A.9, Occupational health & safety"], "partial",
    ["src/lib/onboarding/workforce-policies.ts", "src/lib/onboarding/workforce-step-runtime.ts"],
    ["src/lib/onboarding/workforce-safety.integration.test.ts", "src/lib/onboarding/workforce-step-runtime.test.ts"], "Occupational Health",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("APP-A-05", "Require drug-test evidence only where policy and lawful applicability require it.", "conditional",
    ["BRD Appendix A §A.4, B4", "BRD Appendix A §A.5, Drug-Test Result"], "gap",
    [], [], "Occupational Health / Legal", NOT_STARTED),
  requirement("APP-A-06", "Require both medically-fit and BGV-clear outcomes; route failures to HR/OH review.", "conditional",
    ["BRD Appendix A §A.4, GW-B"], "partial",
    ["src/lib/onboarding/workforce-policies.ts", "src/lib/onboarding/bgv-notifications.ts"],
    ["src/lib/onboarding/workforce-safety.integration.test.ts", "src/lib/onboarding/bgv-notifications.test.ts"], "Occupational Health / HR",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("APP-A-07", "Record statutory worker IDs only where applicable before first wage processing.", "conditional",
    ["BRD Appendix A §A.4, B5", "BRD Appendix A §A.5, Bank / UAN / ESIC", "BRD Appendix A §A.9, Social security"], "gap",
    [], [], "Payroll / Compliance", NOT_STARTED),
  requirement("APP-A-08", "Issue and record badge, PPE, uniform, tools, and locker prerequisites before floor access.", "conditional",
    ["BRD Appendix A §A.4, B6", "BRD Appendix A §A.6"], "partial",
    ["src/lib/onboarding/workforce-policies.ts", "src/lib/onboarding/workforce-step-runtime.ts"],
    ["src/lib/onboarding/workforce-safety.integration.test.ts"], "Site HR / Stores", PARTIAL_WITH_TEST_SOURCE),
  requirement("APP-A-09", "Use wage/timesheet setup and applicable statutory payroll registration.", "conditional",
    ["BRD Appendix A §A.4, B7", "BRD Appendix A §A.9, Wages & hours"], "partial",
    ["src/lib/onboarding/workstream-connectors.ts", "src/lib/onboarding/workforce-step-runtime.ts"],
    ["src/lib/onboarding/workstream-connectors.test.ts", "src/lib/onboarding/workforce-step-runtime.test.ts"], "Payroll / Compliance",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("APP-A-10", "Require safety induction and competency sign-off before floor/site access.", "conditional",
    ["BRD Appendix A §A.4, B8 and GW-C", "BRD Appendix A §A.2, Training gate"], "partial",
    ["src/lib/onboarding/workforce-policies.ts", "src/lib/onboarding/workforce-step-runtime.ts"],
    ["src/lib/onboarding/workforce-safety.integration.test.ts", "src/lib/onboarding/workforce-step-runtime.test.ts"], "EHS / Supervisor",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("APP-A-11", "Capture PPE size and next-of-kin/emergency-contact data only through an approved, minimised process.", "conditional",
    ["BRD Appendix A §A.5, PPE Size Details and Next of Kin / Emergency Contact"], "gap",
    [], [], "Site HR / Privacy", NOT_STARTED),
  requirement("APP-A-12", "Apply age, labour, wage/hour, social-security, and contractor-labour obligations only after jurisdiction/contract review.", "conditional",
    ["BRD Appendix A §A.9, all rows"], "partial",
    ["src/lib/onboarding/workforce-policies.ts"],
    ["src/lib/onboarding/workforce-policies.test.ts"], "Legal / Compliance", PARTIAL_WITH_TEST_SOURCE),
  requirement("APP-A-13", "Retain PPE issuance, safety sign-off, fitness certificates, and IDs as auditable evidence.", "conditional",
    ["BRD Appendix A §A.9, Records & audit"], "partial",
    ["src/lib/onboarding/workforce-step-runtime.ts", "src/lib/onboarding/action-center.ts"],
    ["src/lib/onboarding/workforce-step-runtime.test.ts"], "EHS / Audit", PARTIAL_WITH_TEST_SOURCE),
  requirement("APP-A-14", "Keep medical/safety hard gates independent of the weighted readiness score.", "conditional",
    ["BRD Appendix A §A.7"], "partial",
    ["src/lib/onboarding/workforce-policies.ts", "src/lib/onboarding/readiness-sla.ts"],
    ["src/lib/onboarding/workforce-safety.integration.test.ts", "src/lib/onboarding/readiness-sla.test.ts"], "EHS / Occupational Health",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("APP-A-15", "Handle medical restriction, failed safety competency, PPE stock-out, missing evidence, and surge intake without releasing floor access.", "conditional",
    ["BRD Appendix A §A.10, exception rows"], "partial",
    ["src/lib/onboarding/workforce-policies.ts", "src/lib/onboarding/batch-intake.ts"],
    ["src/lib/onboarding/workforce-safety.integration.test.ts", "src/lib/onboarding/batch-intake.test.ts"], "Site HR / EHS",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("APP-A-16", "Support assisted site intake for low-literacy workers and verify applicable right-to-work evidence before deployment.", "conditional",
    ["BRD Appendix A §A.1", "BRD Appendix A §A.2, Document intake and Identity & eligibility"], "gap",
    [], [], "Site HR / Legal", NOT_STARTED),
  requirement("APP-A-17", "Assign the frontline supervisor and buddy, record on-job or machine-SOP training, and complete probation confirmation.", "conditional",
    ["BRD Appendix A §A.4, B9-B11", "BRD Appendix A §A.2, First-line owner and Induction"], "gap",
    [], [], "Supervisor / Site HR", NOT_STARTED),
  requirement("APP-A-18", "Manage transport and canteen enrolment where site welfare services are provided.", "conditional",
    ["BRD Appendix A §A.6, Transport / Canteen enrolment"], "gap",
    [], [], "Site HR / Facilities", NOT_STARTED),
  requirement("APP-A-19", "Verify minimum working age and block under-age deployment before any regulated floor or site release.", "conditional",
    ["BRD Appendix A §A.9, Age & child- labour"], "partial",
    ["src/lib/onboarding/workforce-policies.ts", "src/lib/onboarding/document-readiness-guard.ts"],
    ["src/lib/onboarding/workforce-policies.test.ts", "src/lib/onboarding/workforce-safety.integration.test.ts"], "Site HR / Compliance",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("APP-A-20", "Track frontline cycle-time, medical turnaround, safety completion, PPE issuance, statutory-registration, and early-attrition measures as reviewable policy metrics.", "conditional",
    ["BRD Appendix A §A.10, Floor-Ready Cycle Time; Medical Fitness Turnaround; Safety Induction Completion; PPE Issuance Compliance; Statutory Registration Timeliness; Early (0-30 day) Attrition"], "gap",
    [], [], "Site HR / EHS / Payroll", NOT_STARTED),
  requirement("APP-A-21", "Evaluate frontline documentation, BGV/police, medical/drug, provisioning, wage/statutory-payroll, and HSE workstreams separately, with medical and safety hard gates before floor-ready status.", "conditional",
    ["BRD Appendix A §A.7, Workstream table"], "partial",
    ["src/lib/onboarding/readiness-sla.ts", "src/lib/onboarding/workforce-policies.ts"],
    ["src/lib/onboarding/readiness-sla.test.ts", "src/lib/onboarding/workforce-safety.integration.test.ts"], "Site HR / EHS / Occupational Health",
    PARTIAL_WITH_TEST_SOURCE),
  requirement("APP-A-22", "Assign and preserve the frontline RACI responsibilities for intake, verification, medical review, provisioning, payroll, safety sign-off, and on-job training.", "conditional",
    ["BRD Appendix A §A.8, RACI Adjustments"], "gap",
    [], [], "Site HR / EHS / Payroll", NOT_STARTED),

  requirement("APP-B-01", "Perform secure HR due diligence over headcount, terms, service, and liabilities.", "conditional",
    ["BRD Appendix B §B.4, M1", "BRD Appendix B §B.5"], "gap",
    [], [], "HR Integration / Legal", NOT_STARTED),
  requirement("APP-B-02", "Determine transfer basis and applicable law before selecting a transfer pathway.", "conditional",
    ["BRD Appendix B §B.1", "BRD Appendix B §B.4, M2 and GW-A"], "gap",
    [], [], "Legal", NOT_STARTED),
  requirement("APP-B-03", "Complete required representative/works-council consultation on the applicable statutory timeline.", "conditional",
    ["BRD Appendix B §B.4, M3", "BRD Appendix B §B.7, Inform & consult"], "gap",
    [], [], "Legal / HR Integration", NOT_STARTED),
  requirement("APP-B-04", "Issue individual transfer communications and measures information after legal review.", "conditional",
    ["BRD Appendix B §B.4, M4"], "gap",
    [], [], "HR Integration / Legal", NOT_STARTED),
  requirement("APP-B-05", "Handle objections, opt-outs, redundancy, and terms changes under the applicable law and approved policy.", "conditional",
    ["BRD Appendix B §B.4, GW-B", "BRD Appendix B §B.7, No transfer-connected dismissal and Objection / opt-out"], "gap",
    [], [], "Legal", NOT_STARTED),
  requirement("APP-B-06", "Bulk-create transfer records while preserving validated original hire/service dates.", "conditional",
    ["BRD Appendix B §B.4, M5", "BRD Appendix B §B.5, Original hire / service dates", "BRD Appendix B §B.7, Continuity of service"], "gap",
    [], [], "HRIS owner / HR Integration", NOT_STARTED),
  requirement("APP-B-07", "Cut over payroll, benefits, and access at legal Day-1 with no unreviewed pay-disruption release.", "conditional",
    ["BRD Appendix B §B.4, M6 and GW-C", "BRD Appendix B §B.5, Compensation & benefits and Payroll & bank data"], "gap",
    [], [], "Payroll / IT / Benefits", NOT_STARTED),
  requirement("APP-B-08", "Use a legally reviewed contingency for failed transfer cutover and preserve the evidence.", "conditional",
    ["BRD Appendix B §B.4, GW-C"], "gap",
    [], [], "HR Integration / Payroll / Legal", NOT_STARTED),
  requirement("APP-B-09", "Deliver transfer integration induction and approved post-transfer harmonisation.", "conditional",
    ["BRD Appendix B §B.4, M7–M8"], "gap",
    [], [], "HR Integration / Legal", NOT_STARTED),
  requirement("APP-B-10", "Lawfully minimise and secure seller employee data and address applicable pension/benefit obligations.", "conditional",
    ["BRD Appendix B §B.5, data rows", "BRD Appendix B §B.7, Data protection and Pension / benefits"], "gap",
    [], [], "Privacy / Legal / Benefits", NOT_STARTED),
  requirement("APP-B-11", "Confirm workforce stabilisation and track Day-1 pay, migration accuracy, consultation, access-cutover, attrition, and harmonisation measures for a transfer.", "conditional",
    ["BRD Appendix B §B.4, M9", "BRD Appendix B §B.7, Day-1 Pay Continuity; Record Migration Accuracy; Consultation Compliance; Access Cutover On-Time; Transfer-Related Attrition (0-90d); Harmonisation Completion"], "gap",
    [], [], "HR Integration / Legal / Payroll", NOT_STARTED),
  requirement("APP-B-12", "Assign and preserve transfer RACI responsibilities for due diligence, legal basis, consultation, communications, objections, migration, cutover, and harmonisation.", "conditional",
    ["BRD Appendix B §B.6, RACI (Transfer-Specific)"], "gap",
    [], [], "HR Integration / Legal / Payroll / IT", NOT_STARTED),
] as const;

function provisionalDecision(
  id: string,
  title: string,
  proposedValue: string,
  rationale: string,
  risks: readonly string[],
  accountableReviewRole: string,
  impactedWorkflows: readonly string[],
  sourceRefs: readonly string[],
  activationScope: GovernanceActivationScope,
): GovernanceDecision {
  const revision: GovernanceDecisionRevision = {
    revision: 1,
    status: "provisional",
    proposedValue,
    rationale,
    risks,
    accountableReviewRole,
    reviewDueDate: null,
    approvedRevision: null,
    impactedWorkflows,
  };
  return {
    id,
    title,
    proposedValue,
    rationale,
    risks,
    accountableReviewRole,
    status: "provisional",
    reviewDueDate: null,
    approvedRevision: null,
    impactedWorkflows,
    sourceRefs,
    activationScope,
    revisions: [revision],
  };
}

/**
 * Explicitly provisional development seeds.  The future governed register
 * stores later revisions; this catalog intentionally starts every decision at
 * revision 1 with no approved revision and no invented review date.
 */
export const GOVERNANCE_DECISIONS: readonly GovernanceDecision[] = [
  provisionalDecision(
    "GD-01", "Working policy baseline and unresolved source labels",
    "Use the uploaded source document as the working policy baseline; retain its conflicting version labels (2.0, 1.0/1.1, and footer 1.2) as unresolved.",
    "The source document is Draft for Review and its own front matter conflicts.",
    ["Implementing a label as an approved revision", "misrepresenting draft content as signed off"],
    "HR Process Owner", ["requirements mapping", "all onboarding workflows"],
    ["BRD document control/front matter", "BRD §1.1–§1.2"], "development-and-simulation",
  ),
  provisionalDecision(
    "GD-02", "Five-stream readiness model",
    "Preserve Documentation 20%, BGV 25%, HRIS 15%, IT & assets 20%, Payroll 20%; Green 100%, Amber 80–99%, Red below 80%.",
    "The working policy baseline states these readiness weights and tiers, which match the current scoring implementation.",
    ["A score can be mistaken for safety, legal, provider, or approval clearance"],
    "HR Process Owner", ["readiness SLA", "Day-1 Readiness", "alerts"],
    ["BRD §4.6", "BRD §8, REQ-08 and REQ-13"], "development-and-simulation",
  ),
  provisionalDecision(
    "GD-03", "Standard Day-1 evidence and final approval",
    "Require complete mandatory evidence and a fresh HR final approval before a real Day-1 release.",
    "The source document requires mandatory workstreams and BGV at Day-1 Readiness; current approval versioning already reopens changed evidence.",
    ["Evidence or approval may be stale", "a readiness score alone could be treated as release authority"],
    "HR Process Owner", ["Day-1 Readiness", "access release", "asset release", "Day-1 review"],
    ["BRD §8, REQ-09", "BRD §10, BR-04 and BR-07"], "affected-live-actions-blocked",
  ),
  provisionalDecision(
    "GD-04", "Conditional-join exceptions",
    "Disable conditional-join exceptions until an approved tenant policy defines them.",
    "The source document permits a conditional join only when approved by policy; none is supplied by the working policy baseline.",
    ["Uncleared workers receiving real access or assets", "unreviewed employment or safety decisions"],
    "HR Compliance", ["BGV", "access provisioning", "asset release", "Day-1 Readiness"],
    ["BRD §4.4, BGV delayed exception", "BRD §10, BR-01"], "affected-live-actions-blocked",
  ),
  provisionalDecision(
    "GD-05", "Standard new-hire access and asset prerequisite",
    "For standard new hires, require BGV clearance and an active HRIS record before real access or asset release.",
    "This source-document control preserves the current BGV/HRIS readiness separation.",
    ["Provider status may be simulated or stale", "HRIS may not be an active integration"],
    "HR Process Owner", ["BGV", "HRIS", "IT/asset provisioning", "Day-1 Readiness"],
    ["BRD §10, BR-01", "BRD §8, REQ-05, REQ-06, and REQ-09"], "affected-live-actions-blocked",
  ),
  provisionalDecision(
    "GD-06", "Frontline medical and safety gates",
    "Keep frontline medical fitness and safety competency/sign-off as independent hard gates; do not substitute a weighted score, reminder, or agent assertion.",
    "The source document expressly makes both gates non-negotiable before floor/site access.",
    ["Jurisdiction and role applicability is unapproved", "incomplete health/safety evidence", "unsafe deployment"],
    "EHS / Occupational Health", ["frontline intake", "site/floor access", "PPE/tools issue", "workforce profiles"],
    ["BRD Appendix A §A.1, §A.4 GW-B/GW-C, §A.7"], "affected-live-actions-blocked",
  ),
  provisionalDecision(
    "GD-07", "M&A/TUPE pathway and BGV",
    "Do not automatically exempt transferring staff from BGV and do not determine TUPE/automatic-transfer status; require verified Legal authority and a jurisdiction-specific approved decision.",
    "The source document says transfer basis and BGV treatment vary by applicable law; it describes typical practice, not a portable determination.",
    ["Incorrect legal transfer classification", "unlawful processing or employment action", "loss of continuity or pay"],
    "Legal", ["M&A/TUPE intake", "bulk record migration", "BGV", "legal Day-1 cutover"],
    ["BRD §4.5.6", "BRD Appendix B §B.1–§B.2 and §B.4 M2/GW-A"], "affected-live-actions-blocked",
  ),
  provisionalDecision(
    "GD-08", "Target-system ownership",
    "Treat Oracle HCM and ServiceNow HRSD as target systems, not configured integrations; retain the existing app as orchestration/review UI pending system-ownership approval.",
    "The source document's application landscape names those systems, while current connector code tracks internal system checks rather than proving those integrations are configured.",
    ["A simulated or tracked status could be presented as a source-system effect", "unclear system-of-record ownership"],
    "HRIS / Service Management owner", ["HRIS record creation", "case management", "ITSM requests", "reporting"],
    ["BRD §9.1", "BRD §8, REQ-05 and REQ-06"], "affected-live-actions-blocked",
  ),
  provisionalDecision(
    "GD-09", "Suggested standard deadlines",
    "Use J-7 documents, J-10 BGV initiation, J-2 BGV result, J-5 HRIS, J-2 IT, and J-3 final review only as pending-calendar development targets.",
    "The source document provides the first five relative dates; its Day-1 review is 2–3 business days before start. Calendar, timezone, and holiday decisions remain unapproved.",
    ["Incorrect deadline calculation across jurisdiction/timezone/holiday calendars", "deadline treated as a statutory or approved SLA"],
    "HR Operations", ["readiness SLA", "reminders", "Day-1 review"],
    ["BRD §4.6", "BRD §4.2, Step 09"], "development-and-simulation",
  ),
  provisionalDecision(
    "GD-10", "No invented jurisdictional or retention defaults",
    "Set no production default for payroll cutoff, jurisdiction calendars/timezone, medical/police/drug applicability, consent/residency, retention periods, or TUPE legal timelines.",
    "The source document names these subjects but does not supply a tenant- and jurisdiction-approved value.",
    ["Invented legal, privacy, payroll, or safety policy", "overwriting an approved tenant setting"],
    "Legal / Privacy / Payroll", ["SLA scheduling", "frontline checks", "data retention", "M&A/TUPE"],
    ["BRD §4.6", "BRD §10, BR-08", "BRD Appendix A §A.5 and §A.9", "BRD Appendix B §B.1 and §B.7"], "affected-live-actions-blocked",
  ),
  provisionalDecision(
    "GD-11", "Live activation and human decision permissions",
    "Development and isolated simulation may proceed. Unapproved legal, privacy, safety, provider configuration, real evidence, or missing current scoped permissions and explicit human review blocks the affected live action. Ordinary access does not establish professional qualifications.",
    "This keeps implementation moving without using tenant membership or demo evidence as approval for external effects.",
    ["Unauthorized live action", "membership mistaken for decision permission or professional qualification", "simulation treated as evidence"],
    "AI Governance Lead", ["all live providers", "frontline release", "M&A/TUPE", "privacy-sensitive processing"],
    ["BRD §3.3, AI Governance / Compliance", "BRD §10, BR-03 and BR-07"], "affected-live-actions-blocked",
  ),
  provisionalDecision(
    "GD-12", "Revision adoption and active cases",
    "Do not silently rewrite active cases. Approved changes apply prospectively; a rebase requires version checks, locks, impact visibility, and fresh approval when the affected gate requires it.",
    "Existing readiness policy and approval code already establishes snapshots, optimistic version checks, case locks, and re-approval on changed evidence.",
    ["Historical policy replay", "stale approvals", "racing an external provider dispatch"],
    "HR Process Owner", ["policy publication", "case rebase", "Day-1 Readiness", "provider dispatch"],
    ["BRD §10, BR-02, BR-06, and BR-07", "Product governance requirement: revision impact assessment and controlled activation"], "affected-live-actions-blocked",
  ),
] as const;