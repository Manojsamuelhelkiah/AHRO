import { useMemo, useRef, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  downloadOnboardingUatEvidenceReport,
  downloadOnboardingUatFixturePack,
  getGetOnboardingUatRunQueryOptions,
  getGetOnboardingUatCatalogQueryKey,
  getGetOnboardingLearningCatalogQueryKey,
  getGetOnboardingUatRunQueryKey,
  useApplyOnboardingUatRunAction,
  useCreateOnboardingUatRun,
  useGetOnboardingUatCatalog,
  useGetOnboardingLearningCatalog,
  useGetOnboardingUatRun,
  type OnboardingUatEvidence,
  type OnboardingUatRun,
  type OnboardingUatRunAction,
  type OnboardingUatScenario,
} from "@workspace/api-client-react";
import { AlertTriangle, ChevronLeft, Clock3, Download, ExternalLink, FileSpreadsheet, FileText, FlaskConical, History, Link2, Pause, Play, RefreshCw, RotateCcw, Send, ShieldCheck, TimerReset } from "lucide-react";
import { Link, useLocation, useSearch } from "wouter";
import { Badge, Button, Card, Input, Label, PageHeader } from "@/components/ui-shared";
import { normalizeLearningCatalog, type CanonicalLearningCatalog } from "./learning-guide";

type CandidatePortalDescriptor = {
  state?: string;
  status?: string;
  message?: string;
  reason?: string;
  caseId?: number;
  expiresAt?: string;
  launchUrl?: string;
  canIssue?: boolean;
};
type PendingEvent = { id?: string; at?: string; dueAt?: string; kind?: string; state?: string; description?: string; note?: string };
type UatRunWithRuntimeDetails = OnboardingUatRun & { candidatePortal?: CandidatePortalDescriptor; pendingEvents?: PendingEvent[] };
type UatActionInput = Omit<OnboardingUatRunAction, "expectedVersion" | "requestId"> | { kind: "issue-candidate-portal"; note?: string | null };

const resultTone: Record<string, string> = {
  passed: "text-[var(--status-green)]", failed: "text-[var(--status-red)]", blocked: "text-[var(--status-amber)]",
  "not-run": "text-[var(--text-muted)]", "not-applicable": "text-[var(--text-muted)]",
};

const SYNTHETIC_TEXT = [
  "SYNTHETIC QA DOCUMENT — NOT A REAL IDENTITY OR EMPLOYMENT RECORD",
  "Fictional person: Avery Example",
  "Purpose: harmless upload-validation testing only",
  "Expected local check: format and content-rule result only; no identity, source or employment verification.",
].join("\n");

export const fixtureVariants = [
  { id: "valid", filename: "01-valid-avery-example.pdf", label: "Valid PDF", kind: "pdf", expected: "Harmless labeled reference fixture." },
  { id: "missing-information", filename: "02-missing-required-information.pdf", label: "Missing information", kind: "pdf", expected: "Required-field validation error." },
  { id: "expired", filename: "03-expired-date.pdf", label: "Expired date", kind: "pdf", expected: "Expiry/content-rule error." },
  { id: "inconsistent-name", filename: "04-inconsistent-name.pdf", label: "Inconsistent name", kind: "pdf", expected: "Name consistency review/error." },
  { id: "unsupported-format", filename: "05-unsupported-format.txt", label: "Unsupported format", kind: "text", expected: "Type rejection; harmless text only." },
  { id: "oversized", filename: "06-oversized-synthetic.pdf", label: "Over 10 MB", kind: "oversized", expected: "Candidate portal's size-limit rejection." },
  { id: "corrupt", filename: "07-unreadable-corrupt-synthetic.pdf", label: "Corrupt PDF", kind: "corrupt-pdf", expected: "Integrity/readability result." },
  { id: "changed-bytes", filename: "08-changed-bytes-synthetic.pdf", label: "Changed bytes", kind: "pdf", expected: "Checksum/integrity mismatch when compared after recording." },
] as const;

type FixtureVariantId = typeof fixtureVariants[number]["id"];

/** Run-owned adapter fixture states interpreted by the server evaluator. */
export const exchangeStatePresets = [
  { value: "queued", label: "Queued (generic)" },
  { value: "simulated-response", label: "Simulated response (generic)" },
  { value: "delayed", label: "Delayed response fixture" },
  { value: "pending", label: "Pending response fixture" },
  { value: "timeout", label: "Timeout fixture" },
  { value: "failed", label: "Failed adapter fixture" },
  { value: "unavailable", label: "Unavailable adapter fixture" },
  { value: "identity-mismatch", label: "Identity-mismatch fixture" },
  { value: "duplicate", label: "Duplicate fixture" },
  { value: "quarantined", label: "Quarantined document fixture" },
  { value: "infected", label: "Infected document fixture" },
  { value: "out-of-order", label: "Out-of-order event fixture" },
] as const;

export function syntheticFixtureText(variant: Exclude<FixtureVariantId, "oversized" | "corrupt">, workerName = "Avery Example") {
  const markers: Record<Exclude<FixtureVariantId, "oversized" | "corrupt">, string> = {
    valid: `Name: ${workerName}\nStatus: fictional and complete`,
    "missing-information": `Name: ${workerName}\nRequired field: intentionally absent`,
    expired: `Name: ${workerName}\nExpiry: 2000-01-01`,
    "inconsistent-name": `Name: Different Fictional Person\nExpected synthetic case fixture: ${workerName}`,
    "unsupported-format": "Harmless text content. The .txt type is intentionally unsupported by the candidate portal.",
    "changed-bytes": "Name: Avery Example\nIntegrity marker: ORIGINAL-0 changed to ALTERED-1",
  };
  return [SYNTHETIC_TEXT, "", `Variant: ${variant}`, markers[variant], "", "Expected outcome is a test observation only; it is not identity, source, scanner, or employment verification."].join("\n");
}

function oversizedFixtureText(workerName = "Avery Example") {
  const label = `${syntheticPdf(["Variant: oversized", "This harmless PDF intentionally exceeds the Candidate Portal 10 MB client limit."], workerName)}\n`;
  return label + "X".repeat((10 * 1024 * 1024 + 1) - label.length);
}

function downloadFile(name: string, body: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function pdfEscape(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

/** A real PDF byte stream, intentionally fictional and visibly watermarked. */
export function syntheticPdf(annotations: string[] = [], workerName = "Avery Example") {
  const lines: Array<[string, number]> = [
    ["SYNTHETIC QA DOCUMENT", 22],
    ["NOT A REAL IDENTITY OR EMPLOYMENT RECORD", 15],
    [`Fictional person: ${workerName}`, 14],
    ["Harmless fixture for upload-validation testing only.", 12],
    ["Local checks do not verify source authenticity, identity, or employment readiness.", 10],
    ...annotations.map((annotation) => [annotation, 10] as [string, number]),
  ];
  const stream = lines.map(([line, size], index) => `${index === 0 ? "BT\n72 720 Td" : "0 -34 Td"}\n/F1 ${size} Tf\n(${pdfEscape(line)}) Tj`).join("\n") + "\nET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => { offsets.push(output.length); output += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return output;
}

/** Canvas yields a genuine PNG, rather than downloading SVG data under a PNG label. */
export async function syntheticPngBlob(): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 675;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser cannot create the PNG fixture.");
  context.fillStyle = "#eef2ff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#ffffff";
  context.fillRect(45, 45, 1110, 585);
  context.strokeStyle = "#4338ca";
  context.lineWidth = 5;
  context.strokeRect(45, 45, 1110, 585);
  context.fillStyle = "#312e81";
  context.font = "700 54px Arial";
  context.fillText("SYNTHETIC QA DOCUMENT", 100, 190);
  context.fillStyle = "#4f46e5";
  context.font = "700 26px Arial";
  context.fillText("NOT A REAL IDENTITY OR EMPLOYMENT RECORD", 100, 250);
  context.fillStyle = "#334155";
  context.font = "28px Arial";
  context.fillText("Fictional person: Avery Example", 100, 355);
  context.fillStyle = "#64748b";
  context.font = "22px Arial";
  context.fillText("Use only for harmless upload-validation testing.", 100, 410);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode the PNG fixture.")), "image/png"));
}

export function syntheticFixturePayload(variantId: FixtureVariantId, workerName = "Avery Example"): { filename: string; body: string; type: string } {
  const variant = fixtureVariants.find((item) => item.id === variantId);
  if (!variant) throw new Error("The requested fixture variant is unavailable.");
  if (variant.kind === "oversized") {
    return { filename: variant.filename, body: oversizedFixtureText(workerName), type: "application/pdf" };
  }
  if (variant.kind === "corrupt-pdf") {
    const harmlessBrokenPdf = `${SYNTHETIC_TEXT}\nVariant: corrupt PDF\nThis is deliberately not a valid PDF stream; it contains no executable or malicious content.`;
    return { filename: variant.filename, body: harmlessBrokenPdf, type: "application/pdf" };
  }
  if (variant.kind === "pdf") {
    return { filename: variant.filename, body: syntheticPdf(syntheticFixtureText(variant.id, workerName).split("\n").slice(4), workerName), type: "application/pdf" };
  }
  return { filename: variant.filename, body: syntheticFixtureText(variant.id, workerName), type: "text/plain;charset=utf-8" };
}

async function downloadFixtureVariant(variantId: FixtureVariantId, workerName?: string) {
  const fixture = syntheticFixturePayload(variantId, workerName);
  downloadFile(fixture.filename, fixture.body, fixture.type);
}

function problemMessage(caught: unknown, fallback: string) {
  if (caught instanceof Error && caught.message) return caught.message;
  if (typeof caught === "object" && caught && "message" in caught && typeof caught.message === "string") return caught.message;
  return fallback;
}

function csvCell(value: string | number) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function uatCoverageCsv(scenarios: OnboardingUatScenario[]) {
  const header = ["scenario_id", "title", "family", "roles", "verification_mode", "availability", "blocker", "step_count"];
  const rows = scenarios.map((scenario) => [scenario.id, scenario.title, scenario.family, scenario.roles.join(" | "), scenario.mode, scenario.status, scenario.blocker ?? "", scenario.steps.length].map(csvCell).join(","));
  return [header.join(","), ...rows].join("\n");
}

type RunForTraceability = Pick<OnboardingUatRun, "scenarioId" | "updatedAt" | "evidence">;
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const text = (value: unknown) => typeof value === "string" ? value : "";
const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === "number" ? value : 0;

/**
 * Exports catalog traceability and tenant run observations separately. Mapping
 * and denominators are not represented as execution evidence.
 */
export function uatTraceabilityCsv(catalog: CanonicalLearningCatalog, runs: RunForTraceability[]) {
  const latestByScenario = new Map<string, { result: string; at: string; provenance: string }>();
  runs.forEach((run) => {
    run.evidence.forEach((evidence) => {
      const existing = latestByScenario.get(run.scenarioId);
      if (!existing || evidence.at.localeCompare(existing.at) > 0) latestByScenario.set(run.scenarioId, { result: evidence.result, at: evidence.at, provenance: evidence.provenance });
    });
  });
  const featureCounts = object(catalog.denominators.features);
  const requirementCounts = object(catalog.denominators.requirements);
  const header = ["catalog_version", "baseline_revision", "record_type", "id", "title", "denominator", "mapped_scenario_count", "coverage_with_scenario", "catalog_availability", "canonical_gap_result", "latest_tenant_run_result", "latest_observed_at", "evidence_provenance", "scenario_ids"];
  const summaryRows = [
    [catalog.catalogVersion, catalog.baselineRevision, "feature-summary", "features", "Feature coverage denominator", number(featureCounts.denominator), "", number(featureCounts.withScenario), "", "", "", "", "", ""],
    [catalog.catalogVersion, catalog.baselineRevision, "requirement-summary", "requirements", "BRD/product requirement coverage denominator", number(requirementCounts.denominator), "", number(requirementCounts.withScenario), "", "", "", "", "", ""],
  ];
  const rowsFor = (recordType: "feature" | "requirement", item: CanonicalLearningCatalog["features"][number]) => {
    const scenarioIds = strings(item.values.scenarioIds);
    const observations = scenarioIds.map((id) => latestByScenario.get(id)).filter((item): item is { result: string; at: string; provenance: string } => Boolean(item)).sort((a, b) => b.at.localeCompare(a.at));
    const latest = observations[0];
    const counts = recordType === "feature" ? featureCounts : requirementCounts;
    const canonicalGap = recordType === "requirement" ? text(item.values.latestResult) || "not-run" : "not-run";
    return [catalog.catalogVersion, catalog.baselineRevision, recordType, item.id, item.title, number(counts.denominator), scenarioIds.length, number(counts.withScenario), text(item.values.availability) || text(item.values.verification), canonicalGap, latest?.result ?? "", latest?.at ?? "", latest?.provenance ?? "", scenarioIds.join(" | ")];
  };
  const rows = [...summaryRows, ...catalog.features.map((feature) => rowsFor("feature", feature)), ...catalog.requirements.map((requirement) => rowsFor("requirement", requirement))];
  return [header.join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\n");
}

function evidenceForStep(evidence: OnboardingUatEvidence[], stepId: string) {
  return evidence.filter((item) => item.stepId === stepId).sort((a, b) => b.at.localeCompare(a.at));
}

/** Cleanup is available after a run becomes paused, blocked, or completed. */
export function canRequestUatCleanup(status: OnboardingUatRun["status"], requestPending: boolean) {
  return status !== "cleaned" && !requestPending;
}

export function UatTestCenterPage() {
  const queryClient = useQueryClient();
  const [location, setLocation] = useLocation();
  const searchParams = new URLSearchParams(useSearch());
  const runId = searchParams.get("run");
  const lastCreateAttemptRef = useRef<{ scenarioId: string; requestId: string } | null>(null);
  const { data: catalog, isLoading, isError, refetch, isFetching } = useGetOnboardingUatCatalog({
    query: { queryKey: getGetOnboardingUatCatalogQueryKey(), staleTime: 5_000, refetchInterval: 30_000, refetchOnWindowFocus: true },
  });
  const create = useCreateOnboardingUatRun();
  const learning = useGetOnboardingLearningCatalog({ query: { queryKey: getGetOnboardingLearningCatalogQueryKey(), staleTime: 5_000, refetchInterval: 30_000, refetchOnWindowFocus: true } });
  const [selectedId, setSelectedId] = useState("");
  const [scenarioSearch, setScenarioSearch] = useState("");
  const [family, setFamily] = useState("All families");
  const [availability, setAvailability] = useState("All availability");
  const [error, setError] = useState<string | null>(null);
  const learningCatalog = useMemo(() => learning.data ? normalizeLearningCatalog(learning.data) : null, [learning.data]);
  const runDetailQueries = useQueries({
    queries: (catalog?.runs ?? []).map((summary) => getGetOnboardingUatRunQueryOptions(summary.runId, { query: { queryKey: getGetOnboardingUatRunQueryKey(summary.runId), staleTime: 5_000, refetchInterval: 30_000, refetchOnWindowFocus: true } })),
  });
  const traceabilityRuns = useMemo(() => runDetailQueries.map((query) => query.data).filter((run): run is OnboardingUatRun => Boolean(run)), [runDetailQueries]);
  const families = useMemo(() => [...new Set(catalog?.scenarios.map((scenario) => scenario.family) ?? [])].sort(), [catalog]);
  const visibleScenarios = useMemo(() => {
    const query = scenarioSearch.trim().toLowerCase();
    return (catalog?.scenarios ?? []).filter((scenario) => {
      const matchesText = !query || [scenario.id, scenario.title, scenario.family, scenario.description, scenario.roles.join(" "), scenario.blocker ?? ""].join(" ").toLowerCase().includes(query);
      return matchesText && (family === "All families" || scenario.family === family) && (availability === "All availability" || scenario.status === availability);
    });
  }, [availability, catalog, family, scenarioSearch]);
  const selected = (catalog?.scenarios ?? []).find((scenario) => scenario.id === selectedId) ?? visibleScenarios[0] ?? catalog?.scenarios[0];

  const begin = async () => {
    if (!selected) return;
    setError(null);
    try {
      const retry = lastCreateAttemptRef.current;
      const requestId = retry?.scenarioId === selected.id ? retry.requestId : crypto.randomUUID();
      lastCreateAttemptRef.current = { scenarioId: selected.id, requestId };
      const created = await create.mutateAsync({ data: { scenarioId: selected.id, mode: "simulated", requestId } });
      lastCreateAttemptRef.current = null;
      await queryClient.cancelQueries({ queryKey: getGetOnboardingUatCatalogQueryKey() });
      queryClient.setQueryData(getGetOnboardingUatRunQueryKey(created.runId), created);
      queryClient.invalidateQueries({ queryKey: getGetOnboardingUatCatalogQueryKey() });
      const next = new URLSearchParams(searchParams);
      next.set("run", created.runId);
      setLocation(`${location}?${next.toString()}`);
    } catch (caught) {
      setError(problemMessage(caught, "Could not create the isolated UAT run. Check your organization access and retry."));
    }
  };

  if (isLoading) return <div className="p-12 text-sm text-[var(--text-muted)]">Loading the UAT catalog…</div>;
  if (isError || !catalog) return <ErrorState message="The UAT catalog could not be loaded. No run has been created." onRetry={() => void refetch()} />;
  return <div className="mx-auto max-w-7xl space-y-6 pb-16">
    <PageHeader title="UAT Test Center" subtitle="Guided, tenant-scoped acceptance runs with explicit expected/observed evidence. Simulated evidence is non-authoritative and never changes live readiness." />
    <div className="rounded-[var(--radius-md)] border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-4 text-sm text-[var(--text-secondary)]" role="note" data-testid="text-uat-safety-boundary">
      <strong className="text-[var(--text-primary)]">Safety boundary:</strong> the default run simulates exchanges only. A manual observation records what a person saw; it does not fabricate workflow execution. Provider sandbox and real-email verification remain explicitly blocked until their separately governed conditions are available.
    </div>
    {error && <div className="rounded-md border border-[var(--status-red)] bg-[var(--status-red-bg)] p-3 text-sm text-[var(--status-red-fg)]" role="alert" data-testid="text-uat-error">{error}</div>}
    {runId ? <UatRunPanel runId={runId} onBack={() => { const next = new URLSearchParams(searchParams); next.delete("run"); setLocation(next.size ? `${location}?${next.toString()}` : location); }} /> : <>
      <Card className="p-5">
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div><div className="flex items-center gap-2"><FlaskConical className="h-5 w-5 text-[var(--primary)]" /><h2 className="font-semibold">Scenario catalog</h2></div><p className="mt-1 text-sm text-[var(--text-secondary)]">Choose a reproducible case family. Blocked and manual scenarios remain visible so coverage gaps cannot disappear.</p></div>
          <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}><RefreshCw className="mr-1 h-3.5 w-3.5" />{isFetching ? "Refreshing…" : "Refresh catalog"}</Button><Button type="button" variant="outline" size="sm" disabled={!learningCatalog} onClick={() => learningCatalog && downloadFile(`onboarding-uat-traceability-${learningCatalog.catalogVersion}.csv`, uatTraceabilityCsv(learningCatalog, traceabilityRuns), "text/csv;charset=utf-8")} data-testid="button-download-uat-coverage"><FileSpreadsheet className="mr-1 h-3.5 w-3.5" />{learningCatalog ? "Traceability CSV" : "Traceability unavailable"}</Button></div>
        </div>
        <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_12rem_12rem]">
          <div className="relative"><Input className="pl-9" value={scenarioSearch} onChange={(event) => setScenarioSearch(event.target.value)} placeholder="Search scenario, role, provider, recovery or lifecycle…" data-testid="input-uat-scenario-search" /><FlaskConical className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-[var(--text-muted)]" /></div>
          <select aria-label="Filter scenarios by family" value={family} onChange={(event) => setFamily(event.target.value)} className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm"><option>All families</option>{families.map((item) => <option key={item}>{item}</option>)}</select>
          <select aria-label="Filter scenarios by availability" value={availability} onChange={(event) => setAvailability(event.target.value)} className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm"><option>All availability</option><option value="available">Available</option><option value="manual">Manual evidence</option><option value="blocked">Blocked</option></select>
        </div>
        <p className="mt-3 text-xs text-[var(--text-muted)]" aria-live="polite">{visibleScenarios.length} of {catalog.scenarios.length} scenarios shown · Catalog {catalog.catalogVersion} · Baseline {catalog.baselineRevision}</p>
      </Card>
      <div className="grid gap-6 lg:grid-cols-[minmax(17rem,.9fr)_minmax(0,1.5fr)]">
        <Card className="max-h-[34rem] overflow-auto p-3" aria-label="UAT scenarios">
          {visibleScenarios.length === 0 ? <p className="p-7 text-center text-sm text-[var(--text-muted)]">No scenario matches these filters.</p> : <div className="space-y-2">{visibleScenarios.map((scenario) => <button key={scenario.id} type="button" onClick={() => setSelectedId(scenario.id)} className={`w-full rounded-md border p-3 text-left transition-colors ${selected?.id === scenario.id ? "border-[var(--primary)] bg-[var(--surface-selected)]" : "border-[var(--border)] hover:bg-[var(--surface-alt)]"}`} data-testid={`button-select-uat-${scenario.id}`}><div className="flex items-start justify-between gap-2"><span className="font-mono text-xs font-bold text-[var(--primary)]">{scenario.id}</span><AvailabilityBadge value={scenario.status} /></div><p className="mt-1 text-sm font-semibold">{scenario.title}</p><p className="mt-1 text-xs text-[var(--text-muted)]">{scenario.family} · {scenario.steps.length} guided steps</p></button>)}</div>}
        </Card>
        <ScenarioDetail scenario={selected} pending={create.isPending} onBegin={() => void begin()} />
      </div>
       <ExistingRuns runs={catalog.runs} onOpen={(id) => { const next = new URLSearchParams(searchParams); next.set("run", id); setLocation(`${location}?${next.toString()}`); }} />
    </>}
  </div>;
}

function ScenarioDetail({ scenario, pending, onBegin }: { scenario?: OnboardingUatScenario; pending: boolean; onBegin: () => void }) {
  if (!scenario) return <Card className="p-10 text-center text-sm text-[var(--text-muted)]">Select a scenario to review its roles and prerequisites.</Card>;
  const unavailable = scenario.status !== "available";
  return <Card className="space-y-5 p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-xs font-bold text-[var(--primary)]">{scenario.id}</p><h2 className="mt-1 text-xl font-semibold">{scenario.title}</h2></div><div className="flex gap-2"><Badge>{scenario.family}</Badge><AvailabilityBadge value={scenario.status} /></div></div>
    <p className="text-sm leading-6 text-[var(--text-secondary)]" data-testid="text-uat-scenario-description">{scenario.description}</p>
    <div className="rounded-md bg-[var(--surface-alt)] p-4 text-sm"><p className="font-semibold">Guidance roles — not an authorization</p><p className="mt-1 text-[var(--text-secondary)]">{scenario.roles.join(" · ")}</p><p className="mt-2 text-xs text-[var(--text-muted)]">Follow only the permissions and approval boundaries actually shown by the product and your organization.</p>{scenario.blocker && <p className="mt-3 border-t border-[var(--border)] pt-3 text-sm text-[var(--status-amber)]"><strong>Verification gap:</strong> {scenario.blocker}</p>}</div>
    {(scenario.prerequisites?.length || scenario.fixturePack || scenario.featureIds?.length || scenario.requirementIds?.length || scenario.passCriteria || scenario.cleanup) && <div className="grid gap-3 rounded-md border border-[var(--border)] p-4 text-xs md:grid-cols-2"><div className="space-y-2">{scenario.prerequisites?.length ? <p><strong>Prerequisites:</strong> {scenario.prerequisites.map((prerequisite, index) => <span key={`${scenario.id}-prerequisite-${index}`}>{index > 0 ? " · " : ""}{prerequisite}</span>)}</p> : null}{scenario.fixturePack ? <p><strong>Fixture pack:</strong> {scenario.fixturePack}</p> : null}{scenario.featureIds?.length ? <p><strong>Feature IDs:</strong> {scenario.featureIds.join(" · ")}</p> : null}{scenario.requirementIds?.length ? <p><strong>Requirement IDs:</strong> {scenario.requirementIds.join(" · ")}</p> : null}</div><div className="space-y-2">{scenario.passCriteria ? <p><strong>Pass criteria:</strong> {scenario.passCriteria}</p> : null}{scenario.cleanup ? <p><strong>Scoped cleanup:</strong> {scenario.cleanup}</p> : null}</div></div>}
    <ol className="space-y-3">{scenario.steps.map((step) => <li key={step.id} className="border-l-2 border-[var(--border)] pl-3"><p className="text-sm font-medium"><span className="mr-2 text-[var(--primary)]">{step.order}.</span>{step.action}</p><p className="mt-1 text-xs text-[var(--text-secondary)]"><strong>Guided role instruction ({step.actor}; not an authorization):</strong> {step.expected}</p><p className="mt-1 text-xs text-[var(--text-muted)]">Evidence: {step.evidence} · Wait: {step.wait}</p>{step.negativePath && <p className="mt-1 text-xs text-[var(--status-amber)]"><strong>Harmless negative path:</strong> {step.negativePath}</p>}{step.cleanup && <p className="mt-1 text-xs text-[var(--text-muted)]"><strong>Step cleanup:</strong> {step.cleanup}</p>}</li>)}</ol>
    <Button type="button" className="w-full gap-2" disabled={pending} onClick={onBegin} data-testid="button-start-uat-run"><Play className="h-4 w-4" />{pending ? "Creating isolated run…" : unavailable ? "Create run to record the gap" : "Create synthetic run"}</Button>
    <p className="text-center text-xs text-[var(--text-muted)]">{unavailable ? "This run can document a blocked/manual verification; it does not make the capability available." : "Default mode is simulated. No provider call, recipient authorization or live readiness change is performed."}</p>
  </Card>;
}

function ExistingRuns({ runs, onOpen }: { runs: Array<{ runId: string; scenarioId: string; status: string; version: number; updatedAt: string }>; onOpen: (id: string) => void }) {
  return <Card className="p-5">
    <div className="flex items-center gap-2"><History className="h-5 w-5 text-[var(--primary)]" /><h2 className="font-semibold">Resume a tenant-owned run</h2></div>
    {!runs.length ? <p className="py-8 text-center text-sm text-[var(--text-muted)]">No UAT runs yet. Create a synthetic run to begin.</p> : <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">{runs.map((run) => <button key={run.runId} type="button" data-testid={`button-open-uat-${run.runId}`} onClick={() => onOpen(run.runId)} className="rounded-md border border-[var(--border)] p-3 text-left hover:bg-[var(--surface-soft)]"><div className="flex items-start justify-between gap-2"><strong className="font-mono text-xs">{run.scenarioId}</strong><Badge>{run.status}</Badge></div><p className="mt-2 text-xs text-[var(--text-muted)]">Version {run.version} · Updated {formatDate(run.updatedAt)}</p></button>)}</div>}
  </Card>;
}

function UatRunPanel({ runId, onBack }: { runId: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch, isFetching } = useGetOnboardingUatRun(runId, { query: { queryKey: getGetOnboardingUatRunQueryKey(runId), staleTime: 5_000, refetchInterval: 15_000, refetchOnWindowFocus: true } });
  const mutate = useApplyOnboardingUatRunAction();
  const [note, setNote] = useState("");
  const [hours, setHours] = useState("24");
  const [exchange, setExchange] = useState({ system: "hris", operation: "request", state: "queued" });
  const [demoRunId, setDemoRunId] = useState("");
  const [demoExpectedVersion, setDemoExpectedVersion] = useState("");
  const [approvedDemoEmailConfirmed, setApprovedDemoEmailConfirmed] = useState(false);
  const [fixtureId, setFixtureId] = useState<FixtureVariantId>("valid");
  const [scannerState, setScannerState] = useState<Exclude<NonNullable<OnboardingUatRunAction["scannerState"]>, null>>("clean");
  const [error, setError] = useState<string | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const run = data as UatRunWithRuntimeDetails | undefined;
  const stepEvidence = useMemo(() => new Map(run?.steps.map((step) => [step.id, evidenceForStep(run.evidence, step.id)]) ?? []), [run]);
  const manualEvidence = useMemo(() => (run?.evidence ?? []).slice().sort((a, b) => b.at.localeCompare(a.at)), [run]);

  const saveRun = async (updated: OnboardingUatRun) => {
    await queryClient.cancelQueries({ queryKey: getGetOnboardingUatRunQueryKey(runId) });
    queryClient.setQueryData(getGetOnboardingUatRunQueryKey(runId), updated);
    queryClient.invalidateQueries({ queryKey: getGetOnboardingUatCatalogQueryKey() });
  };
  const action = async (input: UatActionInput, persistResponse = true) => {
    if (!run) return undefined;
    setError(null);
    try {
      const updated = await mutate.mutateAsync({ runId, data: { ...input, expectedVersion: run.version, requestId: crypto.randomUUID() } as OnboardingUatRunAction });
      if (persistResponse) await saveRun(updated);
      return updated as UatRunWithRuntimeDetails;
    } catch (caught) {
      setError(problemMessage(caught, "The action was not recorded. Refresh the run and retry; no local result was assumed."));
      return undefined;
    }
  };
  const fixtures = async () => {
    setError(null);
    try { downloadFile(`uat-${runId}-fixture-manifest.txt`, await downloadOnboardingUatFixturePack(runId), "text/plain;charset=utf-8"); } catch (caught) { setError(problemMessage(caught, "Fixture manifest download failed. No fixture was created.")); }
  };
  const report = async () => {
    setError(null);
    try { downloadFile(`uat-${runId}-evidence.json`, JSON.stringify(await downloadOnboardingUatEvidenceReport(runId), null, 2), "application/json;charset=utf-8"); } catch (caught) { setError(problemMessage(caught, "Evidence export failed. No report was downloaded.")); }
  };
  const issuePortal = async () => {
    const updated = await action({ kind: "issue-candidate-portal" }, false);
    const url = updated?.candidatePortal?.launchUrl;
    if (!url) {
      if (updated) {
        await saveRun(updated);
        setError("No candidate portal was issued for this run. Review the server-provided availability reason; this response alone does not identify a missing permission or authorization.");
      }
      return;
    }
    try {
      const destination = new URL(url, window.location.origin);
      const opened = window.open(destination.toString(), "_blank", "noopener,noreferrer");
      if (!opened) window.location.assign(destination.toString());
      const safeRun = { ...updated, candidatePortal: { ...updated.candidatePortal, launchUrl: undefined } };
      await saveRun(safeRun);
    } catch {
      setError("The issued candidate portal destination was invalid and was not opened.");
    }
  };

  if (isLoading) return <Card className="p-10 text-center text-sm text-[var(--text-muted)]">Loading run evidence…</Card>;
  if (isError || !run) return <ErrorState message="This UAT run is unavailable or belongs to another tenant. No details have been shown." onRetry={() => void refetch()} />;
  const canOperate = run.status === "active";
  const canCleanup = canRequestUatCleanup(run.status, mutate.isPending);
  const isReadyForEvaluation = run.initialization === "ready";
  const portal = run.candidatePortal;
  const canIssuePortal = canOperate && run.linkedCaseIds.length > 0 && portal?.canIssue !== false;
  const isRealEmailScenario = run.scenarioId === "UAT-EMAIL-01";
  const canDispatchApprovedDemoEmail = canOperate && isRealEmailScenario && approvedDemoEmailConfirmed && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(demoRunId.trim()) && Number.isInteger(Number(demoExpectedVersion)) && Number(demoExpectedVersion) >= 0;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><Button type="button" variant="ghost" size="sm" onClick={onBack}><ChevronLeft className="mr-1 h-4 w-4" />All scenarios & runs</Button><Button type="button" variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}><RefreshCw className="mr-1 h-3.5 w-3.5" />{isFetching ? "Refreshing…" : "Refresh run"}</Button></div>
    <Card className="space-y-4 p-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div><p className="font-mono text-xs font-bold text-[var(--primary)]">{run.scenarioId}</p><h2 className="mt-1 text-xl font-semibold">Run evidence workspace</h2><p className="mt-1 text-xs text-[var(--text-muted)]">Run {run.runId} · Version {run.version} · Created {formatDate(run.createdAt)}</p></div>
        <div className="flex flex-wrap gap-2"><Badge>{run.mode}</Badge><AvailabilityBadge value={run.status} /></div>
      </div>
      <div className="grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-5"><RunFact label="Fixture" value={`${run.fixtureVersion} · seed ${run.fixtureSeed}`} /><RunFact label="Baseline" value={run.baselineRevision} /><RunFact label="Run clock" value={`${formatDate(run.clock.now)} (+${run.clock.offsetHours}h)`} /><RunFact label="Linked synthetic cases" value={run.linkedCaseIds.length ? `${run.linkedCaseIds.length} linked` : "None created yet"} /><RunFact label="Initialization" value={run.initialization} /></div>
      <InitializationStatus state={run.initialization} onRefresh={() => void refetch()} onReturnToCatalog={onBack} />
      {run.externalActionStatus && <ExternalActionStatus status={run.externalActionStatus} onRefresh={() => void refetch()} />}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => void fixtures()} data-testid="button-download-uat-fixtures"><FileText className="h-4 w-4" />Fixture manifest</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => downloadFile("synthetic-avery-example.txt", SYNTHETIC_TEXT, "text/plain;charset=utf-8")} data-testid="button-download-uat-text-fixture">Text fixture</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void syntheticPngBlob().then((blob) => downloadFile("synthetic-avery-example.png", blob, "image/png")).catch((caught) => setError(problemMessage(caught, "PNG fixture download failed.")))} data-testid="button-download-uat-png-fixture">PNG fixture</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => downloadFile("synthetic-run-profile.pdf", syntheticPdf([], run.syntheticProfile.workerName), "application/pdf")} data-testid="button-download-uat-pdf-fixture">PDF fixture</Button>
        <details className="relative">
          <summary className="flex h-7 cursor-pointer list-none items-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] text-[var(--text-xs)] font-medium text-[var(--text-primary)] hover:bg-[var(--surface-alt)]">Negative variants</summary>
          <div className="absolute right-0 z-10 mt-1 grid w-64 gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 shadow-[var(--shadow-md)]">
            {fixtureVariants.map((variant) => <button key={variant.id} type="button" className="rounded p-2 text-left text-xs hover:bg-[var(--surface-alt)]" onClick={() => void downloadFixtureVariant(variant.id, run.syntheticProfile.workerName).catch((caught) => setError(problemMessage(caught, "Fixture download failed.")))} data-testid={`button-download-uat-fixture-${variant.id}`}><span className="block font-semibold">{variant.label}</span><span className="text-[var(--text-muted)]">{variant.expected}</span></button>)}
          </div>
        </details>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => void report()} data-testid="button-export-uat-evidence"><Download className="h-4 w-4" />Evidence report</Button>
        {run.status === "paused" ? <Button type="button" size="sm" disabled={mutate.isPending} onClick={() => void action({ kind: "resume" })} data-testid="button-resume-uat"><Play className="mr-1 h-4 w-4" />Resume</Button> : <Button type="button" variant="outline" size="sm" disabled={!canOperate || mutate.isPending} onClick={() => void action({ kind: "pause" })} data-testid="button-pause-uat"><Pause className="mr-1 h-4 w-4" />Pause</Button>}
        <Button type="button" variant="outline" size="sm" disabled={!canCleanup} onClick={() => setConfirmCleanup(true)} data-testid="button-cleanup-uat"><RotateCcw className="mr-1 h-4 w-4" />Scoped cleanup</Button>
      </div>
      {error && <p role="alert" className="rounded-md border border-[var(--status-red)] bg-[var(--status-red-bg)] p-2 text-xs text-[var(--status-red-fg)]">{error}</p>}
      {confirmCleanup && <div className="flex flex-col gap-3 rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-sm sm:flex-row sm:items-center"><p className="flex-1"><strong>Retire this run's synthetic records?</strong> {run.cleanupNotice}</p><Button type="button" size="sm" variant="outline" onClick={() => setConfirmCleanup(false)}>Cancel</Button><Button type="button" size="sm" variant="destructive" disabled={!canCleanup} onClick={() => { setConfirmCleanup(false); void action({ kind: "cleanup" }); }}>Confirm scoped cleanup</Button></div>}
    </Card>
    <Card className="p-5">
      <div className="flex items-center gap-2"><Link2 className="h-5 w-5 text-[var(--primary)]" /><h3 className="font-semibold">Synthetic case and candidate portal</h3></div>
      <p className="mt-1 text-xs text-[var(--text-muted)]">Portal addresses are never stored locally, rendered in a report or shown in activity history. A fresh address is issued only by an explicit server action.</p>
      <div className="mt-3 flex flex-col gap-3 rounded-md bg-[var(--surface-alt)] p-3 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><p className="text-sm font-medium">{portal?.state ?? portal?.status ?? (run.linkedCaseIds.length ? "Synthetic case available" : "No linked synthetic case")}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{portal?.message ?? portal?.reason ?? (run.linkedCaseIds.length ? "Issue a short-lived candidate portal through the isolated run when you are ready to test the candidate journey." : "This scenario has not created a synthetic candidate case yet.")}</p>{portal?.expiresAt && <p className="mt-1 text-xs text-[var(--text-muted)]">Issued access expires {formatDate(portal.expiresAt)}.</p>}</div><Button type="button" variant="outline" size="sm" disabled={!canIssuePortal || mutate.isPending} onClick={() => void issuePortal()} data-testid="button-issue-uat-candidate-portal"><ExternalLink className="mr-1 h-3.5 w-3.5" />Issue & open portal</Button></div>
      {run.linkedCaseIds.length > 0 && <div className="mt-3 flex flex-wrap gap-2 text-xs">{run.linkedCaseIds.map((caseId) => <Link key={caseId} href={`/cases/${caseId}`}><Button type="button" variant="outline" size="sm">View synthetic case {caseId}</Button></Link>)}</div>}
    </Card>
    <Card className="space-y-4 p-5" data-testid="card-uat-workflow-evaluator">
      <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-[var(--primary)]" /><h3 className="font-semibold">Synthetic workflow evaluator</h3></div>
      <p className="text-xs text-[var(--text-muted)]">This read-only, simulated evaluator produces structured assertions from run-owned facts. Its output is independent of the manual notes below and cannot verify a person, source, malware scan, provider, or live readiness.</p>
      <div className="rounded-md bg-[var(--surface-alt)] p-3 text-xs text-[var(--text-secondary)]"><p className="font-semibold text-[var(--text-primary)]">Fictional run profile</p><p className="mt-1">{run.syntheticProfile.workerName} · {run.syntheticProfile.workerEmail} · {run.syntheticProfile.family} · {run.syntheticProfile.variant} · {run.syntheticProfile.hireType} · {run.syntheticProfile.geography} · joining {run.syntheticProfile.joiningDate}</p><p className="mt-1 text-[var(--text-muted)]">{run.syntheticProfile.statement}</p></div>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem_auto]">
        <div><Label htmlFor="uat-evaluator-fixture">Harmless fixture fact</Label><select id="uat-evaluator-fixture" value={fixtureId} onChange={(event) => setFixtureId(event.target.value as FixtureVariantId)} className="mt-1 h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm" data-testid="select-uat-evaluator-fixture">{fixtureVariants.map((fixture) => <option key={fixture.id} value={fixture.id}>{fixture.label} — {fixture.expected}</option>)}</select></div>
        <div><Label htmlFor="uat-scanner-state">Simulated state</Label><select id="uat-scanner-state" value={scannerState} onChange={(event) => setScannerState(event.target.value as typeof scannerState)} className="mt-1 h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm" data-testid="select-uat-scanner-state">{["clean", "pending", "failed", "quarantined"].map((state) => <option key={state}>{state}</option>)}</select></div>
        <div className="flex items-end gap-2"><Button type="button" variant="outline" size="sm" onClick={() => { const fixture = syntheticFixturePayload(fixtureId, run.syntheticProfile.workerName); downloadFile(fixture.filename, fixture.body, fixture.type); }} data-testid="button-download-selected-uat-fixture">Download selected</Button><Button type="button" variant="outline" size="sm" disabled={!canOperate || mutate.isPending} onClick={() => void action({ kind: "inject-harmless-scanner-fact", fixtureId, scannerState, note: `Run-owned harmless ${fixtureId} fixture fact; simulated ${scannerState} state.` })} data-testid="button-inject-uat-scanner-fact">Record fixture fact</Button></div>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-3"><Button type="button" disabled={!canOperate || !isReadyForEvaluation || mutate.isPending} onClick={() => void action({ kind: "evaluate-workflow", note: "Execute the read-only simulated workflow evaluator for this isolated run." })} data-testid="button-evaluate-uat-workflow"><FlaskConical className="mr-1 h-4 w-4" />Execute workflow evaluation</Button><span className="text-xs text-[var(--text-muted)]">{isReadyForEvaluation ? "Expected outcomes remain fixture declarations. A matching assertion is not a complete verification claim." : "Evaluation is disabled until initialization is ready. Refresh while pending; if it failed, repair access/prerequisites and create a replacement run."}</span></div>
      {run.workflowEvaluation && <WorkflowEvaluation evaluation={run.workflowEvaluation} />}
    </Card>
    <Card className="p-5">
      <div className="mb-2 flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-[var(--primary)]" /><h3 className="font-semibold">Guided steps: expected versus observed</h3></div>
      <p className="mb-4 text-xs text-[var(--text-muted)]">Use the buttons only to preserve a human observation. A manual “passed” record is not an automated assertion or full verification; workflow-originated evidence, provider simulation and manual evidence remain visibly distinct below.</p>
      <div className="space-y-4">{run.steps.map((step) => {
        const observations = stepEvidence.get(step.id) ?? [];
        const latest = observations[0];
        return <section key={step.id} className="rounded-md border border-[var(--border)] p-4" data-testid={`card-uat-step-${step.id}`}>
          <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">{step.order}. {step.action}</h4>{latest ? <ResultBadge value={latest.result} provenance={latest.provenance} /> : <ResultBadge value="not-run" />}</div>
          <div className="mt-3 grid gap-2 text-xs md:grid-cols-2"><p className="rounded bg-[var(--surface-alt)] p-2 text-[var(--text-secondary)]"><strong className="text-[var(--text-primary)]">Guided role instruction:</strong> {step.actor} (not an authorization)<br /><strong className="text-[var(--text-primary)]">Expected:</strong> {step.expected}</p><p className="rounded bg-[var(--surface-alt)] p-2 text-[var(--text-secondary)]"><strong className="text-[var(--text-primary)]">Expected evidence:</strong> {step.evidence}<br /><strong className="text-[var(--text-primary)]">Wait/recovery:</strong> {step.wait}{step.negativePath && <><br /><strong className="text-[var(--status-amber)]">Harmless negative path:</strong> {step.negativePath}</>}{step.cleanup && <><br /><strong className="text-[var(--text-primary)]">Step cleanup:</strong> {step.cleanup}</>}</p></div>
           {latest ? <div className="mt-3 rounded border border-[var(--border)] p-2 text-xs"><p><strong>Latest observed ({latest.provenance}):</strong> {latest.note}</p><p className="mt-1 text-[var(--text-muted)]">{formatDate(latest.at)} · {observations.length} recorded observation{observations.length === 1 ? "" : "s"}</p></div> : <p className="mt-3 text-xs text-[var(--text-muted)]">No observation has been recorded for this step.</p>}
           <div className="mt-3 flex flex-wrap gap-2">{(["passed", "failed", "blocked", "not-applicable"] as const).map((result) => <Button key={result} type="button" variant="outline" size="sm" disabled={!canOperate || mutate.isPending} onClick={() => void action({ kind: "record-evidence", stepId: step.id, result, note: note.trim() || `${step.action}: manually observed ${result}.` })} data-testid={`button-uat-${result}-${step.id}`}>Record manual observation: {result}</Button>)}</div>
        </section>;
      })}</div>
      <div className="mt-4 space-y-2 border-t border-[var(--border)] pt-4"><Label htmlFor="uat-note">Redacted observation note</Label><Input id="uat-note" data-testid="input-uat-evidence-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} placeholder="Observed state only—never paste portal links, tokens or confidential payloads" /><p className="text-xs text-[var(--text-muted)]">This note is stored as manual evidence. It cannot turn an unavailable provider or simulated outcome into verified evidence.</p></div>
    </Card>
    <div className="grid gap-4 xl:grid-cols-2">
      <Card className="space-y-3 p-5">
        <div className="flex items-center gap-2"><TimerReset className="h-5 w-5 text-[var(--primary)]" /><h3 className="font-semibold">Run-scoped clock and exchange simulator</h3></div>
        <p className="text-xs text-[var(--text-muted)]">Clock actions never change production time, worker leases, provider credentials or live deadlines. Exchanges are run-owned adapter fixtures, never live events or provider dispatches.</p>
        <div className="flex flex-col gap-2 sm:flex-row"><Input type="number" min="1" max="8760" value={hours} onChange={(event) => setHours(event.target.value)} className="sm:w-28" data-testid="input-uat-hours" /><Button type="button" variant="outline" disabled={!canOperate || mutate.isPending || !Number.isInteger(Number(hours)) || Number(hours) < 1 || Number(hours) > 8760} onClick={() => void action({ kind: "advance-clock", hours: Number(hours) })} data-testid="button-advance-uat-clock"><Clock3 className="mr-1 h-4 w-4" />Advance run clock</Button></div>
        <div className="grid gap-2 sm:grid-cols-3"><select aria-label="Exchange system" value={exchange.system} onChange={(event) => setExchange({ ...exchange, system: event.target.value })} className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm" data-testid="select-uat-system">{["hris", "bgv", "itsm", "payroll", "benefits", "email"].map((value) => <option key={value}>{value}</option>)}</select><select aria-label="Exchange operation" value={exchange.operation} onChange={(event) => setExchange({ ...exchange, operation: event.target.value })} className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm" data-testid="select-uat-operation">{["request", "status", "poll", "webhook", "status-email"].map((value) => <option key={value}>{value}</option>)}</select><select aria-label="Run-owned adapter fixture state" value={exchange.state} onChange={(event) => setExchange({ ...exchange, state: event.target.value })} className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm" data-testid="select-uat-exchange-preset">{exchangeStatePresets.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}</select></div>
        <Button type="button" variant="outline" disabled={!canOperate || mutate.isPending || !exchange.state.trim()} onClick={() => void action({ kind: "exchange", system: exchange.system as NonNullable<OnboardingUatRunAction["system"]>, operation: exchange.operation as NonNullable<OnboardingUatRunAction["operation"]>, state: exchange.state.trim(), note: "Simulated normalized provider exchange. No external dispatch." })} data-testid="button-send-uat-exchange"><Send className="mr-1 h-4 w-4" />Record simulated exchange</Button>
        {run.exchanges.length > 0 && <div className="max-h-48 space-y-2 overflow-auto border-t border-[var(--border)] pt-3">{run.exchanges.slice().reverse().map((item) => <div key={item.id} className="text-xs text-[var(--text-secondary)]"><strong>{item.system}/{item.operation}</strong> → {item.state}<span className="text-[var(--text-muted)]"> · {formatDate(item.at)}</span><p className="mt-0.5">{item.note}</p></div>)}</div>}
      </Card>
      <Card className="p-5">
        <div className="flex items-center gap-2"><History className="h-5 w-5 text-[var(--primary)]" /><h3 className="font-semibold">Evidence and pending work history</h3></div>
        <p className="mt-1 text-xs text-[var(--text-muted)]">The latest status is summarized per step, while the full append-only observation history remains visible here.</p>
        <div className="mt-4 max-h-64 space-y-2 overflow-auto">{manualEvidence.length ? manualEvidence.map((item) => <div key={item.id} className="rounded border border-[var(--border)] p-2 text-xs"><div className="flex flex-wrap justify-between gap-2"><ResultBadge value={item.result} provenance={item.provenance} /><span className="text-[var(--text-muted)]">{item.provenance} · {formatDate(item.at)}</span></div><p className="mt-1 text-[var(--text-secondary)]">{item.note}</p></div>) : <p className="py-6 text-center text-sm text-[var(--text-muted)]">No evidence history yet.</p>}</div>
        {run.pendingEvents && <div className="mt-4 border-t border-[var(--border)] pt-4"><h4 className="text-sm font-semibold">Pending run-scoped events</h4>{run.pendingEvents.length ? <div className="mt-2 space-y-2">{run.pendingEvents.map((event, index) => <p key={event.id ?? index} className="rounded bg-[var(--surface-alt)] p-2 text-xs text-[var(--text-secondary)]"><strong>{event.kind ?? "Scheduled event"}</strong>{event.state ? ` · ${event.state}` : ""}{event.dueAt || event.at ? ` · ${formatDate(event.dueAt ?? event.at ?? "")}` : ""}<br />{event.description ?? event.note ?? "No additional safe event detail was provided."}</p>)}</div> : <p className="mt-2 text-xs text-[var(--text-muted)]">No pending events for this run.</p>}</div>}
      </Card>
    </div>
    {isRealEmailScenario && <Card className="space-y-3 p-5" data-testid="card-approved-demo-email">
      <div className="flex items-center gap-2"><Send className="h-5 w-5 text-[var(--primary)]" /><h3 className="font-semibold">Approved Demo Organization email boundary</h3></div>
      <p className="text-sm text-[var(--text-secondary)]">This optional action delegates only to an existing approved-volunteer Demo Center run. It never accepts a recipient address here, never authorizes a new recipient, and does not turn delivery or reply correlation into a UAT pass.</p>
      <div className="rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--text-secondary)]"><strong className="text-[var(--text-primary)]">Server-enforced requirements:</strong> Demo Organization membership; an existing approved-volunteer Demo run; that run’s current version; the explicit acknowledgement below; existing provider preflight and monitoring. A blocked preflight is recorded as blocked—there is no retry or simulated substitute.</div>
      <div className="grid gap-3 md:grid-cols-2"><div><Label htmlFor="uat-demo-run-id">Existing Demo run ID</Label><Input id="uat-demo-run-id" value={demoRunId} onChange={(event) => setDemoRunId(event.target.value)} placeholder="Demo Center run UUID" data-testid="input-uat-demo-run-id" /></div><div><Label htmlFor="uat-demo-run-version">Existing Demo run version</Label><Input id="uat-demo-run-version" type="number" min="0" step="1" value={demoExpectedVersion} onChange={(event) => setDemoExpectedVersion(event.target.value)} placeholder="Current version" data-testid="input-uat-demo-run-version" /></div></div>
      <label className="flex gap-2 text-xs text-[var(--text-secondary)]"><input type="checkbox" checked={approvedDemoEmailConfirmed} onChange={(event) => setApprovedDemoEmailConfirmed(event.target.checked)} data-testid="checkbox-uat-approved-demo-email" /><span>I understand this is limited to the existing approved QA mailbox/volunteer path and requires Demo Organization authorization.</span></label>
      <Button type="button" variant="outline" disabled={!canDispatchApprovedDemoEmail || mutate.isPending} onClick={() => void action({ kind: "dispatch-approved-demo-email", demoRunId: demoRunId.trim(), demoExpectedVersion: Number(demoExpectedVersion), realEmailConfirmation: "I_UNDERSTAND_APPROVED_QA_MAILBOX_ONLY", note: "Explicit UAT delegation to the existing approved-volunteer Demo Center email path." })} data-testid="button-dispatch-approved-demo-email"><Send className="mr-1 h-4 w-4" />Dispatch through approved Demo run</Button>
      {!canOperate && <p className="text-xs text-[var(--text-muted)]">Resume an active, isolated run before this optional boundary can be requested.</p>}
    </Card>}
  </div>;
}

function InitializationStatus({ state, onRefresh, onReturnToCatalog }: { state: OnboardingUatRun["initialization"]; onRefresh: () => void; onReturnToCatalog: () => void }) {
  if (state === "ready") return <div className="rounded-md border border-[var(--status-green)] bg-[var(--status-green-bg)] p-3 text-xs text-[var(--text-secondary)]"><strong className="text-[var(--text-primary)]">Initialization ready:</strong> run-owned synthetic setup is available for read-only workflow evaluation. This readiness does not verify any live workflow or provider.</div>;
  if (state === "failed") return <div className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--status-red)] bg-[var(--status-red-bg)] p-3 text-xs text-[var(--text-secondary)]"><p className="flex-1"><strong className="text-[var(--text-primary)]">Initialization failed:</strong> evaluation remains disabled. Review/repair organization access or the isolated-case prerequisite, then create a replacement run; do not record a manual pass to bypass this state.</p><Button type="button" size="sm" variant="outline" onClick={onRefresh}>Refresh state</Button><Button type="button" size="sm" variant="outline" onClick={onReturnToCatalog}>Return to create</Button></div>;
  return <div className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--text-secondary)]"><p className="flex-1"><strong className="text-[var(--text-primary)]">Initialization pending:</strong> setup has not yet reached an evaluable state. Refresh this run; if it eventually fails, repair access/prerequisites and create a replacement run.</p><Button type="button" size="sm" variant="outline" onClick={onRefresh}>Refresh state</Button></div>;
}

function ExternalActionStatus({ status, onRefresh }: { status: NonNullable<OnboardingUatRun["externalActionStatus"]>; onRefresh: () => void }) {
  const explanation: Record<typeof status.state, string> = {
    prepared: "Intent is recorded but no durable outcome is available yet. Do not assume dispatch, delivery, or a pass.",
    dispatched: "A dispatch receipt was recorded. It is not proof of delivery, reply correlation, or UAT completion.",
    confirmed: "A durable receipt was confirmed. It is not a workflow pass, recipient authorization, delivery assertion, or live-readiness verification.",
    uncertain: "The server could not establish a durable outcome. Refresh to allow reconciliation; it will not retry automatically or substitute simulated proof.",
    "terminal-failure": "The action reached a terminal failure. Review the message, repair the applicable access/prerequisite, then use a new explicit action if authorized.",
  };
  return <div className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-xs text-[var(--text-secondary)]" data-testid="card-uat-external-action-status"><div className="min-w-0 flex-1"><p><strong className="text-[var(--text-primary)]">External action: {status.kind} · {status.state}</strong></p><p className="mt-1">{explanation[status.state]}</p><p className="mt-1 text-[var(--text-muted)]">Server status: {status.message}</p></div>{(status.state === "prepared" || status.state === "uncertain") && <Button type="button" size="sm" variant="outline" onClick={onRefresh}>Refresh / reconcile</Button>}</div>;
}

function WorkflowEvaluation({ evaluation }: { evaluation: NonNullable<OnboardingUatRun["workflowEvaluation"]> }) {
  return <section className="border-t border-[var(--border)] pt-4" aria-label="Structured workflow assertions">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">Structured simulated assertions</h4><p className="text-xs text-[var(--text-muted)]">{evaluation.summary.total} assertions · {evaluation.summary.passed} expected/observed matches · {evaluation.summary.failed} mismatches · {evaluation.summary.manual} manual gaps</p></div>
    <p className="mt-1 text-xs text-[var(--text-muted)]">Evaluator provenance and rule references are shown per assertion. Manual observation notes are intentionally not used as evaluator facts.</p>
    <div className="mt-3 space-y-2">{evaluation.decisions.map((decision) => <div key={decision.id} className="rounded-md border border-[var(--border)] p-3 text-xs" data-testid={`card-uat-assertion-${decision.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-semibold text-[var(--text-primary)]">{decision.label}</p><p className="mt-1 text-[var(--text-muted)]">{decision.family} · simulated evaluator</p></div><ResultBadge value={decision.passed ? "passed" : decision.observed === "manual" ? "manual" : "failed"} /></div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2"><p><strong>Expected:</strong> {decision.expected}<br /><strong>Observed:</strong> {decision.observed}</p><p><strong>Evidence provenance:</strong> {decision.provenance.join(" · ") || "Not provided"}<br /><strong>Evidence / rule references:</strong> {decision.ruleRefs.join(" · ") || "Not provided"}</p></div>
      {decision.reasons.length > 0 ? <ul className="mt-2 list-disc space-y-1 pl-4 text-[var(--text-secondary)]">{decision.reasons.map((reason, index) => <li key={`${decision.id}-reason-${index}`}>{reason}</li>)}</ul> : <p className="mt-2 text-[var(--text-muted)]">No evaluator blocking reason was returned. This is a simulated assertion only, not full verification.</p>}
    </div>)}</div>
  </section>;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function RunFact({ label, value }: { label: string; value: string }) { return <div className="rounded-md bg-[var(--surface-alt)] p-2"><p className="font-semibold text-[var(--text-primary)]">{label}</p><p className="mt-0.5 break-words text-[var(--text-secondary)]">{value}</p></div>; }
function ResultBadge({ value, provenance }: { value: string; provenance?: string }) { return <span className={`text-[10px] font-bold uppercase tracking-wide ${resultTone[value] ?? "text-[var(--text-muted)]"}`}>{value === "passed" && provenance === "manual-evidence" ? "manual observation: passed" : value.replaceAll("-", " ")}</span>; }
function AvailabilityBadge({ value }: { value: string }) { return <span className={`rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${value === "blocked" ? "text-[var(--status-amber)]" : value === "active" || value === "available" || value === "passed" ? "text-[var(--status-green)]" : "text-[var(--text-secondary)]"}`}>{value.replaceAll("-", " ")}</span>; }
function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="flex flex-col items-center gap-3 p-12 text-center"><AlertTriangle className="h-8 w-8 text-[var(--status-amber)]" /><p className="text-sm">{message}</p><Button type="button" variant="outline" onClick={onRetry} data-testid="button-retry-uat">Retry</Button></div>; }