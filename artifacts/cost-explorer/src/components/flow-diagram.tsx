/**
 * FlowDiagram — SVG process-flow visualization for HRO intent flow classes.
 *
 * Renders a left-to-right directed graph:
 *   Volume → [Adoption gate] → Steps → [Containment gate] → Outcomes
 *
 * Supports:
 *   - Full mode (Scenario Builder, Intent Detail): gates, branches, annotations
 *   - Mini mode (Flow Classes list): compact step strip only
 *
 * No new dependencies — uses only SVG + framer-motion (already installed).
 */

import { useState } from "react";
import { motion } from "framer-motion";
import type { FlowStep } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { DollarSign, Clock, Database } from "lucide-react";

// ─── Layout constants ──────────────────────────────────────────────────────────

const NW = 128; // step node width
const NH = 50;  // step node height
const GW = 54;  // gate diamond width
const GH = 48;  // gate diamond height
const OW = 126; // outcome node width
const OH = 42;  // outcome node height
const VW = 76;  // volume source pill width
const VH = 42;  // volume source pill height
const GAP = 26; // horizontal gap between elements
const ROW_Y = 96;    // center y for main path
const BRANCH_Y = 220; // center y for branches
const PAD_L = 20;
const PAD_T = 20;
const PAD_R = 20;
const PAD_B = 28;

// ─── Colors ───────────────────────────────────────────────────────────────────

const C = {
  blue:    { fill: "#eff6ff", stroke: "#3b82f6", text: "#1d4ed8", badge: "#3b82f6" },
  amber:   { fill: "#fffbeb", stroke: "#f59e0b", text: "#92400e", badge: "#f59e0b" },
  green:   { fill: "#f0fdf4", stroke: "#10b981", text: "#065f46", badge: "#10b981" },
  slate:   { fill: "#f8fafc", stroke: "#94a3b8", text: "#475569", badge: "#94a3b8" },
  purple:  { fill: "#faf5ff", stroke: "#8b5cf6", text: "#5b21b6", badge: "#8b5cf6" },
} as const;

type ColorKey = keyof typeof C;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FlowDiagramAnnotations {
  /** 0–1 fraction; undefined = use defaults */
  adoptionFraction?: number;
  containmentFraction?: number;
  hitlSamplingFraction?: number;
  annualTransactions?: number;
  /** true when any of the above come from global defaults, not client data */
  usingDefaults?: boolean;
}

export interface FlowDiagramProps {
  steps: FlowStep[];
  fcKey?: string;
  annotations?: FlowDiagramAnnotations;
  /** Compact strip for the Flow Classes list */
  mini?: boolean;
  /** Called when a step node is clicked (full mode) */
  onStepClick?: (stepId: string | null) => void;
  expandedStepId?: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtN(n: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
function pct(f: number) { return `${Math.round(f * 100)}%`; }

function stepColor(step: FlowStep): ColorKey {
  if (step.human) return "amber";
  const hasAi = step.agents.some(a => a.toLowerCase().includes("intent") || a.toLowerCase().includes("classifier") || a.toLowerCase().includes("llm") || a.toLowerCase().includes("reasoning") || a.toLowerCase().includes("supervisor"));
  return hasAi ? "purple" : "blue";
}

function stageShort(stage: string) {
  const map: Record<string, string> = {
    intake: "INTAKE", intent: "INTENT", orchestration: "ORCH",
    knowledge: "KNOW", communication: "COMM", act: "ACT", close: "CLOSE",
  };
  return map[stage] ?? stage.toUpperCase();
}

// ─── Arrowhead marker def ─────────────────────────────────────────────────────

function ArrowDef({ id, color }: { id: string; color: string }) {
  return (
    <marker id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M 0 0 L 8 4 L 0 8 z" fill={color} />
    </marker>
  );
}

// ─── Mini mode ────────────────────────────────────────────────────────────────

export function FlowDiagramMini({ steps }: { steps: FlowStep[] }) {
  const DOT = 10;
  const STEP_W = 96;
  const STEP_H = 56;
  const MGAP = 20;
  const MY = 36;
  const totalW = PAD_L + steps.length * (STEP_W + MGAP) - MGAP + PAD_R;
  const totalH = MY + STEP_H / 2 + PAD_B;

  return (
    <div className="overflow-x-auto">
      <svg
        width={totalW}
        height={totalH}
        viewBox={`0 0 ${totalW} ${totalH}`}
        role="img"
        aria-label="Flow step diagram"
      >
        {steps.map((step, idx) => {
          const cx = PAD_L + idx * (STEP_W + MGAP) + STEP_W / 2;
          const ck = stepColor(step);
          const col = C[ck];
          return (
            <g key={step.id}>
              {/* connector line */}
              {idx < steps.length - 1 && (
                <line
                  x1={cx + STEP_W / 2}
                  y1={MY}
                  x2={cx + STEP_W / 2 + MGAP}
                  y2={MY}
                  stroke={col.stroke}
                  strokeWidth={1.5}
                  strokeDasharray="4 2"
                  opacity={0.5}
                />
              )}
              {/* dot */}
              <circle cx={cx} cy={MY} r={DOT} fill={col.fill} stroke={col.stroke} strokeWidth={1.5} />
              {/* label */}
              <text
                x={cx}
                y={MY + DOT + 14}
                textAnchor="middle"
                fontSize={9}
                fill={col.text}
                fontFamily="Inter, sans-serif"
                fontWeight="500"
              >
                {step.label.length > 14 ? step.label.substring(0, 13) + "…" : step.label}
              </text>
              {step.human && (
                <text x={cx} y={MY - DOT - 4} textAnchor="middle" fontSize={8} fill={col.text} fontFamily="Inter, sans-serif">
                  HITL
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Full diagram ─────────────────────────────────────────────────────────────

export function FlowDiagram({ steps, annotations, mini, onStepClick, expandedStepId }: FlowDiagramProps) {
  if (mini) return <FlowDiagramMini steps={steps} />;

  const ann = annotations ?? {};
  const adoptFrac    = ann.adoptionFraction    ?? 0.40;
  const containFrac  = ann.containmentFraction ?? 0.85;
  const hitlFrac     = ann.hitlSamplingFraction ?? 0.10;
  const annualTxn    = ann.annualTransactions;
  const usingDef     = ann.usingDefaults ?? true;
  const hasHitl      = steps.some(s => s.human);

  // ── Compute x positions ───────────────────────────────────────────────────

  let x = PAD_L;

  // Volume source pill
  const volX = x; x += VW + GAP;

  // Adoption gate
  const adoptX = x; x += GW + GAP;

  // Steps
  const stepXs = steps.map(() => { const sx = x; x += NW + GAP; return sx; });

  // Containment gate
  const containX = x; x += GW + GAP;

  // Auto outcome (possibly after HITL gate)
  let hitlGateX: number | null = null;
  if (hasHitl) {
    hitlGateX = x; x += GW + GAP;
  }
  const autoOutcomeX = x;
  const totalW = x + OW + PAD_R;

  // ── Heights ───────────────────────────────────────────────────────────────
  const hasBranches = true; // always show adoption + containment branches
  const totalH = (hasBranches ? BRANCH_Y + OH / 2 + PAD_B : ROW_Y + NH / 2 + PAD_B);

  // ── Volume labels on edges ────────────────────────────────────────────────
  const adoptedVol  = annualTxn !== undefined ? Math.round(annualTxn * adoptFrac) : null;
  const manualVol   = annualTxn !== undefined ? Math.round(annualTxn * (1 - adoptFrac)) : null;
  const containedVol = adoptedVol !== null ? Math.round(adoptedVol * containFrac) : null;
  const fallbackVol  = adoptedVol !== null ? Math.round(adoptedVol * (1 - containFrac)) : null;
  const hitlVol      = containedVol !== null ? Math.round(containedVol * hitlFrac) : null;
  const autoVol      = containedVol !== null && hitlVol !== null ? containedVol - hitlVol : containedVol;

  // ── Gate centers ──────────────────────────────────────────────────────────
  const adoptCX = adoptX + GW / 2;
  const containCX = containX + GW / 2;
  const hitlCX = hitlGateX !== null ? hitlGateX + GW / 2 : null;

  // ── Edge helpers ──────────────────────────────────────────────────────────

  // Straight horizontal arrow from (x1,y) to (x2,y)
  function HArrow({ x1, x2, y, label, color = "#94a3b8", bold }: {
    x1: number; x2: number; y: number; label?: string; color?: string; bold?: boolean;
  }) {
    const mx = (x1 + x2) / 2;
    return (
      <g>
        <line x1={x1} y1={y} x2={x2 - 8} y2={y} stroke={color} strokeWidth={bold ? 2 : 1.5}
          markerEnd={`url(#arr-${color.replace("#", "")})`} />
        {label && (
          <text x={mx} y={y - 6} textAnchor="middle" fontSize={9} fill={color}
            fontFamily="Inter, sans-serif" fontWeight="500">{label}</text>
        )}
      </g>
    );
  }

  // Curved branch arrow from gate center (cx, ROW_Y) down to branch node (bx, BRANCH_Y)
  function BranchArrow({ fromX, toX, color = "#94a3b8", label }: {
    fromX: number; toX: number; color?: string; label?: string;
  }) {
    const x1 = fromX, y1 = ROW_Y + GH / 2;
    const x2 = toX, y2 = BRANCH_Y - OH / 2;
    const mid = (y1 + y2) / 2;
    return (
      <g>
        <path
          d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2 - 8}`}
          fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="4 3"
          markerEnd={`url(#arr-${color.replace("#", "")})`}
        />
        {label && (
          <text x={(x1 + x2) / 2 + 10} y={mid} textAnchor="start" fontSize={9}
            fill={color} fontFamily="Inter, sans-serif" fontWeight="500">{label}</text>
        )}
      </g>
    );
  }

  // ── Node renderers ────────────────────────────────────────────────────────

  function VolPill() {
    return (
      <g>
        <rect x={volX} y={ROW_Y - VH / 2} width={VW} height={VH} rx={VH / 2}
          fill="#f1f5f9" stroke="#cbd5e1" strokeWidth={1.5} />
        <text x={volX + VW / 2} y={ROW_Y - 5} textAnchor="middle" fontSize={9}
          fill="#64748b" fontFamily="Inter, sans-serif" fontWeight="600">VOLUME</text>
        {annualTxn && (
          <text x={volX + VW / 2} y={ROW_Y + 9} textAnchor="middle" fontSize={11}
            fill="#0f172a" fontFamily="Inter, sans-serif" fontWeight="700">{fmtN(annualTxn)}</text>
        )}
        {!annualTxn && (
          <text x={volX + VW / 2} y={ROW_Y + 5} textAnchor="middle" fontSize={10}
            fill="#475569" fontFamily="Inter, sans-serif">Txn/yr</text>
        )}
      </g>
    );
  }

  function GateDiamond({ cx, col, topLabel, bottomLabel }: {
    cx: number; col: ColorKey; topLabel: string; bottomLabel: string;
  }) {
    const c = C[col];
    const py = ROW_Y;
    const hw = GW / 2, hh = GH / 2;
    const pts = `${cx},${py - hh} ${cx + hw},${py} ${cx},${py + hh} ${cx - hw},${py}`;
    return (
      <g>
        <polygon points={pts} fill={c.fill} stroke={c.stroke} strokeWidth={1.5} />
        <text x={cx} y={py - hh - 6} textAnchor="middle" fontSize={9}
          fill={c.text} fontFamily="Inter, sans-serif" fontWeight="600">{topLabel}</text>
        <text x={cx} y={py + 4} textAnchor="middle" fontSize={8}
          fill={c.text} fontFamily="Inter, sans-serif">{bottomLabel}</text>
      </g>
    );
  }

  function StepNode({ step, sx, idx }: { step: FlowStep; sx: number; idx: number }) {
    const ck = stepColor(step);
    const col = C[ck];
    const isSelected = expandedStepId === step.id;
    const clickable = !!onStepClick;
    const truncLabel = step.label.length > 18 ? step.label.substring(0, 17) + "…" : step.label;

    return (
      <motion.g
        key={step.id}
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: idx * 0.06, duration: 0.3 }}
        style={{ cursor: clickable ? "pointer" : "default" }}
        onClick={() => clickable && onStepClick?.(isSelected ? null : step.id)}
        role={clickable ? "button" : undefined}
        aria-pressed={isSelected}
        tabIndex={clickable ? 0 : undefined}
        onKeyDown={(e) => { if (clickable && (e.key === "Enter" || e.key === " ")) onStepClick?.(isSelected ? null : step.id); }}
      >
        {/* selection glow */}
        {isSelected && (
          <rect x={sx - 3} y={ROW_Y - NH / 2 - 3} width={NW + 6} height={NH + 6}
            rx={9} fill="none" stroke={col.stroke} strokeWidth={2} opacity={0.5} />
        )}
        <rect x={sx} y={ROW_Y - NH / 2} width={NW} height={NH} rx={7}
          fill={isSelected ? col.fill : "#fff"} stroke={col.stroke} strokeWidth={1.5} />
        {/* top stage badge */}
        <rect x={sx + 6} y={ROW_Y - NH / 2 + 6} width={46} height={14} rx={3} fill={col.stroke} opacity={0.15} />
        <text x={sx + 29} y={ROW_Y - NH / 2 + 16} textAnchor="middle" fontSize={7.5}
          fill={col.text} fontFamily="Inter, sans-serif" fontWeight="700" letterSpacing="0.05em">
          {stageShort(step.stage)}
        </text>
        {/* step number */}
        <text x={sx + NW - 10} y={ROW_Y - NH / 2 + 15} textAnchor="middle" fontSize={8}
          fill={col.text} fontFamily="Inter, sans-serif" opacity={0.5}>{idx + 1}</text>
        {/* label */}
        <text x={sx + NW / 2} y={ROW_Y + 4} textAnchor="middle" fontSize={10}
          fill="#0f172a" fontFamily="Inter, sans-serif" fontWeight="600">{truncLabel}</text>
        {/* HITL indicator */}
        {step.human && (
          <g>
            <circle cx={sx + NW - 12} cy={ROW_Y + NH / 2 - 12} r={7} fill="#f59e0b" opacity={0.9} />
            <text x={sx + NW - 12} y={ROW_Y + NH / 2 - 9} textAnchor="middle" fontSize={7}
              fill="#fff" fontFamily="Inter, sans-serif" fontWeight="700">H</text>
          </g>
        )}
        {/* agents */}
        {step.agents.length > 0 && (
          <text x={sx + NW / 2} y={ROW_Y + NH / 2 - 8} textAnchor="middle" fontSize={8}
            fill={col.text} fontFamily="Inter, sans-serif" opacity={0.7}>
            {step.agents[0].length > 16 ? step.agents[0].substring(0, 15) + "…" : step.agents[0]}
          </text>
        )}
      </motion.g>
    );
  }

  function OutcomePill({ x, y, label, sublabel, col, dashed }: {
    x: number; y: number; label: string; sublabel?: string; col: ColorKey; dashed?: boolean;
  }) {
    const c = C[col];
    return (
      <g>
        <rect x={x} y={y - OH / 2} width={OW} height={OH} rx={OH / 2}
          fill={c.fill} stroke={c.stroke} strokeWidth={1.5}
          strokeDasharray={dashed ? "4 3" : undefined} />
        <text x={x + OW / 2} y={y - 4} textAnchor="middle" fontSize={10}
          fill={c.text} fontFamily="Inter, sans-serif" fontWeight="700">{label}</text>
        {sublabel && (
          <text x={x + OW / 2} y={y + 10} textAnchor="middle" fontSize={9}
            fill={c.text} fontFamily="Inter, sans-serif" opacity={0.8}>{sublabel}</text>
        )}
      </g>
    );
  }

  // ── Build unique arrow marker colors ────────────────────────────────────

  const arrowColors = ["#3b82f6", "#94a3b8", "#10b981", "#f59e0b", "#8b5cf6", "#64748b"];

  // ── Annotation text helpers ───────────────────────────────────────────────

  const adoptLabel = annualTxn
    ? `${pct(adoptFrac)} · ${fmtN(adoptedVol!)} txn`
    : pct(adoptFrac);
  const notAdoptLabel = annualTxn
    ? `${pct(1 - adoptFrac)} · ${fmtN(manualVol!)} txn`
    : pct(1 - adoptFrac);
  const containLabel = annualTxn
    ? `${pct(containFrac)} · ${fmtN(containedVol!)} txn`
    : pct(containFrac);
  const fallbackLabel = annualTxn
    ? `${pct(1 - containFrac)} · ${fmtN(fallbackVol!)} txn`
    : pct(1 - containFrac);
  const hitlLabel = hasHitl && annualTxn && hitlVol !== null
    ? `HITL ${pct(hitlFrac)} · ${fmtN(hitlVol)} txn`
    : hasHitl ? `HITL ${pct(hitlFrac)}` : undefined;
  const autoLabel = annualTxn && autoVol !== null ? `${fmtN(autoVol)} txn` : undefined;

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-background/50">
      {usingDef && (
        <div className="px-4 pt-3 pb-0 flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground border-muted-foreground/30 bg-muted/40">
            global defaults — enter client data in Automation Fidelity to update
          </Badge>
        </div>
      )}
      <svg
        width={totalW}
        height={totalH}
        viewBox={`0 0 ${totalW} ${totalH}`}
        aria-label="Transaction flow diagram"
        role="img"
        style={{ minWidth: totalW, display: "block" }}
      >
        {/* ── Arrow markers ── */}
        <defs>
          {arrowColors.map(c => <ArrowDef key={c} id={`arr-${c.replace("#", "")}`} color={c} />)}
        </defs>

        {/* ── Volume pill ── */}
        <VolPill />

        {/* Vol → Adopt gate */}
        <HArrow x1={volX + VW} x2={adoptCX - GW / 2} y={ROW_Y} color="#64748b" />

        {/* ── Adoption gate ── */}
        <GateDiamond cx={adoptCX} col="slate" topLabel="ADOPTION" bottomLabel={pct(adoptFrac)} />

        {/* Adopt → Step 1 */}
        <HArrow x1={adoptCX + GW / 2} x2={stepXs[0]} y={ROW_Y}
          label={adoptLabel} color="#3b82f6" bold />

        {/* Branch: not adopted */}
        <BranchArrow fromX={adoptCX} toX={adoptCX} label={notAdoptLabel} color="#94a3b8" />
        <OutcomePill x={adoptCX - OW / 2} y={BRANCH_Y} label="Manual" sublabel="no benefit" col="slate" dashed />

        {/* ── Steps ── */}
        {steps.map((step, idx) => {
          const sx = stepXs[idx];
          const ck = stepColor(step);
          const col = C[ck];
          const arrowColor = ck === "amber" ? "#f59e0b" : ck === "purple" ? "#8b5cf6" : "#3b82f6";
          return (
            <g key={step.id}>
              <StepNode step={step} sx={sx} idx={idx} />
              {idx < steps.length - 1 && (
                <HArrow x1={sx + NW} x2={stepXs[idx + 1]} y={ROW_Y} color={arrowColor} />
              )}
            </g>
          );
        })}

        {/* Last step → Contain gate */}
        <HArrow
          x1={stepXs[stepXs.length - 1] + NW}
          x2={containCX - GW / 2}
          y={ROW_Y}
          color="#3b82f6"
        />

        {/* ── Containment gate ── */}
        <GateDiamond cx={containCX} col="blue" topLabel="CONTAINMENT" bottomLabel={pct(containFrac)} />

        {/* Branch: fallback */}
        <BranchArrow fromX={containCX} toX={containCX} label={fallbackLabel} color="#94a3b8" />
        <OutcomePill x={containCX - OW / 2} y={BRANCH_Y} label="Fallback" sublabel="human cost" col="slate" dashed />

        {/* Contain → (HITL gate or) Auto outcome */}
        {hitlCX !== null && (
          <>
            <HArrow x1={containCX + GW / 2} x2={hitlCX - GW / 2} y={ROW_Y}
              label={containLabel} color="#10b981" bold />
            <GateDiamond cx={hitlCX} col="amber" topLabel="HITL SAMPLE" bottomLabel={pct(hitlFrac)} />
            {/* HITL → review branch (down) */}
            <BranchArrow fromX={hitlCX} toX={hitlCX} label={hitlLabel} color="#f59e0b" />
            <OutcomePill x={hitlCX - OW / 2} y={BRANCH_Y} label="HITL Review" sublabel="human + AI" col="amber" />
            {/* HITL pass → auto outcome */}
            <HArrow x1={hitlCX + GW / 2} x2={autoOutcomeX} y={ROW_Y}
              label={autoLabel} color="#10b981" bold />
          </>
        )}
        {hitlCX === null && (
          <HArrow x1={containCX + GW / 2} x2={autoOutcomeX} y={ROW_Y}
            label={containLabel} color="#10b981" bold />
        )}

        {/* ── Auto outcome ── */}
        <OutcomePill x={autoOutcomeX} y={ROW_Y} label="✓ Automated" sublabel={autoLabel ?? "benefit realised"} col="green" />
      </svg>
    </div>
  );
}

// ─── Inline step detail panel (for Intent Detail) ─────────────────────────────

export function FlowStepDetail({ step }: { step: FlowStep }) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.25 }}
      className="overflow-hidden"
    >
      <div className={`mt-3 rounded-xl border p-5 grid grid-cols-1 lg:grid-cols-3 gap-6 ${
        step.human ? "border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/5"
                   : "border-border bg-muted/30"
      }`}>
        {/* Systems */}
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5" /> Systems Touched
          </h4>
          {step.systems.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No external systems</p>
          ) : (
            <div className="space-y-2">
              {step.systems.map((sys, i) => (
                <div key={i} className="bg-background p-2 rounded-md text-sm border border-border/50">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{sys.systemKey}</span>
                    <div className="flex gap-1">
                      {sys.actions.map(act => (
                        <Badge key={act} variant="secondary" className={`text-[10px] uppercase px-1.5 py-0 ${
                          act === "get" ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                                       : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                        }`}>{act}</Badge>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Costs */}
        <div className="space-y-3 border-t lg:border-t-0 lg:border-l border-border pt-4 lg:pt-0 lg:pl-6">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <DollarSign className="w-3.5 h-3.5" /> Per-Step Cost
          </h4>
          {step.costs.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Negligible cost</p>
          ) : (
            <div className="space-y-3">
              {step.costs.map((cost, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium">{cost.label}</span>
                    <span className="font-mono text-sm">${cost.unitCostUsd.toFixed(4)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground bg-muted/50 p-2 rounded border border-border/40">{cost.assumption}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Benefits */}
        <div className="space-y-3 border-t lg:border-t-0 lg:border-l border-border pt-4 lg:pt-0 lg:pl-6">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" /> Value Delivered
          </h4>
          {step.benefits.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Enabling step</p>
          ) : (
            <div className="space-y-3">
              {step.benefits.map((ben, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium">{ben.label}</span>
                    {ben.dollarized && ben.unitBenefitUsd > 0 && (
                      <span className="font-mono text-sm text-emerald-600">${ben.unitBenefitUsd.toFixed(4)}</span>
                    )}
                  </div>
                  {ben.qualitative && (
                    <p className="text-xs text-primary italic">{ben.qualitative}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ─── Amortization curve sparkline (for Flow Classes) ─────────────────────────

export function AmortCurve({
  buildCostUsd,
  amortizationTransactions,
}: {
  buildCostUsd: number;
  amortizationTransactions: number;
}) {
  // Cost per transaction at various cumulative volumes (0 to 2x amortization baseline)
  const points = 40;
  const maxVol = amortizationTransactions * 2;
  const data = Array.from({ length: points }, (_, i) => {
    const vol = (maxVol / (points - 1)) * i + 1;
    return buildCostUsd / vol;
  });

  const maxVal = data[0];
  const minVal = data[data.length - 1];
  const W = 180, H = 52;
  const padX = 4, padY = 6;

  const svgPoints = data.map((val, i) => {
    const x = padX + (i / (points - 1)) * (W - 2 * padX);
    const y = H - padY - ((val - minVal) / (maxVal - minVal)) * (H - 2 * padY);
    return `${x},${y}`;
  }).join(" ");

  // breakeven x (at amortizationTransactions)
  const beX = padX + (0.5) * (W - 2 * padX);

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-label="Amortization cost curve">
      <defs>
        <linearGradient id="amorGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#10b981" stopOpacity="0.15" />
        </linearGradient>
      </defs>
      {/* fill area */}
      <polyline
        points={[
          `${padX},${H - padY}`,
          ...data.map((val, i) => {
            const x = padX + (i / (points - 1)) * (W - 2 * padX);
            const y = H - padY - ((val - minVal) / (maxVal - minVal)) * (H - 2 * padY);
            return `${x},${y}`;
          }),
          `${W - padX},${H - padY}`,
        ].join(" ")}
        fill="url(#amorGrad)"
        stroke="none"
      />
      {/* curve */}
      <polyline points={svgPoints} fill="none" stroke="#3b82f6" strokeWidth={1.5} strokeLinejoin="round" />
      {/* breakeven line */}
      <line x1={beX} y1={padY} x2={beX} y2={H - padY} stroke="#10b981" strokeWidth={1} strokeDasharray="3 2" opacity={0.7} />
      {/* labels */}
      <text x={padX} y={padY + 8} fontSize={8} fill="#3b82f6" fontFamily="Inter, sans-serif">high</text>
      <text x={beX + 2} y={padY + 8} fontSize={8} fill="#10b981" fontFamily="Inter, sans-serif">breakeven</text>
      <text x={padX} y={H - padY + 1} fontSize={8} fill="#94a3b8" fontFamily="Inter, sans-serif">$/txn</text>
    </svg>
  );
}
