// Decomposition of each flow class's one-time platform build cost into the
// architecture components that must be engineered for it. Per flow class the
// component amounts sum EXACTLY to that flow class's buildCostUsd, so the
// component view reconciles to the same build totals as the roll-up.

export interface BuildComponent {
  key: string;
  name: string;
  description: string;
  /** One-time build cost contribution per flow class (USD, before maturity scaling). */
  perFlowClassUsd: Record<string, number>;
}

export const buildComponents: BuildComponent[] = [
  {
    key: "experience-gateway",
    name: "Experience Layer & AI Gateway",
    description:
      "Channel intake (chat, portal, email), session handling, authentication hand-off and the AI gateway with rate limiting and prompt logging.",
    perFlowClassUsd: {
      "fc1-deterministic": 5000,
      "fc2-policy": 5000,
      "fc3-multiagent": 8000,
      "fc4-frontier": 10000,
    },
  },
  {
    key: "intent-router",
    name: "Intent Classifier & Router",
    description:
      "Small-model intent classification, confidence thresholds, routing rules per flow class and fallback-to-human paths.",
    perFlowClassUsd: {
      "fc1-deterministic": 4000,
      "fc2-policy": 5000,
      "fc3-multiagent": 7000,
      "fc4-frontier": 10000,
    },
  },
  {
    key: "mcp-integration",
    name: "MCP Integration Layer",
    description:
      "MCP server, typed tool contracts per system (REST/OData, SCIM, webhooks, SFTP bridges), credential vaulting and per-client connector configuration.",
    perFlowClassUsd: {
      "fc1-deterministic": 7000,
      "fc2-policy": 5000,
      "fc3-multiagent": 45000,
      "fc4-frontier": 55000,
    },
  },
  {
    key: "knowledge-rag",
    name: "Policy Knowledge & RAG Pipeline",
    description:
      "Document ingestion, chunking, vector + keyword indexing with country/entity metadata, citation enforcement and freshness monitoring.",
    perFlowClassUsd: {
      "fc1-deterministic": 0,
      "fc2-policy": 22000,
      "fc3-multiagent": 15000,
      "fc4-frontier": 35000,
    },
  },
  {
    key: "orchestration",
    name: "Agent Orchestration & State",
    description:
      "Multi-agent planner, task decomposition, saga/compensation logic for multi-system writes, and durable state management.",
    perFlowClassUsd: {
      "fc1-deterministic": 0,
      "fc2-policy": 0,
      "fc3-multiagent": 30000,
      "fc4-frontier": 70000,
    },
  },
  {
    key: "hitl-console",
    name: "HITL Review Console",
    description:
      "Human-in-the-loop review queues, sampling controls, approval workflows and reviewer feedback loops back into containment tuning.",
    perFlowClassUsd: {
      "fc1-deterministic": 0,
      "fc2-policy": 4000,
      "fc3-multiagent": 8000,
      "fc4-frontier": 45000,
    },
  },
  {
    key: "guardrails-audit",
    name: "Guardrails, Evals & Audit Trail",
    description:
      "Policy guardrails, PII redaction, evaluation harnesses per flow class, full decision logging and compliance reporting.",
    perFlowClassUsd: {
      "fc1-deterministic": 2000,
      "fc2-policy": 4000,
      "fc3-multiagent": 7000,
      "fc4-frontier": 25000,
    },
  },
];

/** Sanity check helper: component contributions must sum to fc.buildCostUsd. */
export function componentSumFor(flowClassKey: string): number {
  return buildComponents.reduce(
    (a, c) => a + (c.perFlowClassUsd[flowClassKey] ?? 0),
    0,
  );
}
