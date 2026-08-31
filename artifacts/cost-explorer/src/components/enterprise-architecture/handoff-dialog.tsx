import { useState } from "react";
import { 
  EaAssessment,
  type EaHandoffSuggestion,
  useCreateEaAssessmentHandoff
} from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { Calculator, ArrowRight, Wand2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { waitForAssessmentUpdates } from "./utils";

export function HandoffDialog({ assessment }: { assessment: EaAssessment }) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [suggestion, setSuggestion] = useState<EaHandoffSuggestion | null>(null);
  
  const createHandoff = useCreateEaAssessmentHandoff();

  const handleGenerate = async () => {
    try {
      await waitForAssessmentUpdates(assessment.id);
      const generated = await createHandoff.mutateAsync({
        id: assessment.id,
      });
      setSuggestion(generated);
      toast({ 
        title: "Handoff prepared", 
        description: "Review the suggested scenario and pricing scope before using it in the calculators." 
      });
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error
        ? error.status
        : undefined;
      if (status === 409) {
        toast({ 
          title: "Conflict", 
          description: "Cannot generate handoff. The assessment is archived or was modified elsewhere.", 
          variant: "destructive" 
        });
      } else {
        toast({ 
          title: "Generation Failed", 
          description: "Failed to generate handoff from architecture scope.", 
          variant: "destructive" 
        });
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) setSuggestion(null);
    }}>
      <DialogTrigger asChild>
        <Button data-testid="button-open-handoff" variant="outline" size="sm" className="border-teal-700 bg-teal-800/50 text-teal-100 hover:bg-teal-700 hover:text-white" disabled={assessment.status === 'archived'}>
          <Calculator className="w-4 h-4 mr-2" /> Price & Scenario
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Generate Commercial Handoff</DialogTitle>
          <DialogDescription>
            Compile architecture gaps, target components, and migration waves into reviewable scope for the existing calculators.
          </DialogDescription>
        </DialogHeader>
        
        <div className="py-6 space-y-4">
          <div className="flex items-start gap-4 p-4 rounded-lg bg-muted/50 border">
            <Wand2 className="w-6 h-6 text-primary mt-0.5" />
            <div>
              <h4 className="font-semibold text-sm">Automated Scope Extraction</h4>
              <p className="text-sm text-muted-foreground mt-1">
                This will analyze the current architecture inventory ({assessment.content.currentState.business.length} business items, {assessment.content.currentState.application.length} applications), {assessment.content.gaps.length} architectural gaps, and derive the initial scenario parameters.
              </p>
            </div>
          </div>
          
          <div className="text-sm text-muted-foreground pl-10">
            <ul className="list-disc space-y-1">
               <li>Prepares a draft Scenario Builder scope for review</li>
               <li>Prepares preliminary Product Pricing scope and review notes</li>
               <li>Preserves the source gap, target component, and work-package identifiers</li>
            </ul>
          </div>

          {suggestion && (
            <div className="space-y-4" data-testid="handoff-result">
              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 dark:border-teal-900 dark:bg-teal-950/30">
                <h4 className="font-semibold text-sm">Reviewable handoff prepared</h4>
                <p className="mt-1 text-sm text-muted-foreground">
                  This is scope guidance only. The Scenario Builder and Product Pricing calculators remain the source of truth for calculated values.
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-lg border p-4">
                  <h5 className="font-medium text-sm">{suggestion.scenario.name}</h5>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground" data-testid="list-scenario-review-notes">
                    {suggestion.scenario.reviewNotes.map((note) => <li key={note}>{note}</li>)}
                  </ul>
                </div>
                <div className="rounded-lg border p-4">
                  <h5 className="font-medium text-sm">{suggestion.productPricing.name}</h5>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground" data-testid="list-pricing-review-notes">
                    {suggestion.productPricing.reviewNotes.map((note) => <li key={note}>{note}</li>)}
                  </ul>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-md bg-muted p-3">
                  <div className="font-mono text-lg font-bold" data-testid="count-handoff-gaps">{suggestion.traceability.gapIds.length}</div>
                  <div className="text-muted-foreground">Gaps</div>
                </div>
                <div className="rounded-md bg-muted p-3">
                  <div className="font-mono text-lg font-bold" data-testid="count-handoff-targets">{suggestion.traceability.targetComponentIds.length}</div>
                  <div className="text-muted-foreground">Targets</div>
                </div>
                <div className="rounded-md bg-muted p-3">
                  <div className="font-mono text-lg font-bold" data-testid="count-handoff-work-packages">{suggestion.traceability.workPackageIds.length}</div>
                  <div className="text-muted-foreground">Work packages</div>
                </div>
              </div>
            </div>
          )}
        </div>
        
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} data-testid="button-close-handoff">
            {suggestion ? "Close" : "Cancel"}
          </Button>
          {suggestion ? (
            <>
              <Button variant="outline" onClick={() => setLocation("/scenario")} data-testid="button-open-scenario-builder">
                Open Scenario Builder
              </Button>
              <Button onClick={() => setLocation("/product-pricing")} data-testid="button-open-product-pricing">
                Open Product Pricing
              </Button>
            </>
          ) : (
          <Button data-testid="button-generate-handoff" onClick={handleGenerate} disabled={createHandoff.isPending} className="bg-teal-600 hover:bg-teal-700 text-white">
            {createHandoff.isPending ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating...</>
            ) : (
              <><ArrowRight className="w-4 h-4 mr-2" /> Generate Handoff</>
            )}
          </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
