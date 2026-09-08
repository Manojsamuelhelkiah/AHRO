import { useState, useMemo } from "react";
import { useListIntents, useCreateCustomIntent, getListIntentsQueryKey } from "@workspace/api-client-react";
import type { CustomIntentInput } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "wouter";
import { Search, Filter, ShieldCheck, Activity, BrainCircuit, Plus, Sparkles, AlertTriangle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { IntentCorpusStatus } from "@/components/intent-corpus-status";

const FLOW_CLASSES = [
  { key: "fc1-deterministic", label: "FC1 — Deterministic Self-Service" },
  { key: "fc2-policy", label: "FC2 — Grounded Policy Answer" },
  { key: "fc3-multiagent", label: "FC3 — Multi-Agent Transaction" },
  { key: "fc4-frontier", label: "FC4 — Frontier Judgment Case" },
];

const KNOWN_DOMAINS = [
  "pay", "leave", "time", "benefits", "hire", "develop",
  "mobility", "retire", "data-admin", "policy",
];

interface FormState {
  name: string;
  domain: string;
  flowClass: string;
  description: string;
  asIsHandlingMin: string;
  toBeHumanMin: string;
  baseWeight: string;
  actGetActions: string;
  actPutActions: string;
  systemsTouchedBase: string;
  source: string;
  author: string;
}

const BLANK: FormState = {
  name: "",
  domain: "",
  flowClass: "",
  description: "",
  asIsHandlingMin: "",
  toBeHumanMin: "",
  baseWeight: "1",
  actGetActions: "2",
  actPutActions: "0",
  systemsTouchedBase: "2",
  source: "",
  author: "",
};

function validate(f: FormState): string | null {
  if (!f.name.trim()) return "Name is required";
  if (!f.domain.trim() || f.domain.trim().length > 60) return "Domain is required (max 60 chars)";
  if (!f.flowClass) return "Flow class is required";
  if (!f.description.trim()) return "Description is required";
  if (!f.source.trim()) return "Source / rationale is required";
  if (!f.author.trim()) return "Author is required";
  const asIs = Number(f.asIsHandlingMin);
  if (!Number.isFinite(asIs) || asIs < 0 || asIs > 600) return "As-is minutes must be 0–600";
  const toBe = Number(f.toBeHumanMin);
  if (!Number.isFinite(toBe) || toBe < 0 || toBe > 600) return "To-be minutes must be 0–600";
  if (toBe > asIs) return "To-be minutes must not exceed as-is minutes";
  const w = Number(f.baseWeight);
  if (!Number.isFinite(w) || w < 0.1 || w > 20) return "Weight must be 0.1–20";
  const get = Number(f.actGetActions);
  if (!Number.isInteger(get) || get < 0 || get > 50) return "GET actions must be whole number 0–50";
  const put = Number(f.actPutActions);
  if (!Number.isInteger(put) || put < 0 || put > 50) return "PUT actions must be whole number 0–50";
  const sys = Number(f.systemsTouchedBase);
  if (!Number.isInteger(sys) || sys < 1 || sys > 10) return "Systems touched must be whole number 1–10";
  return null;
}

function AddIntentDialog({ existingDomains }: { existingDomains: string[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createMutation = useCreateCustomIntent();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(BLANK);
  const [formError, setFormError] = useState<string | null>(null);

  const set = (field: keyof FormState) => (val: string) =>
    setForm((prev) => ({ ...prev, [field]: val }));
  const onInput = (field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    set(field)(e.target.value);

  const allDomains = Array.from(new Set([...KNOWN_DOMAINS, ...existingDomains])).sort();

  const handleSubmit = async () => {
    const err = validate(form);
    if (err) { setFormError(err); return; }
    setFormError(null);
    try {
      const payload: CustomIntentInput = {
        name: form.name.trim(),
        domain: form.domain.trim(),
        flowClass: form.flowClass,
        description: form.description.trim(),
        asIsHandlingMin: Number(form.asIsHandlingMin),
        toBeHumanMin: Number(form.toBeHumanMin),
        baseWeight: Number(form.baseWeight),
        actGetActions: Number(form.actGetActions),
        actPutActions: Number(form.actPutActions),
        systemsTouchedBase: Number(form.systemsTouchedBase),
        source: form.source.trim(),
        author: form.author.trim(),
      };
      await createMutation.mutateAsync({ data: payload });
      toast({ title: "Custom intent created", description: `"${form.name}" is now live in the corpus.` });
      queryClient.invalidateQueries({ queryKey: getListIntentsQueryKey() });
      setForm(BLANK);
      setOpen(false);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to create intent");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setForm(BLANK); setFormError(null); } }}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <Plus className="w-4 h-4" /> Add Intent
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" /> Add custom intent
          </DialogTitle>
          <DialogDescription>
            Custom intents join the corpus with a "custom" badge and participate in roll-ups exactly like reference intents. The flow is inherited from the chosen flow class; SMEs can then version-override it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Row 1: name + author */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Intent name <span className="text-destructive">*</span></Label>
              <Input value={form.name} onChange={onInput("name")} placeholder="e.g. Visa Support Request" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Author <span className="text-destructive">*</span></Label>
              <Input value={form.author} onChange={onInput("author")} placeholder="e.g. Jane (Mobility SME)" />
            </div>
          </div>

          {/* Row 2: domain + flow class */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Domain <span className="text-destructive">*</span></Label>
              <Input
                value={form.domain}
                onChange={onInput("domain")}
                placeholder="e.g. mobility"
                list="domain-suggestions"
              />
              <datalist id="domain-suggestions">
                {allDomains.map((d) => <option key={d} value={d} />)}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Flow class <span className="text-destructive">*</span></Label>
              <Select value={form.flowClass} onValueChange={set("flowClass")}>
                <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {FLOW_CLASSES.map((fc) => (
                    <SelectItem key={fc.key} value={fc.key}>{fc.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label className="text-xs">Description <span className="text-destructive">*</span></Label>
            <Textarea value={form.description} onChange={onInput("description")} rows={2} placeholder="Brief description of what this intent covers." />
          </div>

          {/* Minutes */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">As-is handling (min) <span className="text-destructive">*</span></Label>
              <Input type="number" min={0} max={600} value={form.asIsHandlingMin} onChange={onInput("asIsHandlingMin")} placeholder="e.g. 30" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">To-be residual (min) <span className="text-destructive">*</span></Label>
              <Input type="number" min={0} max={600} value={form.toBeHumanMin} onChange={onInput("toBeHumanMin")} placeholder="e.g. 6" />
            </div>
          </div>

          {/* Actions + weight + systems */}
          <div className="grid grid-cols-4 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">GET actions <span className="text-destructive">*</span></Label>
              <Input type="number" min={0} max={50} value={form.actGetActions} onChange={onInput("actGetActions")} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">PUT actions <span className="text-destructive">*</span></Label>
              <Input type="number" min={0} max={50} value={form.actPutActions} onChange={onInput("actPutActions")} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Volume weight</Label>
              <Input type="number" min={0.1} max={20} step={0.1} value={form.baseWeight} onChange={onInput("baseWeight")} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Systems touched</Label>
              <Input type="number" min={1} max={10} value={form.systemsTouchedBase} onChange={onInput("systemsTouchedBase")} />
            </div>
          </div>

          {/* Source */}
          <div className="space-y-1.5">
            <Label className="text-xs">Source / rationale <span className="text-destructive">*</span></Label>
            <Textarea value={form.source} onChange={onInput("source")} rows={2} placeholder="e.g. Client discovery workshop Nov 2024 — identified as high-volume gap not covered by reference corpus." />
          </div>

          {formError && (
            <p className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">{formError}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={createMutation.isPending}>
            {createMutation.isPending ? "Creating…" : "Create intent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Intents() {
  const { data: corpus, isLoading, isError, error, refetch, isFetching } = useListIntents();
  const intents = corpus?.intents;
  const [search, setSearch] = useState("");
  const [domainFilter, setDomainFilter] = useState<string>("all");

  const domains = useMemo(() => {
    if (!intents) return [];
    return Array.from(new Set(intents.map((i) => i.domain))).sort();
  }, [intents]);

  const filteredIntents = useMemo(() => {
    if (!intents) return [];
    return intents.filter((intent) => {
      const matchesSearch =
        search === "" ||
        intent.name.toLowerCase().includes(search.toLowerCase()) ||
        intent.description.toLowerCase().includes(search.toLowerCase());
      const matchesDomain = domainFilter === "all" || intent.domain === domainFilter;
      return matchesSearch && matchesDomain;
    });
  }, [intents, search, domainFilter]);

  const customCount = useMemo(() => intents?.filter((i) => (i as { isCustom?: boolean }).isCustom).length ?? 0, [intents]);

  return (
    <div className="space-y-6 h-full flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Intent Corpus</h1>
          <p className="text-muted-foreground mt-1">
            Research-backed catalog of HR intents
            {customCount > 0 && (
              <span className="ml-2 text-xs font-medium text-teal-600 dark:text-teal-400">
                +{customCount} custom
              </span>
            )}
          </p>
        </div>
        <AddIntentDialog existingDomains={domains} />
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search intents by name or description..."
            className="pl-9 bg-card border-border"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="w-full sm:w-[200px]">
          <Select value={domainFilter} onValueChange={setDomainFilter}>
            <SelectTrigger className="bg-card">
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-muted-foreground" />
                <SelectValue placeholder="Filter domain" />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Domains</SelectItem>
              {domains.map((d) => (
                <SelectItem key={d} value={d} className="capitalize">{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex-1 overflow-auto -mx-1 px-1 pb-4">
        <IntentCorpusStatus
          isLoading={isLoading}
          isError={isError}
          error={error}
          isFetching={isFetching}
          onRetry={() => { void refetch(); }}
          loading={<div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))}
          </div>}
        >
          <div className="space-y-3">
            {corpus?.customIntentsAvailable === false && (
              <div role="status" className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="flex-1">
                  <p className="font-medium text-foreground">Showing the built-in reference corpus</p>
                  <p className="text-muted-foreground">{corpus.warning}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>Retry</Button>
              </div>
            )}
            {filteredIntents.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                No intents found matching your criteria.
              </div>
            ) : (
              filteredIntents.map((intent) => {
                const isCustom = (intent as { isCustom?: boolean }).isCustom === true;
                return (
                  <Link key={intent.key} href={`/intents/${intent.key}`} className="block group">
                    <Card className={`transition-all duration-200 hover:border-primary/40 hover:shadow-md hover:bg-muted/20 ${isCustom ? "border-teal-500/30 bg-teal-500/[0.02]" : ""}`}>
                      <CardContent className="p-5 flex flex-col md:flex-row gap-4 items-start md:items-center">
                        <div className="flex-1 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-semibold text-lg text-foreground group-hover:text-primary transition-colors">
                              {intent.name}
                            </h3>
                            {isCustom && (
                              <Badge className="text-xs bg-teal-500/15 text-teal-700 dark:text-teal-300 border border-teal-500/30 hover:bg-teal-500/15">
                                <Sparkles className="w-2.5 h-2.5 mr-1" /> custom
                              </Badge>
                            )}
                            <Badge variant="secondary" className="capitalize text-xs font-medium">
                              {intent.domain}
                            </Badge>
                            <Badge variant="outline" className="text-xs bg-card font-mono">
                              {intent.flowClass}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground line-clamp-2">
                            {intent.description}
                          </p>

                          <div className="flex items-center gap-4 text-xs pt-1">
                            <div className="flex items-center gap-1.5 text-muted-foreground">
                              <ShieldCheck className="w-3.5 h-3.5" />
                              <span>Source: <span className="font-medium text-foreground/80">{intent.source.name}</span></span>
                              {intent.source.confidence === "high" && (
                                <span className="w-2 h-2 rounded-full bg-emerald-500 ml-1 inline-block" title="High Confidence" />
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-6 md:pl-6 md:border-l border-border min-w-[200px]">
                          <div className="space-y-1">
                            <div className="text-xs text-muted-foreground flex items-center gap-1">
                              <Activity className="w-3.5 h-3.5" /> As-Is Handle
                            </div>
                            <div className="font-mono text-sm font-medium">{intent.asIsHandlingMin} min</div>
                          </div>
                          <div className="space-y-1">
                            <div className="text-xs text-muted-foreground flex items-center gap-1">
                              <BrainCircuit className="w-3.5 h-3.5" /> To-Be Human
                            </div>
                            <div className="font-mono text-sm font-medium">{intent.toBeHumanMin} min</div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                );
              })
            )}
          </div>
        </IntentCorpusStatus>
      </div>
    </div>
  );
}
