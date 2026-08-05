// Shared corpus data types, mirroring the OpenAPI schemas.

export interface SourceRef {
  name: string;
  note?: string;
  /** measured | high | medium | low. "measured" is the strongest tier. */
  confidence: string;
}

export interface Intent {
  id: number;
  key: string;
  name: string;
  domain: string;
  flowClass: string;
  description: string;
  source: SourceRef;
  asIsHandlingMin: number;
  toBeHumanMin: number;
  baseWeight: number;
  actGetActions: number;
  actPutActions: number;
  systemsTouchedBase: number;
  tags: string[];
}

export interface StepSystemTouch {
  systemKey: string;
  actions: string[];
  scalesWithLandscape: boolean;
}

export interface ModelCall {
  role: string; // router | reasoning | frontier
  count: number;
}

export interface CostComponent {
  type: string; // ai-consumption | infra | human | build | other
  label: string;
  unitCostUsd: number;
  assumption: string;
  source: SourceRef;
  /** Model calls behind this cost; lets scenario model selection reprice it exactly. */
  calls?: ModelCall[];
}

export interface BenefitComponent {
  type: string; // human-effort | cycle-time | error-reduction | experience | compliance
  label: string;
  dollarized: boolean;
  unitBenefitUsd: number;
  qualitative: string;
  assumption: string;
}

export interface FlowStep {
  id: string;
  stage: string; // intake | intent | orchestration | knowledge | communication | act | close
  label: string;
  componentRefs: string[];
  agents: string[];
  human: boolean;
  systems: StepSystemTouch[];
  costs: CostComponent[];
  benefits: BenefitComponent[];
}

export interface FlowClass {
  key: string;
  name: string;
  slideRef: string;
  description: string;
  buildCostUsd: number;
  buildAssumption: string;
  amortizationTransactions: number;
  steps: FlowStep[];
}

export interface McpIntegration {
  method: string; // rest-odata | rag-index | doc-pipeline | event-webhook | scim-oidc | sftp-file | semantic-layer
  label: string;
  note: string;
}

export interface SystemInfo {
  key: string;
  name: string;
  category: string;
  description: string;
  /** How this system is exposed to agents through the MCP server. */
  integration: McpIntegration;
}

export interface DistributionProfile {
  sector: string;
  description: string;
  source: SourceRef;
  domainWeights: Record<string, number>;
  sizeAdjustments: Record<string, number>;
}

export interface GlobalAssumption {
  key: string;
  label: string;
  /** The canonical estimated/modelled value from the assumptions register. */
  value: number;
  /**
   * The value observed in production actuals. Present only when this assumption
   * was replaced by a calibration overlay. The rollup applied measuredValue;
   * value is retained as the pre-calibration estimate for variance display.
   */
  measuredValue?: number;
  unit: string;
  rationale: string;
  source: SourceRef;
}

// ---------------------------------------------------------------------------
// Actuals overlay types
// ---------------------------------------------------------------------------

/** Measured average token counts per model call for one role, from production logs. */
export interface TokenRoleActuals {
  avgInputTokens: number;
  avgOutputTokens: number;
}

/** Per-intent measured values from production data. */
export interface IntentActuals {
  intentKey: string;
  /** Measured containment rate (0-1) for this specific intent. Overrides flow-class level. */
  measuredContainmentRate?: number;
  /** Measured average residual HITL minutes per contained transaction. */
  avgHitlMinutes?: number;
}

/**
 * Calibration actuals overlay. When applied to a rollup, measured values replace
 * corresponding assumption defaults. The confidence score is boosted above the
 * client-confirmed level to reflect that measurements are stronger than self-reporting.
 */
export interface ActualsOverlay {
  clientLabel?: string;
  periodStart?: string;
  periodEnd?: string;
  /** Per-intent measured values. */
  intents?: IntentActuals[];
  /**
   * Measured containment rate per flow class (fc1-deterministic | fc2-policy |
   * fc3-multiagent | fc4-frontier → 0-1). Applied to all intents in that class
   * unless a per-intent measuredContainmentRate is present.
   */
  measuredContainmentByFlowClass?: Record<string, number>;
  /** Measured fraction of residual HITL checkpoints actually reviewed (0-1). */
  measuredHitlSamplingRate?: number;
  /**
   * Measured average token counts per model role. When present for a role,
   * the rollup reprices model calls from catalog per-token rates × measured
   * tokens instead of the baked pricePerCallUsd.
   */
  tokenActualsByRole?: Record<string, TokenRoleActuals>;
}
