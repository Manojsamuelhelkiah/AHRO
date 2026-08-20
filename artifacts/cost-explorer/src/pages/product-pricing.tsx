import { useMemo, useState } from "react";
import {
  BadgeDollarSign,
  Bot,
  Boxes,
  Building2,
  CheckCircle2,
  CloudCog,
  Headphones,
  Info,
  Layers3,
  RefreshCcw,
  ShieldCheck,
  Workflow,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  calculatePricingModel,
  DEFAULT_PRICING_INPUTS,
  normalizePricingInputs,
  pricingAssumptionLabels,
  TOKEN_PROFILES,
  type InfrastructureTier,
  type PricingCostLine,
  type PricingInputs,
  type SecurityTier,
  type SupportTier,
  type TenantTier,
  type TokenProfile,
} from "@/lib/pricing-model";

const wholeCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const unitCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const transactionCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const monthlyAverage = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function NumberField({
  id,
  label,
  value,
  min = 0,
  step = 1,
  suffix,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min?: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type="number"
          min={min}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
          className={`bg-background font-mono ${suffix ? "pr-14" : ""}`}
          data-testid={id}
        />
        {suffix && <span className="absolute right-3 top-2.5 text-[11px] text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}

function SelectField({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="bg-background" data-testid={id}><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function OutcomeCard({
  icon: Icon,
  label,
  amount,
  detail,
  bar,
  testId,
}: {
  icon: typeof Building2;
  label: string;
  amount: number;
  detail: string;
  bar: string;
  testId: string;
}) {
  return (
    <Card className="overflow-hidden shadow-sm">
      <div className={`h-1 ${bar}`} />
      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="font-mono text-2xl font-bold" data-testid={testId}>{wholeCurrency.format(amount)}</div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function DriverTable({ title, badge, lines }: { title: string; badge: string; lines: PricingCostLine[] }) {
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">{title}</CardTitle>
          <Badge variant="outline" className="font-mono text-[10px] uppercase">{badge}</Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">Cost driver</TableHead>
              <TableHead>Calculation basis</TableHead>
              <TableHead className="pr-5 text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line) => (
              <TableRow key={line.name}>
                <TableCell className="pl-5 font-medium">{line.name}</TableCell>
                <TableCell className="max-w-md text-xs text-muted-foreground">{line.basis}</TableCell>
                <TableCell className="pr-5 text-right font-mono">{wholeCurrency.format(line.amount)}</TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableCell className="pl-5 font-semibold" colSpan={2}>Total</TableCell>
              <TableCell className="pr-5 text-right font-mono font-semibold">{wholeCurrency.format(total)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function ProductPricing() {
  const [inputs, setInputs] = useState<PricingInputs>(DEFAULT_PRICING_INPUTS);
  const model = useMemo(() => calculatePricingModel(inputs), [inputs]);
  const update = <K extends keyof PricingInputs>(key: K, value: PricingInputs[K]) => {
    setInputs((current) => normalizePricingInputs({ ...current, [key]: value }));
  };

  const labelOptions = <T extends Record<string, { label: string }>>(items: T) =>
    Object.entries(items).map(([value, meta]) => ({ value, label: meta.label }));

  return (
    <div className="space-y-6 pb-20 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 flex gap-2">
            <Badge variant="outline" className="border-blue-500/30 bg-blue-500/10 text-blue-700">Azure HLD commercial model</Badge>
            <Badge variant="secondary">USD</Badge>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Product Pricing</h1>
          <p className="mt-1 max-w-3xl text-muted-foreground">
            Convert architecture scope and committed client volume into an explainable build estimate, cost-to-serve, and commercial price.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setInputs(DEFAULT_PRICING_INPUTS)} data-testid="reset-pricing">
          <RefreshCcw className="mr-2 h-4 w-4" />Reset assumptions
        </Button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="space-y-4 xl:sticky xl:top-0 xl:self-start">
          <Card className="border-primary/20 shadow-sm">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base"><Layers3 className="h-4 w-4 text-primary" />Pricing assumptions</CardTitle>
              <CardDescription>Every control recalculates the sheet immediately.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <section className="space-y-3">
                <div className="flex items-center gap-2 border-b pb-2 text-xs font-semibold uppercase"><Building2 className="h-3.5 w-3.5 text-primary" />Client scale</div>
                <div className="grid grid-cols-2 gap-3">
                  <NumberField id="clients-in-cohort" label="Clients sharing build" value={inputs.clientsInCohort} min={1} onChange={(value) => update("clientsInCohort", value)} />
                  <NumberField id="annual-transactions" label="Annual transactions" value={inputs.annualTransactions} min={1} step={1000} onChange={(value) => update("annualTransactions", value)} />
                  <div className="col-span-2"><NumberField id="build-amortization" label="Build recovery period" value={inputs.buildAmortizationYears} min={1} suffix="years" onChange={(value) => update("buildAmortizationYears", value)} /></div>
                </div>
              </section>

              <section className="space-y-3">
                <div className="flex items-center gap-2 border-b pb-2 text-xs font-semibold uppercase"><Workflow className="h-3.5 w-3.5 text-primary" />Product surface</div>
                <div className="grid grid-cols-2 gap-3">
                  <NumberField id="channels" label="Channels" value={inputs.channels} onChange={(value) => update("channels", value)} />
                  <NumberField id="integrations" label="Integrations" value={inputs.integrations} onChange={(value) => update("integrations", value)} />
                  <NumberField id="agents" label="Agents" value={inputs.agents} min={1} onChange={(value) => update("agents", value)} />
                  <NumberField id="workflows" label="Workflows" value={inputs.workflows} onChange={(value) => update("workflows", value)} />
                </div>
              </section>

              <section className="space-y-3">
                <div className="flex items-center gap-2 border-b pb-2 text-xs font-semibold uppercase"><CloudCog className="h-3.5 w-3.5 text-primary" />Azure architecture</div>
                <SelectField id="tenant-tier" label="Tenant isolation" value={inputs.tenantTier} options={labelOptions(pricingAssumptionLabels.tenantTier)} onChange={(value) => update("tenantTier", value as TenantTier)} />
                <SelectField id="security-tier" label="Security tier" value={inputs.securityTier} options={labelOptions(pricingAssumptionLabels.securityTier)} onChange={(value) => update("securityTier", value as SecurityTier)} />
                <SelectField id="infrastructure-tier" label="Infrastructure" value={inputs.infrastructureTier} options={labelOptions(pricingAssumptionLabels.infrastructureTier)} onChange={(value) => update("infrastructureTier", value as InfrastructureTier)} />
              </section>

              <section className="space-y-3">
                <div className="flex items-center gap-2 border-b pb-2 text-xs font-semibold uppercase"><Bot className="h-3.5 w-3.5 text-primary" />AI and service</div>
                <SelectField id="token-profile" label="Token profile" value={inputs.tokenProfile} options={Object.entries(TOKEN_PROFILES).map(([value, meta]) => ({ value, label: `${meta.label} — ${meta.detail}` }))} onChange={(value) => update("tokenProfile", value as TokenProfile)} />
                <SelectField id="support-tier" label="Support tier" value={inputs.supportTier} options={labelOptions(pricingAssumptionLabels.supportTier)} onChange={(value) => update("supportTier", value as SupportTier)} />
              </section>

              <section className="space-y-3 rounded-md border bg-muted/30 p-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-semibold">Target gross margin</Label>
                  <span className="font-mono text-lg font-bold text-primary" data-testid="gross-margin-value">{inputs.grossMarginPct}%</span>
                </div>
                <Slider min={30} max={85} step={1} value={[inputs.grossMarginPct]} onValueChange={([value]) => update("grossMarginPct", value)} aria-label="Target gross margin" />
              </section>
            </CardContent>
          </Card>
        </aside>

        <main className="min-w-0 space-y-6">
          <Card className="overflow-hidden border-slate-800 bg-slate-950 text-white shadow-lg">
            <CardContent className="p-5 md:p-7">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-blue-300">Recommended commercial position</div>
                  <div className="font-mono text-4xl font-bold md:text-5xl" data-testid="recommended-annual-price">{wholeCurrency.format(model.recommendedAnnualCommitment)}</div>
                  <div className="mt-2 text-sm text-slate-300">annual subscription at {inputs.grossMarginPct}% gross margin</div>
                </div>
                <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                  {[
                    ["Monthly", wholeCurrency.format(model.recommendedMonthlySubscription)],
                    ["Unit cost", unitCurrency.format(model.unitTransactionCost)],
                    ["One-time fee", wholeCurrency.format(model.recommendedImplementationFee)],
                    ["Annual run-rate", wholeCurrency.format(model.annualRunRate)],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
                      <div className="mt-1 font-mono text-lg font-semibold">{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {inputs.grossMarginPct < 50 && (
            <Alert className="border-amber-500/40 bg-amber-500/10">
              <Info className="h-4 w-4 text-amber-600" />
              <AlertTitle>Margin buffer is thin</AlertTitle>
              <AlertDescription>Below 50%, normal Azure price movement and support variance can quickly erode the commercial case.</AlertDescription>
            </Alert>
          )}

          <section>
            <h2 className="text-lg font-semibold">Four commercial answers</h2>
            <p className="mb-3 text-sm text-muted-foreground">One-time investment is kept separate from recurring supplier cost.</p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <OutcomeCard icon={Boxes} label="Shared product build" amount={model.platformBuild} detail={`Reusable platform investment, shared across ${integer.format(inputs.clientsInCohort)} clients over ${inputs.buildAmortizationYears} years.`} bar="bg-violet-500" testId="platform-build-cost" />
              <OutcomeCard icon={Building2} label="Client implementation" amount={model.clientImplementation} detail="One-time tenant onboarding, integration, workflow and security configuration." bar="bg-amber-500" testId="implementation-cost" />
              <OutcomeCard icon={CloudCog} label="Hosting + AI" amount={model.annualHostingAndAi} detail="Annual Azure services and AI consumption at full committed volume." bar="bg-blue-500" testId="hosting-ai-cost" />
              <OutcomeCard icon={Headphones} label="Support + maintenance" amount={model.annualSupport} detail="Annual service operations, agent quality and workflow maintenance." bar="bg-emerald-500" testId="support-cost" />
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">Annual cost bridge</CardTitle>
                <CardDescription>Recurring supplier COGS plus this client&apos;s share of the platform build.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {[
                  ["Hosting + AI", model.annualHostingAndAi],
                  ["Support", model.annualSupport],
                  ["Shared build recovery", model.annualSharedBuildAllocation],
                ].map(([label, amount]) => (
                  <div key={label as string} className="flex justify-between gap-4 border-b pb-2">
                    <span className="text-muted-foreground">{label}</span><span className="font-mono">{wholeCurrency.format(amount as number)}</span>
                  </div>
                ))}
                <div className="flex justify-between gap-4 pt-1 font-semibold"><span>Annual cost to serve</span><span className="font-mono">{wholeCurrency.format(model.annualRunRate)}</span></div>
                <div className="flex justify-between gap-4 text-primary"><span>Recommended annual price</span><span className="font-mono font-semibold">{wholeCurrency.format(model.recommendedAnnualCommitment)}</span></div>
              </CardContent>
            </Card>

            <Card className="border-primary/20 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><BadgeDollarSign className="h-4 w-4 text-primary" />Packaging options</CardTitle>
                <CardDescription>Equivalent ways to commercialize the same committed volume.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border bg-primary/5 p-3 sm:col-span-2">
                  <div className="text-xs font-semibold uppercase text-primary">Monthly subscription</div>
                  <div className="font-mono text-xl font-bold">{wholeCurrency.format(model.recommendedMonthlySubscription)}</div>
                  <div className="text-xs text-muted-foreground">Annual pool of {integer.format(model.includedAnnualTransactions)} transactions (~{monthlyAverage.format(model.averageMonthlyTransactions)} / month)</div>
                </div>
                {[
                  ["Annual commitment", wholeCurrency.format(model.recommendedAnnualCommitment)],
                  ["Transaction-only", transactionCurrency.format(model.recommendedTransactionPrice)],
                  ["Overage", transactionCurrency.format(model.recommendedOveragePrice)],
                  ["Implementation fee", wholeCurrency.format(model.recommendedImplementationFee)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-md border p-3">
                    <div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
                    <div className="mt-1 font-mono text-lg font-bold">{value}</div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card className="border-dashed bg-muted/25">
            <CardContent className="grid gap-4 p-4 md:grid-cols-3">
              <div className="flex gap-3"><CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" /><div><div className="text-sm font-medium">Margin is applied to cost</div><div className="text-xs text-muted-foreground">Price = cost ÷ (1 − target margin).</div></div></div>
              <div className="flex gap-3"><ShieldCheck className="mt-0.5 h-4 w-4 text-blue-600" /><div><div className="text-sm font-medium">Build is shared once</div><div className="text-xs text-muted-foreground">Only the amortized client allocation enters run-rate.</div></div></div>
              <div className="flex gap-3"><BadgeDollarSign className="mt-0.5 h-4 w-4 text-violet-600" /><div><div className="text-sm font-medium">Implementation stays one-time</div><div className="text-xs text-muted-foreground">The client delivery fee is priced separately.</div></div></div>
            </CardContent>
          </Card>

          <section className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold">Explainable calculation</h2>
              <p className="text-sm text-muted-foreground">Every headline value reconciles to a visible cost driver and basis.</p>
            </div>
            <DriverTable title="Shared platform build" badge="One-time shared" lines={model.productBuildLines} />
            <DriverTable title="Client implementation" badge="One-time client" lines={model.implementationLines} />
            <DriverTable title="Azure hosting and AI" badge="Annual COGS" lines={model.recurringLines} />
            <DriverTable title="Support and maintenance" badge="Annual service" lines={model.supportLines} />
          </section>
        </main>
      </div>
    </div>
  );
}