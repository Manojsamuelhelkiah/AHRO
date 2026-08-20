import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  useListScenarios,
  useComputeRollup,
  useUpdateScenario,
  useListActualsOverlays,
  getListScenariosQueryKey,
  Rollup,
  CommercialAssumptions,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  Printer,
  Settings2,
  DollarSign,
  AlertCircle,
  Activity,
  Layers,
  Zap,
  Briefcase,
  RefreshCw,
  DatabaseZap,
} from "lucide-react";

import { formatRateSetReference } from "@/lib/pricing-format";

const formatUsd = (val: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(val || 0);

const formatNum = (val: number) =>
  new Intl.NumberFormat("en-US").format(val || 0);

const formatUnitUsd = (val: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: val > 0 && val < 0.01 ? 4 : 2,
  }).format(val || 0);

const formatPreciseUsd = (val: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val || 0);

const formatPct = (val: number) =>
  new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(val || 0);

const PrintPortal = ({ children }: { children: React.ReactNode }) => {
  if (typeof document === "undefined") return null;
  let node = document.getElementById("print-portal");
  if (!node) {
    node = document.createElement("div");
    node.id = "print-portal";
    document.body.appendChild(node);
  }
  return createPortal(children, node);
};

const ReportView = ({
  rollup,
  scenarioName,
  calibrationLabel,
}: {
  rollup: Rollup;
  scenarioName: string;
  calibrationLabel: string;
}) => {
  const cs = rollup.commercialSummary;
  const tu = cs.tokenUsage;
  const rawCostComponents = [
    { key: "ai", label: "AI / model consumption", usd: cs.annualAiCostUsd },
    {
      key: "infra",
      label: "Infrastructure & hosting",
      usd: cs.annualInfrastructureCostUsd,
    },
    {
      key: "hitl",
      label: "Supplier-delivered HITL",
      usd: cs.annualVendorHitlCostUsd,
    },
    {
      key: "channel",
      label: "Channels, MCP & other variable",
      usd: cs.annualChannelAndOtherVariableCostUsd,
    },
    {
      key: "knowledge",
      label: "Knowledge maintenance",
      usd: cs.annualKnowledgeMaintenanceCostUsd,
    },
  ];
  let allocatedCents = 0;
  const totalRunCents = Math.round(cs.annualRunCostUsd * 100);
  const costComponents = rawCostComponents.map((component, index) => {
    const cents =
      index === rawCostComponents.length - 1
        ? totalRunCents - allocatedCents
        : Math.round(component.usd * 100);
    allocatedCents += cents;
    return { ...component, displayUsd: cents / 100 };
  });

  return (
    <div className="space-y-8 print:space-y-6 print-content">
      {/* Header */}
      <div className="pb-6 border-b border-border print:border-slate-300">
        <h1 className="text-2xl font-bold tracking-tight text-foreground print:text-black flex items-center gap-2">
          <DollarSign className="w-6 h-6 text-primary" />
          Commercial Pricing Report
        </h1>
        <p className="text-sm text-muted-foreground mt-2 print:text-slate-600 flex items-start gap-2 max-w-3xl">
          <AlertCircle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          This report defines supplier pricing margin and operational cost recovery. It is strictly separate from the client's operational cost-benefit ROI modeled in the Scenario Builder.
        </p>
         <p className="text-xs text-muted-foreground mt-3 print:text-slate-500">
           Scenario: <span className="font-medium text-foreground print:text-slate-800">{scenarioName}</span>
           <span className="mx-2">·</span>
           Calibration: <span className="font-medium text-foreground print:text-slate-800">{calibrationLabel}</span>
         </p>
         {cs.rateSetReference && (
           <p className="text-xs text-muted-foreground mt-1 print:text-slate-500">
             <span className="font-medium text-foreground print:text-slate-800">{formatRateSetReference(cs.rateSetReference)}</span>
             <span className="mx-2">·</span>
             <span className="italic">{cs.rateSetReference.rationale}</span>
           </p>
         )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 print:grid-cols-2 print:gap-6">
        {/* Core Financials */}
        <div className="space-y-6 print:space-y-4">
          
          <div className="bg-card print:bg-slate-50 border border-border print:border-slate-200 rounded-lg p-5">
            <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground print:text-slate-500 mb-4 flex items-center gap-2">
              <Briefcase className="w-4 h-4" /> Implementation & Build
            </h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm">Client Implementation Cost</span>
                <span className="font-mono">{formatUsd(cs.clientImplementationCostUsd)}</span>
              </div>
              <div className="flex justify-between items-center pb-2 border-b border-border/50">
                <span className="text-sm">Target Gross Margin</span>
                <span className="font-mono">{formatPct(cs.pricingMargin)}</span>
              </div>
              <div className="flex justify-between items-center text-primary print:text-blue-700 font-semibold">
                <span>Recommended Implementation Price</span>
                <span className="font-mono">{formatUsd(cs.clientImplementationPriceUsd)}</span>
              </div>
              <div className="mt-4 pt-3 border-t border-border/50 flex justify-between items-center text-xs text-muted-foreground">
                <span>Reusable Product Build Investment</span>
                <span className="font-mono">{formatUsd(cs.productBuildCostUsd)}</span>
              </div>
            </div>
          </div>

          <div className="bg-card print:bg-slate-50 border border-border print:border-slate-200 rounded-lg p-5">
            <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground print:text-slate-500 mb-4 flex items-center gap-2">
              <RefreshCw className="w-4 h-4" /> Annual Recurring
            </h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                 <span className="text-sm">Annual Supplier Operating COGS</span>
                 <span className="font-mono">{formatPreciseUsd(cs.annualRunCostUsd)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm">Allocated Support & Maint. Cost</span>
                <span className="font-mono">{formatUsd(cs.annualSupportCostUsd)}</span>
              </div>
               <div className="flex justify-between items-center">
                 <span className="text-sm">Annual Recurring COGS</span>
                 <span className="font-mono">{formatUsd(cs.annualRecurringCogsUsd)}</span>
               </div>
               <div className="flex justify-between items-center">
                 <span className="text-sm">Monthly Recurring COGS</span>
                 <span className="font-mono">{formatUsd(cs.monthlyRecurringCogsUsd)}</span>
               </div>
              <div className="flex justify-between items-center pb-2 border-b border-border/50">
                <span className="text-sm">Product Recovery Allocation</span>
                <span className="font-mono">{formatUsd(cs.annualProductRecoveryUsd)}</span>
              </div>
              <div className="flex justify-between items-center text-primary print:text-blue-700 font-semibold">
                <span>Recommended Annual Subscription</span>
                <span className="font-mono">{formatUsd(cs.recommendedAnnualPriceUsd)}</span>
              </div>
              <div className="flex justify-between items-center text-xs text-muted-foreground mt-1">
                <span>Monthly Equivalent</span>
                <span className="font-mono">{formatUsd(cs.recommendedMonthlyPriceUsd)}/mo</span>
              </div>
               <div className="flex justify-between items-center text-xs text-muted-foreground mt-1">
                 <span>Standalone Annual Support Price</span>
                 <span className="font-mono">{formatUsd(cs.annualSupportPriceUsd)}</span>
               </div>
               <p className="pt-2 text-[10px] leading-relaxed text-muted-foreground border-t border-border/50">
                 Subscription and unit prices use the same full committed volume of{" "}
                 {formatNum(cs.annualCommittedTransactions)} transactions per year.
                 Client fallback HR labor is excluded from supplier COGS.
               </p>
            </div>
          </div>

        </div>

        {/* Unit Economics & Metrics */}
        <div className="space-y-6 print:space-y-4">
          
          <div className="bg-sidebar print:bg-slate-800 text-sidebar-foreground print:text-white rounded-lg p-5">
            <h3 className="text-sm font-bold uppercase tracking-wider text-sidebar-foreground/70 print:text-slate-300 mb-4 flex items-center gap-2">
              <Zap className="w-4 h-4" /> Target Unit Economics
            </h3>
            <div className="space-y-4">
              <div>
                <div className="text-xs text-sidebar-foreground/70 print:text-slate-300 mb-1">First-Year Contract Value</div>
                <div className="text-2xl font-bold font-mono text-primary-foreground print:text-white">
                  {formatUsd(cs.firstYearContractValueUsd)}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 pt-4 border-t border-sidebar-border print:border-slate-600">
                <div>
                  <div className="text-xs text-sidebar-foreground/70 mb-1">Blended Price / Txn</div>
                  <div className="text-lg font-mono">{formatUnitUsd(cs.recommendedTransactionPriceUsd)}</div>
                </div>
                <div>
                  <div className="text-xs text-sidebar-foreground/70 mb-1">Overage Price / Txn</div>
                  <div className="text-lg font-mono">{formatUnitUsd(cs.overagePricePerTransactionUsd)}</div>
                </div>
                <div>
                  <div className="text-xs text-sidebar-foreground/70 mb-1">Gross Margin</div>
                  <div className="text-lg font-mono">{formatPct(cs.pricingMargin)}</div>
                </div>
                <div>
                  <div className="text-xs text-sidebar-foreground/70 mb-1">Product Payback</div>
                  <div className="text-lg font-mono">{cs.plannedPaybackMonths} mo</div>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-card print:bg-slate-50 border border-border print:border-slate-200 rounded-lg p-5">
            <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground print:text-slate-500 mb-4 flex items-center gap-2">
              <Layers className="w-4 h-4" /> AI Telemetry & COGS
            </h3>
            
            <div className="grid grid-cols-2 gap-y-3 mb-5 text-sm">
              <div className="text-muted-foreground">Basis</div>
              <div className="font-mono text-right capitalize">{tu.basis}</div>
              
              <div className="text-muted-foreground">Annual Model Calls</div>
              <div className="font-mono text-right">{formatNum(tu.annualModelCalls)}</div>
              
              <div className="text-muted-foreground">Annual Input Tokens</div>
              <div className="font-mono text-right">{formatNum(tu.annualInputTokens)}</div>
              
              <div className="text-muted-foreground">Annual Output Tokens</div>
              <div className="font-mono text-right">{formatNum(tu.annualOutputTokens)}</div>

               <div className="text-muted-foreground">Annual Total Tokens</div>
               <div className="font-mono text-right">{formatNum(tu.annualTotalTokens)}</div>
            </div>

            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 border-t border-border/50 pt-3">Operating Breakdown</h4>
            <div className="space-y-2">
              {costComponents.map(c => (
                <div key={c.key} className="flex justify-between items-center text-sm">
                  <span className="capitalize">{c.label}</span>
                   <span className="font-mono">{formatPreciseUsd(c.displayUsd)}</span>
                </div>
              ))}
            </div>

          </div>

        </div>
      </div>
      
      {/* Footer metadata for print */}
      <div className="hidden print:flex justify-between text-[10px] text-slate-400 pt-8 border-t border-slate-200">
        <div>HRO Explorer — Commercial Pricing</div>
        <div>Generated: {new Date().toLocaleDateString()}</div>
      </div>
    </div>
  );
};


export default function Pricing() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: scenarios, isLoading: isScenariosLoading } = useListScenarios();
  const { data: actualsOverlays, isLoading: isOverlaysLoading } =
    useListActualsOverlays();
  const computeRollup = useComputeRollup();
  const updateScenario = useUpdateScenario();

  const [selectedScenarioId, setSelectedScenarioId] = useState<number | "">("");
  const [activeOverlayId, setActiveOverlayId] = useState<number | "">("");
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [assumptions, setAssumptions] = useState<CommercialAssumptions>({});

  const [isComputing, setIsComputing] = useState(false);
  const initialComputeSequence = useRef(0);

  const selectedScenario = scenarios?.find(
    (scenario) => scenario.id === selectedScenarioId,
  );
  const requiredAssumptionKeys: Array<keyof CommercialAssumptions> = [
    "targetGrossMargin",
    "targetClients",
    "productRecoveryMonths",
    "supportTeamFte",
    "supportHourlyCostUsd",
    "supportToolingAnnualUsdPerClient",
  ];
  const assumptionsReady = requiredAssumptionKeys.every(
    (key) => typeof assumptions[key] === "number",
  );
  const activeOverlay = actualsOverlays?.find(
    (overlay) => overlay.id === activeOverlayId,
  );
  const calibrationLabel =
    activeOverlayId === ""
      ? "Architecture estimates"
      : activeOverlay?.clientLabel || `Actuals overlay #${activeOverlayId}`;

  const handleScenarioChange = (value: string) => {
    const nextId = value ? Number(value) : "";
    const nextScenario = scenarios?.find((scenario) => scenario.id === nextId);
    setActiveOverlayId(
      nextScenario?.inputs.commercialAssumptions?.actualsOverlayId ?? "",
    );
    setSelectedScenarioId(nextId);
  };

  useEffect(() => {
    if (!selectedScenario) {
      setRollup(null);
      setAssumptions({});
      return;
    }

    const requestSequence = ++initialComputeSequence.current;
    const fetchInitial = async () => {
      setIsComputing(true);
      setRollup(null);
      try {
        const result = await computeRollup.mutateAsync({
          data: {
            inputs: selectedScenario.inputs,
            ...(activeOverlayId !== "" && {
              actualsOverlayId: activeOverlayId,
            }),
          },
        });
        if (initialComputeSequence.current !== requestSequence) return;
        setRollup(result);
        setAssumptions({ ...result.commercialSummary.assumptions });
      } catch (err: unknown) {
        if (initialComputeSequence.current !== requestSequence) return;
        toast({
          title: "Error computing scenario",
          description:
            err instanceof Error ? err.message : "An unknown error occurred.",
          variant: "destructive",
        });
      } finally {
        if (initialComputeSequence.current === requestSequence) {
          setIsComputing(false);
        }
      }
    };

    void fetchInitial();
    return () => {
      if (initialComputeSequence.current === requestSequence) {
        initialComputeSequence.current += 1;
      }
    };
    // Mutation functions and toast are intentionally omitted: the selected
    // scenario is the only state transition that should trigger this compute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedScenario, activeOverlayId]);

  const handleGenerateReport = async () => {
    if (!selectedScenario || !assumptionsReady) return;

    setIsComputing(true);
    try {
      const { actualsOverlayId: _savedOverlayId, ...editableAssumptions } =
        assumptions;
      const mergedInputs = {
        ...selectedScenario.inputs,
        commercialAssumptions: {
          ...editableAssumptions,
          ...(activeOverlayId !== "" && { actualsOverlayId: activeOverlayId }),
        },
      };

      await updateScenario.mutateAsync({
        id: selectedScenario.id,
        data: { inputs: mergedInputs },
      });

      const result = await computeRollup.mutateAsync({
        data: {
          inputs: mergedInputs,
          ...(activeOverlayId !== "" && {
            actualsOverlayId: activeOverlayId,
          }),
        },
      });
      setRollup(result);

      queryClient.invalidateQueries({ queryKey: getListScenariosQueryKey() });
      
      toast({
        title: "Report Generated",
        description: "Commercial pricing scenario has been updated and recalculated.",
      });
    } catch (err: unknown) {
      toast({
        title: "Error saving scenario",
        description: err instanceof Error ? err.message : "Failed to generate report.",
        variant: "destructive",
      });
    } finally {
      setIsComputing(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const handleNumberChange = (field: keyof CommercialAssumptions, valStr: string, isPercent = false) => {
    if (valStr === "") {
      setAssumptions((previous) => ({ ...previous, [field]: undefined }));
      return;
    }
    const val = parseFloat(valStr);
    if (isNaN(val)) return;
    setAssumptions(prev => ({
      ...prev,
      [field]: isPercent ? val / 100 : val
    }));
  };

  return (
    <div className="flex flex-col h-full print:block print:h-auto">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8 print:hidden">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-3">
            Commercial Pricing
          </h1>
          <p className="text-muted-foreground mt-1">
            Model supplier-side economics, investment recovery, and target client price.
          </p>
        </div>
        
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 w-full md:w-auto">
          <label htmlFor="pricing-scenario" className="sr-only">Saved scenario</label>
          <select
            id="pricing-scenario"
            className="flex h-10 w-full sm:w-[240px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            value={selectedScenarioId}
            onChange={(e) => handleScenarioChange(e.target.value)}
            disabled={isScenariosLoading}
          >
            <option value="">Select a scenario...</option>
            {scenarios?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          <label htmlFor="pricing-calibration" className="sr-only">
            Cost calibration
          </label>
          <select
            id="pricing-calibration"
            className="flex h-10 w-full sm:w-[240px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            value={activeOverlayId}
            onChange={(event) =>
              setActiveOverlayId(
                event.target.value ? Number(event.target.value) : "",
              )
            }
            disabled={!selectedScenarioId || isOverlaysLoading || isComputing}
          >
            <option value="">Architecture estimates</option>
            {actualsOverlays?.map((overlay) => (
              <option key={overlay.id} value={overlay.id}>
                {overlay.clientLabel || `Actuals overlay #${overlay.id}`}
              </option>
            ))}
            {activeOverlayId !== "" && !activeOverlay && !isOverlaysLoading && (
              <option value={activeOverlayId}>
                Unavailable overlay #{activeOverlayId}
              </option>
            )}
          </select>

          <Button 
            variant="default" 
            onClick={handleGenerateReport} 
            disabled={!selectedScenarioId || !assumptionsReady || isComputing}
          >
            {isComputing ? <Activity className="w-4 h-4 mr-2 animate-spin" /> : <Settings2 className="w-4 h-4 mr-2" />}
            Generate Report
          </Button>

          {rollup && (
            <Button variant="outline" onClick={handlePrint} disabled={isComputing}>
              <Printer className="w-4 h-4 mr-2" />
              Save PDF
            </Button>
          )}
        </div>
      </div>

      {!isScenariosLoading && scenarios?.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-12 border-2 border-dashed border-border rounded-xl print:hidden">
          <DollarSign className="w-12 h-12 text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-semibold text-foreground">No saved scenarios yet</h3>
          <p className="text-muted-foreground max-w-sm mt-2">
            Create and save a business-case scenario before generating a commercial pricing report.
          </p>
          <Link href="/scenario" className="mt-5">
            <Button>Create Scenario</Button>
          </Link>
        </div>
      ) : !selectedScenarioId ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-12 border-2 border-dashed border-border rounded-xl print:hidden">
          <DollarSign className="w-12 h-12 text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-semibold text-foreground">No Scenario Selected</h3>
          <p className="text-muted-foreground max-w-sm mt-2">
            Select a saved scenario from the dropdown above to load its inputs and configure commercial pricing assumptions.
          </p>
        </div>
      ) : (
        <div className="flex flex-col lg:flex-row gap-8 items-start print:hidden">
          
          {/* Left Column: Editable Assumptions */}
          <div className="w-full lg:w-[320px] shrink-0 space-y-6">
            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="bg-muted/50 p-4 border-b border-border">
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  <Settings2 className="w-4 h-4 text-primary" />
                  Commercial Assumptions
                </h3>
              </div>
              <div className="p-4 space-y-5">
                
                <div className="space-y-1.5">
                   <label className="text-xs font-medium text-foreground">Target Gross Margin (%)</label>
                  <div className="relative">
                    <input 
                      type="number"
                      step="0.1"
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      min="0"
                      max="95"
                      required
                      value={assumptions.targetGrossMargin === undefined ? "" : Number(assumptions.targetGrossMargin * 100).toFixed(1)}
                      onChange={(e) => handleNumberChange("targetGrossMargin", e.target.value, true)}
                    />
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">%</div>
                  </div>
                  <p className="text-[10px] text-muted-foreground">Desired gross margin on run and setup</p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Target Clients</label>
                  <input 
                    type="number"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    min="1"
                    step="1"
                    required
                    value={assumptions.targetClients ?? ""}
                    onChange={(e) => handleNumberChange("targetClients", e.target.value)}
                  />
                  <p className="text-[10px] text-muted-foreground">Expected clients sharing product investment</p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Product Recovery (Months)</label>
                  <input 
                    type="number"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    min="1"
                    max="240"
                    step="1"
                    required
                    value={assumptions.productRecoveryMonths ?? ""}
                    onChange={(e) => handleNumberChange("productRecoveryMonths", e.target.value)}
                  />
                  <p className="text-[10px] text-muted-foreground">Amortization period for reusable build</p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Support Team (FTE)</label>
                  <input 
                    type="number"
                    step="0.1"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    min="0"
                    required
                    value={assumptions.supportTeamFte ?? ""}
                    onChange={(e) => handleNumberChange("supportTeamFte", e.target.value)}
                  />
                  <p className="text-[10px] text-muted-foreground">Shared support capacity</p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Support Hourly Cost (USD)</label>
                  <div className="relative">
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">$</div>
                    <input 
                      type="number"
                      className="flex h-9 w-full rounded-md border border-input bg-transparent pl-7 pr-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      min="0"
                      required
                      value={assumptions.supportHourlyCostUsd ?? ""}
                      onChange={(e) => handleNumberChange("supportHourlyCostUsd", e.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Support Tooling/Yr (USD per Client)</label>
                  <div className="relative">
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">$</div>
                    <input 
                      type="number"
                      className="flex h-9 w-full rounded-md border border-input bg-transparent pl-7 pr-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      min="0"
                      required
                      value={assumptions.supportToolingAnnualUsdPerClient ?? ""}
                      onChange={(e) => handleNumberChange("supportToolingAnnualUsdPerClient", e.target.value)}
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground">Monitoring and service management cost</p>
                </div>

              </div>
              <div className="px-4 py-3 border-t border-border bg-muted/20 text-[10px] leading-relaxed text-muted-foreground flex gap-2">
                <DatabaseZap className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                {activeOverlayId === ""
                  ? "Token and operating costs use architecture estimates."
                  : `Measured values are applied from ${calibrationLabel}.`}
              </div>
            </div>
          </div>

          {/* Right Column: Screen Report View */}
          <div className="flex-1 w-full bg-background border border-border shadow-sm rounded-xl overflow-hidden relative min-h-[500px]">
            {isComputing && (
              <div className="absolute inset-0 z-10 bg-background/80 backdrop-blur-sm flex flex-col items-center justify-center">
                <Activity className="w-8 h-8 text-primary animate-pulse mb-3" />
                <div className="text-sm font-medium">Recomputing Pricing Model...</div>
              </div>
            )}
            
            {rollup ? (
              <div className="p-8">
                <ReportView
                  rollup={rollup}
                  scenarioName={selectedScenario?.name ?? "Selected scenario"}
                  calibrationLabel={calibrationLabel}
                />
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-center p-12 h-full">
                <p className="text-muted-foreground text-sm">Loading pricing model data...</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Print Portal Mount */}
      {rollup && (
        <PrintPortal>
          <div className="hidden print:block w-full">
            <ReportView
              rollup={rollup}
              scenarioName={selectedScenario?.name ?? "Selected scenario"}
              calibrationLabel={calibrationLabel}
            />
          </div>
        </PrintPortal>
      )}

    </div>
  );
}
