import { useMemo, useState } from "react";
import { BookOpenCheck, Download, ExternalLink, FileSpreadsheet, Search, ShieldAlert } from "lucide-react";
import { Link } from "wouter";
import { getGetOnboardingLearningCatalogQueryKey, useGetOnboardingLearningCatalog, type OnboardingLearningCatalog } from "@workspace/api-client-react";
import { Badge, Button, Card, Input, PageHeader } from "@/components/ui-shared";

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

function csvCell(value: string | number) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

/** A catalog mapping is traceability only; it deliberately does not claim execution. */
export function guideCoverageCsv(catalog: CanonicalLearningCatalog) {
  const header = ["catalog_version", "baseline_revision", "record_type", "id", "title", "roles_or_actor", "entry_points_or_sources", "feature_ids", "scenario_ids", "availability_or_verification", "latest_result"];
  const guideRows = catalog.guideSections.map((section) => [catalog.catalogVersion, catalog.baselineRevision, "guide-section", section.id, section.title, section.roles.join(" | "), section.entryPoints.join(" | "), section.featureIds.join(" | "), section.scenarioIds.join(" | "), "", ""]);
  const featureRows = catalog.features.map((feature) => [catalog.catalogVersion, catalog.baselineRevision, "feature", feature.id, feature.title, asStrings(feature.values.roles).join(" | "), asStrings(feature.values.entryPoints).join(" | "), "", asStrings(feature.values.scenarioIds).join(" | "), asString(feature.values.verification), "not-run"]);
  const requirementRows = catalog.requirements.map((requirement) => [catalog.catalogVersion, catalog.baselineRevision, "requirement", requirement.id, requirement.title, asString(requirement.values.actor), asStrings(requirement.values.sourceRefs).join(" | "), "", asStrings(requirement.values.scenarioIds).join(" | "), asString(requirement.values.availability), asString(requirement.values.latestResult) || "not-run"]);
  return [header.join(","), ...[...guideRows, ...featureRows, ...requirementRows].map((row) => row.map(csvCell).join(","))].join("\n");
}

export function portableGuideText(catalog: CanonicalLearningCatalog) {
  return [
    "ONBOARDING CONTROL TOWER — PORTABLE LEARNING GUIDE",
    `Canonical catalog version: ${catalog.catalogVersion}`,
    `Baseline: ${catalog.baselineRevision}`,
    "Purpose: product guidance and evidence expectations. This is not policy approval, legal advice, proof of execution, or provider certification.",
    "",
    ...catalog.guideSections.flatMap((section) => [
      section.title.toUpperCase(),
      `Roles: ${section.roles.join(" · ") || "Not specified"}`,
      `Entry points: ${section.entryPoints.join(" · ") || "Not specified"}`,
      `Feature coverage: ${section.featureIds.join(", ") || "None mapped"} | Scenarios: ${section.scenarioIds.join(", ") || "None mapped"}`,
      section.summary,
      "How to use it:",
      ...section.instructions.map((instruction, index) => `${index + 1}. ${instruction}`),
      `Evidence to inspect: ${section.evidence.join(" · ") || "Not specified"}`,
      `Exceptions and boundaries: ${section.exceptions.join(" · ") || "Not specified"}`,
      "",
    ]),
  ].join("\n");
}

function downloadFile(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function LearningGuidePage() {
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("All roles");
  const [topic, setTopic] = useState("All topics");
  const { data, isLoading, isError, isFetching, refetch } = useGetOnboardingLearningCatalog({
    query: { queryKey: getGetOnboardingLearningCatalogQueryKey(), staleTime: 5_000, refetchInterval: 30_000, refetchOnWindowFocus: true },
  });
  const catalog = useMemo(() => data ? normalizeLearningCatalog(data) : null, [data]);
  const coverage = useMemo(() => catalog ? learningCoverageTotals(catalog) : null, [catalog]);
  const roles = useMemo(() => [...new Set(catalog?.guideSections.flatMap((section) => section.roles) ?? [])].sort(), [catalog]);
  const topics = useMemo(() => catalog?.guideSections.map((section) => ({ id: section.id, title: section.title })) ?? [], [catalog]);
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (catalog?.guideSections ?? []).filter((section) => {
      const searchable = [section.id, section.title, section.roles.join(" "), section.entryPoints.join(" "), section.summary, section.instructions.join(" "), section.evidence.join(" "), section.exceptions.join(" "), section.featureIds.join(" "), section.scenarioIds.join(" ")].join(" ").toLowerCase();
      return (!query || searchable.includes(query)) && (role === "All roles" || section.roles.includes(role)) && (topic === "All topics" || section.id === topic);
    });
  }, [catalog, role, search, topic]);

  if (isLoading) return <div className="p-12 text-sm text-[var(--text-muted)]">Loading the canonical learning catalog…</div>;
  if (isError || !catalog || !catalog.guideSections.length) return <CatalogError onRetry={() => void refetch()} />;

  return <div className="mx-auto max-w-6xl space-y-6 pb-16">
    <PageHeader title="Learning Guide" subtitle="Canonical, searchable role and topic guidance—what to do, what evidence to inspect, and where the safety boundary remains." />
    <Card className="overflow-hidden p-0">
      <div className="grid gap-5 bg-[var(--surface-alt)] p-5 md:grid-cols-[1.45fr_1fr]">
        <div><p className="text-xs font-bold uppercase tracking-wide text-[var(--primary)]">Canonical product guide · {catalog.catalogVersion}</p><h2 className="mt-1 text-xl font-semibold">Find the operational path before acting</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">Every server-provided topic links roles, entry points, features, scenarios, evidence and exceptions. Search all of those fields—not just a page name.</p></div>
        <ol className="grid grid-cols-3 gap-2 text-center text-xs text-[var(--text-secondary)]" aria-label="Lifecycle overview">{["Intake & evidence", "Readiness & decision", "Outcome & audit"].map((label, index) => <li key={label} className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-3"><span className="mb-1 block font-bold text-[var(--primary)]">{index + 1}</span>{label}</li>)}</ol>
      </div>
      <div className="flex flex-col gap-3 border-t border-[var(--border)] p-4 sm:flex-row sm:items-center"><div className="text-xs text-[var(--text-muted)]"><p>Baseline: {catalog.baselineRevision}</p>{coverage && <p className="mt-1" data-testid="text-learning-catalog-coverage">Canonical mapping: {coverage.features.mapped ?? "Not supplied"} of {coverage.features.denominator ?? "not supplied"} features · {coverage.requirements.mapped ?? "Not supplied"} of {coverage.requirements.denominator ?? "not supplied"} BRD/product requirements mapped to scenarios. Mapping is not runtime execution.</p>}</div><Button type="button" variant="outline" size="sm" className="gap-1.5 sm:ml-auto" onClick={() => downloadFile("onboarding-control-tower-learning-guide.txt", portableGuideText(catalog), "text/plain;charset=utf-8")} data-testid="button-download-learning-guide"><Download className="h-4 w-4" />Download guide</Button><Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => downloadFile("onboarding-learning-guide-coverage.csv", guideCoverageCsv(catalog), "text/csv;charset=utf-8")} data-testid="button-download-learning-coverage"><FileSpreadsheet className="h-4 w-4" />Download coverage CSV</Button></div>
    </Card>
    <div className="rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-4 text-sm text-[var(--text-secondary)]" role="note"><ShieldAlert className="mr-2 inline h-4 w-4 text-[var(--status-amber)]" /><strong className="text-[var(--text-primary)]">Read the evidence boundary:</strong> catalog mapping, simulations, local file checks, configuration labels and provider status do not establish source authenticity, malware clearance, identity verification, vendor certification or live readiness.</div>
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_11rem_14rem]"><div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-[var(--text-muted)]" /><Input className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search a role, topic, feature ID, scenario or evidence…" data-testid="input-guide-search" /></div><select aria-label="Filter guide by role" value={role} onChange={(event) => setRole(event.target.value)} className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm" data-testid="select-guide-role"><option>All roles</option>{roles.map((item) => <option key={item}>{item}</option>)}</select><select aria-label="Filter guide by topic" value={topic} onChange={(event) => setTopic(event.target.value)} className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm" data-testid="select-guide-topic"><option value="All topics">All topics</option>{topics.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
    <div className="flex justify-between text-xs text-[var(--text-muted)]" aria-live="polite"><span>{visible.length} of {catalog.guideSections.length} topics shown</span><Button type="button" variant="ghost" size="sm" disabled={isFetching} onClick={() => void refetch()}>{isFetching ? "Refreshing…" : "Refresh catalog"}</Button></div>
    <div className="grid gap-4">{visible.map((section) => <Card key={section.id} className="p-5" data-testid={`card-guide-${section.id}`}><div className="flex flex-col justify-between gap-4 lg:flex-row"><div className="min-w-0"><div className="flex flex-wrap gap-2">{section.roles.map((item) => <Badge key={item} variant="outline">{item}</Badge>)}</div><h2 className="mt-3 text-lg font-semibold">{section.title}</h2><p className="mt-2 max-w-4xl text-sm leading-6 text-[var(--text-secondary)]">{section.summary}</p><div className="mt-4 grid gap-4 md:grid-cols-2"><div><h3 className="text-xs font-bold uppercase tracking-wide text-[var(--text-primary)]">How to use it</h3><ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-5 text-[var(--text-secondary)]">{section.instructions.map((item) => <li key={item}>{item}</li>)}</ol></div><div className="space-y-3 text-sm"><p><span className="font-semibold text-[var(--text-primary)]">Evidence:</span> <span className="text-[var(--text-secondary)]">{section.evidence.join(" · ")}</span></p><p><span className="font-semibold text-[var(--status-amber)]">Exceptions:</span> <span className="text-[var(--text-secondary)]">{section.exceptions.join(" · ")}</span></p></div></div><p className="mt-4 text-xs text-[var(--text-muted)]">Features: {section.featureIds.join(" · ") || "None mapped"} &nbsp;|&nbsp; Scenarios: {section.scenarioIds.join(" · ") || "None mapped"}</p></div>{section.entryPoints[0] && <Link href={section.entryPoints[0]} className="shrink-0 self-start"><Button type="button" variant="outline" size="sm" data-testid={`link-guide-${section.id}`}>Open area <ExternalLink className="ml-1 h-3.5 w-3.5" /></Button></Link>}</div></Card>)}</div>
    {!visible.length && <Card className="p-10 text-center"><BookOpenCheck className="mx-auto h-7 w-7 text-[var(--text-muted)]" /><p className="mt-3 text-sm font-medium">No guide topic matches these filters.</p><Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => { setSearch(""); setRole("All roles"); setTopic("All topics"); }}>Clear filters</Button></Card>}
  </div>;
}

function CatalogError({ onRetry }: { onRetry: () => void }) {
  return <div className="flex flex-col items-center gap-3 p-12 text-center"><ShieldAlert className="h-8 w-8 text-[var(--status-amber)]" /><p className="text-sm">The canonical learning catalog is unavailable or incomplete. No static guide is substituted.</p><Button type="button" variant="outline" onClick={onRetry} data-testid="button-retry-learning-catalog">Retry</Button></div>;
}