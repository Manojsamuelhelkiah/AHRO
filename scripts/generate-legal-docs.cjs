/* Generates placeholder legal & product documentation PDFs into legal-documents/ */
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'legal-documents');

const COMPANY = '[PROVIDER LEGAL NAME]';
const PRODUCT = 'Autonomous HRO Agentic Platform';

const docs = [
  {
    file: '01_Master_Services_Agreement.pdf',
    stage: 'Contract & Onboard',
    title: 'Master Services Agreement (MSA)',
    sections: [
      ['Parties & Effective Date', `This Master Services Agreement ("Agreement") is entered into as of [EFFECTIVE DATE] between ${COMPANY}, with registered office at [PROVIDER ADDRESS] ("Provider"), and [CLIENT LEGAL NAME], with registered office at [CLIENT ADDRESS] ("Client").`],
    ['Services', `Provider will provide the ${PRODUCT}, an AI-assisted hire-to-retire HR operations platform, as described in each executed Order Form and the Documentation. [DESCRIBE INCLUDED MODULES / TIER].`],
      ['Term & Termination', 'Initial term of [INITIAL TERM, e.g. 36 months] from the Effective Date, renewing for successive [RENEWAL TERM] periods unless either party gives [NOTICE PERIOD, e.g. 90 days] written notice. Either party may terminate for material breach uncured within [CURE PERIOD, e.g. 30 days].'],
      ['Fees & Payment', 'Fees are set out in the applicable Order Form. Invoices are payable within [PAYMENT TERMS, e.g. 30 days]. Late payments accrue interest at [RATE]. Fees exclude applicable taxes.'],
      ['Intellectual Property', 'Provider retains all rights in the platform, models, and documentation. Client retains all rights in Client Data. Client grants Provider a limited licence to process Client Data solely to provide the Services. AI-generated outputs delivered to Client are licensed to Client for internal business use. [ADJUST OUTPUT OWNERSHIP POSITION].'],
      ['Warranties & Disclaimers', 'Provider warrants the Services will materially conform to the Documentation. EXCEPT AS EXPRESSLY STATED, THE SERVICES ARE PROVIDED "AS IS". AI outputs are probabilistic assistance and do not constitute legal, tax, or professional advice. [JURISDICTION-SPECIFIC WARRANTY LANGUAGE].'],
      ['Limitation of Liability', 'Each party\u2019s aggregate liability is capped at [CAP, e.g. fees paid in the preceding 12 months], except for [CARVE-OUTS: confidentiality breach, IP infringement, data protection breach at a super-cap of [SUPER-CAP]].'],
      ['Confidentiality, Governing Law & Notices', 'Standard mutual confidentiality obligations for [CONFIDENTIALITY PERIOD]. Governing law: [GOVERNING LAW]. Venue: [VENUE]. Notices to: [NOTICE ADDRESSES].'],
      ['Signatures', 'Provider: _________________________  Name: [NAME]  Title: [TITLE]  Date: [DATE]\n\nClient: _________________________  Name: [NAME]  Title: [TITLE]  Date: [DATE]'],
    ],
  },
  {
    file: '02_Order_Form_SOW.pdf',
    stage: 'Contract & Onboard',
    title: 'Order Form / Statement of Work',
    sections: [
      ['Order Details', `Order Form No.: [ORDER #]  ·  Effective Date: [DATE]  ·  Governing Agreement: MSA dated [MSA DATE].\nClient: [CLIENT LEGAL NAME]  ·  Provider: ${COMPANY}.`],
      ['Subscription & Tier', 'Isolation tier: [POOLED / SILOED DATA / DEDICATED]. Pricing model: [PEPM / PER RESOLVED CASE / PLATFORM + USAGE]. Employees served: [COUNT]. Countries in scope: [LIST]. Languages: [LIST].'],
      ['Fees', 'PEPM rate: [RATE] per employee per month. / Case rate card: [ATTACH RATE CARD]. Platform fee: [ANNUAL FEE]. Fair-use token band: [BAND]. Overage: [OVERAGE RATE]. One-time onboarding fee: [FEE], credited [CREDIT TERMS].'],
      ['Implementation Scope (SOW)', 'Phases per the Implementation Plan: Discover ([WEEKS]), Foundation ([WEEKS]), Build ([WEEKS]), Assure ([WEEKS]), Launch ([WEEKS]). In-scope connectors: [HCM / PAYROLL / TICKETING SYSTEMS]. In-scope flows: [FLOW LIST]. Out of scope: [EXCLUSIONS].'],
      ['Deliverables & Milestones', 'M1 Design signed off — [DATE]. M2 Connectors live — [DATE]. M3 UAT exit — [DATE]. M4 Pilot go-live — [DATE]. M5 Full rollout — [DATE]. Acceptance criteria: [CRITERIA].'],
      ['Client Responsibilities', 'Provide system access and test tenants by [DATE]; nominate SMEs ([ROLES]); supply policy library content; complete UAT within [WINDOW].'],
      ['Signatures', 'Provider: _________________________  Date: [DATE]\nClient: _________________________  Date: [DATE]'],
    ],
  },
  {
    file: '03_Acceptable_Use_Policy.pdf',
    stage: 'Contract & Onboard / In-Product',
    title: 'Acceptable Use Policy (AUP)',
    sections: [
      ['Purpose', `This policy defines permitted and prohibited use of the ${PRODUCT} by Client and its authorised users. It forms part of the Agreement and is available in-product at [URL].`],
      ['Permitted Use', 'Use of the platform for the Client\u2019s internal HR operations: employee queries, case submission and tracking, document requests, policy questions, and approved administrative workflows, by authorised users within licensed headcount.'],
      ['Prohibited Use', 'Users must NOT: (a) attempt to extract, jailbreak, or manipulate the underlying AI models or system prompts; (b) submit content that is unlawful, discriminatory, or harassing; (c) probe, scan, or test the vulnerability of the platform without written authorisation; (d) use outputs to make automated employment decisions without the human review required by the platform design; (e) scrape, bulk-export, or resell platform content; (f) share credentials or circumvent access controls; (g) upload malware or infringing material; (h) exceed fair-use limits by automated means. [ADD CLIENT-SPECIFIC RESTRICTIONS].'],
      ['AI-Specific Rules', 'AI responses are assistance, not advice; consequential actions (payroll changes, contract generation) require the human approval steps built into the platform and must not be bypassed. Users must not represent AI output as human-authored professional advice.'],
      ['Enforcement', 'Provider may suspend accounts or throttle usage for violations, with notice to [CLIENT ADMIN CONTACT] except where immediate action is required. Repeated or material violations are handled under the MSA termination provisions.'],
      ['Reporting', 'Report suspected misuse to [ABUSE CONTACT EMAIL]. Version: [X.Y] — Last updated: [DATE].'],
    ],
  },
  {
    file: '04_Data_Processing_Addendum_SCCs.pdf',
    stage: 'Contract & Onboard',
    title: 'Data Processing Addendum (DPA) incl. SCCs',
    sections: [
      ['Roles & Scope', `Client is the Controller; ${COMPANY} is the Processor. This DPA governs processing of personal data of Client\u2019s employees, contractors, and dependants in connection with the ${PRODUCT}, and forms part of the MSA dated [DATE].`],
      ['Details of Processing (Annex I)', 'Categories of data subjects: employees, former employees, candidates, dependants. Categories of data: identification, employment, compensation & payroll, benefits, absence & leave, [SPECIAL CATEGORIES IF ANY — health, works council]. Duration: term of the Agreement plus [RETENTION PERIOD]. Purpose: provision of HR operations services.'],
      ['Processor Obligations', 'Process only on documented instructions; ensure confidentiality commitments; implement technical and organisational measures per Annex II; assist with data-subject requests within [SLA]; notify personal-data breaches without undue delay and within [72 HOURS / CONTRACTUAL WINDOW]; delete or return data on termination.'],
      ['Subprocessing', 'Client provides general authorisation for subprocessors listed in the Subprocessor List at [URL]. Provider gives [NOTICE PERIOD, e.g. 30 days] notice of changes; Client may object on reasonable data-protection grounds.'],
      ['International Transfers (SCCs)', 'Where data is transferred outside the [EEA/UK/OTHER], the parties incorporate the EU Standard Contractual Clauses (Module 2, Controller-to-Processor) / UK IDTA as applicable. Data residency commitment: primary processing in [AZURE REGION(S)]. [TRANSFER IMPACT ASSESSMENT REFERENCE].'],
      ['AI Processing Terms', 'Client Data is not used to train foundation models. Model inference occurs within [AZURE OPENAI REGION / TENANT BOUNDARY]. Prompt and completion logs are retained for [PERIOD] for abuse monitoring and quality, then deleted. [ADJUST TO ACTUAL MODEL-PROVIDER TERMS].'],
      ['Security Measures (Annex II)', 'Encryption in transit and at rest; tenant isolation per subscribed tier; role-based access; Entra ID identities for humans and agents; audit logging; annual penetration testing; [CERTIFICATIONS: SOC 2 TYPE II, ISO 27001].'],
      ['Signatures', 'Controller: _________________________  Date: [DATE]\nProcessor: _________________________  Date: [DATE]'],
    ],
  },
  {
    file: '05_SLA_Schedule.pdf',
    stage: 'Contract & Onboard',
    title: 'Service Level Agreement (SLA) Schedule',
    sections: [
      ['Availability Commitment', 'Monthly uptime: [99.9% pooled / 99.95% dedicated — SELECT PER TIER], measured at the platform API boundary, excluding scheduled maintenance windows notified [NOTICE, e.g. 5 business days] in advance.'],
      ['Response & Resolution Targets', 'P1 (platform down / payroll-impacting): response [15 min], workaround [4 h]. P2 (major function degraded): response [1 h], workaround [1 business day]. P3 (minor defect): response [1 business day]. P4 (question/request): [2 business days]. [ADJUST PER TIER].'],
      ['AI Service Levels', 'Assistant first-response latency: [TARGET, e.g. p95 < 5 s] for deterministic flows. Case resolution SLA by flow class: Flow 1 [TARGET], Flow 2 [TARGET], Flow 3 [TARGET incl. human steps], Flow 4 [TARGET]. Human-escalation handoff time: [TARGET].'],
      ['Service Credits', 'Uptime below commitment: [CREDIT TABLE — e.g. 99.0–99.9% → 5% monthly fee; 95–99% → 15%; <95% → 30%]. Credits are calculated automatically from platform metering data and applied to the next invoice. Credits are the sole remedy except for [CHRONIC FAILURE TERMINATION RIGHT].'],
      ['Measurement & Reporting', 'Monthly service report delivered to [CLIENT CONTACT] by [DAY] of the following month, from the same telemetry visible in the client dashboard. Disputes raised within [WINDOW].'],
      ['Exclusions', 'Failures caused by Client systems or connectors outside Provider control, force majeure, suspension for AUP breach, or use outside the Documentation.'],
    ],
  },
  {
    file: '06_Privacy_Notice.pdf',
    stage: 'Live Operations / In-Product',
    title: 'Privacy Notice (Employee-Facing)',
    sections: [
      ['Who We Are', `This notice explains how the ${PRODUCT}, operated by ${COMPANY} on behalf of your employer [CLIENT NAME], processes your personal data. Your employer is the data controller; contact: [CLIENT DPO / HR CONTACT].`],
      ['What We Process', 'Identification and contact details; employment and organisational data; payroll and compensation data needed to answer your requests; documents you upload; your conversation history with the assistant; service telemetry. [LIST SPECIAL CATEGORIES IF APPLICABLE].'],
      ['Why & Legal Basis', 'To answer your HR questions and execute HR processes (performance of employment contract); service improvement and safety monitoring (legitimate interest); compliance with legal obligations. [ADD CONSENT-BASED ITEMS IF ANY].'],
      ['AI Processing', 'Your questions are processed by AI systems, with human review for sensitive or consequential cases. Your data is not used to train AI foundation models. Conversations are retained for [PERIOD] and are visible to [WHO — e.g. HR case workers when escalated].'],
      ['Retention & Your Rights', 'Data is retained per your employer\u2019s retention schedule: [SCHEDULE / LINK]. You may request access, correction, deletion, or restriction, and object to processing, via [CHANNEL]. You may escalate to [SUPERVISORY AUTHORITY].'],
      ['Transfers & Security', 'Data is processed in [REGION(S)] with safeguards described in the DPA between your employer and the Provider. Version [X.Y] — Last updated [DATE].'],
    ],
  },
  {
    file: '07_AI_Transparency_Notice.pdf',
    stage: 'Live Operations / In-Product',
    title: 'AI Transparency Notice',
    sections: [
      ['You Are Interacting With AI', `The ${PRODUCT} assistant is an artificial-intelligence system. It is disclosed as AI at the start of each conversation and in the interface at all times, in accordance with [EU AI ACT ART. 50 / APPLICABLE LAW].`],
      ['What the AI Does', 'Understands your request, retrieves your employer\u2019s HR policies, executes approved HR workflows, and drafts responses grounded in policy documents with citations. Flow classes: instant answers, policy Q&A, multi-step cases, and complex cases.'],
      ['Where Humans Are Involved', 'Consequential actions — payroll corrections, contractual changes, exceptions to policy — always require review and approval by a human HR professional before execution. You may request a human at any time by [MECHANISM, e.g. typing "talk to a person"].'],
      ['Limitations', 'The assistant can make mistakes, may not reflect the very latest policy changes before its knowledge is refreshed ([REFRESH CADENCE]), and does not provide legal, tax, or financial advice. Verify consequential information via the cited policy or a human agent.'],
      ['Automated Decision-Making', '[STATE POSITION: e.g. The platform does not make legally significant decisions about you solely by automated means; all such decisions include human review, consistent with GDPR Art. 22.]'],
      ['Contact & Version', 'Questions: [CONTACT]. Version [X.Y] — Last updated [DATE].'],
    ],
  },
  {
    file: '08_AI_Output_Disclaimer.pdf',
    stage: 'Live Operations / In-Product',
    title: 'AI Output Disclaimer',
    sections: [
      ['Nature of Outputs', `Responses generated by the ${PRODUCT} are AI-generated assistance grounded in [CLIENT NAME]\u2019s HR policy library and connected systems of record. They are provided for operational convenience.`],
      ['Not Professional Advice', 'Outputs do not constitute legal, tax, immigration, financial, or medical advice. For matters with legal or financial consequences — e.g. cross-border relocation, terminations, equity, benefits elections — consult the designated human specialists: [CONTACTS/CHANNEL].'],
      ['Accuracy & Citations', 'Policy answers include citations to source documents. Where the assistant cannot ground an answer, it will say so and route to a human rather than guess. If you believe an answer is wrong, report it via [FEEDBACK MECHANISM]; reported answers are reviewed within [SLA].'],
      ['Authoritative Sources', 'In case of conflict, the signed policy documents, employment contracts, and payroll system of record prevail over assistant responses. [LIST AUTHORITATIVE SYSTEMS].'],
      ['Version', 'Version [X.Y] — Last updated [DATE]. Displayed in-product at [LOCATION].'],
    ],
  },
  {
    file: '09_Subprocessor_List.pdf',
    stage: 'Live Operations',
    title: 'Subprocessor List',
    sections: [
      ['Purpose', 'Current subprocessors engaged in delivering the platform, per the DPA. Clients receive [NOTICE PERIOD] advance notice of additions or replacements via [NOTIFICATION CHANNEL] and may object per the DPA.'],
      ['Infrastructure', 'Microsoft Corporation — Azure cloud infrastructure (compute, storage, networking, database) — Region(s): [LIST] — Purpose: hosting. [ENTITY & LOCATION DETAILS].'],
      ['AI Models', 'Microsoft / Azure OpenAI Service — model inference — Region(s): [LIST] — Client data not used for training. [OTHER MODEL PROVIDERS IF ANY, e.g. Anthropic on Azure — SPECIFY].'],
      ['Platform Services', '[COMMUNICATIONS PROVIDER — e.g. email/SMS delivery] — [PURPOSE] — [LOCATION].\n[TELEPHONY/VOICE PROVIDER] — voice channel — [LOCATION].\n[MONITORING/OBSERVABILITY PROVIDER] — telemetry — [LOCATION].\n[SUPPORT TOOLING PROVIDER] — service desk — [LOCATION].'],
      ['Change Log', '[DATE] — Initial list published.\n[DATE] — [CHANGE].\nVersion [X.Y] — Last updated [DATE] — Maintained at [URL].'],
    ],
  },
  {
    file: '10_Trust_Center_Pack_Overview.pdf',
    stage: 'Live Operations',
    title: 'Trust Center Pack — Overview',
    sections: [
      ['Contents (Available Under NDA)', 'SOC 2 Type II report ([PERIOD]); ISO 27001 certificate ([SCOPE, CERT #]); latest penetration-test executive summary ([DATE, FIRM]); cloud security architecture whitepaper; AI safety & evaluation summary; business-continuity and disaster-recovery summary (RTO [X], RPO [Y]).'],
      ['Security Posture Summary', 'Tenant isolation per subscribed tier; encryption in transit (TLS 1.2+) and at rest (AES-256, [CMK OPTION]); Entra ID for workforce and agent identities; least-privilege RBAC; centralised audit logging with [RETENTION]; vulnerability management with [PATCH SLAS].'],
      ['AI Safety Summary', 'Content-safety guardrails on input and output; grounding with citation enforcement; eval suites run per release ([EVAL CATEGORIES]); red-teaming cadence [CADENCE]; model-change review board. Details in the AI safety summary document.'],
      ['Compliance Mapping', '[GDPR / SOC 2 / ISO 27001 / EU AI ACT ROLE: PROVIDER-DEPLOYER ANALYSIS / LOCAL PAYROLL REGULATIONS — LIST APPLICABLE FRAMEWORKS AND MAPPING DOCS].'],
      ['How to Request', 'Request access via [TRUST CENTER URL / CONTACT]. NDA template: [REFERENCE]. Reports refreshed: [CADENCE].'],
    ],
  },
  {
    file: '11_Release_Notes_Template.pdf',
    stage: 'Change & Update',
    title: 'Release Notes — Template',
    sections: [
      ['Release Header', 'Release: [VERSION] — Date: [DATE] — Environments: [ROLLOUT ORDER, e.g. sandbox → production] — Downtime: [NONE / WINDOW].'],
      ['New Features', '[FEATURE 1 — one-paragraph functional description, affected personas, how to enable].\n[FEATURE 2 — ...].'],
      ['Improvements & Fixes', '[IMPROVEMENT — description].\n[FIX — symptom, affected versions, resolution].'],
      ['AI / Model Changes', '[MODEL OR PROMPT CHANGES — reference the Model/Feature Card for this release: DOC LINK]. [NONE THIS RELEASE].'],
      ['Deprecations & Breaking Changes', '[ITEM — deprecation date, migration path, contact]. Advance notice period per contract: [PERIOD].'],
      ['Admin Actions Required', '[ACTION — e.g. re-consent connector scopes, review new intent mappings] — due by [DATE].'],
    ],
  },
  {
    file: '12_Change_Notification_Template.pdf',
    stage: 'Change & Update',
    title: 'Material Change Notification — Template',
    sections: [
      ['Notification Details', 'Date: [DATE] — Reference: [CHANGE #] — Category: [TERMS / SUBPROCESSOR / MODEL / SECURITY / PRICING] — Effective date: [DATE, respecting contractual notice period of [PERIOD]].'],
      ['Summary of Change', '[PLAIN-LANGUAGE DESCRIPTION OF WHAT IS CHANGING AND WHY].'],
      ['Impact Assessment', 'Affected clients/tiers: [SCOPE]. Data-protection impact: [NONE / DPIA REFERENCE]. Action required from client: [NONE / DESCRIBE]. '],
      ['Client Rights', 'Objection window: [PERIOD] per [DPA §X / MSA §Y]. To object or ask questions, contact [CONTACT]. If no objection is received by [DATE], the change takes effect as described.'],
      ['Approval', 'Change approved by: [ROLE] — [DATE]. Distribution: [CHANNELS — email to admins, trust center, in-product banner].'],
    ],
  },
  {
    file: '13_Model_Feature_Card_Template.pdf',
    stage: 'Change & Update',
    title: 'Model / Feature Card — Template',
    sections: [
      ['Identification', 'Card for: [MODEL VERSION / AI FEATURE NAME] — Release: [VERSION] — Date: [DATE] — Supersedes: [PRIOR CARD].'],
      ['What Changed', '[E.G. UPGRADED REASONING MODEL FROM X TO Y FOR FLOW CLASS 3–4; REVISED INTENT CLASSIFIER; NEW GUARDRAIL].'],
      ['Intended Use & Limits', 'Intended: [FLOWS / PERSONAS]. Not intended: [EXCLUDED USES]. Known limitations: [LIST — languages, edge cases, latency].'],
      ['Evaluation Results', 'Eval suites run: [SUITES — grounding accuracy, refusal correctness, policy-citation precision, bias probes]. Results vs prior version: [SUMMARY TABLE / DELTAS]. Red-team findings: [SUMMARY, REMEDIATIONS].'],
      ['Rollout & Rollback', 'Rollout: [STAGED PLAN]. Monitoring: [METRICS WATCHED]. Rollback trigger and procedure: [CRITERIA].'],
      ['Data & Privacy Notes', 'Training-data statement: client data not used for training. Inference location: [REGION]. Log retention unchanged / changed to [PERIOD].'],
    ],
  },
  {
    file: '14_User_Guide_Update_Cover_Template.pdf',
    stage: 'Change & Update',
    title: 'User & Admin Guide Update — Cover Sheet Template',
    sections: [
      ['Document Control', 'Guide: [ADMIN GUIDE / END-USER GUIDE / HITL WORKBENCH GUIDE] — Version: [X.Y] — Date: [DATE] — Aligned to platform release: [VERSION].'],
      ['What\u2019s Updated', '[SECTION — CHANGE SUMMARY].\n[SECTION — CHANGE SUMMARY].'],
      ['Audience & Distribution', 'Audience: [HR ADMINS / EMPLOYEES / HITL CASE WORKERS]. Distribution: [PORTAL URL, IN-PRODUCT HELP, TRAINING SESSION DATE].'],
      ['Training Impact', '[NONE / REQUIRED — describe training or walkthrough needed, and completion deadline].'],
      ['Approval', 'Documentation owner: [NAME/ROLE] — Reviewed by: [PRODUCT / LEGAL if user-facing claims changed] — Date: [DATE].'],
    ],
  },
  {
    file: '15_Incident_Notification_Template.pdf',
    stage: 'Incident & Exit',
    title: 'Incident / Breach Notification — Template',
    sections: [
      ['Notification Header', 'To: [CLIENT SECURITY & DPO CONTACTS] — From: [PROVIDER INCIDENT COMMANDER] — Date/Time (UTC): [TIMESTAMP] — Incident ref: [INC #] — Classification: [SECURITY INCIDENT / PERSONAL DATA BREACH / AVAILABILITY INCIDENT].'],
      ['Regulatory Clock', 'For personal data breaches: initial notification within [72 HOURS / CONTRACTUAL WINDOW] of awareness ([AWARENESS TIMESTAMP]). This is an [INITIAL / UPDATE / FINAL] notification. Information not yet available is marked TBD and will follow in phased updates.'],
      ['What Happened', '[FACTUAL DESCRIPTION — what occurred, when detected, how detected]. Affected service components: [LIST]. Affected tenants: [THIS CLIENT ONLY / MULTIPLE — scope for this client].'],
      ['Data & Impact Assessment', 'Categories of personal data potentially affected: [LIST / NONE / TBD]. Approximate number of data subjects: [N / TBD]. Likely consequences: [ASSESSMENT]. '],
      ['Containment & Remediation', 'Actions taken: [CONTAINMENT STEPS + TIMESTAMPS]. Actions planned: [STEPS + ETA]. Recommended client actions: [E.G. NONE / CREDENTIAL ROTATION / EMPLOYEE COMMS SUPPORT].'],
      ['Contacts & Next Update', 'Provider contact: [NAME, ROLE, PHONE, EMAIL]. Next update by: [TIMESTAMP]. Final RCA to follow within [PERIOD] of resolution.'],
    ],
  },
  {
    file: '16_RCA_Post_Incident_Report_Template.pdf',
    stage: 'Incident & Exit',
    title: 'Root Cause Analysis / Post-Incident Report — Template',
    sections: [
      ['Incident Summary', 'Incident ref: [INC #] — Severity: [P1–P4] — Duration: [START]–[END] (total [DURATION]) — Services affected: [LIST] — Clients affected: [SCOPE] — SLA impact: [CREDITS APPLICABLE Y/N].'],
      ['Timeline', '[TIMESTAMP] — [EVENT: detection, escalation, mitigation, resolution]. (Repeat rows as needed.)'],
      ['Root Cause', '[TECHNICAL ROOT CAUSE — plain-language plus technical detail]. Contributing factors: [LIST]. Why existing safeguards did not prevent it: [ANALYSIS].'],
      ['Impact', 'User-visible impact: [DESCRIPTION]. Data impact: [NONE / DESCRIBED IN BREACH NOTIFICATION INC #]. AI-behaviour impact if applicable: [E.G. DEGRADED GROUNDING — cases flagged for review: N].'],
      ['Corrective & Preventive Actions', '[ACTION — OWNER — DUE DATE — STATUS]. (Repeat.) Verification method for each action: [HOW CLOSURE IS EVIDENCED].'],
      ['Sign-Off', 'Prepared by: [INCIDENT COMMANDER] — Reviewed by: [ENGINEERING / SECURITY / LEGAL] — Shared with client: [DATE] per [SLA §X].'],
    ],
  },
  {
    file: '17_Audit_Compliance_Report_Template.pdf',
    stage: 'Incident & Exit / Annual',
    title: 'Annual Audit & Compliance Report — Template',
    sections: [
      ['Reporting Period', 'Period: [START]–[END] — Prepared for: [CLIENT NAME] — Tier: [ISOLATION TIER] — Prepared by: [ROLE] — Date: [DATE].'],
      ['Certifications & Attestations', 'SOC 2 Type II: [PERIOD, AUDITOR, RESULT]. ISO 27001: [CERT #, EXPIRY]. Penetration test: [DATE, FIRM, CRITICAL/HIGH FINDINGS + REMEDIATION STATUS]. [OTHER: e.g. payroll-specific attestations].'],
      ['Service Performance', 'Uptime achieved vs commitment: [TABLE BY MONTH]. SLA credits issued: [LIST/NONE]. P1/P2 incidents: [COUNT, REFERENCES].'],
      ['AI Governance', 'Model changes during period: [LIST + CARD REFERENCES]. Eval and red-team summary: [RESULTS]. Human-in-the-loop override rate: [METRIC]. Complaints about AI outputs and resolutions: [SUMMARY].'],
      ['Data Protection', 'Data-subject requests handled: [COUNT, ON-TIME %]. Breaches notified: [NONE / REFERENCES]. Subprocessor changes: [LIST]. DPA compliance confirmations: [STATEMENT].'],
      ['Audit Rights', 'This report supports the audit rights in [MSA/DPA §X]. On-site or remote audit requests: [PROCESS, NOTICE PERIOD, FREQUENCY LIMIT].'],
    ],
  },
  {
    file: '18_Exit_Data_Return_Plan.pdf',
    stage: 'Incident & Exit',
    title: 'Exit & Data Return Plan',
    sections: [
      ['Purpose & Trigger', 'This plan governs orderly exit on expiry or termination of the Agreement dated [DATE], per [MSA §X]. Transition period: [PERIOD, e.g. up to 6 months] from notice, at [RATES — e.g. then-current fees / T&M rate card].'],
      ['Data Export', 'Exportable data sets: employee case history, conversation transcripts, documents, policy library, configuration, audit logs. Formats: [CSV / JSON / PDF — per data set]. Delivery: [SECURE TRANSFER METHOD]. Export completed within [PERIOD] of request. Fees: [INCLUDED / RATE].'],
      ['Data Deletion', 'Following confirmed export, Client Data is deleted from production within [PERIOD, e.g. 30 days] and from backups within [BACKUP CYCLE, e.g. 90 days]. Deletion certificate issued to [CONTACT] by [ROLE]. Exceptions: data retained where legally required — [LEGAL HOLDS / STATUTORY RETENTION].'],
      ['Transition Assistance', 'Provider will supply: [KNOWLEDGE-TRANSFER SESSIONS — N], intent/flow inventory export, connector configuration documentation, and reasonable cooperation with the successor provider, up to [HOURS CAP] at [RATE].'],
      ['Continuity During Exit', 'Services continue at contracted SLAs during the transition period. No destructive changes to Client tenant during [FREEZE WINDOW]. Escalation contact during exit: [NAME/ROLE].'],
      ['Sign-Off', 'Provider: _________________________ Date: [DATE]\nClient: _________________________ Date: [DATE]'],
    ],
  },
];

fs.mkdirSync(OUT, { recursive: true });

function render(doc) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margins: { top: 60, bottom: 60, left: 60, right: 60 } });
    const stream = fs.createWriteStream(path.join(OUT, doc.file));
    pdf.pipe(stream);

    // Header band
    pdf.rect(0, 0, pdf.page.width, 6).fill('#2f81f7');
    pdf.moveDown(0.5);
    pdf.fillColor('#6b7a90').fontSize(9).font('Helvetica')
      .text(`${PRODUCT}  ·  ${doc.stage}  ·  TEMPLATE — PLACEHOLDERS IN [BRACKETS] MUST BE COMPLETED AND REVIEWED BY LEGAL COUNSEL`, { align: 'left' });
    pdf.moveDown(0.6);
    pdf.fillColor('#0a1526').fontSize(20).font('Helvetica-Bold').text(doc.title);
    pdf.moveDown(0.2);
    pdf.strokeColor('#2f81f7').lineWidth(1.5)
      .moveTo(60, pdf.y).lineTo(pdf.page.width - 60, pdf.y).stroke();
    pdf.moveDown(0.8);

    doc.sections.forEach(([h, body], i) => {
      if (pdf.y > pdf.page.height - 140) pdf.addPage();
      pdf.fillColor('#1a4f8f').fontSize(12.5).font('Helvetica-Bold').text(`${i + 1}. ${h}`);
      pdf.moveDown(0.25);
      pdf.fillColor('#222').fontSize(10).font('Helvetica').text(body, { lineGap: 2 });
      pdf.moveDown(0.7);
    });

    pdf.fillColor('#9aa7b8').fontSize(8).font('Helvetica-Oblique')
      .text('This template is provided for drafting convenience only and does not constitute legal advice. Obtain review from qualified counsel in each applicable jurisdiction before use.', 60, pdf.page.height - 90, { width: pdf.page.width - 120 });

    pdf.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

(async () => {
  for (const d of docs) await render(d);
  console.log(`Generated ${docs.length} PDFs in ${OUT}`);
})();
