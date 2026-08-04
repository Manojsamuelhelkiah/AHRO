// Shared corpus data types, mirroring the OpenAPI schemas.

export interface SourceRef {
  name: string;
  note?: string;
  confidence: string; // high | medium | low
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

export interface CostComponent {
  type: string; // ai-consumption | infra | human | build | other
  label: string;
  unitCostUsd: number;
  assumption: string;
  source: SourceRef;
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

export interface SystemInfo {
  key: string;
  name: string;
  category: string;
  description: string;
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
  value: number;
  unit: string;
  rationale: string;
  source: SourceRef;
}
