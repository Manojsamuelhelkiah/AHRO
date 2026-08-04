import type { DistributionProfile } from "./types";

// Sector distribution profiles: multipliers applied to intent base weights per
// lifecycle domain, derived from published HR service-delivery benchmarks and
// documented assumptions. sizeAdjustments shift the complexity mix: larger
// organizations see relatively more multi-agent / frontier cases (applied to
// fc3/fc4 intent weights by the roll-up engine).
export const profiles: DistributionProfile[] = [
  {
    sector: "manufacturing",
    description: "Shift-based blue/white-collar mix; heavy time & attendance, payroll corrections and works-council policy traffic.",
    source: { name: "SSON HR shared-services benchmarks + curated assumption", confidence: "medium" },
    domainWeights: { hire: 0.9, pay: 1.3, leave: 1.2, benefits: 0.9, time: 1.5, mobility: 0.7, develop: 0.8, retire: 1.0, "data-admin": 1.0, policy: 1.1 },
    sizeAdjustments: { small: 0.85, mid: 1.0, large: 1.1, enterprise: 1.2 },
  },
  {
    sector: "financial-services",
    description: "Regulated knowledge workforce; high policy/compliance traffic, above-average mobility and benefits complexity.",
    source: { name: "SSON benchmarks + curated assumption", confidence: "medium" },
    domainWeights: { hire: 1.0, pay: 0.9, leave: 0.9, benefits: 1.2, time: 0.6, mobility: 1.3, develop: 1.2, retire: 1.0, "data-admin": 1.0, policy: 1.4 },
    sizeAdjustments: { small: 0.9, mid: 1.0, large: 1.15, enterprise: 1.3 },
  },
  {
    sector: "retail",
    description: "High-turnover hourly workforce; hiring, time and leave dominate, low mobility.",
    source: { name: "SSON benchmarks + curated assumption", confidence: "medium" },
    domainWeights: { hire: 1.6, pay: 1.1, leave: 1.3, benefits: 0.8, time: 1.6, mobility: 0.4, develop: 0.7, retire: 0.8, "data-admin": 1.1, policy: 0.9 },
    sizeAdjustments: { small: 0.9, mid: 1.0, large: 1.05, enterprise: 1.1 },
  },
  {
    sector: "technology",
    description: "Salaried knowledge workforce; equity/benefits questions, development and global mobility over time-clock traffic.",
    source: { name: "Curated assumption from tech-sector HR ops patterns", confidence: "low" },
    domainWeights: { hire: 1.1, pay: 0.8, leave: 0.9, benefits: 1.3, time: 0.4, mobility: 1.4, develop: 1.4, retire: 0.7, "data-admin": 1.0, policy: 1.0 },
    sizeAdjustments: { small: 0.9, mid: 1.0, large: 1.1, enterprise: 1.2 },
  },
  {
    sector: "healthcare",
    description: "Credentialed shift workforce; scheduling, leave, compliance training and certification tracking dominate.",
    source: { name: "SSON benchmarks + curated assumption", confidence: "medium" },
    domainWeights: { hire: 1.2, pay: 1.1, leave: 1.4, benefits: 1.1, time: 1.5, mobility: 0.5, develop: 1.2, retire: 1.0, "data-admin": 1.1, policy: 1.2 },
    sizeAdjustments: { small: 0.9, mid: 1.0, large: 1.1, enterprise: 1.15 },
  },
  {
    sector: "public-sector",
    description: "Tenured workforce with codified rules; pension/retirement, leave entitlements and policy interpretation are heavy.",
    source: { name: "Curated assumption from public-sector HR ops", confidence: "low" },
    domainWeights: { hire: 0.8, pay: 1.0, leave: 1.3, benefits: 1.2, time: 1.0, mobility: 0.6, develop: 0.9, retire: 1.5, "data-admin": 1.1, policy: 1.4 },
    sizeAdjustments: { small: 0.9, mid: 1.0, large: 1.05, enterprise: 1.1 },
  },
  {
    sector: "energy",
    description: "Mixed field/office workforce with rotations and expat assignments; time, mobility and safety-policy traffic.",
    source: { name: "Curated assumption", confidence: "low" },
    domainWeights: { hire: 0.9, pay: 1.1, leave: 1.0, benefits: 1.0, time: 1.3, mobility: 1.3, develop: 0.9, retire: 1.1, "data-admin": 1.0, policy: 1.1 },
    sizeAdjustments: { small: 0.9, mid: 1.0, large: 1.1, enterprise: 1.2 },
  },
  {
    sector: "professional-services",
    description: "Project-staffed consultants; onboarding/offboarding churn, mobility and development requests dominate.",
    source: { name: "Curated assumption", confidence: "low" },
    domainWeights: { hire: 1.3, pay: 0.9, leave: 0.9, benefits: 1.0, time: 0.8, mobility: 1.5, develop: 1.3, retire: 0.7, "data-admin": 1.0, policy: 0.9 },
    sizeAdjustments: { small: 0.95, mid: 1.0, large: 1.1, enterprise: 1.2 },
  },
];

export const profileMap: Record<string, DistributionProfile> = Object.fromEntries(
  profiles.map((p) => [p.sector, p]),
);
