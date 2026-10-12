/**
 * Canonical, source-grounded learning and UAT traceability catalog.
 *
 * The BRD is explicitly a provisional baseline: it contains conflicting
 * document labels (2.0, 1.0/1.1 and footer 1.2) and pending To-Be material.
 * "Reference-covered" here means the catalog has a mapped test route. It is
 * distinct from an executed assertion: this static catalog records neither a
 * passing execution nor provider configuration nor approval for live use.
 */

export const UAT_LEARNING_CATALOG_VERSION = "2026.09.15";
export const UAT_LEARNING_BASELINE = "BRD Employee Onboarding (AHRO), Draft for Review, 13-Aug-2026; conflicting version labels retained";
/** Compatibility aliases for the existing Test Center module. */
export const UAT_CATALOG_VERSION = UAT_LEARNING_CATALOG_VERSION;
export const UAT_BASELINE_REVISION = UAT_LEARNING_BASELINE;

export type UatMode = "simulated" | "manual-evidence" | "provider-sandbox" | "real-email";
export type UatAvailability = "available" | "blocked" | "manual";
export type FeatureVerification = "implemented-observation-required" | "implemented-simulated" | "manual" | "blocked";
export type RequirementAvailability = "implemented" | "partial" | "not-implemented" | "policy-dependent";

export type UatStep = {
  id: string;
  order: number;
  actor: string;
  action: string;
  expected: string;
  evidence: string;
  wait: string;
  negativePath?: string;
  cleanup?: string;
};

/** Compatible with the existing Test Center UatScenario shape. Extra fields support exports. */
export type UatScenario = {
  id: string;
  title: string;
  family: string;
  description: string;
  roles: string[];
  mode: UatMode;
  status: UatAvailability;
  blocker: string | null;
  steps: UatStep[];
  prerequisites?: string[];
  fixturePack?: string;
  featureIds?: string[];
  requirementIds?: string[];
  passCriteria?: string;
  cleanup?: string;
};

export type ProductFeature = {
  id: string;
  name: string;
  source: "product capability" | "BRD + product capability";
  entryPoints: string[];
  roles: string[];
  guideTopic: string;
  scenarioIds: string[];
  verification: FeatureVerification;
  /** A catalog link only; it is never an execution result. */
  referenceCoverage: "mapped";
  /** Execution belongs in a run/evidence record, not this static inventory. */
  executionAssertion: "not-executed";
  availabilityNote: string;
};

export type TraceabilityRequirement = {
  id: string;
  title: string;
  exactBaseline: string;
  sourceRefs: string[];
  actor: string;
  variants: string[];
  availability: RequirementAvailability;
  scenarioIds: string[];
  testMode: UatMode;
  expectedEvidence: string;
  latestResult: "not-run" | "blocked" | "manual";
  gapOwner: string;
  gapReason: string | null;
};

export type GuideSection = {
  id: string;
  title: string;
  roles: string[];
  entryPoints: string[];
  summary: string;
  instructions: string[];
  evidence: string[];
  exceptions: string[];
  featureIds: string[];
  scenarioIds: string[];
};

const numbered = (items: Array<Omit<UatStep, "id" | "order">>): UatStep[] =>
  items.map((item, index) => ({ id: `step-${index + 1}`, order: index + 1, ...item }));

const scenario = (
  id: string, title: string, family: string, description: string, roles: string[],
  mode: UatMode, status: UatAvailability, blocker: string | null,
  steps: Array<Omit<UatStep, "id" | "order">>, featureIds: string[], requirementIds: string[] = [],
): UatScenario => ({
  id, title, family, description, roles, mode, status, blocker, steps: numbered(steps),
  prerequisites: [
    mode === "simulated"
      ? "Start in Test Center. Use only this run's linked synthetic case, candidate portal or run-owned evaluator; never create or mutate an ordinary Cases, Batch, or Transfer record to execute a simulated test."
      : status === "manual"
        ? "Manual observation only: use an independently authorized non-production fixture or record Blocked. This scenario does not make a real workflow, role, provider, or generic product create action an isolated Test Center flow."
        : "Blocked until the stated role/provider/approval boundary is independently available. Record only the blocked/manual result; do not substitute a generic product action.",
    "Capture observed evidence without tokens, full identifiers, medical details, bank data, or BGV report contents.",
  ],
  fixturePack: "synthetic-fixtures.v1", featureIds, requirementIds,
  passCriteria: "Only an executed run can record an assertion. Capture observed expected state and linked evidence; retain the reason for every blocked or manual check. This catalog itself records no assertion.",
  cleanup: "Retire only run-owned synthetic records; never delete a live case, document, audit record, hold, or operational history.",
});

/**
 * Stable scenarios. The original identifiers remain unchanged so existing
 * saved Test Center runs and clients can continue to resolve them.
 */
export const UAT_SCENARIOS: readonly UatScenario[] = [
  scenario("UAT-STD-01", "Standard hire: guided intake to Day-1 review", "standard/lateral",
    "Exercises a fictional standard case through intake, portal, checklist gates, work items and readiness review.",
    ["HR coordinator", "candidate", "HR reviewer"], "simulated", "available", null, [
      { actor: "HR coordinator", action: "From the Test Center run, open only its run-owned linked standard-hire case/evaluator and record the displayed case link or fixture ID; do not use generic Cases > Create.", expected: "The run-owned subject has its own scope, current owner, joining date and pending workstreams without mutating a real case or readiness.", evidence: "Redacted run header, linked-subject reference and evaluator result.", wait: "Wait for run/link creation once; do not submit twice.", negativePath: "Use the run evaluator's incomplete-intake fixture and confirm its visible validation result.", cleanup: "Retire only run-owned fixture state through Test Center cleanup." },
      { actor: "candidate", action: "Open only the Test Center run's linked candidate portal and submit one harmless labeled fixture.", expected: "The fixture is associated with the run-owned subject and may show a local validation result; source authenticity remains unverified.", evidence: "Run-linked portal confirmation and redacted local status.", wait: "Refresh the run-linked Documents view once after upload.", negativePath: "Use the supplied harmless unsupported-name/type fixture; do not upload executable or malware content." },
      { actor: "HR reviewer", action: "Use the run-owned evaluator to inspect Gateway A, B and C and evaluate reopening a completed mandatory item with a QA reason.", expected: "The production gate predicates are evaluated against run-owned fixture state only; an unmet item prevents simulated progression without changing any real case readiness.", evidence: "Evaluator before/after result, reason and run evidence.", wait: "Use displayed evaluator state; no provider wait is implied.", negativePath: "Evaluate unresolved BGV or mandatory readiness fixture state and confirm the simulated block." },
    ], ["PFC-003", "PFC-005", "PFC-006", "PFC-007", "PFC-008", "PFC-011"], ["REQ-01", "REQ-02", "REQ-08", "REQ-09", "REQ-16", "BR-04", "BR-06"]),
  scenario("UAT-FLT-01", "Frontline / bulk readiness and SLA", "frontline/campus bulk",
    "Exercises capacity-aware frontline batch intake, independent medical/safety gates, and a run-scoped calendar boundary.",
    ["TA intake", "site coordinator", "EHS reviewer"], "simulated", "available", null, [
      { actor: "TA intake", action: "From Test Center, open the run-owned batch evaluator/linked fixture with role, site, shift and skill category; do not use Batch intake to create a cohort.", expected: "Valid fixture rows continue as a cohort while the invalid row is separately reported; no ordinary batch is committed.", evidence: "Run fixture reference and evaluator row-level result.", wait: "Wait for the run-owned preview/evaluation.", negativePath: "Evaluate the supplied regulated-role fixture with missing age proof or skill evidence." },
      { actor: "site coordinator", action: "Use the run-owned evaluator to set simulated medical-fit, BGV and PPE fixture states, leaving safety competency unsigned.", expected: "Production pure gate predicates show that score cannot make the fixture floor-ready while safety or medical hard gates are open; no real readiness is mutated.", evidence: "Run evaluator gate result and simulated-evidence note.", wait: "Do not interpret a simulated result as occupational-health evidence.", negativePath: "Evaluate floor release before the safety sign-off." },
      { actor: "EHS reviewer", action: "Advance only the run clock across a shift/timezone boundary and inspect SLA escalation.", expected: "Only run-owned watches react; production time, leases and real deadlines are unchanged.", evidence: "Clock history and simulated escalation.", wait: "Advance 24 hours, then refresh the run.", negativePath: "Record a PPE stock-out or failed competency and confirm retraining/hold rather than release." },
    ], ["PFC-004", "PFC-009", "PFC-035", "PFC-036"], ["APP-A-01", "APP-A-02", "APP-A-04", "APP-A-08", "APP-A-10", "APP-A-14", "APP-A-15", "REQ-13"]),
  scenario("UAT-XFR-01", "Workforce transfer continuity and cutover", "M&A/TUPE/transfer",
    "Exercises the implemented transfer workspace while preserving that legal basis, consultation and specialist authority are not simulated certification.",
    ["transfer operator", "verified specialist", "payroll reviewer"], "manual-evidence", "manual",
    "Legal transfer basis, consultation and verified specialist authority are tenant- and jurisdiction-specific; simulation cannot certify them.", [
      { actor: "transfer operator", action: "Create or open a synthetic transfer program, import a mapped sample population and inspect versioned reconciliation.", expected: "Required headings are mapped, original service dates remain visible, and invalid rows are explicit.", evidence: "Program ID, population version and validation receipt.", wait: "Generate a preview before commit.", negativePath: "Use duplicate/missing service-date data and confirm it is held for correction." },
      { actor: "verified specialist", action: "Review the authority-gated transfer-basis decision and record either an authorized decision receipt or Blocked.", expected: "Organization membership alone does not confer legal authority; no automatic TUPE/ARD conclusion is made.", evidence: "Authority state and redacted decision receipt.", wait: "Stop if authority is unavailable.", negativePath: "Attempt a basis-changing action with a stale/revoked authority." },
      { actor: "payroll reviewer", action: "Review the cutover plan and record a contingency/parallel-run action if payroll or access evidence is incomplete.", expected: "A legal Day-1 Go requires completed evidence and does not silently release an unreviewed pay disruption.", evidence: "Cutover action history and contingency evidence.", wait: "Use observed program version.", negativePath: "Attempt Go with an incomplete cutover action." },
    ], ["PFC-013", "PFC-014", "PFC-015", "PFC-016", "PFC-017"], ["APP-B-02", "APP-B-03", "APP-B-05", "APP-B-06", "APP-B-07", "APP-B-08", "APP-B-12"]),
  scenario("UAT-DOC-01", "Document validation and quarantine boundaries", "documents/privacy",
    "Separates file validation, scanner status, extraction/content rules, source verification and human disposition.",
    ["candidate", "HR reviewer"], "simulated", "available", null, [
      { actor: "candidate", action: "From Test Center, use only the run-owned linked portal and downloadable harmless fixture manifest to submit variants for valid, missing information, expired date, inconsistent name, unsupported format, size mismatch, unreadable/corrupt content and changed bytes.", expected: "A downloadable fixture is input, not an auto-verified outcome. Record only the displayed local parse/content-rule result; scanner availability, scanner detection, identity and issuer authenticity are separate observations.", evidence: "Per-file run-linked status and redacted local-parse note.", wait: "Upload one variant at a time and refresh the run-linked status.", negativePath: "Use only supplied harmless renamed content for type rejection; never upload executable or malware content." },
      { actor: "HR reviewer", action: "Inspect scanner availability separately, then use the run-owned evaluator's simulated adverse/disputed BGV fixture for a human-disposition boundary.", expected: "Unavailable scanner/provider remains unavailable; local parsing is not scanner detection or authenticity, and simulated BGV never creates an automated employment decision.", evidence: "Scanner state, evaluator result and disposition-boundary note.", wait: "Do not wait for an unconfigured service.", negativePath: "Attempt to mark a fixture or simulated result as verified and record the denial/boundary." },
    ], ["PFC-008", "PFC-009", "PFC-011", "PFC-038"], ["REQ-02", "REQ-04", "REQ-15", "BR-03", "BR-05", "BR-08"]),
  scenario("UAT-EMAIL-01", "Approved-mailbox reply correlation", "communications",
    "Covers simulated communication events and the separately governed real-email path.",
    ["QA coordinator", "approved volunteer"], "real-email", "blocked",
    "Real-email certification requires an approved QA mailbox, volunteer selection and the existing monitored send/reply path; the Test Center never authorizes recipients.", [
      { actor: "QA coordinator", action: "Record simulated status-email, delayed reply, duplicate/replay, self-echo, spoofed sender and ambiguous-tenant events.", expected: "Each event is run-scoped, deduplicated/correlated where applicable, and non-authoritative.", evidence: "Normalized exchange history.", wait: "Use the run clock for delayed response.", negativePath: "Use an ambiguous correlation and confirm it is held rather than attached to a case." },
      { actor: "approved volunteer", action: "Only if the approved boundary is available, use the existing monitored email path and record a redacted result.", expected: "Actual send/reply correlation is auditable; uncertain sends are not automatically retried or replaced with simulated proof.", evidence: "Existing communication audit with recipient masked.", wait: "Blocked until volunteer approval is explicitly confirmed.", negativePath: "Reply from an unapproved/spoofed mailbox and record the rejection." },
    ], ["PFC-010", "PFC-040"], ["REQ-02", "REQ-03", "BR-06"]),
  scenario("UAT-SEC-01", "Tenant, role, retention and audit isolation", "security/recovery",
    "Checks organization isolation, role/authority boundaries, stale updates, retention/hold behavior and UAT cleanup.",
    ["organization member", "owner/admin", "verified specialist"], "manual-evidence", "manual",
    "Cross-tenant checks and specialist authority need independently authorized test accounts; no test run grants either authority.", [
      { actor: "organization member", action: "Attempt to open another tenant's known synthetic run ID and an unauthorized management operation.", expected: "The response is denied/not found without leaking the run, case, document or tenant details.", evidence: "Redacted denial and timestamp.", wait: "Use two authorized test organizations.", negativePath: "Verify that the error does not reveal another tenant's name or case data." },
      { actor: "owner/admin", action: "Submit a stale configuration/action version, refresh, then perform the permitted recovery path.", expected: "A conflict is explicit, no duplicate effect is applied, and the refreshed version can be reviewed.", evidence: "Version-conflict response and subsequent audit event.", wait: "Do not retry a stale write blindly.", negativePath: "Attempt cleanup for a held/operational record and confirm scope/hold protection." },
      { actor: "verified specialist", action: "Inspect that role membership and verified specialist authority are represented separately.", expected: "Specialist action remains unavailable without a valid authority record.", evidence: "Redacted authority state.", wait: "Manual observation required.", negativePath: "Use a revoked/stale approval if an approved test fixture exists." },
    ], ["PFC-012", "PFC-019", "PFC-028", "PFC-029", "PFC-031", "PFC-032", "PFC-043"], ["REQ-15", "REQ-16", "BR-02", "BR-03", "BR-06", "BR-07", "BR-08"]),
  scenario("UAT-OPS-01", "Reusable provider exchanges and timeout recovery", "providers/operations",
    "Exercises normalized HRIS, BGV, ITSM, payroll and benefits exchange shapes without pretending an adapter is configured.",
    ["HR coordinator", "system operator"], "provider-sandbox", "blocked",
    "Approved vendor sandboxes are not configured. Simulated exchanges test correlation and recovery shape, not vendor behavior.", [
      { actor: "system operator", action: "Only if the blocked provider boundary is approved, use the Test Center run-owned evaluator to create simulated request, status, poll, webhook and status-email fixtures for HRIS, BGV, ITSM, payroll and benefits.", expected: "Fixtures retain system, operation, state and run scope; no remote provider is called.", evidence: "Run-owned normalized exchange history.", wait: "Use the run clock for polling/timeout timing.", negativePath: "Record unavailable-provider state and confirm it remains blocked." },
      { actor: "HR coordinator", action: "Use the same run-owned evaluator to record delayed, out-of-order and duplicate fixture states and inspect recommended recovery.", expected: "Stale/duplicate fixtures do not create a real readiness upgrade or duplicated request.", evidence: "Run event ordering and simulated recovery evidence.", wait: "Inspect run event history after each injected state.", negativePath: "Evaluate an ambiguous write and confirm human follow-up is required." },
    ], ["PFC-024", "PFC-025", "PFC-026"], ["REQ-03", "REQ-05", "REQ-06", "REQ-07", "BR-01", "BR-04"]),
  scenario("UAT-CASE-02", "Case search, filters and lifecycle recovery", "operations/cases",
    "Tests dashboard-to-case navigation, empty/loading/error handling and date-change recovery.", ["HR coordinator", "hiring manager"], "manual-evidence", "manual",
    "Requires an authorized synthetic case in the current organization.", [
      { actor: "HR coordinator", action: "Search and filter Cases by a synthetic worker, status and risk, then clear filters.", expected: "Results remain tenant-scoped and filter state can be reset; an empty search has an explicit empty state.", evidence: "Redacted results and empty-state capture.", wait: "Wait for the displayed list request to settle.", negativePath: "Search for a nonexistent fictional worker." },
      { actor: "hiring manager", action: "Update a permitted synthetic joining-date or manager handoff using the visible workflow, then inspect downstream tasks.", expected: "The changed fact is auditable and affected readiness/handoffs are visibly re-reviewed rather than silently assumed current.", evidence: "Before/after case state and audit item.", wait: "Refresh after saving.", negativePath: "Attempt an invalid date/conflicting update and record validation or conflict." },
    ], ["PFC-001", "PFC-002", "PFC-005", "PFC-006", "PFC-011"], ["REQ-01", "REQ-13", "BR-06"]),
  scenario("UAT-BATCH-02", "Campus cohort and individual exception", "campus/bulk",
    "Tests that a cohort can progress while an individual exception is separately visible.", ["TA intake", "HR coordinator"], "manual-evidence", "manual",
    "Requires an authorized non-production cohort fixture.", [
      { actor: "TA intake", action: "Import a small fictional cohort and inspect the preview before commit.", expected: "Column validation and rejected rows are visible before any commit.", evidence: "Preview and import receipt.", wait: "Do not commit until mappings are reviewed.", negativePath: "Provide a missing required heading." },
      { actor: "HR coordinator", action: "Mark one synthetic worker's missing document/duplicate concern and inspect cohort status.", expected: "The individual remains an exception while other valid workers are not represented as blocked without cause.", evidence: "Individual and cohort status views.", wait: "Refresh the cohort after the exception.", negativePath: "Try re-importing the same identity and record conflict handling." },
    ], ["PFC-004", "PFC-006"], ["REQ-01", "REQ-02", "REQ-14"]),
  scenario("UAT-CONFIG-01", "Checklist profiles, snapshots and validation", "configuration",
    "Tests default and targeted checklist configuration without inventing changes to existing cases.", ["owner/admin", "HR coordinator"], "manual-evidence", "manual",
    "Requires an authorized configuration fixture and a non-production organization.", [
      { actor: "owner/admin", action: "Create a uniquely named synthetic checklist item/profile with contiguous order, save it, then reload it.", expected: "A new version is shown and saved configuration survives reload.", evidence: "Versioned configuration and audit event.", wait: "Wait for save confirmation before reload.", negativePath: "Try duplicate stable IDs, non-contiguous order and conflicting equal-priority profile conditions." },
      { actor: "HR coordinator", action: "Create one matching and one non-matching synthetic case and inspect snapshots.", expected: "Matching new case receives the profile; non-matching and pre-existing cases do not silently change.", evidence: "Case checklist snapshots.", wait: "Create cases only after config save.", negativePath: "Reopen a mandatory profile item and confirm a fresh review is visible." },
    ], ["PFC-033", "PFC-034", "PFC-035"], ["REQ-01", "BR-02", "BR-04", "BR-07"]),
  scenario("UAT-POLICY-01", "Cited policy, governed review and expiry", "policy/governance",
    "Tests cited answers, policy-version review, expiry reminders and authority boundaries.", ["policy user", "verified specialist", "owner/admin"], "manual-evidence", "manual",
    "Policy publication and specialist approvals remain governed human activities.", [
      { actor: "policy user", action: "Ask a bounded onboarding-policy question and inspect the cited source context.", expected: "The answer identifies citations/limitations rather than presenting an uncited policy conclusion.", evidence: "Redacted query, cited response and timestamp.", wait: "Wait for the answer state or explicit error.", negativePath: "Ask for a legal/medical conclusion and confirm escalation/guardrail language." },
      { actor: "verified specialist", action: "Review a policy item or reminder using the provided authority flow.", expected: "Authority is visible and a pending/rejected/stale decision does not publish a policy.", evidence: "Review status and version history.", wait: "Stop if authority is unavailable.", negativePath: "Attempt publication with a stale/revoked decision." },
    ], ["PFC-020", "PFC-021", "PFC-022", "PFC-023", "PFC-032"], ["BR-02", "BR-03", "BR-07", "BR-08"]),
  scenario("UAT-AI-01", "AI recommendations, drafting and guardrails", "AI/governance",
    "Tests recommendations and workflow drafting as reviewable assistance, not autonomous authority.", ["HR coordinator", "owner/admin", "verified specialist"], "manual-evidence", "manual",
    "AI output is advisory and can be unavailable; it never confers legal, privacy, payroll or specialist authority.", [
      { actor: "HR coordinator", action: "Request a workflow draft/recommendation for fictional onboarding facts and inspect the proposed actions.", expected: "Input, output, constraints and human follow-up remain visible; no sensitive action is silently executed.", evidence: "Redacted draft/recommendation and guardrail state.", wait: "Wait for completion or an explicit unavailable/error result.", negativePath: "Use conflicting/untrusted text and confirm it is treated as data for review, not an instruction." },
      { actor: "owner/admin", action: "Review configured guardrails and attempt a restricted action through the normal UI.", expected: "The guardrail explains block/escalation and preserves an audit trail.", evidence: "Guardrail decision/audit receipt.", wait: "Do not retry blocked action with altered authority.", negativePath: "Attempt an adverse or privacy-sensitive outcome without specialist review." },
    ], ["PFC-018", "PFC-019", "PFC-022", "PFC-023"], ["BR-03", "BR-05", "BR-07"]),
  scenario("UAT-ANL-01", "Analytics, outcome KPIs and privacy-safe simulation", "analytics",
    "Tests operational insights, bottleneck simulation and privacy treatment of small/sensitive populations.", ["analytics reviewer", "HR Operations"], "manual-evidence", "manual",
    "Synthetic results are not historical KPI proof and aggregate privacy thresholds need human review.", [
      { actor: "analytics reviewer", action: "Open HRO Intelligence, inspect readiness/bottleneck views and run a non-production bottleneck simulation.", expected: "Insights remain operational aids with visible inputs/assumptions; simulated outcome is not written as a factual KPI.", evidence: "Redacted chart/assumption and simulation output.", wait: "Record loading or error state if no data is available.", negativePath: "Use a small/sensitive fictional segment and confirm suppression or review requirement." },
      { actor: "HR Operations", action: "Follow a shown SLA risk to its case/work item and compare the operational detail.", expected: "The drill-down identifies the current owner/blocker without treating an analytics recommendation as a decision.", evidence: "Linked detail and observed timestamp.", wait: "Refresh underlying case before recording.", negativePath: "Record unavailable/no-data state instead of claiming coverage." },
    ], ["PFC-024", "PFC-025", "PFC-026"], ["REQ-08", "REQ-13", "APP-A-20", "APP-B-11"]),
  scenario("UAT-SETTINGS-01", "Client setup, process files and runtime settings", "administration",
    "Tests client setup persistence and settings for job profiles, SLA, early tenure, privacy and synthetic reset.", ["owner/admin"], "manual-evidence", "manual",
    "Only an authorized non-production organization may change configuration; legal defaults must not be invented.", [
      { actor: "owner/admin", action: "Save a clearly synthetic client/process-file configuration and reload the relevant section.", expected: "Saved values persist, validation errors are explicit and source files remain governed inputs rather than executable instructions.", evidence: "Redacted before/after settings and save status.", wait: "Reload after successful save.", negativePath: "Attempt missing/invalid required configuration." },
      { actor: "owner/admin", action: "Inspect readiness/SLA, early-tenure and privacy settings and their scope before changing any synthetic value.", expected: "Unapproved jurisdiction, retention, payroll cutoff and specialist rules remain visible as decisions/gaps, not defaulted by the test.", evidence: "Setting scope/version and governance note.", wait: "Do not change live settings for a test.", negativePath: "Attempt a synthetic reset without required confirmation." },
    ], ["PFC-027", "PFC-028", "PFC-034", "PFC-035", "PFC-036", "PFC-037", "PFC-038"], ["REQ-10", "REQ-11", "REQ-12", "REQ-13", "BR-02", "BR-08"]),
  scenario("UAT-DEMO-01", "Demo Center and synthetic-reset boundary", "demo/synthetic",
    "Tests ordinary Demo Organization access, synthetic workflow controls and the boundary from real operations.", ["Demo Organization member", "owner/admin"], "manual-evidence", "manual",
    "Demo overrides and reset remain presentation/training aids and do not prove workflow execution or authorize live effects.", [
      { actor: "Demo Organization member", action: "Open Demo Center without promotion, start a labeled synthetic workflow and inspect action identity.", expected: "Ordinary Demo Organization membership is sufficient for the demo area, while action identity/audit remain present.", evidence: "Demo workflow receipt and actor label.", wait: "Wait for the current UI status.", negativePath: "Attempt a non-demo/live remote write and confirm it is denied or unavailable." },
      { actor: "owner/admin", action: "Review synthetic reset scope and confirmation text without selecting live records.", expected: "Reset scope is explicit and excludes live operational history.", evidence: "Reset scope/confirmation view.", wait: "Do not execute a destructive reset merely to test the button.", negativePath: "Try to select an out-of-scope/live resource if the UI presents one." },
    ], ["PFC-039", "PFC-040", "PFC-038"], ["BR-06", "BR-07", "BR-08"]),
  scenario("UAT-UAT-01", "Test Center lifecycle, fixtures, report and cleanup", "UAT workspace",
    "Tests catalog search/selection, run creation, fixtures, step evidence, pause/resume, export and scoped cleanup.", ["organization member", "test coordinator"], "simulated", "available", null, [
      { actor: "organization member", action: "Select a scenario, create a synthetic run, download its fixture pack and record one observed step result.", expected: "The run preserves catalog/baseline version, fixture seed, roles, timestamp, evidence provenance and case links without granting new roles.", evidence: "Run header and redacted fixture manifest.", wait: "Wait for run creation before downloading.", negativePath: "Select a blocked scenario and confirm its blocking reason remains visible." },
      { actor: "test coordinator", action: "Pause, reload/resume, export the redacted evidence report, then review cleanup scope.", expected: "History survives reload; export distinguishes Passed/Failed/Blocked/Not run/Not applicable and cleanup is run-owned.", evidence: "Export file and cleanup notice.", wait: "Resume with the latest run version.", negativePath: "Try an action with a stale run version and record the conflict/recovery." },
    ], ["PFC-041", "PFC-042", "PFC-043", "PFC-044"], ["UAT-REQ-01", "UAT-REQ-02", "UAT-REQ-03", "UAT-REQ-04"]),
  scenario("UAT-ARCH-01", "Audit, archive, export and hold-aware recovery", "audit/retention",
    "Tests audit browsing/export and that retention/hold operations do not silently delete evidence.", ["auditor", "owner/admin"], "manual-evidence", "manual",
    "Retention values, archive authority and legal holds are tenant-governed.", [
      { actor: "auditor", action: "Inspect a synthetic case or transfer audit history and export the permitted redacted view.", expected: "Entries expose action/actor/time/version without revealing secret tokens or unrelated tenant data.", evidence: "Redacted export and audit timestamps.", wait: "Wait for the audit list to load.", negativePath: "Open an inaccessible audit reference and confirm no information leaks." },
      { actor: "owner/admin", action: "Attempt an archive/delete/restore action only where the product offers it, checking hold/retention messaging.", expected: "Unsupported operations are not invented; offered actions preserve scope and warn/block when a hold applies.", evidence: "Observed capability and hold/archive result.", wait: "Do not apply destructive operations to live data.", negativePath: "Attempt mutation with a stale version." },
    ], ["PFC-030", "PFC-031", "PFC-032"], ["REQ-16", "BR-06", "BR-08", "APP-A-13", "APP-B-10"]),
];

export const PRODUCT_FEATURES: readonly ProductFeature[] = [
  ["PFC-001", "Control Tower dashboard, gateway and workload visibility", "BRD + product capability", ["/"], ["organization member"], "navigation", ["UAT-CASE-02"], "manual", "Live cards are observed data; empty/loading/error state must be recorded."],
  ["PFC-002", "Case search, filters and operational list", "product capability", ["/cases"], ["organization member"], "lifecycle", ["UAT-CASE-02"], "manual", "Search results are organization-scoped."],
  ["PFC-003", "Individual onboarding intake", "BRD + product capability", ["/cases/new"], ["HR coordinator"], "lifecycle", ["UAT-STD-01"], "manual", "Record form validation and duplicate protection."],
  ["PFC-004", "Batch and campus/frontline intake", "BRD + product capability", ["/cases", "/cases batch intake"], ["TA intake", "HR coordinator"], "variants", ["UAT-FLT-01", "UAT-BATCH-02"], "manual", "Batch support does not make individual exceptions disappear."],
  ["PFC-005", "Case overview, lifecycle and stage state", "BRD + product capability", ["/cases/:id"], ["HR coordinator", "hiring manager"], "lifecycle", ["UAT-STD-01", "UAT-CASE-02"], "manual", "Status labels require supporting workstream evidence."],
  ["PFC-006", "Case tasks, checklists and Gateway A/B/C", "BRD + product capability", ["/cases/:id"], ["HR coordinator", "HR reviewer"], "lifecycle", ["UAT-STD-01", "UAT-CONFIG-01"], "manual", "Mandatory gate behavior is observed; reopening is auditable."],
  ["PFC-007", "Case documents, privacy and validation", "BRD + product capability", ["/cases/:id"], ["candidate", "HR reviewer"], "candidate", ["UAT-STD-01", "UAT-DOC-01"], "manual", "Local validation never proves authenticity or clearance."],
  ["PFC-008", "Candidate portal and upload journey", "BRD + product capability", ["/candidate"], ["candidate"], "candidate", ["UAT-STD-01", "UAT-DOC-01"], "manual", "Candidate access is separate from control-tower membership."],
  ["PFC-009", "Document scanner availability and quarantine boundary", "product capability", ["/cases/:id", "/systems"], ["HR reviewer", "system operator"], "candidate", ["UAT-DOC-01"], "implemented-simulated", "Unavailable scanner remains unavailable; injected result is simulated."],
  ["PFC-010", "Case communications and monitored-email status", "BRD + product capability", ["/cases/:id", "/systems"], ["HR coordinator", "QA coordinator"], "communications", ["UAT-EMAIL-01"], "blocked", "Real email requires existing approved-mailbox controls."],
  ["PFC-011", "Case explanations, activity and audit evidence", "product capability", ["/cases/:id"], ["HR coordinator", "HR reviewer"], "lifecycle", ["UAT-STD-01", "UAT-CASE-02"], "manual", "Explanations aid review and do not supersede audit."],
  ["PFC-012", "Action Center work items and human handoffs", "BRD + product capability", ["/approvals"], ["HR coordinator", "HR reviewer"], "handoffs", ["UAT-STD-01", "UAT-SEC-01"], "manual", "Assignment does not grant specialist decision authority."],
  ["PFC-013", "Workforce transfer program lifecycle", "BRD + product capability", ["/workforce-transfers"], ["transfer operator"], "transfers", ["UAT-XFR-01"], "manual", "Transfer basis remains legally governed."],
  ["PFC-014", "Transfer population import and reconciliation", "BRD + product capability", ["/workforce-transfers/:id"], ["transfer operator"], "transfers", ["UAT-XFR-01"], "manual", "CSV mapping/versions are implemented; legal migration approval is not implied."],
  ["PFC-015", "Transfer governance, authority and objections", "BRD + product capability", ["/workforce-transfers/:id"], ["verified specialist", "transfer operator"], "transfers", ["UAT-XFR-01", "UAT-SEC-01"], "manual", "Role membership is distinct from verified specialist authority."],
  ["PFC-016", "Transfer cutover and contingency actions", "BRD + product capability", ["/workforce-transfers/:id"], ["payroll reviewer", "transfer operator"], "transfers", ["UAT-XFR-01"], "manual", "A Go decision needs observed completed evidence."],
  ["PFC-017", "Transfer operations, KPIs and post-transfer tracking", "BRD + product capability", ["/workforce-transfers/:id"], ["transfer operator", "analytics reviewer"], "transfers", ["UAT-XFR-01", "UAT-ANL-01"], "manual", "Metrics are not legal or payroll certification."],
  ["PFC-018", "AI Agents operational view", "product capability", ["/agents"], ["organization member"], "ai", ["UAT-AI-01"], "manual", "Agent status and outputs remain reviewable."],
  ["PFC-019", "Workflow drafting and recommendations", "product capability", ["/recommendations"], ["HR coordinator", "owner/admin"], "ai", ["UAT-AI-01"], "manual", "Drafts are advisory and use normal approval boundaries."],
  ["PFC-020", "Cited HR Policy Assistant", "product capability", ["/policy-assistant"], ["organization member"], "policy", ["UAT-POLICY-01"], "manual", "Citations/limitations must be observed for the query."],
  ["PFC-021", "Policy library, versions and expiry reminders", "product capability", ["/hr-policy-library"], ["owner/admin", "verified specialist"], "policy", ["UAT-POLICY-01"], "manual", "Publication/expiry actions are governed."],
  ["PFC-022", "Policy review and decision governance", "product capability", ["/policy-review"], ["verified specialist", "owner/admin"], "policy", ["UAT-POLICY-01"], "manual", "Pending/rejected/stale authority cannot publish."],
  ["PFC-023", "Guardrails and restricted action handling", "product capability", ["/guardrails"], ["owner/admin", "HR coordinator"], "ai", ["UAT-AI-01"], "manual", "A guardrail result is not a policy approval."],
  ["PFC-024", "Systems, provider configuration and monitoring", "BRD + product capability", ["/systems"], ["system operator", "owner/admin"], "systems", ["UAT-OPS-01", "UAT-DOC-01"], "blocked", "Configured status must be observed; no vendor sandbox is claimed."],
  ["PFC-025", "Analytics and operational outcome KPIs", "BRD + product capability", ["/analytics"], ["analytics reviewer"], "analytics", ["UAT-ANL-01"], "manual", "Synthetic runs are excluded from historical KPI claims."],
  ["PFC-026", "Bottleneck simulation and operational recommendations", "product capability", ["/analytics", "/recommendations"], ["analytics reviewer"], "analytics", ["UAT-ANL-01"], "implemented-simulated", "Simulation inputs/assumptions are not observed facts."],
  ["PFC-027", "Client setup and organization process configuration", "product capability", ["/client-setup"], ["owner/admin"], "administration", ["UAT-SETTINGS-01"], "manual", "Configuration scope requires authorized observation."],
  ["PFC-028", "Process-file management", "product capability", ["/client-setup"], ["owner/admin"], "administration", ["UAT-SETTINGS-01"], "manual", "Files are governed inputs, not executable instructions."],
  ["PFC-029", "Organization membership and roles", "product capability", ["/settings"], ["owner/admin"], "administration", ["UAT-SEC-01"], "manual", "Membership changes do not imply specialist authority."],
  ["PFC-030", "Audit Trail browse and export", "BRD + product capability", ["/audit"], ["auditor", "owner/admin"], "audit", ["UAT-ARCH-01"], "manual", "Audit evidence requires an authorized observed fixture."],
  ["PFC-031", "Archive, retention and hold-aware actions", "BRD + product capability", ["/audit", "/settings"], ["owner/admin"], "audit", ["UAT-ARCH-01", "UAT-SEC-01"], "manual", "Only actually offered actions are tested; no destructive reset."],
  ["PFC-032", "Verified specialist authority controls", "product capability", ["/settings", "/policy-review", "/workforce-transfers"], ["verified specialist", "owner/admin"], "handoffs", ["UAT-XFR-01", "UAT-POLICY-01", "UAT-SEC-01"], "manual", "Authority is tenant-specific and must be independently evidenced."],
  ["PFC-033", "Default checklist configuration and snapshots", "product capability", ["/settings"], ["owner/admin"], "administration", ["UAT-CONFIG-01"], "manual", "New cases receive a saved snapshot; existing cases do not silently rewrite."],
  ["PFC-034", "Targeted checklist profiles and job profiles", "product capability", ["/settings"], ["owner/admin"], "administration", ["UAT-CONFIG-01", "UAT-SETTINGS-01"], "manual", "Matching and precedence require observed configuration."],
  ["PFC-035", "Readiness/SLA, early-tenure and privacy settings", "BRD + product capability", ["/settings"], ["owner/admin"], "administration", ["UAT-SETTINGS-01", "UAT-FLT-01"], "manual", "Legal/policy defaults cannot be invented."],
  ["PFC-036", "Early-tenure Day-1/30/60/90/probation tracking", "BRD + product capability", ["/settings", "/cases/:id"], ["HRBP", "hiring manager"], "variants", ["UAT-SETTINGS-01"], "manual", "Enabled schedule and human completion must be observed."],
  ["PFC-037", "Synthetic reset configuration", "product capability", ["/settings"], ["owner/admin"], "administration", ["UAT-DEMO-01", "UAT-SETTINGS-01"], "manual", "Scope/confirmation are reviewed; no live data reset."],
  ["PFC-038", "Demo Center synthetic workflows", "product capability", ["/demo-controller"], ["Demo Organization member"], "demo", ["UAT-DEMO-01"], "manual", "Presentation override is not workflow evidence."],
  ["PFC-039", "Demo communication/action identity controls", "product capability", ["/demo-controller"], ["Demo Organization member"], "demo", ["UAT-DEMO-01", "UAT-EMAIL-01"], "manual", "Default communications are simulated."],
  ["PFC-040", "UAT catalog selection and role instructions", "product capability", ["/uat/"], ["organization member"], "test-center", ["UAT-UAT-01"], "implemented-simulated", "Run creation is isolated and non-authoritative."],
  ["PFC-041", "UAT fixture download and synthetic-document manifest", "product capability", ["/uat/"], ["organization member"], "test-center", ["UAT-UAT-01", "UAT-DOC-01"], "implemented-simulated", "Fixtures are harmless and visibly fictional."],
  ["PFC-042", "UAT execution, pause/resume and observed evidence", "product capability", ["/uat/"], ["test coordinator"], "test-center", ["UAT-UAT-01"], "implemented-simulated", "Recorded human evidence does not fabricate backend evidence."],
  ["PFC-043", "UAT run clock, normalized exchanges and evidence export", "product capability", ["/uat/"], ["test coordinator", "system operator"], "test-center", ["UAT-UAT-01", "UAT-OPS-01"], "implemented-simulated", "Clock/exchanges never dispatch providers or change live deadlines."],
  ["PFC-044", "Learning Guide search, navigation and portable download", "product capability", ["/learning-guide"], ["organization member"], "navigation", ["UAT-UAT-01"], "manual", "Guide export content/version should be observed."],
] .map(([id, name, source, entryPoints, roles, guideTopic, scenarioIds, verification, availabilityNote]) => ({
  id, name, source: source as ProductFeature["source"], entryPoints, roles, guideTopic, scenarioIds,
  verification: verification as FeatureVerification, availabilityNote,
  referenceCoverage: "mapped" as const,
  executionAssertion: "not-executed" as const,
})) as readonly ProductFeature[];

const coreRequirements: Array<[string, string, string, string, string[], RequirementAvailability, string[], UatMode, string, string, string | null]> = [
  ["REQ-01", "Create case and checklist on offer acceptance", "Auto-create the onboarding case on offer acceptance and instantiate the pre-boarding checklist.", "BRD §8 REQ-01", ["standard", "campus", "rehire"], "partial", ["UAT-STD-01", "UAT-BATCH-02", "UAT-CONFIG-01"], "manual-evidence", "Case ID, checklist snapshot and audit event", "HR Operations", "Offer-trigger automation must be observed; intake is implemented."],
  ["REQ-02", "Validate and chase mandatory documents", "Ingest and validate new-hire documents against the mandatory checklist; flag and chase deficiencies.", "BRD §8 REQ-02", ["standard", "frontline", "rehire"], "partial", ["UAT-STD-01", "UAT-DOC-01"], "simulated", "Per-file validation, deficiency and audit evidence", "HR Operations", "Authenticity, scanner and provider proof remain distinct."],
  ["REQ-03", "Initiate and track BGV", "Initiate BGV via vendor API and track status against SLA with automated reminders.", "BRD §8 REQ-03", ["standard", "frontline"], "partial", ["UAT-OPS-01", "UAT-EMAIL-01"], "provider-sandbox", "Correlated provider receipt and SLA reminder", "BGV owner", "No approved BGV sandbox is configured."],
  ["REQ-04", "Route BGV discrepancy", "Route BGV discrepancies to HR/Compliance with the vendor report for disposition.", "BRD §8 REQ-04", ["standard", "frontline"], "partial", ["UAT-DOC-01"], "simulated", "Human disposition queue/evidence", "HR Compliance", "Vendor report authenticity and human decision need observation."],
  ["REQ-05", "Create Oracle HCM record", "Create the employee record in Oracle HCM with position, org, manager, and start date on clearance.", "BRD §8 REQ-05; §9.1", ["standard", "rehire"], "not-implemented", ["UAT-OPS-01"], "provider-sandbox", "Oracle source-system receipt", "HRIS owner", "Oracle HCM is a target system, not configured integration."],
  ["REQ-06", "Raise IT/asset/access requests", "Auto-raise IT/asset and role-based access requests via the service catalogue.", "BRD §8 REQ-06; §9.1", ["standard", "contractor", "frontline"], "partial", ["UAT-OPS-01"], "provider-sandbox", "ITSM request/correlation receipt", "IT / Asset Management", "No approved ITSM sandbox is configured."],
  ["REQ-07", "Configure payroll and benefits", "Configure payroll and benefits enrolment with validation against the HRIS record.", "BRD §8 REQ-07", ["standard", "frontline"], "partial", ["UAT-OPS-01"], "provider-sandbox", "Payroll/benefits and HRIS evidence", "Payroll & Benefits", "No payroll/benefits sandbox or approved cutoff policy."],
  ["REQ-08", "Maintain five-workstream readiness", "Maintain a live onboarding readiness score across the five workstreams.", "BRD §8 REQ-08; §4.6", ["standard", "lateral"], "implemented", ["UAT-STD-01", "UAT-ANL-01"], "manual-evidence", "Readiness breakdown and timestamp", "HR Operations", "Observation is not a live-release approval."],
  ["REQ-09", "Enforce Day-1 BGV checkpoint", "Enforce a Day-1 readiness checkpoint with BGV clearance as a hard prerequisite.", "BRD §8 REQ-09; BR-04", ["standard", "lateral"], "partial", ["UAT-STD-01", "UAT-OPS-01"], "manual-evidence", "Gateway C state, BGV and approval evidence", "HR Process Owner", "Provider/approval evidence remains governed."],
  ["REQ-10", "Guide induction and compliance learning", "Provide guided Day-1 induction and mandatory compliance-training enrolment.", "BRD §8 REQ-10", ["standard", "campus", "frontline"], "not-implemented", ["UAT-SETTINGS-01"], "manual-evidence", "Enabled early-tenure/learning configuration", "Learning owner", "No configured LMS/induction execution is claimed."],
  ["REQ-11", "Buddy and manager connect", "Assign a buddy and schedule the structured manager connect.", "BRD §8 REQ-11", ["standard", "campus"], "not-implemented", ["UAT-SETTINGS-01"], "manual-evidence", "Enabled schedule and accountable owner", "Hiring Manager / HRBP", "Business activity must be performed and observed."],
  ["REQ-12", "30/60/90 and probation", "Schedule 30-60-90 check-ins and capture probation confirmation.", "BRD §8 REQ-12", ["standard", "frontline"], "not-implemented", ["UAT-SETTINGS-01"], "manual-evidence", "Early-tenure settings and human evidence", "HRBP", "No generated completion is represented as proof."],
  ["REQ-13", "SLA breach alert", "Generate real-time alerts when any workstream breaches its SLA relative to the joining date.", "BRD §8 REQ-13; §4.6", ["all onboarding"], "implemented", ["UAT-FLT-01", "UAT-ANL-01", "UAT-CASE-02"], "simulated", "Run-clock escalation/readiness evidence", "HR Operations", "Calendar, timezone and holidays remain tenant decisions."],
  ["REQ-14", "Rehire/conversion reduced collection", "Support rehire/conversion with reduced re-collection where prior records are valid.", "BRD §8 REQ-14; §4.5.3", ["rehire", "conversion"], "partial", ["UAT-BATCH-02", "UAT-CASE-02"], "manual-evidence", "Duplicate/identity resolution and policy decision", "HR Operations / HRBP", "Prior-record validity is policy/human review dependent."],
  ["REQ-15", "Data minimisation and RBAC", "Enforce data minimisation and role-based access to sensitive new-hire data.", "BRD §8 REQ-15; BR-03", ["all"], "partial", ["UAT-SEC-01", "UAT-DOC-01"], "manual-evidence", "Authorized denial and redacted view", "Privacy / Security", "Needs two authorized test roles/tenants."],
  ["REQ-16", "Immutable audit trail", "Maintain an immutable audit trail of steps, approvals, owners, and timestamps.", "BRD §8 REQ-16; BR-06", ["all"], "partial", ["UAT-STD-01", "UAT-ARCH-01", "UAT-UAT-01"], "manual-evidence", "Audit/event export with versions", "HR Operations / Audit", "Audit evidence must be independently inspected."],
  ["BR-01", "Access/asset prerequisite", "No system access or asset is granted before BGV clearance (or approved conditional join) and active HRIS record.", "BRD §10 BR-01", ["standard", "frontline"], "partial", ["UAT-OPS-01", "UAT-STD-01"], "provider-sandbox", "Blocked request or approved human exception", "HR Process Owner / IT", "HRIS/provider activation is absent; conditional join disabled pending policy."],
  ["BR-02", "Version-controlled templates", "Onboarding checklists and role-based access templates are version-controlled; only HR Operations/IT owners may modify them.", "BRD §10 BR-02", ["all"], "partial", ["UAT-CONFIG-01", "UAT-SEC-01"], "manual-evidence", "Version, authorization and audit", "HR Operations / IT", "Authorized configuration fixture required."],
  ["BR-03", "Need-to-know sensitive data", "Sensitive new-hire data is collected on a minimisation basis and accessible only on a role-based need-to-know.", "BRD §10 BR-03", ["all"], "partial", ["UAT-SEC-01", "UAT-DOC-01"], "manual-evidence", "Denied cross-role access/redacted fields", "Privacy / Security", "Role/tenant observation required."],
  ["BR-04", "Day-1 workstream gate", "Day-1 readiness requires all mandatory workstreams complete or approved contingency, with BGV as hard prerequisite.", "BRD §10 BR-04", ["standard"], "partial", ["UAT-STD-01", "UAT-OPS-01"], "manual-evidence", "Gateway C blocker/approval evidence", "HR Process Owner", "Live approval/provider evidence is not simulated."],
  ["BR-05", "Human BGV disposition", "BGV discrepancies are dispositioned only by HR/Compliance; analysts cannot self-approve adverse results.", "BRD §10 BR-05", ["standard", "frontline"], "partial", ["UAT-DOC-01", "UAT-AI-01"], "manual-evidence", "Restricted disposition/authority evidence", "HR Compliance", "Human authority must be independently valid."],
  ["BR-06", "Decision/provisioning audit", "Every onboarding decision, approval, and provisioning action is logged with owner and timestamp for audit.", "BRD §10 BR-06", ["all"], "partial", ["UAT-ARCH-01", "UAT-SEC-01"], "manual-evidence", "Audit export/redacted event chain", "Audit", "External provisioning action cannot be claimed without source receipt."],
  ["BR-07", "Bounded reversible agents", "Agent actions are bounded and reversible; defined checkpoints require human approval before proceeding.", "BRD §10 BR-07", ["all"], "partial", ["UAT-AI-01", "UAT-SEC-01"], "manual-evidence", "Guardrail/review/audit result", "AI Governance", "No agent output authorizes sensitive action."],
  ["BR-08", "Retention and external sharing", "Records are retained per statutory policy; documents are not shared externally.", "BRD §10 BR-08", ["all"], "policy-dependent", ["UAT-ARCH-01", "UAT-SEC-01"], "manual-evidence", "Retention/hold state and denied external action", "Privacy / Legal", "No tenant retention policy value is assumed."],
];

const frontline: Array<[string, string, string, string, string[], RequirementAvailability, string[], UatMode, string, string, string | null]> = [
  ["APP-A-01", "Frontline intake context", "Capture role, site, shift, and skill category for frontline intake.", "Appendix A §A.4 B1", ["frontline"], "partial", ["UAT-FLT-01"], "simulated", "Batch/frontline context", "Site HR", "Observation required."],
  ["APP-A-02", "Eligibility evidence", "Require ID, age proof and applicable skill/trade evidence before regulated deployment.", "Appendix A §A.4 GW-A; §A.5", ["frontline"], "partial", ["UAT-FLT-01", "UAT-DOC-01"], "simulated", "Document blocker", "Site HR / Compliance", "Authenticity not verified locally."],
  ["APP-A-03", "Police verification applicability", "Perform police verification only where policy and lawful applicability require it.", "Appendix A §A.4 B3; §A.5", ["frontline"], "policy-dependent", ["UAT-OPS-01"], "provider-sandbox", "Policy decision/provider receipt", "Legal / Site Security", "No jurisdiction policy or sandbox."],
  ["APP-A-04", "Medical fitness", "Require medical fitness evidence before floor/site deployment.", "Appendix A §A.4 B4/GW-B; §A.9", ["frontline"], "partial", ["UAT-FLT-01"], "simulated", "Hard-gate state", "Occupational Health", "Simulated result is not medical evidence."],
  ["APP-A-05", "Drug-test applicability", "Require drug-test evidence only where policy and lawful applicability require it.", "Appendix A §A.4 B4; §A.5", ["frontline"], "policy-dependent", ["UAT-FLT-01"], "manual-evidence", "Policy decision", "Occupational Health / Legal", "No lawful applicability default."],
  ["APP-A-06", "BGV and fitness review", "Require medically-fit and BGV-clear outcomes; route failures to HR/OH review.", "Appendix A §A.4 GW-B", ["frontline"], "partial", ["UAT-FLT-01", "UAT-DOC-01"], "simulated", "Hold/review evidence", "OH / HR", "Human disposition/provider evidence required."],
  ["APP-A-07", "Statutory IDs", "Record statutory worker IDs only where applicable before first wage processing.", "Appendix A §A.4 B5; §A.5; §A.9", ["frontline"], "policy-dependent", ["UAT-OPS-01"], "provider-sandbox", "Payroll policy/source receipt", "Payroll / Compliance", "No configured payroll sandbox."],
  ["APP-A-08", "Physical provisioning", "Issue and record badge, PPE, uniform, tools and locker prerequisites before floor access.", "Appendix A §A.4 B6; §A.6", ["frontline"], "partial", ["UAT-FLT-01"], "manual-evidence", "Issue/gate record", "Site HR / Stores", "Actual store issuance needs observation."],
  ["APP-A-09", "Wage/timesheet setup", "Use wage/timesheet setup and applicable statutory payroll registration.", "Appendix A §A.4 B7; §A.9", ["frontline"], "partial", ["UAT-OPS-01"], "provider-sandbox", "Payroll status", "Payroll / Compliance", "Provider not configured."],
  ["APP-A-10", "Safety induction gate", "Require safety induction and competency sign-off before floor/site access.", "Appendix A §A.4 B8/GW-C; §A.2", ["frontline"], "partial", ["UAT-FLT-01"], "simulated", "Safety hard-gate state", "EHS / Supervisor", "Human safety sign-off required."],
  ["APP-A-11", "PPE/emergency data minimisation", "Capture PPE size and next-of-kin/emergency-contact data only through an approved, minimised process.", "Appendix A §A.5", ["frontline"], "not-implemented", ["UAT-SEC-01"], "manual-evidence", "Approved data collection design", "Site HR / Privacy", "No approved process represented."],
  ["APP-A-12", "Applicable labour obligations", "Apply age, labour, wage/hour, social-security and contractor-labour obligations only after jurisdiction/contract review.", "Appendix A §A.9", ["frontline"], "policy-dependent", ["UAT-SETTINGS-01"], "manual-evidence", "Legal review record", "Legal / Compliance", "No legal default."],
  ["APP-A-13", "Frontline records/audit", "Retain PPE issuance, safety sign-off, fitness certificates and IDs as auditable evidence.", "Appendix A §A.9", ["frontline"], "partial", ["UAT-ARCH-01"], "manual-evidence", "Audit/retention view", "EHS / Audit", "Retention policy needs approval."],
  ["APP-A-14", "Independent safety/medical gates", "Keep medical/safety hard gates independent of weighted readiness score.", "Appendix A §A.7", ["frontline"], "partial", ["UAT-FLT-01"], "simulated", "Score plus unresolved gate", "EHS / OH", "Observed simulated state only."],
  ["APP-A-15", "Frontline exceptions", "Handle restriction, failed competency, PPE stock-out, missing evidence and surge intake without release.", "Appendix A §A.10", ["frontline"], "partial", ["UAT-FLT-01"], "simulated", "Hold/retrain/surge record", "Site HR / EHS", "No live floor release."],
  ["APP-A-16", "Assisted intake/right to work", "Support assisted site intake for low-literacy workers and verify applicable right-to-work evidence before deployment.", "Appendix A §A.1–A.2", ["frontline"], "not-implemented", ["UAT-DOC-01"], "manual-evidence", "Accessibility and legal-review evidence", "Site HR / Legal", "No assisted/right-to-work verifier."],
  ["APP-A-17", "Frontline supervision/early tenure", "Assign supervisor/buddy, record OJT or machine-SOP training and probation confirmation.", "Appendix A §A.4 B9–B11", ["frontline"], "not-implemented", ["UAT-SETTINGS-01"], "manual-evidence", "Human-owned schedule/evidence", "Supervisor / Site HR", "No execution claimed."],
  ["APP-A-18", "Site welfare", "Manage transport and canteen enrolment where site welfare services are provided.", "Appendix A §A.6", ["frontline"], "not-implemented", ["UAT-SETTINGS-01"], "manual-evidence", "Configured service evidence", "Site HR / Facilities", "Conditional service is not implemented."],
  ["APP-A-19", "Minimum age gate", "Verify minimum working age and block under-age deployment before regulated floor/site release.", "Appendix A §A.9", ["frontline"], "partial", ["UAT-FLT-01"], "simulated", "Age-proof blocker", "Site HR / Compliance", "Identity verification remains unavailable."],
  ["APP-A-20", "Frontline metrics", "Track frontline cycle-time, medical turnaround, safety, PPE, statutory and early-attrition measures as reviewable policy metrics.", "Appendix A §A.10", ["frontline"], "not-implemented", ["UAT-ANL-01"], "manual-evidence", "Metric configuration/observed gap", "Site HR / EHS / Payroll", "No all-metric implementation claim."],
  ["APP-A-21", "Separate frontline workstreams", "Evaluate documentation, BGV/police, medical/drug, provisioning, payroll and HSE separately, with hard gates.", "Appendix A §A.7", ["frontline"], "partial", ["UAT-FLT-01"], "simulated", "Separate workstream/gate view", "Site HR / EHS", "Simulated assessment only."],
  ["APP-A-22", "Frontline RACI", "Assign and preserve frontline RACI responsibilities for intake, verification, medical, provisioning, payroll, safety and OJT.", "Appendix A §A.8", ["frontline"], "not-implemented", ["UAT-FLT-01"], "manual-evidence", "Role assignment evidence", "Site HR / EHS / Payroll", "RACI execution needs business configuration."],
];

const transfers: Array<[string, string, string, string, string[], RequirementAvailability, string[], UatMode, string, string, string | null]> = [
  ["APP-B-01", "Transfer due diligence", "Perform secure HR due diligence over headcount, terms, service and liabilities.", "Appendix B §B.4 M1; §B.5", ["M&A/TUPE"], "partial", ["UAT-XFR-01"], "manual-evidence", "Restricted program/audit evidence", "HR Integration / Legal", "Secure due diligence is human/legal governed."],
  ["APP-B-02", "Transfer basis", "Determine transfer basis and applicable law before selecting a transfer pathway.", "Appendix B §B.1; §B.4 M2/GW-A", ["M&A/TUPE", "cross-border"], "policy-dependent", ["UAT-XFR-01"], "manual-evidence", "Verified authority decision", "Legal", "No automated legal conclusion."],
  ["APP-B-03", "Consultation", "Complete required representative/works-council consultation on the applicable statutory timeline.", "Appendix B §B.4 M3; §B.7", ["M&A/TUPE"], "not-implemented", ["UAT-XFR-01"], "manual-evidence", "Legal consultation evidence", "Legal / HR Integration", "No jurisdiction timeline default."],
  ["APP-B-04", "Transfer communications", "Issue individual transfer communications and measures information after legal review.", "Appendix B §B.4 M4", ["M&A/TUPE"], "not-implemented", ["UAT-XFR-01", "UAT-EMAIL-01"], "manual-evidence", "Legal-reviewed communication audit", "HR Integration / Legal", "No authorized live dispatch."],
  ["APP-B-05", "Objections and terms", "Handle objections, opt-outs, redundancy and terms changes under applicable law and approved policy.", "Appendix B §B.4 GW-B; §B.7", ["M&A/TUPE"], "policy-dependent", ["UAT-XFR-01"], "manual-evidence", "Authority-gated objection action", "Legal", "No legal/policy decision inferred."],
  ["APP-B-06", "Bulk migration/service continuity", "Bulk-create transfer records while preserving validated original hire/service dates.", "Appendix B §B.4 M5; §B.5/B.7", ["M&A/TUPE"], "partial", ["UAT-XFR-01"], "manual-evidence", "Population version and service-date validation", "HRIS / HR Integration", "External HRIS creation unavailable."],
  ["APP-B-07", "Legal Day-1 cutover", "Cut over payroll, benefits and access at legal Day-1 with no unreviewed pay-disruption release.", "Appendix B §B.4 M6/GW-C", ["M&A/TUPE"], "partial", ["UAT-XFR-01", "UAT-OPS-01"], "provider-sandbox", "Cutover evidence/contingency", "Payroll / IT / Benefits", "No provider sandbox."],
  ["APP-B-08", "Cutover contingency", "Use a legally reviewed contingency for failed transfer cutover and preserve evidence.", "Appendix B §B.4 GW-C", ["M&A/TUPE"], "partial", ["UAT-XFR-01"], "manual-evidence", "Parallel-run/contingency action", "HR Integration / Payroll / Legal", "Legal review still required."],
  ["APP-B-09", "Integration and harmonisation", "Deliver transfer integration induction and approved post-transfer harmonisation.", "Appendix B §B.4 M7–M8", ["M&A/TUPE"], "not-implemented", ["UAT-XFR-01"], "manual-evidence", "Approved plan/evidence", "HR Integration / Legal", "No harmonisation execution claim."],
  ["APP-B-10", "Transfer data/pension privacy", "Lawfully minimise and secure seller employee data and address applicable pension/benefit obligations.", "Appendix B §B.5; §B.7", ["M&A/TUPE"], "policy-dependent", ["UAT-SEC-01", "UAT-ARCH-01"], "manual-evidence", "Privacy/legal review and hold state", "Privacy / Legal / Benefits", "No legal/pension default."],
  ["APP-B-11", "Transfer stabilisation metrics", "Confirm workforce stabilisation and track Day-1 pay, migration, consultation, access, attrition and harmonisation measures.", "Appendix B §B.4 M9; §B.7", ["M&A/TUPE"], "not-implemented", ["UAT-ANL-01", "UAT-XFR-01"], "manual-evidence", "Metric/gap observation", "HR Integration / Legal / Payroll", "No all-metric implementation claim."],
  ["APP-B-12", "Transfer RACI", "Assign and preserve transfer RACI responsibilities for due diligence, basis, consultation, communications, objections, migration, cutover and harmonisation.", "Appendix B §B.6", ["M&A/TUPE"], "partial", ["UAT-XFR-01"], "manual-evidence", "Assigned work/cutover evidence", "HR Integration / Legal / Payroll / IT", "Authority and business execution must be observed."],
];

/** Narrative, exception, RACI, system-landscape and KPI obligations not represented by REQ-/BR-/appendix IDs. */
const narrativeRequirements: Array<[string, string, string, string, string[], RequirementAvailability, string[], UatMode, string, string, string | null]> = [
  ["BRD-PROC-01", "Twelve-step lifecycle", "Operate the 12-step backbone from intake through documents, BGV, HRIS, provisioning, payroll, Day-1, induction, buddy and probation.", "BRD §4.2 Steps 01–12", ["standard", "lateral"], "partial", ["UAT-STD-01", "UAT-SETTINGS-01"], "manual-evidence", "Case/workstream/early-tenure evidence", "HR Operations", "HRIS, provider, induction and early-tenure execution are not all configured."],
  ["BRD-PROC-02", "Five-workstream SLA model", "Track Documentation, BGV, HRIS, IT & assets and Payroll & benefits by joining-date SLA and use the stated 20/25/15/20/20 readiness weights as provisional baseline.", "BRD §4.6", ["standard", "lateral"], "partial", ["UAT-STD-01", "UAT-FLT-01", "UAT-ANL-01"], "simulated", "Readiness breakdown, clock/SLA evidence", "HR Operations", "Calendar/timezone and targets remain provisional governance decisions."],
  ["BRD-EXC-01", "No response to deficiency", "After a documentation deficiency notice, lapse/escalate no response under SLA and allow joining-date re-plan.", "BRD §4.4 Candidate never responds", ["standard", "campus"], "partial", ["UAT-STD-01", "UAT-EMAIL-01"], "manual-evidence", "Deficiency, elapsed clock and escalation evidence", "HR Operations", "Actual communication delivery/monitoring requires approved path."],
  ["BRD-EXC-02", "Delayed BGV", "When BGV exceeds the acceptable window, use an approved conditional join where permitted or defer the start date.", "BRD §4.4 BGV delayed", ["standard", "lateral"], "policy-dependent", ["UAT-OPS-01", "UAT-CASE-02"], "provider-sandbox", "Blocked/approved exception and date-change audit", "HR Compliance", "Conditional join is disabled pending approved tenant policy; vendor sandbox absent."],
  ["BRD-EXC-03", "IT/asset Day-1 contingency", "When IT/assets are not provisioned before Day-1, expose manual expedite, interim access or contingency plan rather than silently release.", "BRD §4.4 IT/assets not provisioned", ["standard", "remote"], "partial", ["UAT-OPS-01", "UAT-STD-01"], "provider-sandbox", "ITSM state and contingency/work item", "IT / Asset Management", "No configured ITSM sandbox or live effect."],
  ["BRD-EXC-04", "Payroll cutoff recovery", "When payroll cut-off is missed, record off-cycle payment or next-cycle correction through accountable payroll handling.", "BRD §4.4 Payroll cut-off missed", ["standard", "frontline"], "policy-dependent", ["UAT-OPS-01"], "provider-sandbox", "Payroll exception/cutoff evidence", "Payroll & Benefits", "No approved payroll-cutoff value or sandbox."],
  ["BRD-EXC-05", "Start-date change resequencing", "On start-date changes after setup, update effective date and re-sequence provisioning.", "BRD §4.4 Start date changes", ["all onboarding"], "partial", ["UAT-CASE-02"], "manual-evidence", "Date-change, affected task and audit record", "HR Operations", "Requires observed permitted change workflow."],
  ["BRD-EXC-06", "Duplicate and rehire conflict", "Use master-data check to prevent duplicate employee record and reactivate prior record where appropriate.", "BRD §4.4 Duplicate or rehire record", ["rehire", "conversion"], "partial", ["UAT-BATCH-02", "UAT-CASE-02"], "manual-evidence", "Conflict/review and identity continuity evidence", "HRIS / HR Operations", "External master record operation is unavailable."],
  ["BRD-EXC-07", "Bulk-volume recovery", "Use cohort batch checklist and additional analyst assignment during campus/bulk intake spike.", "BRD §4.4 Bulk/campus intake volume spike", ["campus", "frontline"], "partial", ["UAT-BATCH-02", "UAT-FLT-01"], "manual-evidence", "Cohort and individual exception evidence", "TA / HR Operations", "Capacity and assignment require observed environment."],
  ["BRD-VAR-01", "Lateral hire", "Apply complete documentation, standard BGV and role-based access for lateral/experienced hire.", "BRD §4.5.1", ["lateral"], "partial", ["UAT-STD-01", "UAT-OPS-01"], "manual-evidence", "Checklist, BGV and access state", "HR Operations", "Provider/configured access proof unavailable."],
  ["BRD-VAR-02", "Campus/fresher cohort", "Use common-start cohort onboarding with batch collection, standardised induction and bulk provisioning.", "BRD §4.5.2", ["campus"], "partial", ["UAT-BATCH-02", "UAT-SETTINGS-01"], "manual-evidence", "Cohort receipt/individual exceptions", "TA / HR Operations", "Induction/provisioning execution is not configured."],
  ["BRD-VAR-03", "Rehire/conversion", "Use expedited policy-controlled re-collection with refreshed BGV/access and HRBP eligibility review.", "BRD §4.5.3", ["rehire", "contractor conversion"], "partial", ["UAT-BATCH-02", "UAT-CASE-02"], "manual-evidence", "Prior-record review and no-duplicate evidence", "HR Operations / HRBP", "Policy validity and source-system reactivation need review."],
  ["BRD-VAR-04", "Cross-border/relocation", "Add visa/work-authorization, jurisdiction forms and localized payroll/benefits with Legal/Mobility involvement.", "BRD §4.5.4", ["cross-border", "relocation"], "policy-dependent", ["UAT-SETTINGS-01", "UAT-DOC-01"], "manual-evidence", "Dependency/hold and specialist ownership", "Mobility / Legal / Payroll", "No jurisdiction, immigration or payroll default is approved."],
  ["BRD-VAR-05", "Executive/senior hire", "Apply enhanced due diligence, confidentiality handling, tailored induction and executive asset provisioning.", "BRD §4.5.5", ["executive"], "policy-dependent", ["UAT-DOC-01", "UAT-AI-01"], "manual-evidence", "Restricted case/owner/exception evidence", "HRBP / Compliance", "Bespoke executive handling is not automated."],
  ["BRD-RACI-01", "Core RACI ownership", "Preserve accountable ownership for intake, documents, BGV, HRIS, IT, payroll, readiness, induction, buddy and probation activities.", "BRD §6", ["standard", "lateral"], "partial", ["UAT-STD-01", "UAT-SEC-01"], "manual-evidence", "Owner/work-item/audit fields", "HR Operations", "Observed roles may vary by tenant."],
  ["BRD-SYS-01", "Application landscape boundary", "Use Oracle HCM, ServiceNow HRSD, BGV vendor, ITSM, payroll/benefits, Outlook/Teams and Power BI as named system roles without claiming unconfigured integrations.", "BRD §9.1", ["all"], "partial", ["UAT-OPS-01", "UAT-EMAIL-01", "UAT-ANL-01"], "provider-sandbox", "Configured state or blocked/provider evidence", "System owners", "Named landscape is not proof of configured integration."],
  ["BRD-KPI-01", "Core onboarding measures", "Review cycle time, Day-1 readiness, document completeness, BGV turnaround and provisioning-on-time measures; targets remain pending To-Be design.", "BRD §7.2", ["standard", "campus"], "partial", ["UAT-ANL-01"], "manual-evidence", "Analytics definition/filter and data limitation", "HR Operations / Analytics", "Synthetic outcomes are not KPI proof; targets are provisional."],
  ["BRD-KPI-02", "Experience and early-tenure measures", "Review new-hire eNPS and 0–90-day attrition measures without using analytics for individual employment judgment.", "BRD §7.2; POC §14", ["all"], "policy-dependent", ["UAT-ANL-01", "UAT-SETTINGS-01"], "manual-evidence", "Aggregate/suppression evidence", "HRBP / People Analytics", "No individual-identifying or sensitive analytics."],
  ["BRD-NFR-01", "Source labels and To-Be status", "Preserve Draft for Review source labels and treat grey To-Be content as pending design confirmation rather than SME-approved production policy.", "BRD front matter; §5", ["all"], "policy-dependent", ["UAT-POLICY-01", "UAT-SETTINGS-01"], "manual-evidence", "Governance decision/version note", "HR Process Owner", "Conflicting labels and unresolved decisions remain open."],
];

const uatRequirements: Array<[string, string, string, string, string[], RequirementAvailability, string[], UatMode, string, string, string | null]> = [
  ["UAT-REQ-01", "Test Center access and execution", "Authorized users select scenarios, receive role instructions, create/pause/resume/rerun runs and retain versioned history.", "Task #271 §14, §18–19", ["UAT workspace"], "partial", ["UAT-UAT-01"], "simulated", "Run version, actor steps and history", "Product owner", "Rerun/run persistence must be observed."],
  ["UAT-REQ-02", "Fixtures and evidence export", "Fixture download and redacted step/evidence report distinguish inputs from observed local parse/content-rule outcomes and from scanner, authenticity or provider evidence; reports preserve result provenance without fabricating backend evidence.", "Task #271 §18–19, §23, §27", ["UAT workspace"], "partial", ["UAT-UAT-01", "UAT-DOC-01"], "simulated", "Fixture manifest, local-result provenance and report export", "Product owner", "Fixtures are inputs, not auto-verified negative outcomes; scanner/authenticity evidence is separately observed."],
  ["UAT-REQ-03", "Run-scoped evaluator boundary", "The run-owned evaluator may invoke actual production pure predicates only against run-owned fixture/snapshot state; it must not dispatch providers or mutate real cases, readiness, global time, credentials, leases or real deadlines.", "Task #271 §20–22, §28", ["UAT workspace"], "partial", ["UAT-UAT-01", "UAT-OPS-01", "UAT-STD-01", "UAT-FLT-01"], "simulated", "Run evaluator, predicate-result provenance, exchange/clock history and no-dispatch boundary", "Engineering", "Provider sandbox is separately blocked; real-case readiness mutations are prohibited."],
  ["UAT-REQ-04", "Scoped cleanup and isolation", "Cleanup removes only run-owned UAT state and respects tenant isolation, retention and holds.", "Task #271 §14, §28", ["UAT workspace"], "partial", ["UAT-UAT-01", "UAT-SEC-01"], "manual-evidence", "Cleanup receipt/denial and isolation result", "Security / Product owner", "Requires two authorized test organizations for full observation."],
];

const toRequirement = ([id, title, exactBaseline, sourceRef, variants, availability, scenarioIds, testMode, expectedEvidence, gapOwner, gapReason]: typeof coreRequirements[number]): TraceabilityRequirement => ({
  id, title, exactBaseline, sourceRefs: [sourceRef], actor: gapOwner, variants, availability, scenarioIds, testMode, expectedEvidence,
  latestResult: availability === "not-implemented" ? "blocked" : "not-run", gapOwner, gapReason,
});

export const REQUIREMENTS: readonly TraceabilityRequirement[] = [
  ...coreRequirements.map(toRequirement), ...frontline.map(toRequirement), ...transfers.map(toRequirement), ...narrativeRequirements.map(toRequirement), ...uatRequirements.map(toRequirement),
];

export const GUIDE_SECTIONS: readonly GuideSection[] = [
  {
    id: "navigation", title: "Start here: roles, navigation and evidence", roles: ["All organization members"], entryPoints: ["/", "/learning-guide"],
    summary: "Use Control Tower for workload and gateways, Cases for a worker record, Action Center for accountable handoffs, and the guide search to find role-specific instructions. A case variant is not a lifecycle stage.",
    instructions: ["Confirm your organization in the switcher before opening a case or run.", "Use the dashboard to triage Gateway A (intake), Gateway B (BGV) and Gateway C (Day-1 readiness); open the linked case for evidence.", "Record what is actually visible, including empty/loading/error states. Never infer provider completion from a status label alone."],
    evidence: ["Redacted case/run ID, observed timestamp, current role and screen state."], exceptions: ["Membership does not confer verified specialist authority.", "A simulated pass is not vendor certification or live readiness."],
    featureIds: ["PFC-001", "PFC-002", "PFC-044"], scenarioIds: ["UAT-CASE-02", "UAT-UAT-01"],
  },
  {
    id: "lifecycle", title: "Standard and lateral lifecycle: Gateway A/B/C", roles: ["HR coordinator", "candidate", "HR reviewer"], entryPoints: ["/cases", "/cases/:id", "/candidate"],
    summary: "This is an authorized product-operation guide: create a case only under normal business authority. It does not make generic Cases creation an isolated UAT flow. For UAT, start Test Center and use only the run-owned linked case, portal or evaluator. Gateway A checks complete intake, Gateway B routes BGV exceptions, and Gateway C is the final readiness boundary.",
    instructions: ["In authorized product operation, confirm legal name, role, business unit, joining date, manager and location through the visible workflow. For UAT, do not use this create flow; use the Test Center run link.", "At Gateway A, send a deficiency only for listed missing items; return to intake after correction and escalate no-response through the visible SLA path.", "At Gateway B, an adverse/disputed result goes to HR/Compliance; analysts do not self-disposition.", "At Gateway C, inspect each mandatory workstream plus fresh approval. Do not release access/assets based on score alone."],
    evidence: ["Case header, checklist states, workstream owner/status, redacted communication record, audit timestamps."], exceptions: ["Start-date, manager or role changes require the current workflow/review; do not overwrite a stale view.", "Conditional join is disabled unless approved tenant policy explicitly enables it."],
    featureIds: ["PFC-003", "PFC-005", "PFC-006", "PFC-007", "PFC-011"], scenarioIds: ["UAT-STD-01", "UAT-CASE-02"],
  },
  {
    id: "candidate", title: "Candidate portal, documents and confidentiality", roles: ["Candidate", "HR reviewer"], entryPoints: ["/candidate", "/cases/:id"],
    summary: "The portal is a separate limited journey for submitting requested material. HR reviews the associated case without exposing portal secrets or other workers' data.",
    instructions: ["For UAT, use only clearly labeled fictional files through the Test Center run-owned linked portal; do not upload to a generic case as an isolated test.", "Treat a downloadable fixture as input, not an auto-verified negative-content outcome. Record displayed local parse/content-rule results separately from scanner availability/detection, issuer authenticity and identity verification.", "Refresh the run-linked HR Documents view after upload and verify the run-owned association before progressing."],
    evidence: ["Candidate submission confirmation, displayed local parse/content-rule status, separately observed scanner/quarantine state where available."], exceptions: ["A local successful check is not a scanner result or a genuine BGV, malware, identity, authenticity or employment-readiness result.", "Never place portal URLs, tokens, real IDs, bank, tax, health or BGV details in evidence notes."],
    featureIds: ["PFC-007", "PFC-008", "PFC-009"], scenarioIds: ["UAT-STD-01", "UAT-DOC-01"],
  },
  {
    id: "communications", title: "Communications, monitoring and recovery", roles: ["HR coordinator", "QA coordinator", "approved volunteer"], entryPoints: ["/cases/:id", "/systems", "/demo-controller"],
    summary: "Communications show a redacted operational record. Default UAT uses simulation; real email is a separately opted-in approved-mailbox test using the existing monitored route.",
    instructions: ["Check Systems for monitor health before relying on inbound replies.", "For simulated runs, record status-email, duplicate, delayed and ambiguous events as non-authoritative exchanges.", "For real email, select only an approved volunteer/mailbox through the existing path and capture a redacted existing audit record."],
    evidence: ["Communication audit, monitor state, correlation/duplicate outcome."], exceptions: ["Do not authorize recipients from Test Center.", "Uncertain send is not retried automatically; spoofed, self-echo and ambiguous messages must not be silently attached."],
    featureIds: ["PFC-010", "PFC-039"], scenarioIds: ["UAT-EMAIL-01", "UAT-OPS-01"],
  },
  {
    id: "handoffs", title: "Work items, approvals and human ownership", roles: ["HR coordinator", "HR reviewer", "verified specialist"], entryPoints: ["/approvals", "/cases/:id"],
    summary: "Action Center makes work and review ownership visible. Human review, authority and audit records are part of the outcome, not optional annotations.",
    instructions: ["Open the work item/case link and identify its owner, due state and supporting evidence.", "Use the offered assign/complete/reopen flow; reload before retrying after a conflict.", "Route BGV, legal, privacy, medical, payroll and specialist decisions to their named owner."],
    evidence: ["Work item state, owner, decision/audit timestamp."], exceptions: ["An organization admin cannot self-declare Legal, EHS, Privacy or other specialist authority.", "Rejected, expired or stale approvals must remain blocked."],
    featureIds: ["PFC-012", "PFC-032"], scenarioIds: ["UAT-STD-01", "UAT-SEC-01"],
  },
  {
    id: "variants", title: "Case variants and early tenure", roles: ["HR Operations", "HRBP", "hiring manager"], entryPoints: ["/cases", "/settings"],
    summary: "Standard/lateral, campus/bulk, rehire/conversion, cross-border/relocation, executive, contractor, frontline and transfer are variants. They follow applicable lifecycle controls, not separate fictional stage names.",
    instructions: ["Use a cohort path for campus/bulk and keep individual exceptions visible.", "For rehire/conversion, use a policy-controlled prior-record review; do not create duplicate identity.", "For cross-border/relocation, hold unresolved work authorization for Mobility/Legal review.", "Treat executive and accessibility/accommodation details as privacy-sensitive, human-led cases.", "Use enabled early-tenure schedules for Day-1/30/60/90/probation only where configured."],
    evidence: ["Variant classification, applicable checklist/profile, human owner and schedule state."], exceptions: ["No visa, legal basis or accommodation conclusion is automated.", "Contractor/client-facing access remains scoped and approval-bound."],
    featureIds: ["PFC-004", "PFC-034", "PFC-035", "PFC-036"], scenarioIds: ["UAT-BATCH-02", "UAT-SETTINGS-01"],
  },
  {
    id: "frontline", title: "Frontline / blue-collar safety pathway", roles: ["Site HR", "EHS / Occupational Health", "Supervisor", "Payroll"], entryPoints: ["/cases", "/settings"],
    summary: "Frontline intake adds site, shift and skill context. This explains authorized operational work; UAT must use only Test Center run-owned evaluator/fixture links, not generic batch or case creation. Medical fitness and safety sign-off are independent hard gates; a weighted score cannot substitute for either before floor/site release.",
    instructions: ["Capture assisted/bulk intake facts and the applicable age, skill and eligibility evidence.", "Track BGV/police and medical/drug checks only where approved policy/law requires them.", "Record badge, PPE, uniform, tools/locker and wage/timesheet setup as separate prerequisites.", "Require EHS safety induction/competency before floor access; route restrictions, PPE stock-out and failed competency to hold/retrain."],
    evidence: ["Hard-gate state, issuance record, safety sign-off, redacted exception/handoff."], exceptions: ["No real medical, police, drug or identity verification is asserted from a simulation.", "Under-age or missing evidence blocks regulated deployment."],
    featureIds: ["PFC-004", "PFC-006", "PFC-035"], scenarioIds: ["UAT-FLT-01", "UAT-DOC-01"],
  },
  {
    id: "transfers", title: "M&A / TUPE / transfer pathway", roles: ["Transfer operator", "HR Integration", "Legal", "Payroll", "IT"], entryPoints: ["/workforce-transfers"],
    summary: "Transfer work is an inherited-population pathway. It preserves service continuity where applicable and follows legally authorized basis, consultation, objections, cutover and harmonisation steps. This is not an isolated UAT create flow: transfer UAT is Manual/Blocked unless an independently authorized non-production fixture is available.",
    instructions: ["In authorized product operation, create/open the transfer program and import a mapped population only after validating headings and service dates. Do not use generic transfer creation as simulated UAT.", "Request verified Legal authority for transfer basis; do not label a transfer TUPE/ARD automatically.", "Track consultation, individual measures communications and objection/opt-out handling as governed human work.", "At legal Day-1, inspect payroll, benefits and access evidence; record a contingency/parallel-run action if not complete."],
    evidence: ["Program/population version, authority state, cutover action and redacted audit."], exceptions: ["No automatic BGV exemption, legal basis or pay-disruption release.", "Asset purchase and cross-border arrangements need separate approved treatment."],
    featureIds: ["PFC-013", "PFC-014", "PFC-015", "PFC-016", "PFC-017"], scenarioIds: ["UAT-XFR-01"],
  },
  {
    id: "systems", title: "Systems, provider evidence and readiness", roles: ["System operator", "HR coordinator", "Payroll"], entryPoints: ["/systems", "/cases/:id"],
    summary: "Oracle HCM, ITSM, payroll/benefits and BGV are distinct source systems. The product can expose state and controlled exchanges; configuration status is not proof of an external effect.",
    instructions: ["Check monitor/provider configuration and record any unavailable/error state.", "Use normalized request/status/poll/webhook/status-email simulation only through the Test Center run-owned evaluator; it may evaluate production pure predicates against run state but cannot dispatch a provider or mutate real readiness.", "Keep HRIS, BGV, IT/asset and payroll/benefits evidence separate at readiness review."],
    evidence: ["System state, exchange history, source receipt where actually configured."], exceptions: ["Unconfigured adapter/sandbox remains Blocked.", "Late/out-of-order/duplicate events must not create a live readiness upgrade."],
    featureIds: ["PFC-024", "PFC-025", "PFC-026"], scenarioIds: ["UAT-OPS-01", "UAT-STD-01"],
  },
  {
    id: "ai", title: "AI agents, workflow drafting and guardrails", roles: ["HR coordinator", "owner/admin", "verified specialist"], entryPoints: ["/agents", "/recommendations", "/guardrails"],
    summary: "AI features provide visibility, recommendations and drafts under guardrails. Human accountability, source-system authority and specialised review are retained.",
    instructions: ["Review inputs and output before accepting any draft or recommendation.", "Use guardrails to understand why an action is blocked/escalated.", "Treat candidate documents, notes and free text as evidence to review—not instructions to execute."],
    evidence: ["Redacted recommendation/draft, guardrail decision, related audit."], exceptions: ["No automated adverse hiring, BGV, legal, medical, accommodation or payroll decision.", "Unavailable AI result must be recorded, not replaced with invented content."],
    featureIds: ["PFC-018", "PFC-019", "PFC-023"], scenarioIds: ["UAT-AI-01"],
  },
  {
    id: "policy", title: "Cited policy, library, review and expiry", roles: ["Policy user", "verified specialist", "owner/admin"], entryPoints: ["/policy-assistant", "/hr-policy-library", "/policy-review"],
    summary: "The policy assistant should show cited sources and limitations. Library/review workflows preserve versions, expiry reminders and governed authority.",
    instructions: ["Ask a bounded product/policy question and inspect citation context.", "Use the review workflow for a proposed policy decision and inspect authority/version state.", "Record expiry reminders as prompts for an owner, not proof that policy is renewed."],
    evidence: ["Redacted cited response, policy version, review/authority status."], exceptions: ["Draft/provisional BRD language is not an approved tenant policy.", "Legal/medical/privacy conclusion requires an authorized specialist."],
    featureIds: ["PFC-020", "PFC-021", "PFC-022", "PFC-032"], scenarioIds: ["UAT-POLICY-01"],
  },
  {
    id: "analytics", title: "Analytics, bottlenecks and outcomes", roles: ["Analytics reviewer", "HR Operations", "People Analytics"], entryPoints: ["/analytics", "/recommendations"],
    summary: "Analytics summarizes operational workload, agent performance, risks and bottlenecks. It is an insight layer and must not make individual employment decisions.",
    instructions: ["Review KPI definitions, chart filters and drill-down source before relying on an insight.", "Run bottleneck simulation only with clearly stated non-production assumptions.", "Use aggregate skill/bottleneck insights for human planning review, suppressing small or sensitive populations."],
    evidence: ["Redacted chart/filter, source case link, simulation assumptions/output."], exceptions: ["Synthetic test data is not historical KPI evidence.", "Do not publish small-population or sensitive BGV/medical/work-authorization analytics."],
    featureIds: ["PFC-025", "PFC-026"], scenarioIds: ["UAT-ANL-01"],
  },
  {
    id: "administration", title: "Client setup, profiles, SLA, privacy and membership", roles: ["owner/admin"], entryPoints: ["/client-setup", "/settings"],
    summary: "Owners/admins configure organization-level setup, process files, checklists/profiles, job context, readiness/SLA, early-tenure and privacy settings. This is authorized operational work, not isolation for UAT; configuration tests remain Manual unless an independently authorized non-production fixture exists. Scope and version matter.",
    instructions: ["Save/reload a synthetic configuration before using it for a test.", "Validate checklist IDs/order and profile precedence; new cases receive snapshots, existing cases require deliberate management.", "Inspect the governance note before changing legal, timezone, retention, medical, payroll or transfer-related settings.", "Manage membership separately from verified specialist authority."],
    evidence: ["Configuration version, validation result, scope and audit record."], exceptions: ["Do not assume a retention period, payroll cutoff or jurisdiction calendar.", "Do not alter real configuration to create a test condition."],
    featureIds: ["PFC-027", "PFC-028", "PFC-029", "PFC-033", "PFC-034", "PFC-035"], scenarioIds: ["UAT-CONFIG-01", "UAT-SETTINGS-01", "UAT-SEC-01"],
  },
  {
    id: "audit", title: "Audit, archive, export and recovery", roles: ["Auditor", "owner/admin"], entryPoints: ["/audit", "/cases/:id", "/workforce-transfers/:id"],
    summary: "Audit records support review of who did what and when. Archive/delete/restore are tested only where the product visibly offers them, and retention/hold rules take precedence.",
    instructions: ["Export only redacted evidence suitable for sign-off.", "Compare event version/owner/time when recovering from stale or conflicting updates.", "Use retention/hold-aware controls and never remove genuine operational history during UAT."],
    evidence: ["Redacted audit export, version conflict, archive/hold response."], exceptions: ["An offered archive action is not blanket permission to delete.", "Unsupported CRUD actions are not available merely because the guide names them."],
    featureIds: ["PFC-030", "PFC-031", "PFC-032"], scenarioIds: ["UAT-ARCH-01", "UAT-SEC-01"],
  },
  {
    id: "demo", title: "Demo Center and synthetic boundaries", roles: ["Demo Organization member", "owner/admin"], entryPoints: ["/demo-controller", "/settings"],
    summary: "Demo Center is available to every Demo Organization member for synthetic workflows and presentations. It is not a route around live controls.",
    instructions: ["Confirm the synthetic/demo label and action identity.", "Use demo communications/overrides only as described by the current control.", "Review reset scope before confirming; retain run evidence first."],
    evidence: ["Demo action receipt, actor label, reset-scope confirmation."], exceptions: ["Demo presentation overrides are not provider or workflow proof.", "Never use reset on genuine cases/history."],
    featureIds: ["PFC-037", "PFC-038", "PFC-039"], scenarioIds: ["UAT-DEMO-01"],
  },
  {
    id: "test-center", title: "UAT Test Center: run, evidence and safe cleanup", roles: ["Organization member", "test coordinator"], entryPoints: ["/uat/"],
    summary: "Select a role-appropriate scenario, create a tenant-scoped synthetic run, then use only its linked synthetic case, candidate portal or run-owned evaluator. Record observed evidence, pause/resume, export and clean only run-owned state. Reference coverage is a catalog mapping; only a recorded run can make an execution assertion.",
    instructions: ["Read scenario prerequisites, actor assignment, test mode and blocker before creating the run. If a role, provider or real workflow is required, record Manual or Blocked rather than using a generic product create action.", "Use the fixture manifest and harmless files as inputs, not pre-verified outcomes; capture displayed local parse/content-rule state separately from scanner, authenticity and provider observations.", "Record Passed, Failed, Blocked or Not applicable with a redacted reason. A safely blocked negative action can pass its test, while the unavailable capability remains blocked.", "Use the run-scoped clock/exchanges and evaluator only for run-owned simulation. It can apply production pure predicates to run state but must never change real-case readiness; export before scoped cleanup."],
    evidence: ["Run/catalog/baseline version, linked-subject/evaluator reference, fixture seed, step history, provenance, report export and cleanup receipt."], exceptions: ["Test Center does not impersonate/promote users, authorize real recipients, dispatch providers or make generic Case/Batch/Transfer creation isolated.", "Simulation evidence cannot clear real quarantine, certify vendors, assert scanner/authenticity outcomes, or establish live readiness."],
    featureIds: ["PFC-040", "PFC-041", "PFC-042", "PFC-043"], scenarioIds: ["UAT-UAT-01", "UAT-OPS-01", "UAT-SEC-01"],
  },
];

/** Lower-case aliases are intended for catalog consumers and static generators. */
export const guideSections = GUIDE_SECTIONS;
export const features = PRODUCT_FEATURES;
export const requirements = REQUIREMENTS;

export const FEATURE_COVERAGE = {
  denominator: PRODUCT_FEATURES.length,
  /** Reference mappings only; they are not executed UAT assertions. */
  referenceMapped: PRODUCT_FEATURES.filter((feature) => feature.referenceCoverage === "mapped").length,
  withGuide: PRODUCT_FEATURES.filter((feature) => GUIDE_SECTIONS.some((section) => section.id === feature.guideTopic)).length,
  withScenario: PRODUCT_FEATURES.filter((feature) => feature.scenarioIds.length > 0).length,
  /** The static catalog has no run/evidence ledger. */
  executedAssertions: 0,
  blocked: PRODUCT_FEATURES.filter((feature) => feature.verification === "blocked").length,
  manual: PRODUCT_FEATURES.filter((feature) => feature.verification === "manual" || feature.verification === "implemented-observation-required").length,
} as const;

export const REQUIREMENT_COVERAGE = {
  denominator: REQUIREMENTS.length,
  /** A route is reference coverage, not an execution result. */
  referenceMapped: REQUIREMENTS.filter((requirement) => requirement.scenarioIds.length > 0).length,
  withScenario: REQUIREMENTS.filter((requirement) => requirement.scenarioIds.length > 0).length,
  executedAssertions: 0,
  unavailableOrPolicyDependent: REQUIREMENTS.filter((requirement) => requirement.availability === "not-implemented" || requirement.availability === "policy-dependent").length,
  providerSandboxBlocked: REQUIREMENTS.filter((requirement) => requirement.testMode === "provider-sandbox").length,
} as const;

export function inventoryConsistencyIssues(): string[] {
  const issues: string[] = [];
  const scenarioIds = new Set(UAT_SCENARIOS.map((item) => item.id));
  const guideIds = new Set(GUIDE_SECTIONS.map((item) => item.id));
  const featureIds = new Set(PRODUCT_FEATURES.map((item) => item.id));
  const requirementIds = new Set(REQUIREMENTS.map((item) => item.id));
  if (scenarioIds.size !== UAT_SCENARIOS.length) issues.push("Duplicate scenario ID.");
  if (featureIds.size !== PRODUCT_FEATURES.length) issues.push("Duplicate product feature ID.");
  if (guideIds.size !== GUIDE_SECTIONS.length) issues.push("Duplicate guide section ID.");
  for (const feature of PRODUCT_FEATURES) {
    if (!guideIds.has(feature.guideTopic)) issues.push(`${feature.id}: missing guide topic ${feature.guideTopic}.`);
    if (!GUIDE_SECTIONS.some((section) => section.featureIds.includes(feature.id))) issues.push(`${feature.id}: not linked from guide content.`);
    if (!feature.scenarioIds.length) issues.push(`${feature.id}: missing test scenario.`);
    feature.scenarioIds.filter((id) => !scenarioIds.has(id)).forEach((id) => issues.push(`${feature.id}: unknown scenario ${id}.`));
  }
  for (const requirement of REQUIREMENTS) {
    if (!requirement.scenarioIds.length) issues.push(`${requirement.id}: missing test route.`);
    requirement.scenarioIds.filter((id) => !scenarioIds.has(id)).forEach((id) => issues.push(`${requirement.id}: unknown scenario ${id}.`));
    if ((requirement.availability === "not-implemented" || requirement.availability === "policy-dependent") && !requirement.gapReason) issues.push(`${requirement.id}: gap has no reason.`);
  }
  for (const item of UAT_SCENARIOS) {
    item.featureIds?.filter((id) => !featureIds.has(id)).forEach((id) => issues.push(`${item.id}: unknown feature ${id}.`));
    item.requirementIds?.filter((id) => !requirementIds.has(id)).forEach((id) => issues.push(`${item.id}: unknown requirement ${id}.`));
    if (item.mode === "simulated" && !item.prerequisites?.[0]?.includes("Test Center")) issues.push(`${item.id}: simulated scenario is missing the Test Center boundary.`);
  }
  for (const section of GUIDE_SECTIONS) {
    section.featureIds.filter((id) => !featureIds.has(id)).forEach((id) => issues.push(`${section.id}: unknown feature ${id}.`));
    section.scenarioIds.filter((id) => !scenarioIds.has(id)).forEach((id) => issues.push(`${section.id}: unknown scenario ${id}.`));
  }
  return issues;
}