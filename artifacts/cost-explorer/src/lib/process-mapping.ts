import type { FlowStep } from "@workspace/api-client-react";

export type BpmnLane = "Employee" | "Digital Service" | "HR Operations" | "Specialist";
export type BpmnTaskType = "user" | "service" | "business-rule" | "send" | "receive";

export interface BpmnNode {
  id: string;
  lane: BpmnLane;
  taskType: BpmnTaskType;
  label: string;
  stage: string;
  isFallback: boolean;
  evidence: FlowStep;
}

export interface SipocRow {
  stageId: string;
  supplier: string;
  input: string;
  process: string;
  output: string;
  customer: string;
  evidence: FlowStep;
}

export interface ProcessMappingValidation {
  valid: boolean;
  issues: string[];
  triggerCount: number;
  outcomeCount: number;
  connected: boolean;
  namedOwnership: boolean;
  completeSipoc: boolean;
}

export interface ProcessMapping {
  trigger: string;
  outcomes: string[];
  bpmnNodes: BpmnNode[];
  sipocRows: SipocRow[];
  validation: ProcessMappingValidation;
  usedFallbacks: boolean;
}

export interface ProcessScenarioAnnotations {
  adoptionFraction?: number;
  containmentFraction?: number;
  hitlSamplingFraction?: number;
  annualTransactions?: number;
}

export interface ProcessBranchMetrics {
  adoptionFraction: number;
  containmentFraction: number;
  hitlSamplingFraction: number;
  adoptedTransactions: number | null;
  manualTransactions: number | null;
  containedTransactions: number | null;
  fallbackTransactions: number | null;
  humanReviewTransactions: number | null;
  automatedTransactions: number | null;
}

const stageMeaning: Record<string, {
  owner: BpmnLane;
  supplier: string;
  input: string;
  output: string;
  customer: string;
}> = {
  intake: { owner: "Digital Service", supplier: "Employee or manager", input: "Request and identity context", output: "Validated request", customer: "HR service" },
  intent: { owner: "Digital Service", supplier: "Request channel", input: "Validated request", output: "Routed service need", customer: "Process owner" },
  orchestration: { owner: "Digital Service", supplier: "Process owner and source systems", input: "Case context and operating rules", output: "Decision or action plan", customer: "HR operations or specialist" },
  knowledge: { owner: "Digital Service", supplier: "Policy and content owners", input: "Approved policy and employee context", output: "Grounded answer", customer: "Employee and HR operations" },
  communication: { owner: "Digital Service", supplier: "Process owner", input: "Approved response", output: "Stakeholder communication", customer: "Employee or manager" },
  act: { owner: "Digital Service", supplier: "HR operations and systems of record", input: "Authorized action", output: "Verified record or transaction", customer: "Employee and process owner" },
  close: { owner: "HR Operations", supplier: "Completed process", input: "Outcome and evidence", output: "Closed case and audit record", customer: "Employee, HR and assurance" },
};

function meaningFor(step: FlowStep) {
  return stageMeaning[step.stage] ?? {
    owner: step.human ? "HR Operations" as const : "Digital Service" as const,
    supplier: "Upstream process owner",
    input: "Process context",
    output: "Completed process stage",
    customer: "Downstream process owner",
  };
}

function laneFor(step: FlowStep): BpmnLane {
  if (step.human && step.agents.some((agent) => /specialist|mobility|approver|reviewer|analyst/i.test(agent))) {
    return "Specialist";
  }
  if (step.human) return "HR Operations";
  return meaningFor(step).owner;
}

function taskTypeFor(step: FlowStep): BpmnTaskType {
  if (step.human) return "user";
  if (step.stage === "intake") return "receive";
  if (step.stage === "communication" || (step.stage === "close" && /notify|deliver/i.test(step.label))) return "send";
  if (step.stage === "intent" || step.stage === "orchestration") return "business-rule";
  return "service";
}

function businessLabel(step: FlowStep): { label: string; fallback: boolean } {
  const label = step.label
    .replace(/\b(agent|MCP|LLM|SLM|NL2SQL|LDM)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,&])/g, "$1")
    .trim();
  if (label.length >= 4) return { label, fallback: false };
  return { label: `${step.stage || "Process"} activity`, fallback: true };
}

export function deriveProcessMapping(steps: FlowStep[]): ProcessMapping {
  const bpmnNodes = steps.map((step) => {
    const business = businessLabel(step);
    return {
      id: step.id,
      lane: laneFor(step),
      taskType: taskTypeFor(step),
      label: business.label,
      stage: step.stage,
      isFallback: business.fallback || !stageMeaning[step.stage],
      evidence: step,
    };
  });

  const sipocRows = bpmnNodes.map((node, index) => {
    const step = node.evidence;
    const meaning = meaningFor(step);
    return {
      stageId: step.id,
      supplier: index === 0 ? meaning.supplier : bpmnNodes[index - 1]!.lane,
      input: meaning.input,
      process: node.label,
      output: meaning.output,
      customer: index === bpmnNodes.length - 1 ? meaning.customer : bpmnNodes[index + 1]!.lane,
      evidence: step,
    };
  });

  const trigger = steps.length > 0 ? "Employee or manager raises an HR service need" : "";
  const outcomes = steps.length > 0
    ? ["Request resolved and recorded", "Exception routed to accountable human owner"]
    : [];
  const completeSipoc = sipocRows.length > 0 && sipocRows.every((row) =>
    [row.supplier, row.input, row.process, row.output, row.customer].every(Boolean));
  const namedOwnership = bpmnNodes.length > 0 && bpmnNodes.every((node) => Boolean(node.lane));
  const connected = bpmnNodes.length > 0 && new Set(bpmnNodes.map((node) => node.id)).size === bpmnNodes.length;
  const issues: string[] = [];
  if (!trigger) issues.push("A clear process trigger could not be derived.");
  if (outcomes.length === 0) issues.push("At least one process outcome is required.");
  if (!connected) issues.push("Process stages must form one connected, uniquely identified path.");
  if (!namedOwnership) issues.push("Every process stage needs a named accountable lane.");
  if (!completeSipoc) issues.push("Every SIPOC category must contain a value.");

  return {
    trigger,
    outcomes,
    bpmnNodes,
    sipocRows,
    validation: {
      valid: issues.length === 0,
      issues,
      triggerCount: trigger ? 1 : 0,
      outcomeCount: outcomes.length,
      connected,
      namedOwnership,
      completeSipoc,
    },
    usedFallbacks: bpmnNodes.some((node) => node.isFallback),
  };
}

/** Shared by Technical and BPMN presentations so scenario branch figures cannot drift. */
export function deriveProcessBranchMetrics(
  annotations: ProcessScenarioAnnotations = {},
): ProcessBranchMetrics {
  const adoptionFraction = annotations.adoptionFraction ?? 0.4;
  const containmentFraction = annotations.containmentFraction ?? 0.85;
  const hitlSamplingFraction = annotations.hitlSamplingFraction ?? 0.1;
  const total = annotations.annualTransactions;
  const adoptedTransactions = total === undefined ? null : Math.round(total * adoptionFraction);
  const manualTransactions = total === undefined ? null : Math.round(total * (1 - adoptionFraction));
  const containedTransactions = adoptedTransactions === null
    ? null
    : Math.round(adoptedTransactions * containmentFraction);
  const fallbackTransactions = adoptedTransactions === null
    ? null
    : Math.round(adoptedTransactions * (1 - containmentFraction));
  const humanReviewTransactions = containedTransactions === null
    ? null
    : Math.round(containedTransactions * hitlSamplingFraction);
  const automatedTransactions = containedTransactions === null || humanReviewTransactions === null
    ? containedTransactions
    : containedTransactions - humanReviewTransactions;

  return {
    adoptionFraction,
    containmentFraction,
    hitlSamplingFraction,
    adoptedTransactions,
    manualTransactions,
    containedTransactions,
    fallbackTransactions,
    humanReviewTransactions,
    automatedTransactions,
  };
}