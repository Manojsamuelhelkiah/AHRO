/**
 * Excel "shadow model" workbook: a self-contained spreadsheet with live
 * formulas that approximate the pricing engine, plus structured input sheets
 * that can be re-imported. On import ONLY the inputs are read — pricing is
 * always recomputed by the real engine, so the workbook can never become an
 * alternative source of truth.
 */
import ExcelJS from "exceljs";
import {
  computeRollup,
  computeShares,
  maturityAssumptionFor,
  OVERRIDABLE_ASSUMPTION_KEYS,
  type CommercialAssumptions,
  type ScenarioInputs,
} from "./rollup";
import { assumptions, assumptionMap } from "../data/assumptions";
import { flowClasses } from "../data/flow-classes";
import { intents } from "../data/intents";
import { systems } from "../data/systems";
import { modelCatalog, MODEL_ROLES } from "../data/model-catalog";
import type { Intent } from "../data/types";
import { InputValidationError } from "./validate-inputs";

const WORKBOOK_MARKER = "HRO-COST-SHADOW-V1";

const INPUT_ROWS: Array<{
  key: keyof ScenarioInputs & string;
  label: string;
  note: string;
  optional?: boolean;
  enumValues?: string[];
}> = [
  { key: "annualTransactions", label: "Annual HR transactions", note: "Total yearly transaction volume in scope." },
  { key: "employees", label: "Employees served", note: "Headcount served by the HRO scope." },
  { key: "numSystems", label: "HR systems in landscape", note: "Systems of record the agents must touch." },
  { key: "countries", label: "Countries", note: "Countries in scope (drives localization & onboarding)." },
  { key: "sector", label: "Sector", note: "Client industry (free text)." },
  { key: "companyType", label: "Geographic span", note: "single-country | multi-country | global", enumValues: ["single-country", "multi-country", "global"] },
  { key: "isolationTier", label: "Compute isolation tier", note: "pooled | siloed | dedicated", enumValues: ["pooled", "siloed", "dedicated"] },
  { key: "hrHourlyCostUsd", label: "As-is HR cost ($/hr)", note: "Blended hourly cost of today's HR handling." },
  { key: "hitlHourlyCostUsd", label: "To-be HITL cost ($/hr)", note: "Hourly cost of human reviewers in the to-be model." },
  { key: "adoptionRate", label: "Adoption rate (0-1, scalar)", note: "OPTIONAL scalar fallback. Ignored when the Y1-Y3 ramp below is filled. Blank = engine default ramp.", optional: true },
  { key: "hitlSamplingRate", label: "HITL sampling rate (0-1)", note: "OPTIONAL scalar fallback. Blank = per-flow-class defaults.", optional: true },
  { key: "landscapeMaturity", label: "Landscape maturity", note: "OPTIONAL. clean | mixed | legacy. Blank = mixed.", optional: true, enumValues: ["clean", "mixed", "legacy"] },
  { key: "contractYears", label: "Contract length (years)", note: "OPTIONAL. Blank = 3-year default.", optional: true },
  { key: "reworkRatePct", label: "As-is rework rate (%)", note: "OPTIONAL. Share of transactions needing rework today.", optional: true },
  { key: "peakLoadFactor", label: "Peak load factor", note: "OPTIONAL. 1.0-1.5 seasonal peak provisioning.", optional: true },
];

/** Adoption ramp is a 3-element array in ScenarioInputs; serialized as three keyed rows. */
const RAMP_KEYS = ["adoptionRampY1", "adoptionRampY2", "adoptionRampY3"] as const;
const COMMERCIAL_INPUT_ROWS: Array<{
  key: keyof CommercialAssumptions & string;
  label: string;
  note: string;
}> = [
  {
    key: "targetGrossMargin",
    label: "Commercial target margin (0-0.95)",
    note: "OPTIONAL. Supplier pricing margin applied to implementation and recurring price.",
  },
  {
    key: "targetClients",
    label: "Target paying clients",
    note: "OPTIONAL. Clients sharing reusable product investment and support capacity.",
  },
  {
    key: "productRecoveryMonths",
    label: "Product recovery period (months)",
    note: "OPTIONAL. Planned period for recovering reusable product investment.",
  },
  {
    key: "supportTeamFte",
    label: "Shared support team (FTE)",
    note: "OPTIONAL. Shared supplier support and maintenance capacity.",
  },
  {
    key: "supportHourlyCostUsd",
    label: "Support hourly cost (USD)",
    note: "OPTIONAL. Loaded hourly cost of supplier support capacity.",
  },
  {
    key: "supportToolingAnnualUsdPerClient",
    label: "Support tooling/client/year (USD)",
    note: "OPTIONAL. Monitoring and service-management tooling per client.",
  },
];

interface FcAgg {
  key: string;
  label: string;
  share: number;
  aiPerTxn: number;
  infraPerTxn: number;
  otherPerTxn: number;
  buildPerTxn: number;
  asIsMin: number;
  toBeMin: number;
  otherBenefitPerContained: number;
  defaultContainment: number;
  defaultSampling: number;
  localized: boolean;
  providedContainment?: number;
  providedSampling?: number;
}

const DEFAULT_CONTAINMENT: Record<string, number> = {
  "fc1-deterministic": 0.95,
  "fc2-policy": 0.88,
  "fc3-multiagent": 0.8,
  "fc4-frontier": 0.7,
};
const DEFAULT_SAMPLING: Record<string, number> = {
  "fc1-deterministic": 0.05,
  "fc2-policy": 0.15,
  "fc3-multiagent": 0.3,
  "fc4-frontier": 0.6,
};
const LOCALIZED = new Set(["fc2-policy", "fc4-frontier"]);

function effVal(key: string, inputs: ScenarioInputs): number {
  return inputs.assumptionOverrides?.[key] ?? assumptionMap[key]!.value;
}

/** Aggregates the engine's per-intent pricing into per-flow-class unit rates at a reference configuration. */
function buildFcAggregates(inputs: ScenarioInputs, customIntents: Intent[]): FcAgg[] {
  // Reference run: full adoption, no ramp, so unit rates divide out cleanly.
  const ref: ScenarioInputs = { ...inputs, adoptionRate: 1, adoptionRamp: undefined };
  const rollup = computeRollup(ref, {}, undefined, customIntents);
  const shares = computeShares(ref, customIntents);
  const allIntents = [...intents, ...customIntents];

  return flowClasses.map((fc) => {
    const rows = rollup.rows.filter((r) => r.flowClass === fc.key);
    const txns = rows.reduce((a, r) => a + r.transactions, 0) || 1;
    const contain = inputs.containmentRates?.[fc.key] ?? DEFAULT_CONTAINMENT[fc.key]!;
    const contained = txns * contain || 1;
    // Volume-weighted handling minutes from the corpus.
    let asIsW = 0, toBeW = 0, wSum = 0;
    for (const it of allIntents) {
      if (it.flowClass !== fc.key) continue;
      const s = shares.get(it.key) ?? 0;
      asIsW += it.asIsHandlingMin * s;
      toBeW += it.toBeHumanMin * s;
      wSum += s;
    }
    const asIsMin = wSum > 0 ? asIsW / wSum : 0;
    const toBeMin = wSum > 0 ? toBeW / wSum : 0;
    const benefit = rows.reduce((a, r) => a + r.benefitUsd, 0);
    const timeBenefit = (Math.max(0, asIsMin - toBeMin) / 60) * inputs.hrHourlyCostUsd * contained;
    return {
      key: fc.key,
      label: fc.name,
      share: txns / (rollup.rows.reduce((a, r) => a + r.transactions, 0) || 1),
      aiPerTxn: rows.reduce((a, r) => a + r.aiCostUsd, 0) / txns,
      infraPerTxn: rows.reduce((a, r) => a + r.infraCostUsd, 0) / txns,
      otherPerTxn: rows.reduce((a, r) => a + r.otherCostUsd, 0) / txns,
      buildPerTxn: rows.reduce((a, r) => a + r.buildCostUsd, 0) / txns,
      asIsMin,
      toBeMin,
      otherBenefitPerContained: Math.max(0, benefit - timeBenefit) / contained,
      defaultContainment: DEFAULT_CONTAINMENT[fc.key]!,
      defaultSampling: DEFAULT_SAMPLING[fc.key]!,
      localized: LOCALIZED.has(fc.key),
      providedContainment: inputs.containmentRates?.[fc.key],
      providedSampling: inputs.hitlSamplingRates?.[fc.key],
    };
  });
}

export async function buildScenarioWorkbook(
  inputs: ScenarioInputs,
  customIntents: Intent[] = [],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "HRO Intent Flow Cost-Benefit Explorer";

  const header = { font: { bold: true }, fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFE8EDF5" } } };
  const lock = { font: { color: { argb: "FF6B7280" } } };
  const edit = { fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFF7DB" } } };

  // ── READ ME ──
  const readme = wb.addWorksheet("READ ME");
  readme.getColumn(1).width = 110;
  const readmeLines = [
    WORKBOOK_MARKER,
    "HRO Intent Flow Cost-Benefit Explorer — shadow model",
    "",
    "HOW TO USE",
    "1. Edit the YELLOW cells only: Inputs, Flow Classes (containment / sampling overrides), Assumptions (override column),",
    "   Model Stack (model choice) and Systems (Integrated? = No for systems the client will not connect).",
    "2. Results update live via formulas — they give a FAIR, DIRECTIONAL estimate of the annual business case.",
    "3. Upload this file back into the app (Scenario Builder → Import workbook). The app reads ONLY your inputs and",
    "   reprices with the exact engine — per-intent pricing, adoption ramp, fan-out, SME overrides and validation.",
    "",
    "IMPORTANT",
    "- The spreadsheet formulas are a simplified per-flow-class approximation exported from the engine at the",
    "  configuration current when this file was generated. The app's number is the authoritative one.",
    "- Do not rename sheets, delete key columns (column A) or reorder columns; the importer reads them by position.",
  ];
  readmeLines.forEach((t, i) => { readme.getCell(i + 1, 1).value = t; });
  readme.getCell(1, 1).font = { color: { argb: "FFFFFFFF" }, size: 8 };
  readme.getCell(2, 1).font = { bold: true, size: 14 };

  // ── Inputs ──
  const inp = wb.addWorksheet("Inputs");
  inp.columns = [{ width: 24 }, { width: 30 }, { width: 18 }, { width: 70 }] as never;
  inp.addRow(["Key", "Input", "Value", "Notes"]).eachCell((c) => Object.assign(c, header));
  const inputRows: Array<{ key: string; label: string; note: string; optional?: boolean; enumValues?: string[]; value: string | number | undefined }> = [
    ...INPUT_ROWS.map((r) => ({ ...r, value: inputs[r.key] as string | number | undefined })),
    ...RAMP_KEYS.map((k, i) => ({
      key: k,
      label: `Adoption ramp Year ${i + 1} (0-1)`,
      note: "OPTIONAL. Fill all three or none. Fraction of volume in the automated channel that year. Blank = engine default ramp (40/75/100%).",
      optional: true,
      value: inputs.adoptionRamp?.[i],
    })),
    ...COMMERCIAL_INPUT_ROWS.map((row) => ({
      ...row,
      optional: true,
      value: inputs.commercialAssumptions?.[row.key],
    })),
  ];
  for (const row of inputRows) {
    const v = row.value;
    const r = inp.addRow([row.key, row.label, v === undefined ? "" : v, row.note]);
    Object.assign(r.getCell(1), lock);
    Object.assign(r.getCell(3), edit);
    if (row.enumValues) {
      r.getCell(3).dataValidation = {
        type: "list",
        allowBlank: !!row.optional,
        formulae: [`"${row.enumValues.join(",")}"`],
      };
    }
  }
  const inpCell = (key: string) => {
    const idx = inputRows.findIndex((r) => r.key === key);
    return `Inputs!$C$${idx + 2}`;
  };

  // ── Ref (lookup tables & reference multipliers) ──
  const ref = wb.addWorksheet("Ref");
  ref.state = "veryHidden";
  const tierPooled = effVal("tier-pooled", inputs);
  const tierSiloed = effVal("tier-siloed", inputs);
  const tierDedicated = effVal("tier-dedicated", inputs);
  const refTier = inputs.isolationTier === "dedicated" ? tierDedicated : inputs.isolationTier === "siloed" ? tierSiloed : tierPooled;
  const multi = effVal("company-multi-country", inputs);
  const globalM = effVal("company-global", inputs);
  const refLoc = inputs.companyType === "global" ? globalM : inputs.companyType === "multi-country" ? multi : 1;
  const matClean = assumptionMap["maturity-clean"]!.value;
  const matMixed = assumptionMap["maturity-mixed"]!.value;
  const matLegacy = assumptionMap["maturity-legacy"]!.value;
  const refMat = maturityAssumptionFor(inputs.landscapeMaturity).value;
  ref.addRow(["tier", "mult"]);
  ref.addRow(["pooled", tierPooled]);
  ref.addRow(["siloed", tierSiloed]);
  ref.addRow(["dedicated", tierDedicated]);
  ref.addRow(["company", "mult"]);
  ref.addRow(["single-country", 1]);
  ref.addRow(["multi-country", multi]);
  ref.addRow(["global", globalM]);
  ref.addRow(["maturity", "mult"]);
  ref.addRow(["clean", matClean]);
  ref.addRow(["mixed", matMixed]);
  ref.addRow(["legacy", matLegacy]);
  ref.addRow(["refTier", refTier]);
  ref.addRow(["refLoc", refLoc]);
  ref.addRow(["refMat", refMat]);
  ref.addRow(["refAdoption", 1]);
  // Named formula fragments
  const TIER_RATIO = `(VLOOKUP(${inpCell("isolationTier")},Ref!$A$2:$B$4,2,FALSE)/Ref!$B$13)`;
  const LOC_RATIO = `(VLOOKUP(${inpCell("companyType")},Ref!$A$6:$B$8,2,FALSE)/Ref!$B$14)`;
  const MAT_RATIO = `(IF(${inpCell("landscapeMaturity")}="",Ref!$B$11,VLOOKUP(${inpCell("landscapeMaturity")},Ref!$A$10:$B$12,2,FALSE))/Ref!$B$15)`;
  // Adoption for the shadow model: 3-year average of the ramp if provided,
  // else the scalar rate, else the engine's default ramp average.
  const rampAvg = `AVERAGE(${inpCell("adoptionRampY1")},${inpCell("adoptionRampY2")},${inpCell("adoptionRampY3")})`;
  const ADOPTION = `IF(${inpCell("adoptionRampY1")}<>"",${rampAvg},IF(${inpCell("adoptionRate")}="",0.71667,${inpCell("adoptionRate")}))`; // 0.71667 = avg of default 40/75/100 ramp

  // ── Flow Classes (the shadow engine) ──
  const aggs = buildFcAggregates(inputs, customIntents);
  const fcs = wb.addWorksheet("Flow Classes");
  fcs.columns = [
    { width: 18 }, { width: 28 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 },
    { width: 12 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 10 }, { width: 10 }, { width: 12 },
    { width: 12 }, { width: 12 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 14 }, { width: 14 },
  ] as never;
  fcs.addRow([
    "Key", "Flow class", "Share", "Txns/yr", "Default containment", "Containment override", "Effective containment",
    "Contained txns", "AI $/txn (ref)", "Infra $/txn (ref)", "Other $/txn (ref)", "As-is min", "To-be min",
    "Default HITL sampling", "Sampling override", "Effective sampling", "AI cost", "Infra cost", "Other cost",
    "Human cost", "Build cost", "Benefit", "Net",
  ]).eachCell((c) => Object.assign(c, header));
  aggs.forEach((a, i) => {
    const r = i + 2;
    const row = fcs.addRow([
      a.key, a.label, a.share,
      { formula: `C${r}*${ADOPTION}*${inpCell("annualTransactions")}` },
      a.defaultContainment,
      a.providedContainment ?? "",
      { formula: `IF(F${r}="",E${r},F${r})` },
      { formula: `D${r}*G${r}` },
      a.aiPerTxn, a.infraPerTxn, a.otherPerTxn, a.asIsMin, a.toBeMin,
      a.defaultSampling,
      a.providedSampling ?? "",
      { formula: `IF(O${r}="",IF(${inpCell("hitlSamplingRate")}="",N${r},${inpCell("hitlSamplingRate")}),O${r})` },
      { formula: `D${r}*I${r}*${TIER_RATIO}${a.localized ? `*${LOC_RATIO}` : ""}` },
      { formula: `D${r}*J${r}*${TIER_RATIO}${a.localized ? `*${LOC_RATIO}` : ""}` },
      { formula: `D${r}*K${r}` },
      { formula: `H${r}*(M${r}/60)*${inpCell("hitlHourlyCostUsd")}*P${r}+(D${r}-H${r})*(L${r}/60)*${inpCell("hitlHourlyCostUsd")}` },
      { formula: `D${r}*${a.buildPerTxn}*${MAT_RATIO}` },
      { formula: `H${r}*MAX(0,L${r}-M${r})/60*${inpCell("hrHourlyCostUsd")}+H${r}*${a.otherBenefitPerContained}` },
      { formula: `V${r}-Q${r}-R${r}-S${r}-T${r}-U${r}` },
    ]);
    Object.assign(row.getCell(6), edit);
    Object.assign(row.getCell(15), edit);
    [1, 3, 5, 9, 10, 11, 12, 13, 14].forEach((c) => Object.assign(row.getCell(c), lock));
  });
  const nFc = aggs.length;

  // ── Assumptions ──
  const asmSheet = wb.addWorksheet("Assumptions");
  asmSheet.columns = [{ width: 26 }, { width: 40 }, { width: 16 }, { width: 12 }, { width: 12 }, { width: 80 }] as never;
  asmSheet.addRow(["Key", "Assumption", "Unit", "Default", "Override", "Rationale"]).eachCell((c) => Object.assign(c, header));
  const overridable = assumptions.filter((a) => OVERRIDABLE_ASSUMPTION_KEYS.has(a.key));
  const asmRowIndex = new Map<string, number>();
  overridable.forEach((a, i) => {
    asmRowIndex.set(a.key, i + 2);
    const row = asmSheet.addRow([a.key, a.label, a.unit, a.value, inputs.assumptionOverrides?.[a.key] ?? "", a.rationale]);
    Object.assign(row.getCell(5), edit);
    [1, 2, 3, 4, 6].forEach((c) => Object.assign(row.getCell(c), lock));
  });
  // Fixed annual costs referenced by Results (onboarding + knowledge maintenance use registry defaults; not user-overridable here).
  const kmVal = assumptionMap["knowledge-maintenance-country"]!.value;
  const obBase = assumptionMap["onboarding-base"]!.value;
  const obSys = assumptionMap["onboarding-per-system"]!.value;
  const obCty = assumptionMap["onboarding-per-country"]!.value;

  // ── Model Stack ──
  const ms = wb.addWorksheet("Model Stack");
  ms.columns = [{ width: 14 }, { width: 36 }, { width: 26 }, { width: 70 }] as never;
  ms.addRow(["Role", "Options (key — $/call)", "Selected model key", "Note"]).eachCell((c) => Object.assign(c, header));
  MODEL_ROLES.forEach((role) => {
    const opts = modelCatalog.filter((m) => m.role === role);
    const row = ms.addRow([
      role,
      opts.map((o) => `${o.key} — $${o.pricePerCallUsd}`).join("  |  "),
      inputs.modelSelection?.[role] ?? "",
      "Blank = engine default. Model choice reprices AI steps exactly on re-import (spreadsheet totals do not reprice).",
    ]);
    Object.assign(row.getCell(3), edit);
    row.getCell(3).dataValidation = { type: "list", allowBlank: true, formulae: [`"${opts.map((o) => o.key).join(",")}"`] };
    [1, 2, 4].forEach((c) => Object.assign(row.getCell(c), lock));
  });

  // ── Systems ──
  const sys = wb.addWorksheet("Systems");
  sys.columns = [{ width: 20 }, { width: 38 }, { width: 34 }, { width: 12 }, { width: 70 }] as never;
  sys.addRow(["Key", "System", "MCP integration", "Integrated?", "Note"]).eachCell((c) => Object.assign(c, header));
  const nonIntegrated = new Set(inputs.nonIntegratedSystems ?? []);
  for (const s of systems) {
    const row = sys.addRow([
      s.key, s.name, s.integration.label, nonIntegrated.has(s.key) ? "No" : "Yes",
      "Set to No if the client will not connect this system: its act-stage actions stay manual (approx. not reflected in spreadsheet totals; exact on re-import).",
    ]);
    Object.assign(row.getCell(4), edit);
    row.getCell(4).dataValidation = { type: "list", allowBlank: false, formulae: ['"Yes,No"'] };
    [1, 2, 3, 5].forEach((c) => Object.assign(row.getCell(c), lock));
  }

  // ── Intent Mix ──
  const im = wb.addWorksheet("Intent Mix");
  im.columns = [{ width: 24 }, { width: 44 }, { width: 20 }, { width: 14 }, { width: 14 }, { width: 60 }] as never;
  im.addRow(["Key", "Intent", "Flow class", "Default share", "Share override", "Note"]).eachCell((c) => Object.assign(c, header));
  const defaultShares = computeShares({ ...inputs, intentShareOverrides: undefined }, customIntents);
  const allIntentsList = [...intents, ...customIntents];
  for (const it of allIntentsList) {
    const row = im.addRow([
      it.key, it.name, it.flowClass,
      defaultShares.get(it.key) ?? 0,
      inputs.intentShareOverrides?.[it.key] ?? "",
      "OPTIONAL. Fraction of annual volume (0-1). Blank = default mix. Overrides reprice exactly on re-import (not in spreadsheet totals).",
    ]);
    Object.assign(row.getCell(5), edit);
    [1, 2, 3, 4, 6].forEach((c) => Object.assign(row.getCell(c), lock));
  }

  // ── Results ──
  const res = wb.addWorksheet("Results");
  res.columns = [{ width: 44 }, { width: 20 }, { width: 76 }] as never;
  res.addRow(["Result (annual, directional)", "USD", "How it is computed"]).eachCell((c) => Object.assign(c, header));
  const fcSum = (col: string) => `SUM('Flow Classes'!${col}2:${col}${nFc + 1})`;
  const asmRef = (key: string) => {
    const r = asmRowIndex.get(key);
    return r ? `IF(Assumptions!$E$${r}="",Assumptions!$D$${r},Assumptions!$E$${r})` : "0";
  };
  const rows: Array<[string, string, string]> = [
    ["AI consumption", fcSum("Q"), "Per-flow-class AI unit rates x volume, scaled by isolation tier and localization."],
    ["Infrastructure", fcSum("R"), "Per-flow-class infra unit rates x volume, scaled like AI."],
    ["Other run cost", `${fcSum("S")}+${kmVal}*${inpCell("countries")}`, `Other per-txn cost + knowledge maintenance ($${kmVal}/country/yr).`],
    ["Human (HITL + fallback)", fcSum("T"), "Sampled review minutes on contained txns + full as-is handling on uncontained fallbacks."],
    ["Platform build (amortized)", fcSum("U"), "Flow-class build cost amortized over expected volume, scaled by landscape maturity."],
    ["Client onboarding (annualized)", `(${obBase}+${obSys}*${inpCell("numSystems")}+${obCty}*${inpCell("countries")})/IF(${inpCell("contractYears")}="",3,${inpCell("contractYears")})`, `$${obBase} base + $${obSys}/system + $${obCty}/country, over the contract term.`],
    ["TOTAL COST", "B2+B3+B4+B5+B6+B7", "Sum of all cost lines above."],
    ["Benefit (time eliminated + dollarized)", fcSum("V"), "Handling minutes eliminated on contained txns at the as-is rate + dollarized step benefits."],
    ["NET ANNUAL VALUE", "B9-B8", "Benefit minus total cost. Directional — upload this file to the app for the exact engine number."],
  ];
  rows.forEach(([label, formula, note]) => {
    const row = res.addRow([label, { formula }, note]);
    row.getCell(2).numFmt = '#,##0;[Red]-#,##0';
    Object.assign(row.getCell(3), lock);
  });
  res.getRow(8).font = { bold: true };
  res.getRow(10).font = { bold: true, size: 12 };
  // AI model note referencing mcp/model assumption overrides is intentionally omitted: spreadsheet does not reprice models.

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

// ─── Import ───────────────────────────────────────────────────────────────────

function num(v: ExcelJS.CellValue, field: string): number {
  const n = typeof v === "number" ? v : Number(String(cellText(v)).replace(/,/g, ""));
  if (!Number.isFinite(n)) throw new InputValidationError(`"${field}" must be a number (got "${cellText(v)}")`);
  return n;
}
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("result" in v && v.result !== undefined) return String(v.result);
    if ("text" in v && typeof v.text === "string") return v.text;
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    return "";
  }
  return String(v).trim();
}
function isBlank(v: ExcelJS.CellValue): boolean {
  return cellText(v) === "";
}

export async function parseScenarioWorkbook(buffer: Buffer): Promise<ScenarioInputs> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new InputValidationError("File is not a readable .xlsx workbook");
  }
  const readme = wb.getWorksheet("READ ME");
  if (!readme || cellText(readme.getCell(1, 1).value) !== WORKBOOK_MARKER) {
    throw new InputValidationError("This is not a workbook exported by this app (marker missing). Download a fresh shadow workbook first.");
  }
  const inp = wb.getWorksheet("Inputs");
  const fcSheet = wb.getWorksheet("Flow Classes");
  const asmSheet = wb.getWorksheet("Assumptions");
  const msSheet = wb.getWorksheet("Model Stack");
  const sysSheet = wb.getWorksheet("Systems");
  if (!inp || !fcSheet || !asmSheet || !msSheet || !sysSheet) {
    throw new InputValidationError("Workbook is missing one of the required sheets (Inputs, Flow Classes, Assumptions, Model Stack, Systems)");
  }

  // Inputs — scan by key in column A.
  const byKey = new Map<string, ExcelJS.CellValue>();
  inp.eachRow((row, n) => {
    if (n === 1) return;
    const key = cellText(row.getCell(1).value);
    if (key) byKey.set(key, row.getCell(3).value);
  });
  const req = (key: string) => {
    const v = byKey.get(key);
    if (v === undefined || isBlank(v)) throw new InputValidationError(`Required input "${key}" is empty in the Inputs sheet`);
    return v;
  };
  const inputs: ScenarioInputs = {
    annualTransactions: num(req("annualTransactions"), "annualTransactions"),
    employees: num(req("employees"), "employees"),
    numSystems: num(req("numSystems"), "numSystems"),
    countries: num(req("countries"), "countries"),
    sector: cellText(req("sector")),
    companyType: cellText(req("companyType")),
    isolationTier: cellText(req("isolationTier")),
    hrHourlyCostUsd: num(req("hrHourlyCostUsd"), "hrHourlyCostUsd"),
    hitlHourlyCostUsd: num(req("hitlHourlyCostUsd"), "hitlHourlyCostUsd"),
  };
  const opt = (key: string): ExcelJS.CellValue | undefined => {
    const v = byKey.get(key);
    return v === undefined || isBlank(v) ? undefined : v;
  };
  const adoption = opt("adoptionRate");
  if (adoption !== undefined) inputs.adoptionRate = num(adoption, "adoptionRate");
  const sampling = opt("hitlSamplingRate");
  if (sampling !== undefined) inputs.hitlSamplingRate = num(sampling, "hitlSamplingRate");
  const maturity = opt("landscapeMaturity");
  if (maturity !== undefined) inputs.landscapeMaturity = cellText(maturity);
  const cy = opt("contractYears");
  if (cy !== undefined) inputs.contractYears = num(cy, "contractYears");
  const rw = opt("reworkRatePct");
  if (rw !== undefined) inputs.reworkRatePct = num(rw, "reworkRatePct");
  const pl = opt("peakLoadFactor");
  if (pl !== undefined) inputs.peakLoadFactor = num(pl, "peakLoadFactor");
  const commercial: Partial<CommercialAssumptions> = {};
  for (const row of COMMERCIAL_INPUT_ROWS) {
    const value = opt(row.key);
    if (value !== undefined) {
      commercial[row.key] = num(value, row.key);
    }
  }
  if (Object.keys(commercial).length > 0) {
    inputs.commercialAssumptions = commercial;
  }
  // Adoption ramp: all three or none.
  const rampCells = RAMP_KEYS.map((k) => opt(k));
  const rampFilled = rampCells.filter((v) => v !== undefined).length;
  if (rampFilled === 3) {
    inputs.adoptionRamp = rampCells.map((v, i) => num(v!, RAMP_KEYS[i]!)) as [number, number, number];
  } else if (rampFilled > 0) {
    throw new InputValidationError("Adoption ramp: fill all three years (adoptionRampY1-Y3) or leave all blank");
  }

  // Flow Classes — containment (col F) and sampling (col O) overrides.
  const containment: Record<string, number> = {};
  const fcSampling: Record<string, number> = {};
  fcSheet.eachRow((row, n) => {
    if (n === 1) return;
    const key = cellText(row.getCell(1).value);
    if (!key) return;
    if (!isBlank(row.getCell(6).value)) containment[key] = num(row.getCell(6).value, `${key} containment override`);
    if (!isBlank(row.getCell(15).value)) fcSampling[key] = num(row.getCell(15).value, `${key} sampling override`);
  });
  if (Object.keys(containment).length > 0) inputs.containmentRates = containment;
  if (Object.keys(fcSampling).length > 0) inputs.hitlSamplingRates = fcSampling;

  // Assumption overrides (col E).
  const overrides: Record<string, number> = {};
  asmSheet.eachRow((row, n) => {
    if (n === 1) return;
    const key = cellText(row.getCell(1).value);
    if (!key || !OVERRIDABLE_ASSUMPTION_KEYS.has(key)) return;
    if (!isBlank(row.getCell(5).value)) overrides[key] = num(row.getCell(5).value, `${key} override`);
  });
  if (Object.keys(overrides).length > 0) inputs.assumptionOverrides = overrides;

  // Model selection (col C).
  const selection: Record<string, string> = {};
  msSheet.eachRow((row, n) => {
    if (n === 1) return;
    const role = cellText(row.getCell(1).value);
    const chosen = cellText(row.getCell(3).value);
    if (role && chosen) selection[role] = chosen;
  });
  if (Object.keys(selection).length > 0) inputs.modelSelection = selection;

  // Intent mix share overrides (col E).
  const imSheet = wb.getWorksheet("Intent Mix");
  if (imSheet) {
    const shareOverrides: Record<string, number> = {};
    imSheet.eachRow((row, n) => {
      if (n === 1) return;
      const key = cellText(row.getCell(1).value);
      if (key && !isBlank(row.getCell(5).value)) shareOverrides[key] = num(row.getCell(5).value, `${key} share override`);
    });
    if (Object.keys(shareOverrides).length > 0) inputs.intentShareOverrides = shareOverrides;
  }

  // Non-integrated systems (col D = "No").
  const non: string[] = [];
  sysSheet.eachRow((row, n) => {
    if (n === 1) return;
    const key = cellText(row.getCell(1).value);
    if (key && cellText(row.getCell(4).value).toLowerCase() === "no") non.push(key);
  });
  if (non.length > 0) inputs.nonIntegratedSystems = non;

  return inputs;
}
