import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPricingRateSets,
  useCreatePricingRateSet,
  getListPricingRateSetsQueryKey,
  PricingRateSetVersion,
} from "@workspace/api-client-react";
import { format } from "date-fns";
import { BookOpen, Calendar, Clock, User, Save, ShieldAlert, Plus, CheckCircle2, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ModelRates {
  pricePerCallUsd: number;
  inputPricePerMillionTokens: number;
  outputPricePerMillionTokens: number;
}

interface FlowBuildRates {
  buildCostUsd: number;
  amortizationTransactions: number;
}

interface PricingRateSnapshot {
  slmCallCost: number;
  llmCallCost: number;
  frontierCallCost: number;
  dataCallCost: number;

  mcpActionCost: number;
  infraPerTxn: number;

  modelRates: Record<string, ModelRates>;
  flowBuildRates: Record<string, FlowBuildRates>;

  onboardingBase: number;
  onboardingPerSystem: number;
  onboardingPerCountry: number;

  knowledgeMaintenancePerCountry: number;

  supportTeamFte: number;
  supportHourlyCostUsd: number;
  supportToolingAnnualUsdPerClient: number;
}

type DefaultCallCostKey =
  | "slmCallCost"
  | "llmCallCost"
  | "frontierCallCost"
  | "dataCallCost";

const DEFAULT_MODEL_BY_CALL_COST: Record<DefaultCallCostKey, string> = {
  slmCallCost: "gpt-5-mini",
  llmCallCost: "gpt-5",
  frontierCallCost: "claude-opus",
  dataCallCost: "ldm-schema-grounded",
};

const DEFAULT_MODEL_KEYS = new Set(Object.values(DEFAULT_MODEL_BY_CALL_COST));

const formatUsd = (val: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(val || 0);

export default function RateRegister() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: register, isLoading, isError } = useListPricingRateSets();
  const createRateSet = useCreatePricingRateSet();

  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState<PricingRateSnapshot | null>(null);
  const [effectiveDate, setEffectiveDate] = useState("");
  const [rationale, setRationale] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  const current = register?.current;
  const versions = register?.versions || [];
  const canManage = register?.canManage ?? false;

  if (isLoading) {
    return <div className="p-8 text-center text-muted-foreground animate-pulse">Loading rate register...</div>;
  }

  if (isError) {
    return <div className="p-8 text-center text-destructive">Failed to load rate register.</div>;
  }

  const handleStartCreate = () => {
    if (!canManage) {
      toast({
        title: "Permission required",
        description: "Only designated commercial rate managers can publish global rate versions.",
        variant: "destructive",
      });
      return;
    }
    if (!current || !current.rates) {
      toast({ title: "No Baseline", description: "Cannot create a new rate set without an existing baseline.", variant: "destructive" });
      return;
    }

    // Set a deliberate default: tomorrow's date
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    setEffectiveDate(tomorrow.toISOString().split("T")[0]);
    setRationale("");
    setFormData(JSON.parse(JSON.stringify(current.rates)));
    setIsCreating(true);
  };

  const handleCancelCreate = () => {
    setIsCreating(false);
    setFormData(null);
  };

  const updateDefaultCallCost = (
    data: PricingRateSnapshot,
    field: DefaultCallCostKey,
    value: number,
  ) => {
    const modelKey = DEFAULT_MODEL_BY_CALL_COST[field];
    const modelRate = data.modelRates[modelKey];
    setFormData({
      ...data,
      [field]: value,
      modelRates: modelRate
        ? {
            ...data.modelRates,
            [modelKey]: { ...modelRate, pricePerCallUsd: value },
          }
        : data.modelRates,
    });
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData || !effectiveDate || !rationale.trim()) {
      toast({ title: "Validation Error", description: "Effective date and rationale are required.", variant: "destructive" });
      return;
    }
    setShowConfirm(true);
  };

  const handleConfirmSave = async () => {
    setShowConfirm(false);

    if (!formData || !effectiveDate || !rationale.trim()) return;

    try {
      await createRateSet.mutateAsync({
        data: {
          effectiveDate,
          rationale,
          rates: formData as unknown as Record<string, unknown>,
        }
      });
      toast({
        title: "Rate Set Published",
        description: `Version scheduled for ${effectiveDate}.`,
      });
      queryClient.invalidateQueries({ queryKey: getListPricingRateSetsQueryKey() });
      setIsCreating(false);
      setFormData(null);
    } catch (err) {
      toast({
        title: "Error publishing rate set",
        description: err instanceof Error ? err.message : "Failed to create rate set version.",
        variant: "destructive"
      });
    }
  };

  const renderRateForm = (data: PricingRateSnapshot) => {
    if (!data.modelRates || !data.flowBuildRates) {
      return <div className="text-destructive p-4 border border-destructive/20 rounded-md bg-destructive/5">Malformed rate data: missing modelRates or flowBuildRates.</div>;
    }

    return (
      <div className="space-y-8">
        <div className="bg-card border rounded-lg p-5">
          <h3 className="text-sm font-semibold mb-4 text-primary">Azure & Operating</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label htmlFor="mcpActionCost" className="text-xs font-medium">MCP Action Cost (USD)</label>
              <input id="mcpActionCost" type="number" min="0" step="0.0001" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={data.mcpActionCost} onChange={e => setFormData({ ...data, mcpActionCost: Number(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <label htmlFor="infraPerTxn" className="text-xs font-medium">Infra Per Txn (USD)</label>
              <input id="infraPerTxn" type="number" min="0" step="0.0001" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={data.infraPerTxn} onChange={e => setFormData({ ...data, infraPerTxn: Number(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <label htmlFor="knowledgeMaint" className="text-xs font-medium">Knowledge Maintenance / Country</label>
              <input id="knowledgeMaint" type="number" min="0" max="1000000" step="0.01" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={data.knowledgeMaintenancePerCountry} onChange={e => setFormData({ ...data, knowledgeMaintenancePerCountry: Number(e.target.value) })} />
            </div>
          </div>
        </div>

        <div className="bg-card border rounded-lg p-5">
          <h3 className="text-sm font-semibold mb-4 text-primary">AI Call Cost Defaults</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="space-y-1">
              <label htmlFor="slmCallCost" className="text-xs font-medium">SLM Call (USD)</label>
              <input id="slmCallCost" type="number" min="0" max="100" step="0.0001" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={data.slmCallCost} onChange={e => updateDefaultCallCost(data, "slmCallCost", Number(e.target.value))} />
            </div>
            <div className="space-y-1">
              <label htmlFor="llmCallCost" className="text-xs font-medium">LLM Call (USD)</label>
              <input id="llmCallCost" type="number" min="0" max="100" step="0.0001" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={data.llmCallCost} onChange={e => updateDefaultCallCost(data, "llmCallCost", Number(e.target.value))} />
            </div>
            <div className="space-y-1">
              <label htmlFor="frontierCallCost" className="text-xs font-medium">Frontier Call (USD)</label>
              <input id="frontierCallCost" type="number" min="0" max="100" step="0.0001" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={data.frontierCallCost} onChange={e => updateDefaultCallCost(data, "frontierCallCost", Number(e.target.value))} />
            </div>
            <div className="space-y-1">
              <label htmlFor="dataCallCost" className="text-xs font-medium">Data Call (USD)</label>
              <input id="dataCallCost" type="number" min="0" max="100" step="0.0001" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={data.dataCallCost} onChange={e => updateDefaultCallCost(data, "dataCallCost", Number(e.target.value))} />
            </div>
          </div>
        </div>

        <div className="bg-card border rounded-lg p-5">
          <h3 className="text-sm font-semibold mb-4 text-primary">AI Model Catalog</h3>
          <p className="mb-4 text-xs text-muted-foreground">
            Default-model per-call prices stay synchronized with the role defaults above. Token rates and non-default model prices remain independently editable.
          </p>
          <div className="space-y-6">
            {Object.entries(data.modelRates).map(([modelKey, rates]) => (
              <div key={modelKey} className="pb-4 border-b border-border/50 last:border-0 last:pb-0">
                <h4 className="text-xs font-bold uppercase mb-2">{modelKey}</h4>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <label htmlFor={`priceCall-${modelKey}`} className="text-xs text-muted-foreground">
                      Price/Call{DEFAULT_MODEL_KEYS.has(modelKey) ? " (synced)" : ""}
                    </label>
                    <input id={`priceCall-${modelKey}`} type="number" min="0" max="100" step="0.0001" readOnly={DEFAULT_MODEL_KEYS.has(modelKey)} aria-readonly={DEFAULT_MODEL_KEYS.has(modelKey)} className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm read-only:bg-muted read-only:text-muted-foreground" value={rates.pricePerCallUsd} onChange={e => setFormData({ ...data, modelRates: { ...data.modelRates, [modelKey]: { ...rates, pricePerCallUsd: Number(e.target.value) } } })} />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`inputToken-${modelKey}`} className="text-xs text-muted-foreground">Input/1M Tokens</label>
                    <input id={`inputToken-${modelKey}`} type="number" min="0" step="0.01" className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm" value={rates.inputPricePerMillionTokens} onChange={e => setFormData({ ...data, modelRates: { ...data.modelRates, [modelKey]: { ...rates, inputPricePerMillionTokens: Number(e.target.value) } } })} />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`outputToken-${modelKey}`} className="text-xs text-muted-foreground">Output/1M Tokens</label>
                    <input id={`outputToken-${modelKey}`} type="number" min="0" step="0.01" className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm" value={rates.outputPricePerMillionTokens} onChange={e => setFormData({ ...data, modelRates: { ...data.modelRates, [modelKey]: { ...rates, outputPricePerMillionTokens: Number(e.target.value) } } })} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-card border rounded-lg p-5">
          <h3 className="text-sm font-semibold mb-4 text-primary">Flow Build Costs</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {Object.entries(data.flowBuildRates).map(([fcKey, rates]) => (
              <div key={fcKey} className="space-y-2">
                <h4 className="text-xs font-bold uppercase">{fcKey}</h4>
                <div className="flex gap-4">
                  <div className="flex-1 space-y-1">
                    <label htmlFor={`buildCost-${fcKey}`} className="text-[10px] text-muted-foreground">Build (USD)</label>
                    <input id={`buildCost-${fcKey}`} type="number" min="0" max="10000000" step="1" className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm" value={rates.buildCostUsd} onChange={e => setFormData({ ...data, flowBuildRates: { ...data.flowBuildRates, [fcKey]: { ...rates, buildCostUsd: Number(e.target.value) } } })} />
                  </div>
                  <div className="flex-1 space-y-1">
                    <label htmlFor={`amortTxns-${fcKey}`} className="text-[10px] text-muted-foreground">Amortization Txns</label>
                    <input id={`amortTxns-${fcKey}`} type="number" min="1" max="1000000000" step="1" className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm" value={rates.amortizationTransactions} onChange={e => setFormData({ ...data, flowBuildRates: { ...data.flowBuildRates, [fcKey]: { ...rates, amortizationTransactions: Number(e.target.value) } } })} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-card border rounded-lg p-5">
          <h3 className="text-sm font-semibold mb-4 text-primary">Implementation & Onboarding</h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1">
              <label htmlFor="onboardingBase" className="text-xs font-medium">Base (USD)</label>
              <input id="onboardingBase" type="number" min="0" max="10000000" step="0.01" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={data.onboardingBase} onChange={e => setFormData({ ...data, onboardingBase: Number(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <label htmlFor="onboardingPerSystem" className="text-xs font-medium">Per System (USD)</label>
              <input id="onboardingPerSystem" type="number" min="0" max="1000000" step="0.01" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={data.onboardingPerSystem} onChange={e => setFormData({ ...data, onboardingPerSystem: Number(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <label htmlFor="onboardingPerCountry" className="text-xs font-medium">Per Country (USD)</label>
              <input id="onboardingPerCountry" type="number" min="0" max="1000000" step="0.01" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={data.onboardingPerCountry} onChange={e => setFormData({ ...data, onboardingPerCountry: Number(e.target.value) })} />
            </div>
          </div>
        </div>

        <div className="bg-card border rounded-lg p-5">
          <h3 className="text-sm font-semibold mb-4 text-primary">Support</h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1">
              <label htmlFor="supportTeamFte" className="text-xs font-medium">Team FTE</label>
              <input id="supportTeamFte" type="number" min="0" max="100" step="0.1" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={data.supportTeamFte} onChange={e => setFormData({ ...data, supportTeamFte: Number(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <label htmlFor="supportHourly" className="text-xs font-medium">Hourly Cost (USD)</label>
              <input id="supportHourly" type="number" min="0" max="5000" step="0.01" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={data.supportHourlyCostUsd} onChange={e => setFormData({ ...data, supportHourlyCostUsd: Number(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <label htmlFor="supportTooling" className="text-xs font-medium">Tooling / Client (USD)</label>
              <input id="supportTooling" type="number" min="0" max="100000" step="0.01" className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm" value={data.supportToolingAnnualUsdPerClient} onChange={e => setFormData({ ...data, supportToolingAnnualUsdPerClient: Number(e.target.value) })} />
            </div>
          </div>
        </div>

      </div>
    );
  };

  const renderRateView = (version: PricingRateSetVersion) => {
    const data = version.rates as unknown as PricingRateSnapshot;

    if (!data.modelRates || !data.flowBuildRates) {
      return <div className="text-destructive p-4 border border-destructive/20 rounded-md bg-destructive/5">Malformed rate data: missing modelRates or flowBuildRates.</div>;
    }

    return (
      <div className="space-y-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-card border rounded-lg p-5">
            <h3 className="text-sm font-semibold mb-4 text-primary">Azure & Operating</h3>
            <div className="grid grid-cols-2 gap-y-3 gap-x-4 text-sm">
              <span className="text-muted-foreground">MCP Action</span>
              <span className="font-mono text-right">{formatUsd(data.mcpActionCost)}</span>
              <span className="text-muted-foreground">Infra / Txn</span>
              <span className="font-mono text-right">{formatUsd(data.infraPerTxn)}</span>
              <span className="text-muted-foreground">Knowledge Maint. / Country</span>
              <span className="font-mono text-right">{formatUsd(data.knowledgeMaintenancePerCountry)}</span>
            </div>
          </div>

          <div className="bg-card border rounded-lg p-5">
            <h3 className="text-sm font-semibold mb-4 text-primary">AI Call Defaults</h3>
            <div className="grid grid-cols-2 gap-y-3 gap-x-4 text-sm">
              <span className="text-muted-foreground">SLM Call</span>
              <span className="font-mono text-right">{formatUsd(data.slmCallCost)}</span>
              <span className="text-muted-foreground">LLM Call</span>
              <span className="font-mono text-right">{formatUsd(data.llmCallCost)}</span>
              <span className="text-muted-foreground">Frontier Call</span>
              <span className="font-mono text-right">{formatUsd(data.frontierCallCost)}</span>
              <span className="text-muted-foreground">Data Call</span>
              <span className="font-mono text-right">{formatUsd(data.dataCallCost)}</span>
            </div>
          </div>
        </div>

        <div className="bg-card border rounded-lg p-5">
          <h3 className="text-sm font-semibold mb-4 text-primary">AI Model Catalog</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left font-medium p-2">Model</th>
                  <th className="text-right font-medium p-2">Per Call</th>
                  <th className="text-right font-medium p-2">Input / 1M</th>
                  <th className="text-right font-medium p-2">Output / 1M</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {Object.entries(data.modelRates).map(([modelKey, rates]) => (
                  <tr key={modelKey}>
                    <td className="p-2 font-mono text-xs">{modelKey}</td>
                    <td className="p-2 text-right font-mono">{formatUsd(rates.pricePerCallUsd)}</td>
                    <td className="p-2 text-right font-mono">{formatUsd(rates.inputPricePerMillionTokens)}</td>
                    <td className="p-2 text-right font-mono">{formatUsd(rates.outputPricePerMillionTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-card border rounded-lg p-5">
            <h3 className="text-sm font-semibold mb-4 text-primary">Implementation & Support</h3>
            <div className="grid grid-cols-2 gap-y-3 gap-x-4 text-sm">
              <span className="text-muted-foreground">Onboarding Base</span>
              <span className="font-mono text-right">{formatUsd(data.onboardingBase)}</span>
              <span className="text-muted-foreground">Onboarding / System</span>
              <span className="font-mono text-right">{formatUsd(data.onboardingPerSystem)}</span>
              <span className="text-muted-foreground">Onboarding / Country</span>
              <span className="font-mono text-right">{formatUsd(data.onboardingPerCountry)}</span>
              <div className="col-span-2 border-t border-border/50 my-1"></div>
              <span className="text-muted-foreground">Support Team FTE</span>
              <span className="font-mono text-right">{data.supportTeamFte}</span>
              <span className="text-muted-foreground">Support Hourly</span>
              <span className="font-mono text-right">{formatUsd(data.supportHourlyCostUsd)}</span>
              <span className="text-muted-foreground">Support Tooling / Client</span>
              <span className="font-mono text-right">{formatUsd(data.supportToolingAnnualUsdPerClient)}</span>
            </div>
          </div>

          <div className="bg-card border rounded-lg p-5">
            <h3 className="text-sm font-semibold mb-4 text-primary">Flow Build Costs</h3>
            <div className="space-y-3">
              {Object.entries(data.flowBuildRates).map(([fcKey, rates]) => (
                <div key={fcKey} className="flex justify-between items-center text-sm border-b border-border/30 pb-2 last:border-0 last:pb-0">
                  <span className="font-mono text-xs uppercase">{fcKey}</span>
                  <div className="text-right">
                    <div className="font-mono">{formatUsd(rates.buildCostUsd)}</div>
                    <div className="text-[10px] text-muted-foreground">/ {rates.amortizationTransactions.toLocaleString()} txns</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-5xl mx-auto pb-12">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-3">
            <BookOpen className="w-8 h-8 text-primary" />
            Unit Rate Register
          </h1>
          <p className="text-muted-foreground mt-1">
            Global pricing master data and cost catalogs used for commercial modeling.
          </p>
        </div>
        {!isCreating && canManage && (
          <Button onClick={handleStartCreate} className="shrink-0">
            <Plus className="w-4 h-4 mr-2" />
            New Rate Version
          </Button>
        )}
      </div>

      {!canManage && (
        <div className="mb-6 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          You can review the current register and its history. Only designated commercial rate managers can publish a new global version.
        </div>
      )}

      <div className="flex gap-8 flex-col lg:flex-row items-start">
        {/* Left Column: Editor or Viewer */}
        <div className="flex-1 w-full order-2 lg:order-1">
          {isCreating && formData ? (
            <form onSubmit={handleFormSubmit} className="space-y-6">
              <div className="bg-primary/5 border border-primary/20 rounded-xl p-5 mb-8">
                <div className="flex items-start gap-3">
                  <ShieldAlert className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                  <div className="space-y-4 flex-1">
                    <div>
                      <h3 className="font-medium text-foreground">Create New Rate Version</h3>
                      <p className="text-sm text-muted-foreground mt-1">
                        Creating a new rate set publishes an immutable snapshot. Scenario inputs and manual rate overrides defined within specific scenarios will continue to take precedence over these register defaults.
                      </p>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label htmlFor="effectiveDate" className="text-xs font-medium text-foreground">Effective Date</label>
                        <input
                          id="effectiveDate"
                          type="date"
                          required
                          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          value={effectiveDate}
                          onChange={e => setEffectiveDate(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="rationale" className="text-xs font-medium text-foreground">Rationale for change</label>
                        <input
                          id="rationale"
                          type="text"
                          required
                          placeholder="e.g. Q3 2026 Model Cost Reduction"
                          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          value={rationale}
                          onChange={e => setRationale(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {renderRateForm(formData)}

              <div className="sticky bottom-4 p-4 bg-card border shadow-lg rounded-xl flex items-center justify-end gap-3 z-10 mt-8">
                <Button type="button" variant="outline" onClick={handleCancelCreate} disabled={createRateSet.isPending}>Cancel</Button>
                <Button type="submit" disabled={createRateSet.isPending}>
                  {createRateSet.isPending ? "Publishing..." : <><Save className="w-4 h-4 mr-2" /> Publish Version</>}
                </Button>
              </div>

              <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Publish Rate Set Version</AlertDialogTitle>
                    <AlertDialogDescription>
                      Publishing a new rate set version is immutable. The new rates will apply to all future scenario pricing reports created from {effectiveDate}. Are you sure you want to proceed?
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleConfirmSave}>Publish Rates</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </form>
          ) : (
            current ? (
              <div className="space-y-6">
                <div className="bg-primary/10 border border-primary/20 rounded-xl p-5 flex items-start justify-between">
                  <div className="flex items-start gap-4">
                    <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                      <CheckCircle2 className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h2 className="font-semibold text-lg flex items-center gap-2">
                        Rate set v{current.id}
                        <span className="text-muted-foreground font-normal text-sm">&middot;</span>
                        <span className="text-foreground text-base">effective {format(new Date(current.effectiveDate + "T00:00:00Z"), "d MMM yyyy")}</span>
                      </h2>
                      <p className="text-sm text-primary mb-2">Currently effective</p>
                      <div className="text-sm text-muted-foreground">
                        <span className="italic">{current.rationale}</span>
                        <span className="mx-2">&middot;</span>
                        By {current.createdBy}
                        <span className="mx-2">&middot;</span>
                        Published {format(new Date(current.createdAt), "d MMM yyyy HH:mm")}
                      </div>
                    </div>
                  </div>
                </div>
                {renderRateView(current)}
              </div>
            ) : (
              <div className="text-center p-12 border-2 border-dashed border-border rounded-xl">
                <BookOpen className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
                <h3 className="text-lg font-medium">No rates configured</h3>
                <p className="text-muted-foreground mt-2">Publish a new rate set to establish a baseline.</p>
              </div>
            )
          )}
        </div>

        {/* Right Column: Version History Sidebar */}
        {!isCreating && versions.length > 0 && (
          <div className="w-full lg:w-[320px] shrink-0 order-1 lg:order-2 space-y-4">
            <h3 className="font-semibold flex items-center gap-2 mb-4">
              <History className="w-4 h-4 text-muted-foreground" />
              Version History
            </h3>
            <div className="space-y-3">
              {versions.map((v) => {
                const isCurrent = current?.id === v.id;
                // Add explicit Z to parse as UTC start-of-day for the pure YYYY-MM-DD string
                const effDate = new Date(v.effectiveDate + "T00:00:00Z");
                const isScheduled = effDate > new Date();
                
                return (
                  <div key={v.id} className={`p-4 rounded-lg border ${isCurrent ? 'bg-primary/5 border-primary/30' : 'bg-card border-border'}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-semibold text-sm">v{v.id}</span>
                      {isCurrent && <span className="text-[10px] bg-primary text-primary-foreground px-1.5 py-0.5 rounded-full font-medium">CURRENT</span>}
                      {isScheduled && <span className="text-[10px] bg-warning text-warning-foreground px-1.5 py-0.5 rounded-full font-medium">SCHEDULED</span>}
                    </div>
                    <p className="text-sm font-medium mb-3">{v.rationale}</p>
                    
                    <div className="space-y-1.5 text-xs text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <Calendar className="w-3.5 h-3.5" />
                        Effective {format(effDate, "d MMM yyyy")}
                      </div>
                      <div className="flex items-center gap-2">
                        <User className="w-3.5 h-3.5" />
                        By {v.createdBy}
                      </div>
                      <div className="flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5" />
                        Published {format(new Date(v.createdAt), "d MMM yyyy HH:mm")}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
