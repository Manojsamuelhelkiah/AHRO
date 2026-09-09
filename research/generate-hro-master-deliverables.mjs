import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const requireFromApi = createRequire(path.resolve("artifacts/api-server/package.json"));
const ExcelJS = requireFromApi("exceljs");

const root = process.cwd();
const taxonomyPath = path.join(root, "research/hro-master-intent-taxonomy.json");
const existingSourcesPath = path.join(root, "research/sources.json");
const taxonomy = JSON.parse(await readFile(taxonomyPath, "utf8"));
const existingSources = JSON.parse(await readFile(existingSourcesPath, "utf8")).sources;

const masterSources = [
  {
    key: "master-sap-onboarding-tasks",
    title: "Onboarding Tasks",
    url: "https://help.sap.com/docs/successfactors-onboarding/implementing-onboarding/onboarding-tasks",
    publisher: "SAP Help Portal",
    publishedDate: null,
    tier: 2,
    credibility: "Official product documentation for onboarding programs, responsible groups, equipment, buddy, and completion tasks.",
    evidencePath: "research/sources/master-hire-01.md",
    focusArea: "Recruiting, preboarding, and onboarding",
    evidenceType: "fetched",
  },
  {
    key: "master-uscis-i9-retention",
    title: "Form I-9 Retention and Storage",
    url: "https://www.uscis.gov/i-9-central/completing-form-i-9/retention-and-storage",
    publisher: "U.S. Citizenship and Immigration Services",
    publishedDate: "2020-07-10",
    tier: 1,
    credibility: "Government source for U.S. employment-eligibility records, retention, inspection, and electronic audit controls.",
    evidencePath: "research/sources/master-hire-02.md",
    focusArea: "Work eligibility and records",
    evidenceType: "fetched",
  },
  {
    key: "master-ftc-background-checks",
    title: "Employer Background Checks and Your Rights",
    url: "https://consumer.ftc.gov/articles/employer-background-checks-your-rights",
    publisher: "U.S. Federal Trade Commission",
    publishedDate: "2025-08-01",
    tier: 1,
    credibility: "Government source for U.S. screening consent, report copies, disputes, and adverse-action notices.",
    evidencePath: "research/sources/master-hire-03.md",
    focusArea: "Background screening",
    evidenceType: "fetched",
  },
  {
    key: "master-ecfr-personnel-records",
    title: "5 CFR Part 293 Subpart A—Basic Policies on Maintenance of Personnel Records",
    url: "https://www.ecfr.gov/current/title-5/chapter-I/subchapter-B/part-293/subpart-A",
    publisher: "Electronic Code of Federal Regulations",
    publishedDate: null,
    tier: 1,
    credibility: "Government source for personnel-record maintenance, access, disclosure, and integrity concepts.",
    evidencePath: "research/sources/master-core-01.md",
    focusArea: "Core HR records",
    evidenceType: "fetched",
  },
  {
    key: "master-ico-employment-sar",
    title: "Subject access request Q and As for employers",
    url: "https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/subject-access-request-q-and-as-for-employers",
    publisher: "UK Information Commissioner's Office",
    publishedDate: null,
    tier: 1,
    credibility: "Regulator guidance for employment subject-access intake, search, redaction, and response.",
    evidencePath: "research/sources/master-core-02.md",
    focusArea: "Privacy rights",
    evidenceType: "fetched",
  },
  {
    key: "master-servicenow-hr-case",
    title: "HR Case Management",
    url: "https://www.servicenow.com/docs/r/yokohama/employee-service-management/hr-service-delivery/c_HRCaseManagement.html",
    publisher: "ServiceNow",
    publishedDate: null,
    tier: 2,
    credibility: "Official product documentation supporting case intake, assignment, work, confidentiality, SLA, and closure patterns.",
    evidencePath: "research/sources/master-core-03.md",
    focusArea: "HR service delivery",
    evidenceType: "fetched",
  },
  {
    key: "master-gsa-time-leave",
    title: "Time and Leave",
    url: "https://www.gsa.gov/buy-through-us/shared-services/support-services-for-commissions-and-boards/hr-links-user-guides/time-and-leave",
    publisher: "U.S. General Services Administration",
    publishedDate: "2026-07-21",
    tier: 1,
    credibility: "Government service documentation for time entry, leave requests, balances, approvals, and corrections.",
    evidencePath: "research/sources/master-pay-01.md",
    focusArea: "Time and leave",
    evidenceType: "fetched",
  },
  {
    key: "master-oracle-time-payroll",
    title: "Integrating Absence Management, Time and Labor, and Payroll",
    url: "https://docs.oracle.com/en/applications/peoplesoft/human-capital-management/9.2.055/peoplesoft-time-and-labor/integrating-absence-management-time-labor-payroll-north-america.html",
    publisher: "Oracle",
    publishedDate: null,
    tier: 2,
    credibility: "Official product documentation for absence, payable time, and payroll interface boundaries.",
    evidencePath: "research/sources/master-pay-02.md",
    focusArea: "Time, absence, and payroll integration",
    evidenceType: "fetched",
  },
  {
    key: "master-govuk-payroll-errors",
    title: "Fix problems with running payroll",
    url: "https://www.gov.uk/payroll-errors/correct-mistakes",
    publisher: "GOV.UK",
    publishedDate: null,
    tier: 1,
    credibility: "Government guidance supporting payroll correction and statutory reconciliation workflows.",
    evidencePath: "research/sources/master-pay-03.md",
    focusArea: "Payroll corrections",
    evidenceType: "fetched",
  },
  {
    key: "master-cipd-performance",
    title: "Performance management: An introduction",
    url: "https://www.cipd.org/en/knowledge/factsheets/performance-factsheet",
    publisher: "Chartered Institute of Personnel and Development",
    publishedDate: null,
    tier: 1,
    credibility: "Professional-body guidance for goals, feedback, review, development, and performance processes.",
    evidencePath: "research/sources/master-talent-01.md",
    focusArea: "Performance",
    evidenceType: "fetched",
  },
  {
    key: "master-cipd-workforce-planning",
    title: "Workforce planning",
    url: "https://www.cipd.org/en/knowledge/factsheets/workforce-planning-factsheet",
    publisher: "Chartered Institute of Personnel and Development",
    publishedDate: null,
    tier: 1,
    credibility: "Professional-body guidance for workforce demand, supply, capability, and action planning.",
    evidencePath: "research/sources/master-talent-02.md",
    focusArea: "Workforce planning",
    evidenceType: "fetched",
  },
  {
    key: "master-cipd-talent",
    title: "Talent management",
    url: "https://www.cipd.org/en/knowledge/factsheets/talent-factsheet",
    publisher: "Chartered Institute of Personnel and Development",
    publishedDate: null,
    tier: 1,
    credibility: "Professional-body guidance for learning, development, mobility, succession, and retention scope.",
    evidencePath: "research/sources/master-talent-03.md",
    focusArea: "Talent and careers",
    evidenceType: "fetched",
  },
  {
    key: "master-govuk-disciplinary",
    title: "Taking disciplinary action against an employee",
    url: "https://www.gov.uk/taking-disciplinary-action",
    publisher: "GOV.UK",
    publishedDate: null,
    tier: 1,
    credibility: "Government guidance supporting notice, procedure, meetings, decisions, and appeal boundaries.",
    evidencePath: "research/sources/master-risk-01.md",
    focusArea: "Disciplinary action",
    evidenceType: "fetched",
  },
  {
    key: "master-acas-grievance",
    title: "Formal grievance procedure",
    url: "https://www.acas.org.uk/grievance-procedure-step-by-step",
    publisher: "Acas",
    publishedDate: null,
    tier: 1,
    credibility: "Public professional guidance for grievance intake, investigation, meeting, decision, and appeal.",
    evidencePath: "research/sources/master-risk-02.md",
    focusArea: "Grievances and employee relations",
    evidenceType: "fetched",
  },
  {
    key: "master-osha-general-duty",
    title: "OSH Act of 1970, Section 5",
    url: "https://www.osha.gov/laws-regs/oshact/section5-duties",
    publisher: "U.S. Occupational Safety and Health Administration",
    publishedDate: null,
    tier: 1,
    credibility: "Government source for workplace-safety duty and hazard-remediation concepts.",
    evidencePath: "research/sources/master-risk-03.md",
    focusArea: "Occupational safety",
    evidenceType: "fetched",
  },
];

const normalizedExistingSources = existingSources.map((source) => ({
  ...source,
  tier: Math.min(Number(source.tier || 3), 3),
  focusArea: source.focusArea || "Prior HRO corpus and agent architecture research",
  evidenceType: source.evidenceType || "fetched or saved snippet",
}));

const sourcesByUrl = new Map();
for (const source of [...masterSources, ...normalizedExistingSources]) {
  if (!sourcesByUrl.has(source.url)) {
    sourcesByUrl.set(source.url, source);
  } else {
    const existing = sourcesByUrl.get(source.url);
    sourcesByUrl.set(source.url, {
      ...existing,
      tier: Math.min(existing.tier, source.tier),
      evidencePath: existing.evidencePath || source.evidencePath,
    });
  }
}
const sources = [...sourcesByUrl.values()];
const sourceIndex = new Map(sources.map((source, index) => [source.url, index + 1]));
const cite = (url) => `[[${sourceIndex.get(url)}]](${url})`;

const journeysByKey = new Map(taxonomy.journeys.map((row) => [row.key, row]));
const servicesByKey = new Map(taxonomy.serviceIntents.map((row) => [row.key, row]));
const leavesByService = new Map(taxonomy.serviceIntents.map((row) => [row.key, []]));
for (const row of taxonomy.subIntents) {
  leavesByService.get(row.serviceIntentKey).push(row);
}

const leafCountsByAgent = new Map();
for (const row of taxonomy.subIntents) {
  leafCountsByAgent.set(row.accountableAgent, (leafCountsByAgent.get(row.accountableAgent) || 0) + 1);
}

const allSystems = [...new Set(taxonomy.subIntents.flatMap((row) => row.systems))].sort();
const allRequesterTypes = [...new Set(taxonomy.subIntents.flatMap((row) => row.requesters))].sort();

const csvEscape = (value) => {
  const text = Array.isArray(value)
    ? value.join(" | ")
    : value === null || value === undefined
      ? ""
      : String(value);
  return `"${text.replaceAll('"', '""')}"`;
};

const flatHeaders = [
  "intentKey",
  "intentName",
  "journeyKey",
  "journeyName",
  "serviceIntentKey",
  "serviceIntentName",
  "description",
  "requesters",
  "accountableAgent",
  "collaboratingAgents",
  "systems",
  "flowClass",
  "riskClass",
  "readActions",
  "writeActions",
  "humanApproval",
  "completionEvidence",
  "exactAliases",
  "jurisdictionOverlay",
  "targetMaturity",
  "currentCoverage",
  "promotionStatus",
  "currentRuntimeStatus",
  "legacyReferenceKey",
  "sourceFamilies",
];

const flatRows = taxonomy.subIntents.map((row) => ({
  intentKey: row.key,
  intentName: row.name,
  journeyKey: row.journeyKey,
  journeyName: journeysByKey.get(row.journeyKey).name,
  serviceIntentKey: row.serviceIntentKey,
  serviceIntentName: servicesByKey.get(row.serviceIntentKey).name,
  description: row.description,
  requesters: row.requesters,
  accountableAgent: row.accountableAgent,
  collaboratingAgents: row.collaboratingAgents,
  systems: row.systems,
  flowClass: row.flowClass,
  riskClass: row.riskClass,
  readActions: row.readActions,
  writeActions: row.writeActions,
  humanApproval: row.humanApproval,
  completionEvidence: row.completionEvidence,
  exactAliases: row.exactAliases,
  jurisdictionOverlay: row.jurisdictionOverlay,
  targetMaturity: row.targetMaturity,
  currentCoverage: row.currentCoverage,
  promotionStatus: row.promotionStatus,
  currentRuntimeStatus: row.currentRuntimeStatus,
  legacyReferenceKey: row.legacyReferenceKey,
  sourceFamilies: row.sourceFamilies,
}));

const csv = [
  flatHeaders.map(csvEscape).join(","),
  ...flatRows.map((row) => flatHeaders.map((header) => csvEscape(row[header])).join(",")),
].join("\n");

const journeyStats = taxonomy.journeys.map((journey) => ({
  journey: journey.name,
  key: journey.key,
  services: taxonomy.serviceIntents.filter((service) => service.journeyKey === journey.key).length,
  leaves: taxonomy.subIntents.filter((leaf) => leaf.journeyKey === journey.key).length,
}));

const report = [];
report.push("# Comprehensive HRO Intent and Agent Coverage");
report.push("");
report.push("**Research date:** 9 September 2026  ");
report.push("**Depth:** Deep  ");
report.push(`**Sources consulted:** ${sources.length} saved or registered sources  `);
report.push(`**Taxonomy version:** ${taxonomy.taxonomyVersion}`);
report.push("");
report.push("## Executive summary");
report.push("");
report.push(`The recommended product corpus contains **${taxonomy.validation.counts.journeys} HRO journeys, ${taxonomy.validation.counts.serviceIntents} service intents, ${taxonomy.validation.counts.subIntents} atomic sub-intents, ${taxonomy.validation.counts.compositeRoutes} explicit composite route, and ${taxonomy.validation.counts.agentCapabilities} accountable specialist capabilities**. It replaces the misleading idea that broad journeys such as onboarding are single intents. SAP's own onboarding scope is task-program based and spans responsible groups, equipment, buddies, notifications, and completion handling ${cite("https://help.sap.com/docs/successfactors-onboarding/implementing-onboarding/onboarding-tasks")}; employment eligibility and background screening also contain separately controlled document, consent, retention, dispute, and notice outcomes ${cite("https://www.uscis.gov/i-9-central/completing-form-i-9/retention-and-storage")} ${cite("https://consumer.ftc.gov/articles/employer-background-checks-your-rights")}.`);
report.push("");
report.push(`The hierarchy now includes **${taxonomy.validation.counts.onboardingSubIntents} onboarding leaves across ${taxonomy.validation.counts.onboardingServiceIntents} services**. Examples include requesting BGV documents, recording screening consent, receiving the vendor result, handling a dispute, creating the worker record, collecting tax and bank information, setting pay/time profiles, enrolling benefits, provisioning identity/access, assigning equipment and facilities, issuing learning and policy tasks, coordinating the manager/buddy, checking day-one readiness, recording attendance/no-show, activating employment, managing probation, and cleaning up a cancelled hire.`);
report.push("");
report.push("This is a **target catalog**, not a claim of production automation. Today, one leaf (`background-check-chase`) and one composite route (`new-hire-setup`) are simulated; the other 319 leaves are unsupported by registered runtime executors. There are no integrated or production-verified specialist routes. The product must keep catalog coverage, agent mapping, and execution maturity separate.");
report.push("");
report.push("“Comprehensive” means a canonical global HRO operating model, not every country rule duplicated as a new intent. Local law, collective agreements, plan rules, data retention, approvals, and entity policy belong in jurisdiction and policy overlays. This prevents corpus explosion while allowing the same canonical intent to behave correctly by worker, country, legal entity, contract, and effective date.");
report.push("");
report.push("## Final coverage totals");
report.push("");
report.push("| Journey | Service intents | Atomic sub-intents |");
report.push("|---|---:|---:|");
for (const row of journeyStats) {
  report.push(`| ${row.journey} | ${row.services} | ${row.leaves} |`);
}
report.push(`| **Total** | **${taxonomy.validation.counts.serviceIntents}** | **${taxonomy.validation.counts.subIntents}** |`);
report.push("");
report.push("## Current versus target product coverage");
report.push("");
report.push("| Coverage layer | Count | Meaning |");
report.push("|---|---:|---|");
report.push("| Current reference concepts | 60 | Existing cost-model corpus retained and mapped: 59 atomic leaves plus 1 composite onboarding route. |");
report.push("| Proposed canonical leaves | 320 | Full target list below; aliases are not counted as separate intents. |");
report.push("| Custom intents | Environment-specific | Additive tenant outcomes using the same parent, owner, action, evidence, executor, risk, maturity, and version contract. |");
report.push("| Simulated runtime leaves | 1 | `background-check-chase`. |");
report.push("| Simulated composite routes | 1 | `new-hire-setup`. |");
report.push("| Integrated routes | 0 | No live source-system connector execution is evidenced. |");
report.push("| Production-verified routes | 0 | No end-to-end production executor is evidenced. |");
report.push("| Unsupported target leaves | 319 | Catalogued/mapped but not executable until an approved executor and evidence contract are registered. |");
report.push("");
report.push("## How the hierarchy works");
report.push("");
report.push("- **Journey:** a lifecycle area, such as Onboard and activate workers.");
report.push("- **Service intent:** a bounded process family, such as Background screening.");
report.push("- **Atomic sub-intent:** one routable outcome with one accountable specialist and observable completion evidence.");
report.push("- **Composite route:** an orchestration request that coordinates several atomic sub-intents without pretending to be one source-system write.");
report.push("- **Alias:** alternative wording that resolves to a canonical node and is never counted as another intent.");
report.push("- **Custom intent:** a tenant-defined canonical outcome, promoted only after ownership, evidence, actions, registered executors, risk, maturity, and version checks pass.");
report.push("");
report.push("## Complete intent and sub-intent list");
report.push("");
for (const journey of taxonomy.journeys) {
  const journeyServices = taxonomy.serviceIntents.filter((service) => service.journeyKey === journey.key);
  const journeyLeafCount = taxonomy.subIntents.filter((leaf) => leaf.journeyKey === journey.key).length;
  report.push(`### ${journey.name} (${journeyServices.length} services, ${journeyLeafCount} sub-intents)`);
  report.push("");
  report.push(journey.description);
  report.push("");
  for (const service of journeyServices) {
    const leaves = leavesByService.get(service.key);
    report.push(`#### ${service.name} (${leaves.length})`);
    report.push("");
    for (const leaf of leaves) {
      const flags = [
        leaf.riskClass,
        leaf.flowClass,
        leaf.jurisdictionOverlay ? "jurisdiction overlay" : null,
        leaf.currentRuntimeStatus,
      ].filter(Boolean).join("; ");
      report.push(`- **${leaf.name}** (\`${leaf.key}\`) — ${leaf.accountableAgent}. ${leaf.description} _${flags}._`);
    }
    report.push("");
  }
}
report.push("## Composite routes");
report.push("");
for (const route of taxonomy.compositeRoutes) {
  report.push(`- **${route.name}** (\`${route.key}\`) — ${route.description} It orchestrates ${route.subIntentKeys.length} named atomic outcomes across ${route.serviceIntentKeys.length} services. Current runtime: **${route.currentRuntimeStatus}**.`);
}
report.push("");
report.push("## Agent capability map");
report.push("");
report.push("| Accountable specialist capability | Owned leaves | Mission |");
report.push("|---|---:|---|");
for (const agent of taxonomy.agentCapabilities) {
  report.push(`| ${agent.name} | ${leafCountsByAgent.get(agent.name) || 0} | ${agent.mission.replaceAll("|", "\\|")} |`);
}
report.push("");
report.push("## Product implications");
report.push("");
report.push("### 1. Import the hierarchy without distorting the cost model");
report.push("");
report.push("The existing 60-row cost baseline should remain a versioned commercial model. The 320-leaf operational corpus is a different layer. Replacing the 60 cost rows with 320 rows would double-count composite work and invalidate current weights. Instead, map cost scenarios to service intents/composite routes while routing runtime requests to atomic leaves.");
report.push("");
report.push("### 2. Make every leaf resolvable before making it executable");
report.push("");
report.push(`The corpus browser and resolver should understand all 320 canonical leaves plus tenant custom intents. Unsupported leaves should still be searchable, classifiable, explainable, and intake-capable, but must fail closed before a remote write. HR case management patterns support separate intake, assignment, confidential work, SLA, and closure states ${cite("https://www.servicenow.com/docs/r/yokohama/employee-service-management/hr-service-delivery/c_HRCaseManagement.html")}.`);
report.push("");
report.push("### 3. Register bounded executors by specialist capability");
report.push("");
report.push(`Each accountable capability needs an executor registry with approved read/write tools, ownership, risk ceiling, evidence schema, and supported maturity. Time, absence, and payroll are distinct but connected operational boundaries ${cite("https://www.gsa.gov/buy-through-us/shared-services/support-services-for-commissions-and-boards/hr-links-user-guides/time-and-leave")} ${cite("https://docs.oracle.com/en/applications/peoplesoft/human-capital-management/9.2.055/peoplesoft-time-and-labor/integrating-absence-management-time-labor-payroll-north-america.html")}; one generic HR agent should not own all of them.`);
report.push("");
report.push("### 4. Keep evidence and human authority explicit");
report.push("");
report.push(`Restricted outcomes—screening, payroll release, privacy, employee relations, safety, accommodation, mobility, and termination—must retain source-confirmed evidence and human decision boundaries. Subject-access work alone requires bounded intake, search, review/redaction, and delivery activities ${cite("https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/subject-access-request-q-and-as-for-employers")}; grievance and disciplinary journeys likewise require distinct meeting, decision, and appeal outcomes ${cite("https://www.acas.org.uk/grievance-procedure-step-by-step")} ${cite("https://www.gov.uk/taking-disciplinary-action")}.`);
report.push("");
report.push("### 5. Apply policy overlays instead of multiplying canonical intents");
report.push("");
report.push("The same canonical leave, payroll, screening, mobility, or separation intent can have different rules by jurisdiction, entity, worker type, union/CBA, plan, and effective date. The resolver should select the applicable policy version and record it with the case evidence. This is especially important because the research sources include U.S. and UK examples and must not be generalized into universal entitlements.");
report.push("");
report.push("### 6. Roll out by value and risk");
report.push("");
report.push(`Start with high-volume deterministic reads and reversible writes, then policy-bound transactions, then multi-agent cases. Performance, talent, and workforce planning are broad professional disciplines rather than single chatbot labels ${cite("https://www.cipd.org/en/knowledge/factsheets/performance-factsheet")} ${cite("https://www.cipd.org/en/knowledge/factsheets/talent-factsheet")} ${cite("https://www.cipd.org/en/knowledge/factsheets/workforce-planning-factsheet")}. Employee-relations and safety routes should remain human-led with automation limited to intake, evidence handling, notifications, deadlines, and approved actions ${cite("https://www.osha.gov/laws-regs/oshact/section5-duties")}.`);
report.push("");
report.push("## Validation");
report.push("");
report.push("The canonical JSON passed the following checks:");
report.push("");
for (const [check, passed] of Object.entries(taxonomy.validation.checks)) {
  report.push(`- ${passed ? "Passed" : "Failed"}: ${check}`);
}
report.push("");
report.push("Additional workbook-generation checks confirm unique canonical names, unique aliases, no canonical-key/alias collision, exact journey/service child membership, and one accountable registered capability per leaf.");
report.push("");
report.push("## Limitations");
report.push("");
report.push("No finite global taxonomy can enumerate every client-specific policy name, collective-agreement clause, country form, vendor exception, or future regulation. The corpus therefore models canonical outcomes and marks where a jurisdiction overlay is mandatory. Agent ownership is a target operating model and may be reassigned during client implementation. Current runtime maturity is based only on repository evidence; catalog mapping must not be marketed as integration. The corpus should be governed as a versioned product asset with change review, alias collision checks, deprecation handling, and usage-driven additions.");
report.push("");
report.push("## Sources");
report.push("");
sources.forEach((source, index) => {
  const date = source.publishedDate || "date not stated";
  report.push(`${index + 1}. [${source.title}](${source.url}) — ${source.publisher || "Publisher not stated"}; ${date}; Tier ${source.tier}. Evidence: \`${source.evidencePath}\`.`);
});
report.push("");

const sourceRegistry = {
  accessedOn: "2026-09-09",
  methodology: "Deduplicated by URL from prior HRO coverage research and this deep taxonomy pass. Tier 1 is regulator/government/professional-body evidence; Tier 2 is official product or primary dataset evidence; Tier 3 is supporting/discovery evidence.",
  counts: {
    total: sources.length,
    tier1: sources.filter((source) => source.tier === 1).length,
    tier2: sources.filter((source) => source.tier === 2).length,
    tier3: sources.filter((source) => source.tier === 3).length,
  },
  sources,
};

await mkdir(path.join(root, "research"), { recursive: true });
await Promise.all([
  writeFile(path.join(root, "research/hro-master-intent-taxonomy.csv"), `${csv}\n`, "utf8"),
  writeFile(path.join(root, "research/hro-master-intent-taxonomy.md"), `${report.join("\n")}\n`, "utf8"),
  writeFile(
    path.join(root, "research/hro-master-taxonomy-sources.json"),
    `${JSON.stringify(sourceRegistry, null, 2)}\n`,
    "utf8",
  ),
]);

const workbook = new ExcelJS.Workbook();
workbook.creator = "Replit Agent";
workbook.company = "HRO Intent Corpus";
workbook.created = new Date("2026-09-09T00:00:00Z");
workbook.modified = new Date("2026-09-09T00:00:00Z");
workbook.title = "Comprehensive HRO Intent and Agent Coverage";
workbook.subject = "Global canonical HRO journey, service-intent, and atomic sub-intent taxonomy";

const colors = {
  navy: "17324D",
  blue: "2F75B5",
  lightBlue: "D9EAF7",
  teal: "1F6D74",
  lightTeal: "DDEBF0",
  green: "2E7D32",
  lightGreen: "E2F0D9",
  amber: "C78600",
  lightAmber: "FFF2CC",
  red: "B42318",
  lightRed: "FCE8E6",
  gray: "667085",
  lightGray: "F2F4F7",
  white: "FFFFFF",
  border: "D0D5DD",
};

const thinBorder = {
  top: { style: "thin", color: { argb: colors.border } },
  left: { style: "thin", color: { argb: colors.border } },
  bottom: { style: "thin", color: { argb: colors.border } },
  right: { style: "thin", color: { argb: colors.border } },
};

const styleHeader = (row, fill = colors.navy) => {
  row.height = 34;
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true, color: { argb: colors.white }, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = thinBorder;
  });
};

const styleDataRows = (sheet, startRow = 2) => {
  for (let rowIndex = startRow; rowIndex <= sheet.rowCount; rowIndex += 1) {
    const row = sheet.getRow(rowIndex);
    row.height = 42;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = thinBorder;
      cell.font = { size: 9, color: { argb: "202939" } };
      if (rowIndex % 2 === 0) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "F8FAFC" } };
      }
    });
  }
};

const applyRiskFill = (cell, risk) => {
  const fills = {
    low: colors.lightGreen,
    medium: colors.lightBlue,
    high: colors.lightAmber,
    restricted: colors.lightRed,
  };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fills[risk] || colors.lightGray } };
  cell.font = { bold: true, color: { argb: risk === "restricted" ? colors.red : colors.navy }, size: 9 };
  cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
};

const setColumns = (sheet, columns) => {
  sheet.columns = columns.map(([header, key, width]) => ({ header, key, width }));
  styleHeader(sheet.getRow(1));
  sheet.views = [{ state: "frozen", ySplit: 1, xSplit: Math.min(3, columns.length) }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
};

const summary = workbook.addWorksheet("Executive Summary", {
  properties: { tabColor: { argb: colors.navy } },
  views: [{ showGridLines: false }],
});
summary.columns = [
  { key: "a", width: 37 },
  { key: "b", width: 18 },
  { key: "c", width: 64 },
  { key: "d", width: 18 },
];
summary.mergeCells("A1:D2");
summary.getCell("A1").value = "Comprehensive HRO Intent and Agent Coverage";
summary.getCell("A1").font = { bold: true, size: 22, color: { argb: colors.white } };
summary.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors.navy } };
summary.getCell("A1").alignment = { vertical: "middle", horizontal: "left" };
summary.getRow(1).height = 32;
summary.getRow(2).height = 24;
summary.mergeCells("A3:D3");
summary.getCell("A3").value = "Global canonical baseline · 9 September 2026 · target catalog, not a claim of production automation";
summary.getCell("A3").font = { italic: true, color: { argb: colors.gray } };
summary.getCell("A3").alignment = { vertical: "middle" };
summary.addRow([]);
summary.addRow(["Metric", "Count", "Interpretation", "Current runtime"]);
styleHeader(summary.getRow(5), colors.teal);
const summaryRows = [
  ["Journeys", taxonomy.validation.counts.journeys, "Lifecycle-level grouping nodes", "Catalog"],
  ["Service intents", taxonomy.validation.counts.serviceIntents, "Bounded process families", "Catalog"],
  ["Atomic sub-intents", taxonomy.validation.counts.subIntents, "Canonical routable outcomes", "1 simulated / 319 unsupported"],
  ["Composite routes", taxonomy.validation.counts.compositeRoutes, "Orchestrations across multiple leaves", "1 simulated"],
  ["Agent capabilities", taxonomy.validation.counts.agentCapabilities, "Bounded accountable specialist roles", "2 represented by simulations"],
  ["Onboarding leaves", taxonomy.validation.counts.onboardingSubIntents, "Detailed preboarding-to-probation coverage", "1 simulated leaf"],
  ["Existing references", taxonomy.validation.counts.legacyReferenceKeys, "59 atomic mappings + 1 composite mapping", "2 simulated routes"],
  ["Integrated routes", 0, "Live approved source-system execution", "None evidenced"],
  ["Production verified", 0, "End-to-end evidence in production", "None evidenced"],
];
summary.addRows(summaryRows);
styleDataRows(summary, 6);
summary.addRow([]);
summary.addRow(["Journey", "Services", "Atomic sub-intents", "Share of corpus"]);
styleHeader(summary.getRow(summary.rowCount), colors.blue);
for (const row of journeyStats) {
  summary.addRow([row.journey, row.services, row.leaves, row.leaves / taxonomy.subIntents.length]);
  summary.getCell(summary.rowCount, 4).numFmt = "0.0%";
}
styleDataRows(summary, 17);
summary.addRow([]);
summary.mergeCells(`A${summary.rowCount}:D${summary.rowCount}`);
summary.getCell(summary.rowCount, 1).value = "Important: Local statutory and client policy variants are overlays on canonical intents. Mapped does not mean executable.";
summary.getCell(summary.rowCount, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors.lightAmber } };
summary.getCell(summary.rowCount, 1).font = { bold: true, color: { argb: colors.red } };
summary.getCell(summary.rowCount, 1).alignment = { wrapText: true, vertical: "middle" };
summary.getRow(summary.rowCount).height = 38;

const hierarchyColumns = [
  ["Journey", "journeyName", 28],
  ["Service intent", "serviceIntentName", 28],
  ["Intent key", "intentKey", 30],
  ["Atomic sub-intent", "intentName", 34],
  ["Description", "description", 48],
  ["Accountable agent", "accountableAgent", 34],
  ["Collaborating agents", "collaboratingAgents", 38],
  ["Requesters", "requesters", 24],
  ["Systems", "systems", 34],
  ["Flow class", "flowClass", 20],
  ["Risk", "riskClass", 14],
  ["Read actions", "readActions", 40],
  ["Write actions", "writeActions", 40],
  ["Human approval", "humanApproval", 45],
  ["Completion evidence", "completionEvidence", 48],
  ["Exact aliases", "exactAliases", 30],
  ["Jurisdiction overlay", "jurisdictionOverlay", 18],
  ["Target maturity", "targetMaturity", 18],
  ["Current coverage", "currentCoverage", 20],
  ["Promotion", "promotionStatus", 16],
  ["Current runtime", "currentRuntimeStatus", 18],
  ["Legacy reference", "legacyReferenceKey", 28],
  ["Source families", "sourceFamilies", 30],
];

const addHierarchySheet = (name, rows, tabColor) => {
  const sheet = workbook.addWorksheet(name, { properties: { tabColor: { argb: tabColor } } });
  setColumns(sheet, hierarchyColumns);
  for (const row of rows) {
    sheet.addRow({
      ...row,
      requesters: row.requesters.join(" | "),
      collaboratingAgents: row.collaboratingAgents.join(" | "),
      systems: row.systems.join(" | "),
      readActions: row.readActions.join(" | "),
      writeActions: row.writeActions.join(" | "),
      completionEvidence: row.completionEvidence.join(" | "),
      exactAliases: row.exactAliases.join(" | "),
      jurisdictionOverlay: row.jurisdictionOverlay ? "Yes" : "No",
      sourceFamilies: row.sourceFamilies.join(" | "),
    });
  }
  styleDataRows(sheet);
  const riskColumn = hierarchyColumns.findIndex((column) => column[1] === "riskClass") + 1;
  const runtimeColumn = hierarchyColumns.findIndex((column) => column[1] === "currentRuntimeStatus") + 1;
  for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex += 1) {
    applyRiskFill(sheet.getCell(rowIndex, riskColumn), sheet.getCell(rowIndex, riskColumn).value);
    const runtimeCell = sheet.getCell(rowIndex, runtimeColumn);
    runtimeCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: runtimeCell.value === "simulated" ? colors.lightBlue : colors.lightGray },
    };
    runtimeCell.font = { bold: true, color: { argb: colors.navy }, size: 9 };
  }
  return sheet;
};

addHierarchySheet("All 320 Sub-Intents", flatRows, colors.blue);
addHierarchySheet(
  "Onboarding 63",
  flatRows.filter((row) => row.journeyKey === "onboarding"),
  colors.teal,
);

const serviceSheet = workbook.addWorksheet("88 Service Intents", {
  properties: { tabColor: { argb: colors.blue } },
});
setColumns(serviceSheet, [
  ["Journey", "journey", 30],
  ["Service key", "key", 30],
  ["Service intent", "name", 36],
  ["Description", "description", 56],
  ["Atomic leaves", "leafCount", 16],
  ["Legacy references", "legacyReferences", 35],
]);
for (const service of taxonomy.serviceIntents) {
  serviceSheet.addRow({
    journey: journeysByKey.get(service.journeyKey).name,
    key: service.key,
    name: service.name,
    description: service.description,
    leafCount: service.subIntentKeys.length,
    legacyReferences: service.legacyReferenceKeys.join(" | "),
  });
}
styleDataRows(serviceSheet);

const agentSheet = workbook.addWorksheet("41 Agent Capabilities", {
  properties: { tabColor: { argb: colors.teal } },
});
setColumns(agentSheet, [
  ["Capability key", "key", 34],
  ["Accountable specialist capability", "name", 42],
  ["Owned leaves", "ownedLeaves", 15],
  ["Mission", "mission", 58],
  ["Service boundaries", "services", 50],
  ["System boundaries", "systems", 48],
  ["Default approval boundary", "approval", 58],
]);
for (const agent of taxonomy.agentCapabilities) {
  agentSheet.addRow({
    key: agent.key,
    name: agent.name,
    ownedLeaves: leafCountsByAgent.get(agent.name) || 0,
    mission: agent.mission,
    services: agent.serviceIntentKeys.map((key) => servicesByKey.get(key)?.name || key).join(" | "),
    systems: agent.systemBoundaries.join(" | "),
    approval: agent.defaultApprovalBoundary,
  });
}
styleDataRows(agentSheet);

const legacyMappings = [];
for (const leaf of taxonomy.subIntents) {
  if (leaf.legacyReferenceKey) {
    legacyMappings.push({
      legacyKey: leaf.legacyReferenceKey,
      nodeType: "atomic-sub-intent",
      canonicalKey: leaf.key,
      canonicalName: leaf.name,
      journey: journeysByKey.get(leaf.journeyKey).name,
      service: servicesByKey.get(leaf.serviceIntentKey).name,
      currentRuntime: leaf.currentRuntimeStatus,
    });
  }
}
for (const route of taxonomy.compositeRoutes) {
  legacyMappings.push({
    legacyKey: route.legacyReferenceKey,
    nodeType: route.nodeType,
    canonicalKey: route.key,
    canonicalName: route.name,
    journey: journeysByKey.get(route.journeyKey).name,
    service: route.serviceIntentKeys.map((key) => servicesByKey.get(key)?.name || key).join(" | "),
    currentRuntime: route.currentRuntimeStatus,
  });
}
legacyMappings.sort((a, b) => a.legacyKey.localeCompare(b.legacyKey));

const legacySheet = workbook.addWorksheet("Legacy 60 Mapping", {
  properties: { tabColor: { argb: colors.amber } },
});
setColumns(legacySheet, [
  ["Existing reference key", "legacyKey", 32],
  ["Mapped node type", "nodeType", 22],
  ["Canonical key", "canonicalKey", 32],
  ["Canonical name", "canonicalName", 38],
  ["Journey", "journey", 30],
  ["Service(s)", "service", 50],
  ["Current runtime", "currentRuntime", 18],
]);
legacySheet.addRows(legacyMappings);
styleDataRows(legacySheet);

const lookupSheet = workbook.addWorksheet("Lookups & Governance", {
  properties: { tabColor: { argb: colors.gray } },
  views: [{ showGridLines: false }],
});
lookupSheet.columns = [
  { width: 34 },
  { width: 48 },
  { width: 34 },
  { width: 48 },
];
lookupSheet.addRow(["Requester types", "", "System categories", ""]);
styleHeader(lookupSheet.getRow(1));
const lookupLength = Math.max(allRequesterTypes.length, allSystems.length);
for (let index = 0; index < lookupLength; index += 1) {
  lookupSheet.addRow([
    allRequesterTypes[index] || "",
    "",
    allSystems[index] || "",
    "",
  ]);
}
styleDataRows(lookupSheet);
lookupSheet.addRow([]);
lookupSheet.addRow(["Governance rule", "Required handling", "Allowed values", "Notes"]);
styleHeader(lookupSheet.getRow(lookupSheet.rowCount), colors.teal);
const governanceRows = [
  ["Node counting", "Count journeys, services, leaves, routes, and aliases separately.", "journey | service-intent | atomic-sub-intent | composite-route | alias", "Aliases never increase canonical intent totals."],
  ["Execution maturity", "Catalog mapping must not imply runtime execution.", "unsupported | simulated | integrated | verified", "Fail closed if executor/evidence/ownership contracts are missing."],
  ["Risk", "Use risk to set approval, data-access, and executor ceilings.", "low | medium | high | restricted", "Restricted routes remain human-authorized."],
  ["Policy overlays", "Resolve rules by jurisdiction, entity, worker type, plan, CBA, and effective date.", "boolean plus policy/version reference", "Do not clone canonical intents per country."],
  ["Custom intents", "Require parent, exact aliases, owner, actions, evidence, executor, risk, maturity, and version.", "draft | catalogued | executable", "Custom rows remain additive to the reference corpus."],
];
lookupSheet.addRows(governanceRows);
styleDataRows(lookupSheet, lookupSheet.rowCount - governanceRows.length + 1);

const sourceSheet = workbook.addWorksheet("Sources", {
  properties: { tabColor: { argb: colors.gray } },
});
setColumns(sourceSheet, [
  ["#", "number", 8],
  ["Source", "title", 48],
  ["Publisher", "publisher", 30],
  ["URL", "url", 70],
  ["Published", "publishedDate", 16],
  ["Tier", "tier", 10],
  ["Focus area", "focusArea", 34],
  ["Evidence path", "evidencePath", 52],
  ["Assessment", "credibility", 72],
]);
sources.forEach((source, index) => {
  sourceSheet.addRow({
    number: index + 1,
    title: source.title,
    publisher: source.publisher || "",
    url: source.url,
    publishedDate: source.publishedDate || "",
    tier: source.tier,
    focusArea: source.focusArea,
    evidencePath: source.evidencePath,
    credibility: source.credibility,
  });
  sourceSheet.getCell(index + 2, 4).value = {
    text: source.url,
    hyperlink: source.url,
    tooltip: source.title,
  };
  sourceSheet.getCell(index + 2, 4).font = { color: { argb: "0563C1" }, underline: true, size: 9 };
});
styleDataRows(sourceSheet);

const dictionarySheet = workbook.addWorksheet("Data Dictionary", {
  properties: { tabColor: { argb: colors.gray } },
});
setColumns(dictionarySheet, [
  ["Field", "field", 30],
  ["Applies to", "appliesTo", 28],
  ["Definition", "definition", 80],
  ["Import rule", "rule", 64],
]);
dictionarySheet.addRows([
  { field: "journeyKey", appliesTo: "service and leaf", definition: "Stable lifecycle grouping key.", rule: "Must reference one registered journey." },
  { field: "serviceIntentKey", appliesTo: "leaf", definition: "Stable bounded-process parent key.", rule: "Must reference one service under the leaf journey." },
  { field: "key", appliesTo: "all canonical nodes", definition: "Globally unique canonical machine key.", rule: "Kebab case; never reuse a retired meaning." },
  { field: "exactAliases", appliesTo: "leaf", definition: "Alternative exact labels resolving to this canonical key.", rule: "May not collide with another canonical key or alias." },
  { field: "accountableAgent", appliesTo: "leaf", definition: "One bounded capability accountable for the outcome.", rule: "Must resolve to one agent capability and own the selected executor." },
  { field: "collaboratingAgents", appliesTo: "leaf", definition: "Capabilities participating without owning final outcome.", rule: "Must not repeat the accountable capability." },
  { field: "flowClass", appliesTo: "leaf", definition: "Deterministic, policy-bound, multi-agent, or frontier execution complexity.", rule: "Use only registered enum values." },
  { field: "riskClass", appliesTo: "leaf", definition: "Approval and execution-risk ceiling.", rule: "Restricted outcomes require explicit human authority." },
  { field: "completionEvidence", appliesTo: "leaf", definition: "Observable evidence proving completion.", rule: "Evidence must be source-confirmed before a route completes." },
  { field: "jurisdictionOverlay", appliesTo: "leaf", definition: "Whether local legal or policy resolution is mandatory.", rule: "Resolve and record the applicable policy/version at runtime." },
  { field: "currentRuntimeStatus", appliesTo: "leaf and route", definition: "Evidence-backed execution maturity today.", rule: "Mapped/catalogued never implies simulated, integrated, or verified." },
  { field: "legacyReferenceKey", appliesTo: "leaf or composite route", definition: "One-to-one mapping to an existing 60-row reference concept.", rule: "Every legacy key maps exactly once by honest node type." },
]);
styleDataRows(dictionarySheet);

for (const sheet of workbook.worksheets) {
  sheet.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    paperSize: 9,
    margins: {
      left: 0.25,
      right: 0.25,
      top: 0.5,
      bottom: 0.5,
      header: 0.2,
      footer: 0.2,
    },
  };
  sheet.headerFooter.oddFooter = "&LComprehensive HRO Intent Corpus&CPage &P of &N&R9 September 2026";
}

const workbookPath = path.join(root, "research/hro-master-intent-taxonomy.xlsx");
await workbook.xlsx.writeFile(workbookPath);

console.log(JSON.stringify({
  taxonomy: taxonomy.validation.counts,
  sources: sourceRegistry.counts,
  files: [
    "research/hro-master-intent-taxonomy.json",
    "research/hro-master-intent-taxonomy.csv",
    "research/hro-master-intent-taxonomy.xlsx",
    "research/hro-master-intent-taxonomy.md",
    "research/hro-master-taxonomy-sources.json",
  ],
}, null, 2));