// Core/custom demarcation strip + Build Cost Breakdown table.
//
// Extracted from scenario.tsx so a UI-level test can render BOTH surfaces from
// the same fixture rollup and assert the quotable strip numbers can't drift
// from the breakdown table footer (same fields, same formatter).
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/format";

/** Structural subset of the API `Rollup` used by these components. */
export interface DemarcationSplitData {
  coreAnnualUsd: number;
  coreOneTimeUsd: number;
  customOneTimeUsd: number;
  customAnnualUsd: number;
  contractYears: number;
  configurableDials: { label: string }[];
}

export interface BuildComponentRow {
  key: string;
  name: string;
  description: string;
  kind: string;
  provisioning: string;
  oneTimeUsd: number;
  annualUsd: number;
}

export interface BuildCostRollupSlice {
  demarcationSplit: DemarcationSplitData;
  buildBreakdown: BuildComponentRow[];
  totals: { buildCostUsd: number };
}

const fmt = (v: number) => formatCurrency(v, true);

export function DemarcationSplitStrip({ split }: { split: DemarcationSplitData }) {
  return (
    <div className="mt-4 bg-background/10 rounded-lg p-4 border border-sidebar-border" data-testid="demarcation-split">
      <div className="text-xs uppercase tracking-wider text-sidebar-foreground/60 mb-3">Core vs Custom Split</div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div data-testid="demarcation-core">
          <div className="flex items-center gap-2">
            <Badge className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] uppercase">core</Badge>
            <span className="text-lg font-bold text-sidebar-foreground">
              <span data-testid="demarcation-core-annual">{fmt(split.coreAnnualUsd)}</span><span className="text-xs font-normal text-sidebar-foreground/60">/yr</span>
            </span>
          </div>
          <p className="text-[11px] text-sidebar-foreground/60 mt-1">
            Core platform, amortized ({fmt(split.coreOneTimeUsd)} one-time product build shared across clients)
          </p>
        </div>
        <div data-testid="demarcation-custom">
          <div className="flex items-center gap-2">
            <Badge className="bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] uppercase">custom</Badge>
            <span className="text-lg font-bold text-sidebar-foreground">
              {fmt(split.customOneTimeUsd)}<span className="text-xs font-normal text-sidebar-foreground/60"> one-time</span>
            </span>
          </div>
          <p className="text-[11px] text-sidebar-foreground/60 mt-1">
            Client implementation (<span data-testid="demarcation-custom-annual">{fmt(split.customAnnualUsd)}</span>/yr over {split.contractYears}-yr contract)
          </p>
        </div>
        <div data-testid="demarcation-configurable">
          <div className="flex items-center gap-2">
            <Badge className="bg-sky-500/20 text-sky-300 border border-sky-500/30 text-[10px] uppercase">configurable</Badge>
            <span className="text-lg font-bold text-sidebar-foreground">{split.configurableDials.length}<span className="text-xs font-normal text-sidebar-foreground/60"> dials</span></span>
          </div>
          <p className="text-[11px] text-sidebar-foreground/60 mt-1 line-clamp-2" title={split.configurableDials.map(d => d.label).join(", ")}>
            {split.configurableDials.map(d => d.label).slice(0, 4).join(", ")}
            {split.configurableDials.length > 4 ? ` +${split.configurableDials.length - 4} more` : ""}
          </p>
        </div>
      </div>
    </div>
  );
}

export function BuildBreakdownTable({ rollup }: { rollup: BuildCostRollupSlice }) {
  return (
    <div className="rounded-md border border-border overflow-hidden">
      <table className="w-full text-sm text-left">
        <thead className="bg-muted/50 text-muted-foreground text-xs uppercase font-semibold">
          <tr>
            <th className="px-4 py-3">Component</th>
            <th className="px-4 py-3">Type</th>
            <th className="px-4 py-3">Demarcation</th>
            <th className="px-4 py-3 text-right">One-Time Build</th>
            <th className="px-4 py-3 text-right">Annual (this scenario)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {[...rollup.buildBreakdown].sort((a, b) => b.annualUsd - a.annualUsd).map(c => (
            <tr key={c.key} className="hover:bg-muted/30 transition-colors">
              <td className="px-4 py-3">
                <div className="font-medium text-foreground">{c.name}</div>
                <div className="text-xs text-muted-foreground mt-0.5 max-w-xl">{c.description}</div>
              </td>
              <td className="px-4 py-3">
                <Badge variant="outline" className={`text-[10px] capitalize ${c.kind === "platform" ? "bg-primary/5 text-primary border-primary/30" : "bg-background"}`}>
                  {c.kind}
                </Badge>
              </td>
              <td className="px-4 py-3">
                <Badge variant="outline" className={`text-[10px] uppercase tracking-wide ${c.provisioning === "core" ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/30" : c.provisioning === "custom" ? "bg-amber-500/10 text-amber-600 border-amber-500/30" : "bg-sky-500/10 text-sky-600 border-sky-500/30"}`} data-testid={`badge-provisioning-${c.key}`}>
                  {c.provisioning}
                </Badge>
              </td>
              <td className="px-4 py-3 text-right font-mono text-xs">{fmt(c.oneTimeUsd)}</td>
              <td className="px-4 py-3 text-right font-mono text-xs font-semibold">{fmt(c.annualUsd)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-muted/50">
          <tr>
            <td className="px-4 py-3 font-semibold text-xs uppercase text-muted-foreground" colSpan={3}>Total build cost in this scenario</td>
            <td className="px-4 py-3 text-right font-mono text-xs" data-testid="breakdown-onetime-total">{fmt(rollup.buildBreakdown.reduce((a, c) => a + c.oneTimeUsd, 0))}</td>
            <td className="px-4 py-3 text-right font-mono text-xs font-bold" data-testid="breakdown-annual-total">{fmt(rollup.totals.buildCostUsd)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
