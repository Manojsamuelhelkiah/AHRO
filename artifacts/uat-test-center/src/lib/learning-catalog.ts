import type { OnboardingLearningCatalog } from "@workspace/api-client-react";

type CatalogRecord = Record<string, unknown>;
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
export type CatalogItem = { id: string; title: string; values: CatalogRecord };
export type CanonicalLearningCatalog = {
  catalogVersion: string;
  baselineRevision: string;
  guideSections: GuideSection[];
  features: CatalogItem[];
  requirements: CatalogItem[];
  denominators: CatalogRecord;
};
export type LearningCoverageTotals = {
  features: { denominator: number | null; mapped: number | null };
  requirements: { denominator: number | null; mapped: number | null };
};

const asRecord = (value: unknown): CatalogRecord | null => value && typeof value === "object" && !Array.isArray(value) ? value as CatalogRecord : null;
const asString = (value: unknown) => typeof value === "string" ? value : "";
const asStrings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const asNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

function sectionFrom(value: unknown): GuideSection | null {
  const item = asRecord(value);
  if (!item) return null;
  const id = asString(item.id);
  const title = asString(item.title);
  if (!id || !title) return null;
  return {
    id, title, roles: asStrings(item.roles), entryPoints: asStrings(item.entryPoints), summary: asString(item.summary),
    instructions: asStrings(item.instructions), evidence: asStrings(item.evidence), exceptions: asStrings(item.exceptions),
    featureIds: asStrings(item.featureIds), scenarioIds: asStrings(item.scenarioIds),
  };
}

function itemFrom(value: unknown): CatalogItem | null {
  const values = asRecord(value);
  if (!values) return null;
  const id = asString(values.id);
  const title = asString(values.title) || asString(values.name);
  return id && title ? { id, title, values } : null;
}

/** Converts the generated API's intentionally extensible catalog objects into display-safe fields. */
export function normalizeLearningCatalog(raw: OnboardingLearningCatalog): CanonicalLearningCatalog {
  return {
    catalogVersion: raw.catalogVersion,
    baselineRevision: raw.baselineRevision,
    guideSections: raw.guideSections.map(sectionFrom).filter((section): section is GuideSection => section !== null),
    features: raw.features.map(itemFrom).filter((item): item is CatalogItem => item !== null),
    requirements: raw.requirements.map(itemFrom).filter((item): item is CatalogItem => item !== null),
    denominators: asRecord(raw.denominators) ?? {},
  };
}

/** Canonical mapping totals are catalog traceability, never runtime execution. */
export function learningCoverageTotals(catalog: CanonicalLearningCatalog): LearningCoverageTotals {
  const features = asRecord(catalog.denominators.features) ?? {};
  const requirements = asRecord(catalog.denominators.requirements) ?? {};
  return {
    features: { denominator: asNumber(features.denominator), mapped: asNumber(features.withScenario) },
    requirements: { denominator: asNumber(requirements.denominator), mapped: asNumber(requirements.withScenario) },
  };
}
