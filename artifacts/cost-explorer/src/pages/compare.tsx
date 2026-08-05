import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import {
  useListScenarios,
  useGetScenario,
  useComputeRollup,
  getGetScenarioQueryKey,
  type Rollup,
  type Scenario,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Calculator,
  GitCompareArrows,
  PlusCircle,
  Printer,
  Star,
  X,
} from "lucide-react";
import {
  ResponsiveContainer,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  Radar,
  Tooltip as RadarTooltip,
  Legend as RadarLegend,
} from "recharts";
import { formatCurrency, formatNumber } from "@/lib/format";
import {
  calcDelta,
  serializeCompareUrl,
  deserializeCompareUrl,
  buildIntentDeltas,
  hydrateSlots,
  MIN_SCENARIOS,
  MAX_SCENARIOS,
  type Favorability,
  type DeltaInfo,
} from "@/lib/compare";

// ─── Inline delta chip ────────────────────────────────────────────────────────

function DeltaChip({
  d,
  format,
}: {
  d: DeltaInfo;
  format: (v: number) => string;
}) {
  if (d.favorable === null) return null;

  const colorClass = d.favorable
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-destructive";
  const bgClass = d.significant
    ? d.favorable
      ? "bg-emerald-500/10 rounded px-1"
      : "bg-destructive/10 rounded px-1"
    : "";
  const arrow = d.delta > 0 ? "↑" : "↓";

  return (
    <span className={`font-mono text-[10px] font-semibold ${colorClass} ${bgClass}`}>
      {d.delta > 0 ? "+" : ""}
      {format(d.delta)} {arrow}{" "}
      <span className="opacity-70">
        ({d.delta > 0 ? "+" : ""}
        {(d.pct * 100).toFixed(1)}%)
      </span>
    </span>
  );
}

// ─── Per-slot hook ────────────────────────────────────────────────────────────

interface SlotState {
  scenario: Scenario | undefined;
  rollup: Rollup | null;
  isPending: boolean;
}

function useScenarioSlot(id: number | null): SlotState {
  const { data: scenario } = useGetScenario(id as number, {
    query: {
      enabled: !!id,
      queryKey: getGetScenarioQueryKey(id as number),
    },
  });
  const compute = useComputeRollup();
  const [rollup, setRollup] = useState<Rollup | null>(null);

  // Key that captures both id and inputs — changes trigger recompute
  const inputsKey =
    id && scenario?.id === id
      ? `${scenario.id}:${JSON.stringify(scenario.inputs)}`
      : null;

  useEffect(() => {
    if (!inputsKey || !scenario) {
      setRollup(null);
      return;
    }
    setRollup(null);
    let cancelled = false;
    compute
      .mutateAsync({ data: { inputs: scenario.inputs } })
      .then((r) => { if (!cancelled) setRollup(r); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputsKey]);

  return {
    scenario: id && scenario?.id === id ? scenario : undefined,
    rollup: id ? rollup : null,
    isPending: !!id && !rollup,
  };
}

// ─── Headline metric definitions ──────────────────────────────────────────────

interface MetricDef {
  label: string;
  get: (r: Rollup) => number;
  fav: Favorability;
  format: (v: number) => string;
}

const METRICS: MetricDef[] = [
  {
    label: "Net Value",
    get: (r) => r.totals.netUsd,
    fav: "higher-is-better",
    format: (v) => formatCurrency(v, true),
  },
  {
    label: "ROI",
    get: (r) => r.totals.roi,
    fav: "higher-is-better",
    format: (v) => `${v.toFixed(2)}×`,
  },
  {
    label: "FTE Equivalent Saved",
    get: (r) => r.totals.fteEquivalent,
    fav: "higher-is-better",
    format: (v) => v.toFixed(1),
  },
  {
    label: "Gross Benefit",
    get: (r) => r.totals.benefitUsd,
    fav: "higher-is-better",
    format: (v) => formatCurrency(v, true),
  },
  {
    label: "Total Cost",
    get: (r) => r.totals.totalCostUsd,
    fav: "lower-is-better",
    format: (v) => formatCurrency(v, true),
  },
  {
    label: "Run Cost",
    get: (r) => r.totals.runCostUsd,
    fav: "lower-is-better",
    format: (v) => formatCurrency(v, true),
  },
  {
    label: "Build Cost (amortized)",
    get: (r) => r.totals.buildCostUsd,
    fav: "lower-is-better",
    format: (v) => formatCurrency(v, true),
  },
  {
    label: "Cost per Transaction",
    get: (r) => r.totals.costPerTransactionUsd,
    fav: "lower-is-better",
    format: (v) => `$${v.toFixed(4)}`,
  },
  {
    label: "Benefit per Transaction",
    get: (r) => r.totals.benefitPerTransactionUsd,
    fav: "higher-is-better",
    format: (v) => `$${v.toFixed(4)}`,
  },
  {
    label: "Human Hours Saved",
    get: (r) => r.totals.humanHoursSaved,
    fav: "higher-is-better",
    format: (v) => formatNumber(v),
  },
];

// ─── Print portal (N-scenario one-pager) ─────────────────────────────────────

interface PrintPortalProps {
  slots: (number | null)[];
  activeSlots: SlotState[];
  intentDeltas: ReturnType<typeof buildIntentDeltas>;
  effectiveBaselineId: number | null;
  baselineIdx: number;
  exportDate: string;
}

function PrintPortal({
  slots,
  activeSlots,
  intentDeltas,
  effectiveBaselineId,
  baselineIdx,
  exportDate,
}: PrintPortalProps) {
  const portal = document.getElementById("print-portal");
  if (!portal) return null;

  // Filled slots only (slot has an id AND a loaded rollup)
  const filledSlots = activeSlots
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => slots[i] !== null && s.rollup !== null);

  if (filledSlots.length < 2) return null;

  // Scenario names for the header subtitle
  const scenarioNames = filledSlots.map(
    ({ s, i }) => s.scenario?.name ?? `Scenario ${i + 1}`,
  );
  const baselineName =
    baselineIdx >= 0
      ? (activeSlots[baselineIdx]?.scenario?.name ?? `Scenario ${baselineIdx + 1}`)
      : scenarioNames[0];

  // Top 10 intent rows (already sorted by maxAbsDelta desc)
  const topIntents = intentDeltas.slice(0, 10);

  // Per-scenario font size for headline table — shrink slightly when ≥ 4 scenarios
  const tableFontSz = filledSlots.length >= 4 ? "7.5pt" : "8.5pt";

  const content = (
    <div
      className="print-content"
      style={{ fontFamily: "Inter, sans-serif", color: "#000" }}
    >
      {/* ── Document header ─────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "10pt",
          borderBottom: "2pt solid #1e3a5f",
          paddingBottom: "6pt",
        }}
      >
        <div>
          <h1 style={{ fontSize: "15pt", fontWeight: 700, margin: 0, color: "#1e293b" }}>
            Scenario Comparison
          </h1>
          <div style={{ fontSize: "8.5pt", color: "#475569", marginTop: "2pt" }}>
            {scenarioNames.map((name, idx) => (
              <span key={idx}>
                {idx > 0 && <span style={{ color: "#94a3b8", margin: "0 4pt" }}>·</span>}
                <span
                  style={{
                    fontWeight: slots[filledSlots[idx]?.i] === effectiveBaselineId ? 700 : 500,
                  }}
                >
                  {name}
                  {slots[filledSlots[idx]?.i] === effectiveBaselineId && (
                    <span style={{ color: "#d97706", marginLeft: "3pt" }}>★</span>
                  )}
                </span>
              </span>
            ))}
          </div>
          <div style={{ fontSize: "7.5pt", color: "#94a3b8", marginTop: "2pt" }}>
            Baseline: <strong style={{ color: "#475569" }}>{baselineName}</strong>
            {" "}— deltas shown vs baseline
          </div>
        </div>
        <div style={{ textAlign: "right", fontSize: "8pt", color: "#64748b" }}>
          <div style={{ fontWeight: 600 }}>HRO Intent Flow Cost-Benefit Explorer</div>
          <div>{exportDate}</div>
        </div>
      </div>

      {/* ── Headline metrics ─────────────────────────────────────────────────── */}
      <div
        className="print-section"
        style={{ marginBottom: "10pt" }}
      >
        <div
          style={{
            fontSize: "8pt",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.07em",
            color: "#475569",
            borderBottom: "1pt solid #cbd5e1",
            paddingBottom: "2pt",
            marginBottom: "4pt",
          }}
        >
          Headline Metrics
        </div>
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: tableFontSz }}
        >
          <thead>
            <tr style={{ background: "#f1f5f9" }}>
              <th
                style={{
                  padding: "3pt 6pt",
                  textAlign: "left",
                  fontWeight: 600,
                  borderBottom: "1pt solid #cbd5e1",
                  color: "#334155",
                }}
              >
                Metric
              </th>
              {filledSlots.map(({ s, i }) => {
                const isBase = slots[i] === effectiveBaselineId;
                const name = s.scenario?.name ?? `Scenario ${i + 1}`;
                return (
                  <th
                    key={i}
                    style={{
                      padding: "3pt 6pt",
                      textAlign: "right",
                      fontWeight: 600,
                      borderBottom: "1pt solid #cbd5e1",
                      color: isBase ? "#92400e" : "#334155",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {isBase ? `★ ${name}` : name}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {METRICS.map((m) => {
              const baselineRollup =
                baselineIdx >= 0 ? activeSlots[baselineIdx]?.rollup : null;
              const baselineVal = baselineRollup ? m.get(baselineRollup) : null;

              return (
                <tr key={m.label} style={{ borderBottom: "0.5pt solid #e2e8f0" }}>
                  <td style={{ padding: "2.5pt 6pt", color: "#475569" }}>{m.label}</td>
                  {filledSlots.map(({ s, i }) => {
                    if (!s.rollup) return <td key={i} />;
                    const val = m.get(s.rollup);
                    const isBase = slots[i] === effectiveBaselineId;
                    const d =
                      !isBase && baselineVal !== null
                        ? calcDelta(val, baselineVal, m.fav)
                        : null;
                    const deltaStr = d
                      ? d.favorable === null
                        ? ""
                        : `${d.delta > 0 ? "+" : ""}${m.format(d.delta)} ${d.delta > 0 ? "↑" : "↓"} (${d.pct >= 0 ? "+" : ""}${(d.pct * 100).toFixed(1)}%)`
                      : "";
                    const deltaColor =
                      d && d.favorable !== null
                        ? d.favorable
                          ? "#059669"
                          : "#dc2626"
                        : "#64748b";

                    return (
                      <td
                        key={i}
                        style={{ padding: "2.5pt 6pt", textAlign: "right" }}
                      >
                        <div
                          style={{
                            fontFamily: "monospace",
                            fontWeight: 600,
                            color: "#1e293b",
                          }}
                        >
                          {m.format(val)}
                        </div>
                        {deltaStr && (
                          <div
                            style={{
                              fontSize: "6.5pt",
                              fontFamily: "monospace",
                              color: deltaColor,
                              marginTop: "1pt",
                            }}
                          >
                            {deltaStr}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Top intent divergences ───────────────────────────────────────────── */}
      <div className="print-section">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            borderBottom: "1pt solid #cbd5e1",
            paddingBottom: "2pt",
            marginBottom: "4pt",
          }}
        >
          <div
            style={{
              fontSize: "8pt",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.07em",
              color: "#475569",
            }}
          >
            Top Intent Divergences
          </div>
          <div style={{ fontSize: "7pt", color: "#94a3b8" }}>
            Sorted by max |Δ Net| vs baseline — top {topIntents.length} of{" "}
            {intentDeltas.length}
          </div>
        </div>
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: "7.5pt" }}
        >
          <thead>
            <tr style={{ background: "#f1f5f9" }}>
              <th
                style={{
                  padding: "3pt 6pt",
                  textAlign: "left",
                  fontWeight: 600,
                  borderBottom: "1pt solid #cbd5e1",
                  color: "#334155",
                }}
              >
                Intent
              </th>
              <th
                style={{
                  padding: "3pt 6pt",
                  textAlign: "left",
                  fontWeight: 600,
                  borderBottom: "1pt solid #cbd5e1",
                  color: "#334155",
                }}
              >
                Domain
              </th>
              {filledSlots.map(({ s, i }) => {
                const isBase = slots[i] === effectiveBaselineId;
                const name = s.scenario?.name ?? `Scenario ${i + 1}`;
                return (
                  <th
                    key={i}
                    style={{
                      padding: "3pt 6pt",
                      textAlign: "right",
                      fontWeight: 600,
                      borderBottom: "1pt solid #cbd5e1",
                      color: isBase ? "#92400e" : "#334155",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {isBase ? `★ ${name}` : name}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {topIntents.map((row) => {
              const baselineNet =
                baselineIdx >= 0 ? (row.netBySlot[baselineIdx] ?? 0) : 0;

              return (
                <tr key={row.intentKey} style={{ borderBottom: "0.5pt solid #e2e8f0" }}>
                  <td
                    style={{
                      padding: "2pt 6pt",
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.intentName}
                  </td>
                  <td style={{ padding: "2pt 6pt" }}>
                    <span
                      style={{
                        border: "0.5pt solid #cbd5e1",
                        borderRadius: "3pt",
                        padding: "0 3pt",
                        fontSize: "6.5pt",
                        color: "#475569",
                      }}
                    >
                      {row.domain}
                    </span>
                  </td>
                  {filledSlots.map(({ i }) => {
                    const net = row.netBySlot[i] ?? 0;
                    const isBase = slots[i] === effectiveBaselineId;
                    const netColor = net >= 0 ? "#059669" : "#dc2626";
                    const d =
                      !isBase
                        ? calcDelta(net, baselineNet, "higher-is-better")
                        : null;
                    const deltaStr = d
                      ? d.favorable === null
                        ? ""
                        : `${d.delta > 0 ? "+" : ""}${formatCurrency(d.delta, true)} ${d.delta > 0 ? "↑" : "↓"}`
                      : "";
                    const deltaColor =
                      d && d.favorable !== null
                        ? d.favorable
                          ? "#059669"
                          : "#dc2626"
                        : "#64748b";

                    return (
                      <td
                        key={i}
                        style={{ padding: "2pt 6pt", textAlign: "right" }}
                      >
                        <div
                          style={{
                            fontFamily: "monospace",
                            fontWeight: 600,
                            color: netColor,
                          }}
                        >
                          {net >= 0 ? "+" : ""}
                          {formatCurrency(net, true)}
                        </div>
                        {deltaStr && (
                          <div
                            style={{
                              fontSize: "6.5pt",
                              fontFamily: "monospace",
                              color: deltaColor,
                              marginTop: "1pt",
                            }}
                          >
                            {deltaStr}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <div
        style={{
          marginTop: "8pt",
          fontSize: "7pt",
          color: "#94a3b8",
          borderTop: "0.5pt solid #e2e8f0",
          paddingTop: "4pt",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>Generated by HRO Intent Flow Cost-Benefit Explorer</span>
        <span>
          Δ vs {baselineName} &nbsp;·&nbsp; ↑ higher &nbsp;·&nbsp; green = favorable
        </span>
      </div>
    </div>
  );

  return createPortal(content, portal);
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function Compare() {
  const [, navigate] = useLocation();

  // ── Initialise state from URL (runs once on mount) ──────────────────────────
  const [slots, setSlots] = useState<(number | null)[]>(() => {
    const { ids } = deserializeCompareUrl(window.location.search);
    return hydrateSlots(ids, MIN_SCENARIOS, MAX_SCENARIOS);
  });

  const [baselineId, setBaselineId] = useState<number | null>(() => {
    const { ids, baselineId } = deserializeCompareUrl(window.location.search);
    return baselineId ?? ids[0] ?? null;
  });

  // ── Fixed-slot hooks (Rules of Hooks — always called, always 5) ─────────────
  const slot0 = useScenarioSlot(slots[0] ?? null);
  const slot1 = useScenarioSlot(slots[1] ?? null);
  const slot2 = useScenarioSlot(slots[2] ?? null);
  const slot3 = useScenarioSlot(slots[3] ?? null);
  const slot4 = useScenarioSlot(slots[4] ?? null);
  const ALL_SLOTS = [slot0, slot1, slot2, slot3, slot4];

  // Active slots = only up to slots.length
  const activeSlots = ALL_SLOTS.slice(0, slots.length);

  // ── Derived baseline ────────────────────────────────────────────────────────
  const nonNullIds = slots.filter((id): id is number => id !== null);
  // Auto-correct: if baselineId not in current slot list, use first non-null
  const effectiveBaselineId = nonNullIds.includes(baselineId as number)
    ? baselineId
    : nonNullIds[0] ?? null;
  const baselineIdx = slots.findIndex((id) => id === effectiveBaselineId);

  // ── Scenario list ───────────────────────────────────────────────────────────
  const { data: scenarios, isLoading: isLoadingScenarios } = useListScenarios();
  const scenarioCount = scenarios?.length ?? 0;

  // ── URL sync ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const filledIds = slots.filter((id): id is number => id !== null);
    if (filledIds.length === 0) return;
    const newPath = serializeCompareUrl(filledIds, effectiveBaselineId);
    const current = deserializeCompareUrl(window.location.search);
    if (
      JSON.stringify(current.ids) !== JSON.stringify(filledIds) ||
      current.baselineId !== effectiveBaselineId
    ) {
      navigate(newPath, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(slots), effectiveBaselineId]);

  // ── Slot mutation helpers ────────────────────────────────────────────────────
  const setSlotId = (slotIdx: number, id: number) => {
    setSlots((prev) => {
      const next = [...prev];
      next[slotIdx] = id;
      return next;
    });
    // If this is the first filled slot, make it baseline
    if (effectiveBaselineId === null) setBaselineId(id);
  };

  const addSlot = () => {
    if (slots.length >= MAX_SCENARIOS) return;
    setSlots((prev) => [...prev, null]);
  };

  const removeSlot = (slotIdx: number) => {
    if (slots.length <= MIN_SCENARIOS) return;
    const removedId = slots[slotIdx];
    setSlots((prev) => prev.filter((_, i) => i !== slotIdx));
    // If we removed the baseline, reassign to first remaining non-null
    if (removedId !== null && removedId === effectiveBaselineId) {
      const remaining = slots.filter((id, i) => i !== slotIdx && id !== null) as number[];
      setBaselineId(remaining[0] ?? null);
    }
  };

  const handleExport = () => {
    window.print();
  };

  // ── Ready state ──────────────────────────────────────────────────────────────
  const filledSlotCount = slots.filter((id) => id !== null).length;
  const loadedRollupCount = activeSlots.filter(
    (s, i) => slots[i] !== null && s.rollup !== null,
  ).length;
  const anyPending = activeSlots.some((s, i) => slots[i] !== null && s.isPending);
  const readyToCompare =
    filledSlotCount >= 2 && loadedRollupCount === filledSlotCount;

  // ── Intent deltas ────────────────────────────────────────────────────────────
  const intentDeltas = readyToCompare
    ? buildIntentDeltas(
        activeSlots.map((s) => s.rollup?.rows ?? null),
        slots.length,
        baselineIdx >= 0 ? baselineIdx : 0,
      )
    : [];

  // Export date
  const exportDate = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // ── Loading skeleton ─────────────────────────────────────────────────────────
  if (isLoadingScenarios) {
    return (
      <div className="flex flex-col gap-6 animate-in fade-in duration-300 pb-20">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // ── Not enough scenarios saved ───────────────────────────────────────────────
  if (scenarioCount < 2) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 animate-in fade-in duration-300">
        <GitCompareArrows className="w-16 h-16 opacity-20" />
        <h2 className="text-xl font-semibold text-foreground">
          Not enough saved scenarios
        </h2>
        <p className="text-muted-foreground text-center max-w-md">
          You need at least two saved scenarios to compare. Head to the Scenario
          Builder to create and save some.
        </p>
        <Button onClick={() => navigate("/scenario")}>
          <Calculator className="w-4 h-4 mr-2" /> Go to Scenario Builder
        </Button>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            Scenario Comparison
          </h1>
          <p className="text-muted-foreground mt-1">
            Compare up to {MAX_SCENARIOS} saved scenarios side-by-side. Mark one as
            baseline — all deltas are computed against it.
          </p>
        </div>
        {readyToCompare && (
          <Button
            variant="outline"
            onClick={handleExport}
            className="shrink-0 gap-2 print:hidden"
            title="Export as PDF via browser print dialog"
          >
            <Printer className="w-4 h-4" />
            Export / Print
          </Button>
        )}
      </div>

      {/* ── Selector bar ──────────────────────────────────────────────────────── */}
      <Card className="shadow-sm border-border print:hidden">
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3 items-end">
            {slots.map((id, slotIdx) => {
              const isBaseline = id !== null && id === effectiveBaselineId;
              const scenarioName =
                activeSlots[slotIdx]?.scenario?.name ?? null;

              return (
                <div
                  key={slotIdx}
                  className="flex flex-col gap-1.5 min-w-[180px] flex-1"
                >
                  {/* Column header row */}
                  <div className="flex items-center justify-between h-5">
                    {isBaseline ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-600 dark:text-amber-400">
                        <Star className="w-3 h-3 fill-current" />
                        Baseline
                      </span>
                    ) : id !== null ? (
                      <button
                        onClick={() => setBaselineId(id)}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline"
                        title="Set as baseline"
                      >
                        Set as baseline
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Scenario {slotIdx + 1}
                      </span>
                    )}

                    {slots.length > MIN_SCENARIOS && (
                      <button
                        onClick={() => removeSlot(slotIdx)}
                        className="ml-1 text-muted-foreground hover:text-destructive transition-colors"
                        title="Remove this column"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Dropdown */}
                  <Select
                    value={id ? String(id) : ""}
                    onValueChange={(v) => setSlotId(slotIdx, parseInt(v, 10))}
                  >
                    <SelectTrigger className="bg-background w-full">
                      <SelectValue placeholder="Choose a scenario…" />
                    </SelectTrigger>
                    <SelectContent>
                      {scenarios?.map((s) => {
                        // Disable if this scenario is already in another slot
                        const usedElsewhere = slots.some(
                          (sid, i) => i !== slotIdx && sid === s.id,
                        );
                        return (
                          <SelectItem
                            key={s.id}
                            value={String(s.id)}
                            disabled={usedElsewhere}
                          >
                            {s.name}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>

                  {/* Scenario name tag when loaded */}
                  {scenarioName && (
                    <span className="text-[10px] text-muted-foreground truncate">
                      {isBaseline && (
                        <span className="text-amber-600 dark:text-amber-400 font-semibold mr-1">
                          ★
                        </span>
                      )}
                      {scenarioName}
                    </span>
                  )}
                </div>
              );
            })}

            {/* Add column button */}
            {slots.length < MAX_SCENARIOS && (
              <div className="flex flex-col justify-end pb-0.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addSlot}
                  className="gap-1.5 whitespace-nowrap"
                >
                  <PlusCircle className="w-3.5 h-3.5" />
                  Add scenario
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Empty / loading / results ─────────────────────────────────────────── */}
      {filledSlotCount < 2 ? (
        <div className="flex flex-col items-center justify-center min-h-[40vh] gap-3 text-muted-foreground">
          <GitCompareArrows className="w-12 h-12 opacity-20" />
          <p>Select at least two scenarios above to see the comparison.</p>
        </div>
      ) : anyPending ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : readyToCompare ? (
        <>
          {/* ── Radar comparison chart ───────────────────────────────────────── */}
          {(() => {
            // Build normalized radar data across 5 dimensions
            const dims = [
              { key: "roi",      label: "ROI",              get: (r: Rollup) => r.totals.roi,                      higher: true },
              { key: "net",      label: "Net Value",        get: (r: Rollup) => r.totals.netUsd,                   higher: true },
              { key: "fte",      label: "FTE Saved",        get: (r: Rollup) => r.totals.fteEquivalent,            higher: true },
              { key: "bpt",      label: "Benefit/Txn",      get: (r: Rollup) => r.totals.benefitPerTransactionUsd, higher: true },
              { key: "cost_eff", label: "Cost Efficiency",  get: (r: Rollup) => 1 / (r.totals.costPerTransactionUsd + 0.0001), higher: true },
            ];
            const filledSlotData = activeSlots
              .map((s, i) => ({ s, i }))
              .filter(({ s, i }) => slots[i] !== null && s.rollup !== null);
            if (filledSlotData.length < 2) return null;

            // Per-dim min/max for normalization
            const radarData = dims.map(dim => {
              const vals = filledSlotData.map(({ s }) => dim.get(s.rollup!));
              const mn = Math.min(...vals), mx = Math.max(...vals);
              const row: Record<string, number | string> = { dim: dim.label };
              filledSlotData.forEach(({ s, i }) => {
                const raw = dim.get(s.rollup!);
                // Normalize 0–100; if all equal set to 75 (mid-high)
                const norm = mx === mn ? 75 : ((raw - mn) / (mx - mn)) * 70 + 30;
                row[`s${i}`] = Math.round(norm);
              });
              return row;
            });

            const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899"];

            return (
              <Card className="shadow-sm border-border">
                <CardHeader className="px-4 py-3 border-b border-border bg-muted/30">
                  <CardTitle className="text-sm font-semibold">Business Case Shape</CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Normalized comparison — each axis shows relative strength within this set.
                  </p>
                </CardHeader>
                <CardContent className="pt-4 pb-2">
                  <div className="h-[280px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <RadarChart data={radarData} margin={{ top: 10, right: 40, bottom: 10, left: 40 }}>
                        <PolarGrid stroke="hsl(var(--border))" />
                        <PolarAngleAxis
                          dataKey="dim"
                          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))", fontFamily: "Inter, sans-serif" }}
                        />
                        {filledSlotData.map(({ s, i }) => {
                          const name = s.scenario?.name ?? `Scenario ${i + 1}`;
                          const isBase = slots[i] === effectiveBaselineId;
                          return (
                            <Radar
                              key={i}
                              name={isBase ? `★ ${name}` : name}
                              dataKey={`s${i}`}
                              stroke={COLORS[i % COLORS.length]}
                              fill={COLORS[i % COLORS.length]}
                              fillOpacity={0.12}
                              strokeWidth={2}
                            />
                          );
                        })}
                        <RadarTooltip
                          formatter={(val: number) => [`${val}/100`, ""]}
                          contentStyle={{ borderRadius: 8, border: "1px solid hsl(var(--border))", fontSize: 11 }}
                        />
                        <RadarLegend
                          wrapperStyle={{ fontSize: 11, paddingTop: 8, fontFamily: "Inter, sans-serif" }}
                        />
                      </RadarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* ── Headline metrics ─────────────────────────────────────────────── */}
          <Card className="shadow-sm border-border overflow-hidden">
            <CardHeader className="px-4 py-3 border-b border-border bg-muted/30">
              <CardTitle className="text-sm font-semibold">
                Headline Metrics
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-muted-foreground text-xs uppercase font-semibold">
                    <tr>
                      <th className="px-4 py-2.5 text-left font-semibold sticky left-0 bg-muted/50">
                        Metric
                      </th>
                      {activeSlots.map((slot, i) => {
                        const isBaseline =
                          slots[i] !== null && slots[i] === effectiveBaselineId;
                        const name =
                          slot.scenario?.name ?? `Scenario ${i + 1}`;
                        return (
                          <th
                            key={i}
                            className="px-4 py-2.5 text-right font-semibold min-w-[140px]"
                          >
                            <div className="flex flex-col items-end gap-0.5">
                              <span className="truncate max-w-[160px]">{name}</span>
                              {isBaseline ? (
                                <Badge className="text-[9px] px-1.5 py-0 bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30">
                                  ★ Baseline
                                </Badge>
                              ) : slots[i] !== null ? (
                                <button
                                  onClick={() =>
                                    setBaselineId(slots[i] as number)
                                  }
                                  className="text-[9px] text-muted-foreground hover:text-foreground underline underline-offset-1"
                                >
                                  Set baseline
                                </button>
                              ) : null}
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {METRICS.map((m) => {
                      const baselineRollup =
                        baselineIdx >= 0 ? activeSlots[baselineIdx]?.rollup : null;
                      const baselineVal = baselineRollup ? m.get(baselineRollup) : null;

                      return (
                        <tr
                          key={m.label}
                          className="border-b border-border hover:bg-muted/20 transition-colors"
                        >
                          <td className="px-4 py-2.5 text-sm text-muted-foreground sticky left-0 bg-background">
                            {m.label}
                          </td>
                          {activeSlots.map((slot, i) => {
                            if (slots[i] === null || !slot.rollup) {
                              return (
                                <td
                                  key={i}
                                  className="px-4 py-2.5 text-right"
                                />
                              );
                            }
                            const val = m.get(slot.rollup);
                            const isBaseline =
                              slots[i] === effectiveBaselineId;
                            const d =
                              !isBaseline && baselineVal !== null
                                ? calcDelta(val, baselineVal, m.fav)
                                : null;

                            return (
                              <td
                                key={i}
                                className="px-4 py-2.5 text-right"
                              >
                                <div className="flex flex-col items-end gap-0.5">
                                  <span
                                    className={`font-mono font-semibold text-sm ${
                                      isBaseline
                                        ? "text-foreground"
                                        : "text-foreground/80"
                                    }`}
                                  >
                                    {m.format(val)}
                                  </span>
                                  {d && (
                                    <DeltaChip d={d} format={m.format} />
                                  )}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* ── Per-intent breakdown ─────────────────────────────────────────── */}
          <Card className="shadow-sm border-border overflow-hidden">
            <CardHeader className="px-4 py-3 border-b border-border bg-muted/30">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold">
                  Per-Intent Breakdown
                </CardTitle>
                <span className="text-xs text-muted-foreground">
                  Sorted by max |ΔNet| vs baseline
                </span>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-muted/50 text-muted-foreground text-xs uppercase font-semibold">
                    <tr>
                      <th className="px-4 py-3 sticky left-0 bg-muted/50">
                        Intent
                      </th>
                      <th className="px-4 py-3">Domain</th>
                      {activeSlots.map((slot, i) => {
                        if (slots[i] === null) return null;
                        const isBaseline = slots[i] === effectiveBaselineId;
                        const name =
                          slot.scenario?.name ?? `Scenario ${i + 1}`;
                        return (
                          <th
                            key={i}
                            className="px-4 py-3 text-right min-w-[130px]"
                          >
                            <div className="flex flex-col items-end gap-0.5">
                              <span className="truncate max-w-[160px]">
                                {name} Net
                              </span>
                              {isBaseline && (
                                <Badge className="text-[9px] px-1.5 py-0 bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30">
                                  ★ Baseline
                                </Badge>
                              )}
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {intentDeltas.map((row) => {
                      const baselineNet =
                        baselineIdx >= 0 ? row.netBySlot[baselineIdx] ?? 0 : 0;

                      return (
                        <tr
                          key={row.intentKey}
                          className="hover:bg-muted/30 transition-colors"
                        >
                          <td className="px-4 py-2.5 font-medium text-foreground whitespace-nowrap sticky left-0 bg-background">
                            {row.intentName}
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge
                              variant="outline"
                              className="capitalize text-[10px] bg-background"
                            >
                              {row.domain}
                            </Badge>
                          </td>
                          {activeSlots.map((_, i) => {
                            if (slots[i] === null) return null;
                            const net = row.netBySlot[i] ?? 0;
                            const isBaseline = slots[i] === effectiveBaselineId;
                            const d =
                              !isBaseline
                                ? calcDelta(net, baselineNet, "higher-is-better")
                                : null;

                            return (
                              <td
                                key={i}
                                className="px-4 py-2.5 text-right"
                              >
                                <div className="flex flex-col items-end gap-0.5">
                                  <span
                                    className={`font-mono text-xs font-semibold ${
                                      net >= 0
                                        ? "text-emerald-600 dark:text-emerald-400"
                                        : "text-destructive"
                                    }`}
                                  >
                                    {net >= 0 ? "+" : ""}
                                    {formatCurrency(net, true)}
                                  </span>
                                  {d && (
                                    <DeltaChip
                                      d={d}
                                      format={(v) => formatCurrency(v, true)}
                                    />
                                  )}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Print portal — rendered outside app shell, only visible when printing */}
          <PrintPortal
            slots={slots}
            activeSlots={activeSlots}
            intentDeltas={intentDeltas}
            effectiveBaselineId={effectiveBaselineId}
            baselineIdx={baselineIdx >= 0 ? baselineIdx : 0}
            exportDate={exportDate}
          />
        </>
      ) : null}
    </div>
  );
}
