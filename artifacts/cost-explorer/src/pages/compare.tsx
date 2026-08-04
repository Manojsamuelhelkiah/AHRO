import { useState, useEffect } from "react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeftRight,
  Calculator,
  TrendingUp,
  TrendingDown,
  Minus,
  GitCompareArrows,
} from "lucide-react";
import { formatCurrency, formatNumber } from "@/lib/format";

// ─── Delta helpers ────────────────────────────────────────────────────────────

type Favorability = "higher-is-better" | "lower-is-better";

interface DeltaInfo {
  delta: number;
  pct: number; // relative to B
  favorable: boolean | null; // null = neutral (zero)
  significant: boolean; // |pct| > 10%
}

function calcDelta(a: number, b: number, fav: Favorability): DeltaInfo {
  const delta = a - b;
  const pct = b !== 0 ? delta / Math.abs(b) : 0;
  const significant = Math.abs(pct) >= 0.1;
  let favorable: boolean | null = null;
  if (Math.abs(delta) > 0.005) {
    favorable = fav === "higher-is-better" ? delta > 0 : delta < 0;
  }
  return { delta, pct, favorable, significant };
}

interface DeltaCellProps {
  delta: number;
  pct: number;
  favorable: boolean | null;
  significant: boolean;
  format: (v: number) => string;
}

function DeltaCell({ delta, pct, favorable, significant, format }: DeltaCellProps) {
  if (favorable === null) {
    return <span className="text-muted-foreground font-mono text-xs">—</span>;
  }

  const colorClass = favorable
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-destructive";
  const bgClass = significant
    ? favorable
      ? "bg-emerald-500/10 rounded px-1"
      : "bg-destructive/10 rounded px-1"
    : "";
  const icon = delta > 0 ? "↑" : "↓";

  return (
    <span className={`font-mono text-xs font-semibold ${colorClass} ${bgClass}`}>
      {delta > 0 ? "+" : ""}
      {format(delta)} {icon}
    </span>
  );
}

// ─── Headline metric row ──────────────────────────────────────────────────────

interface MetricRowProps {
  label: string;
  valA: number;
  valB: number;
  fav: Favorability;
  format: (v: number) => string;
}

function MetricRow({ label, valA, valB, fav, format }: MetricRowProps) {
  const d = calcDelta(valA, valB, fav);
  return (
    <tr className="border-b border-border hover:bg-muted/20 transition-colors">
      <td className="px-4 py-2.5 text-sm text-muted-foreground">{label}</td>
      <td className="px-4 py-2.5 text-sm font-mono font-semibold text-right">{format(valA)}</td>
      <td className="px-4 py-2.5 text-sm font-mono font-semibold text-right">{format(valB)}</td>
      <td className="px-4 py-2.5 text-right">
        <DeltaCell {...d} format={format} />
      </td>
    </tr>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function Compare() {
  const [location, navigate] = useLocation();

  // Read ?a= and ?b= from the URL
  const searchParams = new URLSearchParams(window.location.search);
  const [idA, setIdA] = useState<number | null>(() => {
    const v = searchParams.get("a");
    return v ? parseInt(v, 10) : null;
  });
  const [idB, setIdB] = useState<number | null>(() => {
    const v = searchParams.get("b");
    return v ? parseInt(v, 10) : null;
  });

  // Keep URL in sync with selections
  useEffect(() => {
    const p = new URLSearchParams();
    if (idA) p.set("a", String(idA));
    if (idB) p.set("b", String(idB));
    const qs = p.toString();
    const newPath = qs ? `/compare?${qs}` : "/compare";
    // Only push if different from current
    const cur = window.location.search;
    const curA = new URLSearchParams(cur).get("a");
    const curB = new URLSearchParams(cur).get("b");
    if (String(idA ?? "") !== String(curA ?? "") || String(idB ?? "") !== String(curB ?? "")) {
      navigate(newPath, { replace: true });
    }
  }, [idA, idB]);

  const { data: scenarios, isLoading: isLoadingScenarios } = useListScenarios();

  const { data: scenarioA } = useGetScenario(idA as number, {
    query: { enabled: !!idA, queryKey: getGetScenarioQueryKey(idA as number) },
  });
  const { data: scenarioB } = useGetScenario(idB as number, {
    query: { enabled: !!idB, queryKey: getGetScenarioQueryKey(idB as number) },
  });

  const computeA = useComputeRollup();
  const computeB = useComputeRollup();

  const [rollupA, setRollupA] = useState<Rollup | null>(null);
  const [rollupB, setRollupB] = useState<Rollup | null>(null);

  // Compute rollup when scenario inputs are loaded
  useEffect(() => {
    if (!scenarioA) return;
    setRollupA(null);
    computeA.mutateAsync({ data: { inputs: scenarioA.inputs } }).then(setRollupA);
  }, [scenarioA?.id, JSON.stringify(scenarioA?.inputs)]);

  useEffect(() => {
    if (!scenarioB) return;
    setRollupB(null);
    computeB.mutateAsync({ data: { inputs: scenarioB.inputs } }).then(setRollupB);
  }, [scenarioB?.id, JSON.stringify(scenarioB?.inputs)]);

  const handleSwap = () => {
    const tmp = idA;
    setIdA(idB);
    setIdB(tmp);
    setRollupA(rollupB);
    setRollupB(rollupA);
  };

  // ── Scenario list states ────────────────────────────────────────────────────
  const scenarioCount = scenarios?.length ?? 0;
  const hasEnough = scenarioCount >= 2;

  if (isLoadingScenarios) {
    return (
      <div className="flex flex-col gap-6 animate-in fade-in duration-300 pb-20">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!hasEnough) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 animate-in fade-in duration-300">
        <GitCompareArrows className="w-16 h-16 opacity-20" />
        <h2 className="text-xl font-semibold text-foreground">Not enough saved scenarios</h2>
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

  const isLoading = (idA && !rollupA) || (idB && !rollupB);
  const readyToCompare = !!rollupA && !!rollupB;

  const nameA = scenarioA?.name ?? "Scenario A";
  const nameB = scenarioB?.name ?? "Scenario B";

  // ── Per-intent rows joined by intentKey ────────────────────────────────────
  interface IntentDelta {
    intentKey: string;
    intentName: string;
    domain: string;
    netA: number;
    netB: number;
    shareA: number;
    shareB: number;
    deltaNet: number;
    absDeltaNet: number;
  }

  const intentDeltas: IntentDelta[] = (() => {
    if (!rollupA || !rollupB) return [];
    const mapB = new Map(rollupB.rows.map((r) => [r.intentKey, r]));
    return rollupA.rows
      .map((rA) => {
        const rB = mapB.get(rA.intentKey);
        const netB = rB?.netUsd ?? 0;
        const shareB = rB?.share ?? 0;
        const deltaNet = rA.netUsd - netB;
        return {
          intentKey: rA.intentKey,
          intentName: rA.intentName,
          domain: rA.domain,
          netA: rA.netUsd,
          netB,
          shareA: rA.share,
          shareB,
          deltaNet,
          absDeltaNet: Math.abs(deltaNet),
        };
      })
      .sort((a, b) => b.absDeltaNet - a.absDeltaNet);
  })();

  return (
    <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20">
      {/* Page header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Scenario Comparison</h1>
        <p className="text-muted-foreground mt-1">
          Select two saved scenarios to see totals, ROI, FTE, and per-intent breakdown side by side.
        </p>
      </div>

      {/* Scenario selector bar */}
      <Card className="shadow-sm border-border">
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row items-center gap-3">
            {/* Scenario A */}
            <div className="flex-1 w-full">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                Scenario A (baseline)
              </div>
              <Select
                value={idA ? String(idA) : ""}
                onValueChange={(v) => setIdA(parseInt(v, 10))}
              >
                <SelectTrigger className="bg-background w-full">
                  <SelectValue placeholder="Choose a scenario…" />
                </SelectTrigger>
                <SelectContent>
                  {scenarios?.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)} disabled={s.id === idB}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Swap button */}
            <div className="flex-shrink-0 pt-5 sm:pt-0 self-end sm:self-auto">
              <Button
                variant="outline"
                size="icon"
                onClick={handleSwap}
                disabled={!idA || !idB}
                title="Swap A and B"
                className="mt-auto sm:mt-5"
              >
                <ArrowLeftRight className="w-4 h-4" />
              </Button>
            </div>

            {/* Scenario B */}
            <div className="flex-1 w-full">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                Scenario B (comparison)
              </div>
              <Select
                value={idB ? String(idB) : ""}
                onValueChange={(v) => setIdB(parseInt(v, 10))}
                disabled={scenarioCount < 2}
              >
                <SelectTrigger className="bg-background w-full">
                  <SelectValue placeholder="Choose a scenario…" />
                </SelectTrigger>
                <SelectContent>
                  {scenarios?.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)} disabled={s.id === idA}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Empty / loading state */}
      {!idA || !idB ? (
        <div className="flex flex-col items-center justify-center min-h-[40vh] gap-3 text-muted-foreground">
          <GitCompareArrows className="w-12 h-12 opacity-20" />
          <p>Select two scenarios above to see the comparison.</p>
        </div>
      ) : isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : readyToCompare ? (
        <>
          {/* ── Headline metrics ──────────────────────────────────────────── */}
          <Card className="shadow-sm border-border overflow-hidden">
            <CardHeader className="px-4 py-3 border-b border-border bg-muted/30">
              <CardTitle className="text-sm font-semibold">Headline Metrics</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-muted-foreground text-xs uppercase font-semibold">
                    <tr>
                      <th className="px-4 py-2.5 text-left font-semibold">Metric</th>
                      <th className="px-4 py-2.5 text-right font-semibold">{nameA}</th>
                      <th className="px-4 py-2.5 text-right font-semibold">{nameB}</th>
                      <th className="px-4 py-2.5 text-right font-semibold">
                        Δ (A vs B)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <MetricRow
                      label="Net Value"
                      valA={rollupA.totals.netUsd}
                      valB={rollupB.totals.netUsd}
                      fav="higher-is-better"
                      format={(v) => formatCurrency(v, true)}
                    />
                    <MetricRow
                      label="ROI"
                      valA={rollupA.totals.roi}
                      valB={rollupB.totals.roi}
                      fav="higher-is-better"
                      format={(v) => `${v.toFixed(2)}×`}
                    />
                    <MetricRow
                      label="FTE Equivalent Saved"
                      valA={rollupA.totals.fteEquivalent}
                      valB={rollupB.totals.fteEquivalent}
                      fav="higher-is-better"
                      format={(v) => v.toFixed(1)}
                    />
                    <MetricRow
                      label="Gross Benefit"
                      valA={rollupA.totals.benefitUsd}
                      valB={rollupB.totals.benefitUsd}
                      fav="higher-is-better"
                      format={(v) => formatCurrency(v, true)}
                    />
                    <MetricRow
                      label="Total Cost"
                      valA={rollupA.totals.totalCostUsd}
                      valB={rollupB.totals.totalCostUsd}
                      fav="lower-is-better"
                      format={(v) => formatCurrency(v, true)}
                    />
                    <MetricRow
                      label="Run Cost"
                      valA={rollupA.totals.runCostUsd}
                      valB={rollupB.totals.runCostUsd}
                      fav="lower-is-better"
                      format={(v) => formatCurrency(v, true)}
                    />
                    <MetricRow
                      label="Build Cost (amortized)"
                      valA={rollupA.totals.buildCostUsd}
                      valB={rollupB.totals.buildCostUsd}
                      fav="lower-is-better"
                      format={(v) => formatCurrency(v, true)}
                    />
                    <MetricRow
                      label="Cost per Transaction"
                      valA={rollupA.totals.costPerTransactionUsd}
                      valB={rollupB.totals.costPerTransactionUsd}
                      fav="lower-is-better"
                      format={(v) => `$${v.toFixed(4)}`}
                    />
                    <MetricRow
                      label="Benefit per Transaction"
                      valA={rollupA.totals.benefitPerTransactionUsd}
                      valB={rollupB.totals.benefitPerTransactionUsd}
                      fav="higher-is-better"
                      format={(v) => `$${v.toFixed(4)}`}
                    />
                    <MetricRow
                      label="Human Hours Saved"
                      valA={rollupA.totals.humanHoursSaved}
                      valB={rollupB.totals.humanHoursSaved}
                      fav="higher-is-better"
                      format={(v) => formatNumber(v)}
                    />
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* ── Per-intent breakdown ──────────────────────────────────────── */}
          <Card className="shadow-sm border-border overflow-hidden">
            <CardHeader className="px-4 py-3 border-b border-border bg-muted/30">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold">Per-Intent Breakdown</CardTitle>
                <span className="text-xs text-muted-foreground">Sorted by |ΔNet| descending</span>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-muted/50 text-muted-foreground text-xs uppercase font-semibold">
                    <tr>
                      <th className="px-4 py-3">Intent</th>
                      <th className="px-4 py-3">Domain</th>
                      <th className="px-4 py-3 text-right">{nameA} Net</th>
                      <th className="px-4 py-3 text-right">{nameB} Net</th>
                      <th className="px-4 py-3 text-right">Δ Net</th>
                      <th className="px-4 py-3 text-right">{nameA} Share</th>
                      <th className="px-4 py-3 text-right">{nameB} Share</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {intentDeltas.map((row) => {
                      const d = calcDelta(row.netA, row.netB, "higher-is-better");
                      return (
                        <tr key={row.intentKey} className="hover:bg-muted/30 transition-colors">
                          <td className="px-4 py-2.5 font-medium text-foreground whitespace-nowrap">
                            {row.intentName}
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge variant="outline" className="capitalize text-[10px] bg-background">
                              {row.domain}
                            </Badge>
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs">
                            <span className={row.netA >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>
                              {row.netA >= 0 ? "+" : ""}{formatCurrency(row.netA, true)}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs">
                            <span className={row.netB >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>
                              {row.netB >= 0 ? "+" : ""}{formatCurrency(row.netB, true)}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <DeltaCell {...d} format={(v) => formatCurrency(v, true)} />
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs text-muted-foreground">
                            {(row.shareA * 100).toFixed(1)}%
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs text-muted-foreground">
                            {(row.shareB * 100).toFixed(1)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
