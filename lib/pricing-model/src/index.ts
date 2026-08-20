export type TenantTier = "pooled" | "siloed" | "dedicated";
export type SecurityTier = "standard" | "regulated" | "enterprise";
export type TokenProfile = "light" | "balanced" | "rich";
export type InfrastructureTier = "starter" | "production" | "critical";
export type SupportTier = "essential" | "premium" | "managed";

export interface PricingInputs {
  clientsInCohort: number;
  annualTransactions: number;
  channels: number;
  integrations: number;
  agents: number;
  workflows: number;
  tenantTier: TenantTier;
  securityTier: SecurityTier;
  tokenProfile: TokenProfile;
  infrastructureTier: InfrastructureTier;
  supportTier: SupportTier;
  grossMarginPct: number;
  buildAmortizationYears: number;
}

export const DEFAULT_PRICING_INPUTS: PricingInputs = {
  clientsInCohort: 12,
  annualTransactions: 120_000,
  channels: 3,
  integrations: 4,
  agents: 2,
  workflows: 6,
  tenantTier: "siloed",
  securityTier: "regulated",
  tokenProfile: "balanced",
  infrastructureTier: "production",
  supportTier: "premium",
  grossMarginPct: 65,
  buildAmortizationYears: 3,
};

export const TOKEN_PROFILES: Record<
  TokenProfile,
  { label: string; aiCostPerTransaction: number; detail: string }
> = {
  light: {
    label: "Light",
    aiCostPerTransaction: 0.014,
    detail: "Intent routing, short responses, limited tool use",
  },
  balanced: {
    label: "Balanced",
    aiCostPerTransaction: 0.038,
    detail: "Multi-step orchestration and retrieval",
  },
  rich: {
    label: "Rich",
    aiCostPerTransaction: 0.092,
    detail: "Long context, multilingual and document-heavy work",
  },
};

const TENANT_FACTORS: Record<
  TenantTier,
  { label: string; implementation: number; infrastructure: number }
> = {
  pooled: {
    label: "Pooled shared services",
    implementation: 0.9,
    infrastructure: 0.8,
  },
  siloed: {
    label: "Siloed tenant data",
    implementation: 1,
    infrastructure: 1,
  },
  dedicated: {
    label: "Dedicated client environment",
    implementation: 1.45,
    infrastructure: 1.8,
  },
};

const SECURITY_FACTORS: Record<
  SecurityTier,
  {
    label: string;
    build: number;
    implementation: number;
    infrastructure: number;
  }
> = {
  standard: {
    label: "Standard controls",
    build: 1,
    implementation: 1,
    infrastructure: 1,
  },
  regulated: {
    label: "Regulated / audit-ready",
    build: 1.15,
    implementation: 1.18,
    infrastructure: 1.2,
  },
  enterprise: {
    label: "Enterprise / zero-trust",
    build: 1.35,
    implementation: 1.38,
    infrastructure: 1.45,
  },
};

const INFRASTRUCTURE_TIERS: Record<
  InfrastructureTier,
  { label: string; annualBase: number }
> = {
  starter: { label: "Starter Azure footprint", annualBase: 18_000 },
  production: { label: "Production Azure footprint", annualBase: 42_000 },
  critical: { label: "Business-critical Azure footprint", annualBase: 84_000 },
};

const SUPPORT_TIERS: Record<
  SupportTier,
  { label: string; annualBase: number; detail: string }
> = {
  essential: {
    label: "Essential",
    annualBase: 15_000,
    detail: "Business-hours operations and release support",
  },
  premium: {
    label: "Premium",
    annualBase: 32_000,
    detail: "Named service lead, monthly optimization and extended cover",
  },
  managed: {
    label: "Managed",
    annualBase: 65_000,
    detail: "Proactive operations, SLA reporting and change support",
  },
};

export interface PricingCostLine {
  name: string;
  amount: number;
  basis: string;
}

export interface PricingModel {
  platformBuild: number;
  clientImplementation: number;
  annualHostingAndAi: number;
  annualSupport: number;
  annualSharedBuildAllocation: number;
  annualRunRate: number;
  unitTransactionCost: number;
  recommendedMonthlySubscription: number;
  recommendedAnnualCommitment: number;
  recommendedTransactionPrice: number;
  recommendedOveragePrice: number;
  recommendedImplementationFee: number;
  includedAnnualTransactions: number;
  averageMonthlyTransactions: number;
  productBuildLines: PricingCostLine[];
  implementationLines: PricingCostLine[];
  recurringLines: PricingCostLine[];
  supportLines: PricingCostLine[];
}

export type PricingRecommendation = Pick<
  PricingModel,
  | "recommendedMonthlySubscription"
  | "recommendedAnnualCommitment"
  | "recommendedTransactionPrice"
  | "recommendedOveragePrice"
  | "recommendedImplementationFee"
  | "includedAnnualTransactions"
>;

const atLeast = (value: number, minimum: number) =>
  Math.max(minimum, Number.isFinite(value) ? value : minimum);

const wholeAtLeast = (value: number, minimum: number) =>
  Math.round(atLeast(value, minimum));

export function normalizePricingInputs(rawInputs: PricingInputs): PricingInputs {
  return {
    ...rawInputs,
    clientsInCohort: wholeAtLeast(rawInputs.clientsInCohort, 1),
    annualTransactions: wholeAtLeast(rawInputs.annualTransactions, 1),
    channels: wholeAtLeast(rawInputs.channels, 0),
    integrations: wholeAtLeast(rawInputs.integrations, 0),
    agents: wholeAtLeast(rawInputs.agents, 1),
    workflows: wholeAtLeast(rawInputs.workflows, 0),
    grossMarginPct: Math.min(90, atLeast(rawInputs.grossMarginPct, 1)),
    buildAmortizationYears: wholeAtLeast(rawInputs.buildAmortizationYears, 1),
  };
}

export function calculatePricingModel(rawInputs: PricingInputs): PricingModel {
  const inputs = normalizePricingInputs(rawInputs);

  const tenant = TENANT_FACTORS[inputs.tenantTier];
  const security = SECURITY_FACTORS[inputs.securityTier];
  const infrastructure = INFRASTRUCTURE_TIERS[inputs.infrastructureTier];
  const token = TOKEN_PROFILES[inputs.tokenProfile];
  const support = SUPPORT_TIERS[inputs.supportTier];

  const productBuildLines = [
    {
      name: "Shared orchestration foundation",
      amount: 180_000,
      basis: "Azure landing zone, core services and reusable platform controls",
    },
    {
      name: "Channel capability",
      amount: inputs.channels * 9_000,
      basis: `${inputs.channels} channel(s) × $9,000 reusable capability`,
    },
    {
      name: "Agent capability",
      amount: inputs.agents * 18_000,
      basis: `${inputs.agents} agent(s) × $18,000 design and evaluation`,
    },
    {
      name: "Workflow library",
      amount: inputs.workflows * 7_500,
      basis: `${inputs.workflows} workflow(s) × $7,500 reusable automation`,
    },
  ];
  const productBuildBase = productBuildLines.reduce(
    (sum, line) => sum + line.amount,
    0,
  );
  const platformBuild = productBuildBase * security.build;
  productBuildLines.push({
    name: `${security.label} uplift`,
    amount: platformBuild - productBuildBase,
    basis: `${Math.round((security.build - 1) * 100)}% reusable security and compliance uplift`,
  });

  const implementationBaseLines = [
    {
      name: "Client discovery and onboarding",
      amount: 12_000,
      basis: "Tenant setup, acceptance plan and launch readiness",
    },
    {
      name: "Third-party integrations",
      amount: inputs.integrations * 6_500,
      basis: `${inputs.integrations} integration(s) × $6,500 configuration and testing`,
    },
    {
      name: "Channel rollout",
      amount: inputs.channels * 2_500,
      basis: `${inputs.channels} channel(s) × $2,500 tenant configuration`,
    },
    {
      name: "Client workflow configuration",
      amount: inputs.workflows * 3_500,
      basis: `${inputs.workflows} workflow(s) × $3,500 client-specific setup`,
    },
  ];
  const implementationBase = implementationBaseLines.reduce(
    (sum, line) => sum + line.amount,
    0,
  );
  const clientImplementation =
    implementationBase * tenant.implementation * security.implementation;
  implementationBaseLines.push({
    name: "Tenant and security complexity uplift",
    amount: clientImplementation - implementationBase,
    basis: `${tenant.label}; ${security.label}`,
  });

  const annualAi = inputs.annualTransactions * token.aiCostPerTransaction;
  const annualInfrastructure =
    infrastructure.annualBase *
    tenant.infrastructure *
    security.infrastructure;
  const annualChannelServices = inputs.channels * 3_600;
  const annualIntegrationServices = inputs.integrations * 2_400;
  const annualHostingAndAi =
    annualAi +
    annualInfrastructure +
    annualChannelServices +
    annualIntegrationServices;
  const recurringLines = [
    {
      name: "Azure hosting and observability",
      amount: annualInfrastructure,
      basis: `${infrastructure.label}; ${tenant.label}; ${security.label}`,
    },
    {
      name: "AI inference and orchestration",
      amount: annualAi,
      basis: `${inputs.annualTransactions.toLocaleString()} transactions × $${token.aiCostPerTransaction.toFixed(3)} ${token.label.toLowerCase()} profile`,
    },
    {
      name: "Channel services",
      amount: annualChannelServices,
      basis: `${inputs.channels} channel(s) × $3,600 / year`,
    },
    {
      name: "Integration operations",
      amount: annualIntegrationServices,
      basis: `${inputs.integrations} integration(s) × $2,400 / year`,
    },
  ];

  const annualSupport =
    support.annualBase + inputs.agents * 2_400 + inputs.workflows * 900;
  const supportLines = [
    {
      name: `${support.label} support`,
      amount: support.annualBase,
      basis: support.detail,
    },
    {
      name: "Agent quality operations",
      amount: inputs.agents * 2_400,
      basis: `${inputs.agents} agent(s) × $2,400 annual evaluation and tuning`,
    },
    {
      name: "Workflow maintenance",
      amount: inputs.workflows * 900,
      basis: `${inputs.workflows} workflow(s) × $900 annual release maintenance`,
    },
  ];

  const annualSharedBuildAllocation =
    platformBuild / inputs.clientsInCohort / inputs.buildAmortizationYears;
  const annualRunRate =
    annualHostingAndAi + annualSupport + annualSharedBuildAllocation;
  const unitTransactionCost =
    annualRunRate / inputs.annualTransactions;
  const marginMultiplier = 1 / (1 - inputs.grossMarginPct / 100);
  const recommendedMonthlySubscription =
    (annualRunRate * marginMultiplier) / 12;
  const recommendedAnnualCommitment =
    recommendedMonthlySubscription * 12;
  const recommendedTransactionPrice =
    unitTransactionCost * marginMultiplier;
  const recommendedOveragePrice =
    token.aiCostPerTransaction * marginMultiplier * 1.25;

  return {
    platformBuild,
    clientImplementation,
    annualHostingAndAi,
    annualSupport,
    annualSharedBuildAllocation,
    annualRunRate,
    unitTransactionCost,
    recommendedMonthlySubscription,
    recommendedAnnualCommitment,
    recommendedTransactionPrice,
    recommendedOveragePrice,
    recommendedImplementationFee: clientImplementation * marginMultiplier,
    includedAnnualTransactions: inputs.annualTransactions,
    averageMonthlyTransactions: inputs.annualTransactions / 12,
    productBuildLines,
    implementationLines: implementationBaseLines,
    recurringLines,
    supportLines,
  };
}

export function extractPricingRecommendation(
  model: PricingModel,
): PricingRecommendation {
  return {
    recommendedMonthlySubscription: model.recommendedMonthlySubscription,
    recommendedAnnualCommitment: model.recommendedAnnualCommitment,
    recommendedTransactionPrice: model.recommendedTransactionPrice,
    recommendedOveragePrice: model.recommendedOveragePrice,
    recommendedImplementationFee: model.recommendedImplementationFee,
    includedAnnualTransactions: model.includedAnnualTransactions,
  };
}

export const pricingAssumptionLabels = {
  tenantTier: TENANT_FACTORS,
  securityTier: SECURITY_FACTORS,
  infrastructureTier: INFRASTRUCTURE_TIERS,
  supportTier: SUPPORT_TIERS,
};