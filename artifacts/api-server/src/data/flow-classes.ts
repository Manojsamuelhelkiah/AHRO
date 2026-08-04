import type { FlowClass, SourceRef } from "./types";
import { assumptionMap } from "./assumptions";

// All step unit costs are derived from the global assumption registry so the
// "Applied Assumptions" register is the single source of truth for the model.
const SLM = assumptionMap["slm-call-cost"]!.value;
const LLM = assumptionMap["llm-call-cost"]!.value;
const FRONTIER = assumptionMap["frontier-call-cost"]!.value;
const MCP = assumptionMap["mcp-action-cost"]!.value;
const DATA = assumptionMap["data-call-cost"]!.value;
const INFRA = assumptionMap["infra-per-txn"]!.value;

const pricingSrc: SourceRef = {
  name: "Azure OpenAI / consumption pricing model",
  confidence: "medium",
};
const assumptionSrc: SourceRef = {
  name: "Documented assumption (delivery sizing)",
  confidence: "low",
};

// The four flow-class templates codified from the deck's flow slides.
// Component refs use the deck's circled numbers:
// 1 Experience, 2 AI Gateway, 3 Multimodal Intake, 4 Intent & Routing,
// 5 Orchestration (supervisor/reason/memory/HITL), 6 MCP Services + Registry /
// Case Mgmt & SLA / Act Integration, 7 Systems of Record.
export const flowClasses: FlowClass[] = [
  {
    key: "fc1-deterministic",
    name: "Deterministic Self-Service",
    slideRef: "Flow: Payslip Copy & Leave Balance",
    description:
      "High-volume, zero-ambiguity requests resolved end-to-end without human involvement: retrieve, verify, deliver. Mirrors the deck's payslip-copy flow (1-4-6-7-6).",
    buildCostUsd: 18000,
    buildAssumption:
      "Per intent family: prompt/route configuration, one MCP read pattern, test pack and rollout. ~15 person-days at blended delivery rate.",
    amortizationTransactions: 250000,
    steps: [
      {
        id: "fc1-s1",
        stage: "intake",
        label: "Channel intake & identity check",
        componentRefs: ["1", "2"],
        agents: ["Experience Layer", "AI Gateway"],
        human: false,
        systems: [{ systemKey: "idp", actions: ["get"], scalesWithLandscape: false }],
        costs: [
          { type: "infra", label: "Gateway + session infra", unitCostUsd: INFRA * 0.2, assumption: "20% of infra-per-txn: gateway/identity share per request at pooled utilization.", source: pricingSrc },
        ],
        benefits: [
          { type: "experience", label: "24/7 instant availability", dollarized: false, unitBenefitUsd: 0, qualitative: "Employee gets an answer at any hour instead of waiting for service-desk hours.", assumption: "Channel availability vs. 8x5 desk." },
        ],
      },
      {
        id: "fc1-s2",
        stage: "intent",
        label: "Intent classification & routing",
        componentRefs: ["4"],
        agents: ["Intent Classifier"],
        human: false,
        systems: [],
        costs: [
          { type: "ai-consumption", label: "SLM routing call", unitCostUsd: SLM, calls: [{ role: "router", count: 1 }], assumption: "One small-model call (slm-call-cost) classifies and routes.", source: pricingSrc },
        ],
        benefits: [],
      },
      {
        id: "fc1-s3",
        stage: "act",
        label: "Retrieve from system of record",
        componentRefs: ["6", "7"],
        agents: ["Act Integration (MCP)"],
        human: false,
        systems: [
          { systemKey: "sf-ec", actions: ["get"], scalesWithLandscape: true },
          { systemKey: "sf-ecp", actions: ["get"], scalesWithLandscape: true },
        ],
        costs: [
          { type: "ai-consumption", label: "MCP get actions", unitCostUsd: MCP, assumption: "Per-intent get actions x mcp-action-cost; repeats across the client landscape (Act fan-out).", source: pricingSrc },
          { type: "infra", label: "Connector infra share", unitCostUsd: INFRA * 0.27, assumption: "27% of infra-per-txn: API management + connector amortization.", source: pricingSrc },
        ],
        benefits: [
          { type: "human-effort", label: "Handling time eliminated", dollarized: true, unitBenefitUsd: 0, qualitative: "", assumption: "Dollarized centrally: (as-is minutes - to-be minutes) x HR hourly rate. Shown in the roll-up, not double-counted here." },
          { type: "cycle-time", label: "Seconds instead of days", dollarized: false, unitBenefitUsd: 0, qualitative: "Resolution drops from a 1-2 day ticket to under a minute.", assumption: "Deck flow slide SLA comparison." },
        ],
      },
      {
        id: "fc1-s4",
        stage: "close",
        label: "Deliver result & auto-close case",
        componentRefs: ["6", "1"],
        agents: ["Case Management & SLA"],
        human: false,
        systems: [{ systemKey: "ticketing", actions: ["put"], scalesWithLandscape: false }],
        costs: [
          { type: "infra", label: "Case write + audit trail", unitCostUsd: INFRA * 0.13, assumption: "13% of infra-per-txn: ticket auto-creation/closure and audit log entry.", source: pricingSrc },
        ],
        benefits: [
          { type: "compliance", label: "Complete audit trail", dollarized: false, unitBenefitUsd: 0, qualitative: "Every transaction is logged with full lineage - no unrecorded shadow work.", assumption: "Guardrails/observability cross-cutting layer." },
        ],
      },
    ],
  },
  {
    key: "fc2-policy",
    name: "Grounded Policy Answer",
    slideRef: "Flow: Policy Question",
    description:
      "Policy and knowledge questions answered from the curated client knowledge base with confidence scoring; low-confidence answers are gated to a human reviewer. Mirrors the deck's policy-question flow (1-4-6-5 + HITL gate).",
    buildCostUsd: 45000,
    buildAssumption:
      "Per intent family: knowledge curation pipeline, retrieval tuning, confidence calibration, reviewer workflow. ~35 person-days plus content onboarding.",
    amortizationTransactions: 150000,
    steps: [
      {
        id: "fc2-s1",
        stage: "intake",
        label: "Channel intake & context capture",
        componentRefs: ["1", "2"],
        agents: ["Experience Layer", "AI Gateway"],
        human: false,
        systems: [{ systemKey: "idp", actions: ["get"], scalesWithLandscape: false }],
        costs: [
          { type: "infra", label: "Gateway + session infra", unitCostUsd: INFRA * 0.2, assumption: "20% of infra-per-txn: gateway/identity share per request.", source: pricingSrc },
        ],
        benefits: [],
      },
      {
        id: "fc2-s2",
        stage: "intent",
        label: "Intent classification & entitlement scoping",
        componentRefs: ["4"],
        agents: ["Intent Classifier"],
        human: false,
        systems: [],
        costs: [
          { type: "ai-consumption", label: "SLM routing call", unitCostUsd: SLM, calls: [{ role: "router", count: 1 }], assumption: "One small-model call (slm-call-cost) scopes the question to country/entity policy set.", source: pricingSrc },
        ],
        benefits: [],
      },
      {
        id: "fc2-s3",
        stage: "knowledge",
        label: "Grounded retrieval & answer synthesis",
        componentRefs: ["6", "5"],
        agents: ["Knowledge Agent", "Reasoning Agent"],
        human: false,
        systems: [
          { systemKey: "knowledge-base", actions: ["get"], scalesWithLandscape: false },
          { systemKey: "sf-ec", actions: ["get"], scalesWithLandscape: true },
        ],
        costs: [
          { type: "ai-consumption", label: "Retrieval + LLM synthesis", unitCostUsd: LLM + SLM, calls: [{ role: "reasoning", count: 1 }, { role: "router", count: 1 }], assumption: "One reasoning-model call (llm-call-cost) plus one small-model rerank call (slm-call-cost) with grounded context.", source: pricingSrc },
          { type: "infra", label: "Vector search infra", unitCostUsd: INFRA * 0.2, assumption: "20% of infra-per-txn: AI Search query share.", source: pricingSrc },
        ],
        benefits: [
          { type: "error-reduction", label: "Policy-cited answers", dollarized: false, unitBenefitUsd: 0, qualitative: "Answers cite the governing policy version, reducing wrong-answer rework and escalations.", assumption: "Grounding on curated corpus vs. tribal knowledge." },
        ],
      },
      {
        id: "fc2-s4",
        stage: "orchestration",
        label: "Confidence gate - human review when low",
        componentRefs: ["5"],
        agents: ["Supervisor Agent", "HITL Reviewer"],
        human: true,
        systems: [{ systemKey: "ticketing", actions: ["put"], scalesWithLandscape: false }],
        costs: [
          { type: "human", label: "Reviewer minutes (blended)", unitCostUsd: 0, assumption: "Residual human minutes are intent-specific (toBeHumanMin) and dollarized centrally at the HITL hourly rate.", source: assumptionSrc },
        ],
        benefits: [
          { type: "compliance", label: "Human accountability on low confidence", dollarized: false, unitBenefitUsd: 0, qualitative: "Sensitive or ambiguous policy answers always carry a named human approver.", assumption: "Deck HITL gate (amber) on the policy flow." },
        ],
      },
      {
        id: "fc2-s5",
        stage: "close",
        label: "Deliver answer & log case",
        componentRefs: ["6", "1"],
        agents: ["Case Management & SLA"],
        human: false,
        systems: [{ systemKey: "ticketing", actions: ["put"], scalesWithLandscape: false }],
        costs: [
          { type: "infra", label: "Case write + audit trail", unitCostUsd: INFRA * 0.13, assumption: "13% of infra-per-txn: ticket logging and audit entry.", source: pricingSrc },
        ],
        benefits: [],
      },
    ],
  },
  {
    key: "fc3-multiagent",
    name: "Multi-Agent Transaction",
    slideRef: "Flow: Payroll Discrepancy Dispute",
    description:
      "Multi-step transactions where several specialist agents investigate, reconcile and execute writes behind a human approval gate. Mirrors the deck's payroll-discrepancy flow (1-3-5-5 + approver + 6-7-6).",
    buildCostUsd: 120000,
    buildAssumption:
      "Per intent family: multi-agent orchestration graph, reconciliation logic, write-path integration with approval workflow, regression pack. ~90 person-days.",
    amortizationTransactions: 80000,
    steps: [
      {
        id: "fc3-s1",
        stage: "intake",
        label: "Multimodal intake & document parsing",
        componentRefs: ["1", "3"],
        agents: ["Multimodal Intake"],
        human: false,
        systems: [{ systemKey: "doc-store", actions: ["get", "put"], scalesWithLandscape: false }],
        costs: [
          { type: "ai-consumption", label: "Document extraction call", unitCostUsd: SLM * 4, calls: [{ role: "router", count: 4 }], assumption: "Vision/document parsing at ~4x slm-call-cost for attached payslips or evidence.", source: pricingSrc },
          { type: "infra", label: "Intake pipeline infra", unitCostUsd: INFRA * 0.2, assumption: "20% of infra-per-txn: blob storage, queue and scanning share.", source: pricingSrc },
        ],
        benefits: [],
      },
      {
        id: "fc3-s2",
        stage: "intent",
        label: "Classify dispute & assemble case context",
        componentRefs: ["4", "6"],
        agents: ["Intent Classifier", "Case Management"],
        human: false,
        systems: [{ systemKey: "ticketing", actions: ["put"], scalesWithLandscape: false }],
        costs: [
          { type: "ai-consumption", label: "SLM routing call", unitCostUsd: SLM, calls: [{ role: "router", count: 1 }], assumption: "One small-model call (slm-call-cost): classification plus SLA clock start.", source: pricingSrc },
        ],
        benefits: [],
      },
      {
        id: "fc3-s3",
        stage: "orchestration",
        label: "Investigator agents reconcile records",
        componentRefs: ["5", "6", "7"],
        agents: ["Supervisor Agent", "Payroll Analyst Agent", "Time Analyst Agent"],
        human: false,
        systems: [
          { systemKey: "sf-ecp", actions: ["get"], scalesWithLandscape: true },
          { systemKey: "time-system", actions: ["get"], scalesWithLandscape: true },
          { systemKey: "sf-ec", actions: ["get"], scalesWithLandscape: true },
          { systemKey: "legacy-db", actions: ["get"], scalesWithLandscape: true },
        ],
        costs: [
          { type: "ai-consumption", label: "Multi-agent reasoning (3-5 LLM calls)", unitCostUsd: LLM * 4, calls: [{ role: "reasoning", count: 4 }], assumption: "Supervisor plus specialist agents make ~4 reasoning calls (llm-call-cost x 4).", source: pricingSrc },
          { type: "ai-consumption", label: "Structured data access (LDM/NL2SQL)", unitCostUsd: DATA * 2, calls: [{ role: "data", count: 2 }], assumption: "~2 schema-grounded structured-data calls (data-call-cost x 2) retrieve and reconcile records from legacy databases with poor lineage.", source: pricingSrc },
          { type: "infra", label: "Orchestration + memory infra", unitCostUsd: INFRA * 0.4, assumption: "40% of infra-per-txn: durable orchestration state and agent memory.", source: pricingSrc },
        ],
        benefits: [
          { type: "error-reduction", label: "Systematic reconciliation", dollarized: true, unitBenefitUsd: 0.9, qualitative: "Every dispute is reconciled against all source systems, catching under/overpayments a rushed human check misses.", assumption: "~1.5% of disputes uncover a correction averaging $60; expected value per transaction." },
        ],
      },
      {
        id: "fc3-s4",
        stage: "orchestration",
        label: "Human approver validates resolution",
        componentRefs: ["5"],
        agents: ["HITL Approver"],
        human: true,
        systems: [{ systemKey: "ticketing", actions: ["put"], scalesWithLandscape: false }],
        costs: [
          { type: "human", label: "Approver minutes (blended)", unitCostUsd: 0, assumption: "Residual human minutes are intent-specific (toBeHumanMin), dollarized at the HITL hourly rate.", source: assumptionSrc },
        ],
        benefits: [
          { type: "compliance", label: "Approval-gated writes", dollarized: false, unitBenefitUsd: 0, qualitative: "No financial correction reaches a system of record without named human approval.", assumption: "Deck guardrail: all put actions are approval-gated." },
        ],
      },
      {
        id: "fc3-s5",
        stage: "act",
        label: "Execute correction in systems of record",
        componentRefs: ["6", "7"],
        agents: ["Act Integration (MCP)"],
        human: false,
        systems: [
          { systemKey: "sf-ecp", actions: ["put"], scalesWithLandscape: true },
          { systemKey: "time-system", actions: ["put"], scalesWithLandscape: true },
        ],
        costs: [
          { type: "ai-consumption", label: "MCP put actions", unitCostUsd: MCP, assumption: "Per-intent put actions x mcp-action-cost with landscape fan-out.", source: pricingSrc },
          { type: "infra", label: "Write-path infra + validation", unitCostUsd: INFRA * 0.33, assumption: "33% of infra-per-txn: idempotency, validation and rollback safety on writes.", source: pricingSrc },
        ],
        benefits: [
          { type: "cycle-time", label: "Days to hours", dollarized: false, unitBenefitUsd: 0, qualitative: "Dispute resolution drops from a 5-10 day investigation to same-day.", assumption: "Deck flow slide SLA comparison." },
        ],
      },
      {
        id: "fc3-s6",
        stage: "close",
        label: "Notify employee & close with audit trail",
        componentRefs: ["6", "1"],
        agents: ["Case Management & SLA", "Communication Agent"],
        human: false,
        systems: [{ systemKey: "ticketing", actions: ["put"], scalesWithLandscape: false }],
        costs: [
          { type: "ai-consumption", label: "Explanation generation", unitCostUsd: SLM * 2, calls: [{ role: "router", count: 2 }], assumption: "Drafting the employee-facing explanation at ~2x slm-call-cost.", source: pricingSrc },
          { type: "infra", label: "Case close + audit", unitCostUsd: INFRA * 0.13, assumption: "13% of infra-per-txn: ticket closure, SLA stop, audit entry.", source: pricingSrc },
        ],
        benefits: [
          { type: "experience", label: "Transparent resolution letter", dollarized: false, unitBenefitUsd: 0, qualitative: "Employee receives a plain-language explanation of what was wrong and what was fixed.", assumption: "Communication agent output." },
        ],
      },
    ],
  },
  {
    key: "fc4-frontier",
    name: "Frontier Judgment Case",
    slideRef: "Flow: Cross-Border Relocation",
    description:
      "Low-volume, high-complexity cases requiring deep reasoning across tax, immigration, payroll and policy - with human gates at every consequential decision. Mirrors the deck's cross-border relocation flow.",
    buildCostUsd: 250000,
    buildAssumption:
      "Per intent family: frontier-model reasoning harness, country-pair knowledge packs, multi-gate approval workflow, specialist evaluation suite. ~180 person-days.",
    amortizationTransactions: 20000,
    steps: [
      {
        id: "fc4-s1",
        stage: "intake",
        label: "Structured case intake",
        componentRefs: ["1", "3"],
        agents: ["Experience Layer", "Multimodal Intake"],
        human: false,
        systems: [{ systemKey: "doc-store", actions: ["get", "put"], scalesWithLandscape: false }],
        costs: [
          { type: "ai-consumption", label: "Document + form extraction", unitCostUsd: SLM * 5, calls: [{ role: "router", count: 5 }], assumption: "Document + form extraction at ~5x slm-call-cost (contracts, visas, assignment letters).", source: pricingSrc },
          { type: "infra", label: "Intake pipeline infra", unitCostUsd: INFRA * 0.2, assumption: "20% of infra-per-txn: storage, queue, scanning share.", source: pricingSrc },
        ],
        benefits: [],
      },
      {
        id: "fc4-s2",
        stage: "orchestration",
        label: "Deep-reasoning case plan",
        componentRefs: ["4", "5"],
        agents: ["Supervisor Agent", "Frontier Reasoning Agent"],
        human: false,
        systems: [
          { systemKey: "knowledge-base", actions: ["get"], scalesWithLandscape: false },
          { systemKey: "legacy-db", actions: ["get"], scalesWithLandscape: true },
        ],
        costs: [
          { type: "ai-consumption", label: "Frontier reasoning calls", unitCostUsd: FRONTIER * 2.5, calls: [{ role: "frontier", count: 2.5 }], assumption: "2-3 frontier-model calls (frontier-call-cost x 2.5) plan the case across tax, immigration, payroll and benefits threads.", source: pricingSrc },
          { type: "ai-consumption", label: "Structured data access (LDM/NL2SQL)", unitCostUsd: DATA * 3, calls: [{ role: "data", count: 3 }], assumption: "~3 structured-data calls (data-call-cost x 3) assemble the case picture from legacy databases and vendor extracts lacking lineage.", source: pricingSrc },
          { type: "infra", label: "Long-context memory infra", unitCostUsd: INFRA * 0.53, assumption: "53% of infra-per-txn: case memory, thread state, long-context caching.", source: pricingSrc },
        ],
        benefits: [
          { type: "error-reduction", label: "Nothing falls through the cracks", dollarized: true, unitBenefitUsd: 12, qualitative: "Checklist-complete case plans avoid missed filings and compliance penalties.", assumption: "~2% of relocations historically incur a remediation averaging $600; expected value per case." },
        ],
      },
      {
        id: "fc4-s3",
        stage: "orchestration",
        label: "Specialist review gate (mobility lead)",
        componentRefs: ["5"],
        agents: ["HITL Mobility Lead"],
        human: true,
        systems: [{ systemKey: "ticketing", actions: ["put"], scalesWithLandscape: false }],
        costs: [
          { type: "human", label: "Specialist review minutes", unitCostUsd: 0, assumption: "Residual human minutes are intent-specific (toBeHumanMin), dollarized at the HITL hourly rate.", source: assumptionSrc },
        ],
        benefits: [
          { type: "compliance", label: "Human sign-off on consequential steps", dollarized: false, unitBenefitUsd: 0, qualitative: "Immigration and tax-affecting steps always carry specialist approval.", assumption: "Deck frontier flow: human gates at every consequential decision." },
        ],
      },
      {
        id: "fc4-s4",
        stage: "act",
        label: "Coordinated execution across systems & vendors",
        componentRefs: ["6", "7"],
        agents: ["Act Integration (MCP)", "Vendor Coordination Agent"],
        human: false,
        systems: [
          { systemKey: "sf-ec", actions: ["get", "put"], scalesWithLandscape: true },
          { systemKey: "vendor-payroll", actions: ["put"], scalesWithLandscape: true },
          { systemKey: "benefits-platform", actions: ["put"], scalesWithLandscape: true },
        ],
        costs: [
          { type: "ai-consumption", label: "MCP get/put actions", unitCostUsd: MCP, assumption: "Per-intent actions x mcp-action-cost with landscape fan-out across HCM, payroll vendors and benefits.", source: pricingSrc },
          { type: "infra", label: "Write-path + vendor integration infra", unitCostUsd: INFRA * 0.53, assumption: "53% of infra-per-txn: multi-vendor connector amortization, validation, retries.", source: pricingSrc },
        ],
        benefits: [
          { type: "cycle-time", label: "Weeks to days", dollarized: false, unitBenefitUsd: 0, qualitative: "Relocation setup drops from multi-week email coordination to days.", assumption: "Deck flow slide SLA comparison." },
        ],
      },
      {
        id: "fc4-s5",
        stage: "close",
        label: "Case summary, handover & audit close",
        componentRefs: ["6", "1"],
        agents: ["Case Management & SLA", "Communication Agent"],
        human: true,
        systems: [{ systemKey: "ticketing", actions: ["put"], scalesWithLandscape: false }],
        costs: [
          { type: "ai-consumption", label: "Case summary generation", unitCostUsd: LLM, calls: [{ role: "reasoning", count: 1 }], assumption: "One reasoning-model call (llm-call-cost) compiles the full case narrative.", source: pricingSrc },
          { type: "human", label: "Final human closure check", unitCostUsd: 0, assumption: "Included in intent-level residual minutes.", source: assumptionSrc },
        ],
        benefits: [
          { type: "compliance", label: "Complete defensible case file", dollarized: false, unitBenefitUsd: 0, qualitative: "Full reasoning trace and approvals preserved for audits and works councils.", assumption: "Observability/governance cross-cutting layer." },
        ],
      },
    ],
  },
];

export const flowClassMap: Record<string, FlowClass> = Object.fromEntries(
  flowClasses.map((fc) => [fc.key, fc]),
);
