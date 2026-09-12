import { useRef, useState } from "react";
import {
  useDraftOnboardingChecklistProfile,
  type OnbChecklistProfileInput,
  type OnbChecklistProfileDraftResponse,
} from "@workspace/api-client-react";
import { Button, cn, Label, Badge } from "@/components/ui-shared";
import { AlertTriangle, Bot, Check, X } from "lucide-react";
import {
  acceptDraftError,
  acceptDraftResponse,
  editDraftDescription,
  handoffDraftToProfileEditor,
  initialDrafterState,
  readDraftError,
  startDraftGeneration,
  type DrafterState,
} from "./checklist-profile-drafter-logic";

type ChecklistProfileDrafterProps = {
  onReview: (profile: OnbChecklistProfileInput) => void;
};

export function ChecklistProfileDrafter({ onReview }: ChecklistProfileDrafterProps) {
  const draftProfile = useDraftOnboardingChecklistProfile();
  const [draftDescription, setDraftDescription] = useState("");
  const [state, setState] = useState<DrafterState>(initialDrafterState);
  const generationRef = useRef(initialDrafterState.generation);

  const nextGeneration = () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    return generation;
  };

  const handleGenerate = () => {
    const generation = nextGeneration();
    setState((current) => startDraftGeneration(current, generation));
    draftProfile.mutate({ data: { description: draftDescription } }, {
      onSuccess: (result) => {
        if (generationRef.current !== generation) return;
        setState((current) => acceptDraftResponse(current, generation, result));
      },
      onError: (error) => {
        if (generationRef.current !== generation) return;
        setState((current) => acceptDraftError(
          current,
          generation,
          readDraftError(error),
        ));
      },
    });
  };

  const handleDescriptionChange = (value: string) => {
    setDraftDescription(value);
    const generation = nextGeneration();
    setState((current) => editDraftDescription(current, generation));
  };

  const result = state.result;
  return (
    <div className="mb-6 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <Bot className="h-5 w-5 text-[var(--primary)]" />
        <h4 className="font-bold text-[var(--text-sm)] text-[var(--text-primary)]">AI Policy Drafter</h4>
      </div>
      <p className="mb-4 text-[var(--text-sm)] text-[var(--text-muted)]">
        Describe the onboarding policy, matching criteria, and checklist items in plain language. The AI will translate this into a structured, tenant-safe profile proposal.
      </p>

      <textarea
        data-testid="input-draft-description"
        className="mb-3 flex h-24 w-full resize-none rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[8px] text-[var(--text-sm)] shadow-sm transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
        placeholder="e.g. Create a policy for remote software engineers in Canada. They need to sign the remote work agreement and complete the security training before day 1."
        value={draftDescription}
        onChange={(event) => handleDescriptionChange(event.target.value)}
      />

      <div className="flex justify-end">
        <Button
          data-testid="button-generate-checklist-profile"
          onClick={handleGenerate}
          disabled={!draftDescription.trim() || draftProfile.isPending}
          className="gap-2"
        >
          <Bot className={cn("h-4 w-4", draftProfile.isPending && "animate-pulse")} />
          {draftProfile.isPending ? "Generating..." : "Generate Proposal"}
        </Button>
      </div>

      {state.error && (
        <div className="mt-4 space-y-3">
          <div
            data-testid="status-draft-error"
            className="flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--status-red-bg)] p-3 text-[var(--status-red-fg)] text-[var(--text-sm)]"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{state.error}</p>
          </div>
          {state.unsupportedRequests.length > 0 && (
            <div className="rounded border border-[var(--status-red)] bg-[var(--status-red-bg)] p-3 text-[var(--status-red-fg)] text-[var(--text-sm)]">
              <span className="mb-1 flex items-center gap-1 font-semibold">
                <X className="h-4 w-4" /> Unsupported Requests
              </span>
              <ul className="list-disc space-y-1 pl-5">
                {state.unsupportedRequests.map((request, index) => (
                  <li key={`${request}-${index}`}>{request}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {result && <DraftResult result={result} state={state} onAcknowledge={(acknowledged) => setState((current) => ({ ...current, humanAcknowledged: acknowledged }))} onReview={() => onReview(handoffDraftToProfileEditor(result.proposal))} />}
    </div>
  );
}

function DraftResult({
  result,
  state,
  onAcknowledge,
  onReview,
}: {
  result: OnbChecklistProfileDraftResponse;
  state: DrafterState;
  onAcknowledge: (acknowledged: boolean) => void;
  onReview: () => void;
}) {
  return (
    <div className="mt-6 border-t border-[var(--border)] pt-5">
      <div className="mb-4 flex items-center justify-between">
        <h5 className="font-semibold text-[var(--text-sm)]">Proposed Policy Configuration</h5>
        <Badge className="bg-[var(--status-info-bg)] text-[var(--status-info-fg)] shadow-none">Simulated Match</Badge>
      </div>

      <div className="mb-4 rounded border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-[var(--text-sm)] text-[var(--text-secondary)]">
        <span className="mb-1 block font-semibold">AI Rationale:</span>
        {result.rationale}
      </div>

      {result.warnings.length > 0 && (
        <div className="mb-4 rounded border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-[var(--status-amber-fg)] text-[var(--text-sm)]">
          <span className="mb-1 flex items-center gap-1 font-semibold">
            <AlertTriangle className="h-4 w-4" /> Policy Warnings
          </span>
          <ul className="list-disc space-y-1 pl-5">
            {result.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
          </ul>
        </div>
      )}

      {result.unsupportedRequests.length > 0 && (
        <div className="mb-4 rounded border border-[var(--status-red)] bg-[var(--status-red-bg)] p-3 text-[var(--status-red-fg)] text-[var(--text-sm)]">
          <span className="mb-1 flex items-center gap-1 font-semibold">
            <X className="h-4 w-4" /> Unsupported Requests
          </span>
          <p className="mb-2 text-xs opacity-90">These requests could not be safely mapped to tenant policies.</p>
          <ul className="list-disc space-y-1 pl-5">
            {result.unsupportedRequests.map((request, index) => <li key={`${request}-${index}`}>{request}</li>)}
          </ul>
        </div>
      )}

      <div className="mb-4 rounded border border-[var(--border)] bg-[var(--surface)] p-4">
        <h6 data-testid="text-draft-proposal-name" className="mb-2 font-medium text-[var(--text-sm)]">{result.proposal.name}</h6>
        <div className="flex flex-wrap gap-2 text-[var(--text-xs)] text-[var(--text-muted)]">
          {Object.entries(result.proposal.criteria).map(([key, value]) => value ? (
            <span key={key} className="rounded bg-[var(--surface-soft)] px-2 py-1">
              <span className="font-semibold text-[var(--text-secondary)]">{key}:</span> {value}
            </span>
          ) : null)}
        </div>
        <div className="mt-3 text-[var(--text-xs)]">
          <span className="mb-1 block font-semibold">Checklist Overrides ({result.proposal.overrides.length}):</span>
          <ul className="space-y-1">
            {result.proposal.overrides.map((override, index) => (
              <li key={`${override.id}-${index}`} className="flex items-center gap-2">
                {override.enabled === false
                  ? <X className="h-3 w-3 text-[var(--status-red)]" />
                  : <Check className="h-3 w-3 text-[var(--status-green)]" />}
                <span className={override.enabled === false ? "line-through opacity-60" : ""}>{override.label || override.id}</span>
                {override.mandatory && <Badge className="ml-2 h-4 px-1 py-0 text-[9px] shadow-none">Mandatory</Badge>}
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-3 border-t border-[var(--border)] pt-3 text-[var(--text-xs)]">
          <span className="mb-1 block font-semibold">
            Effective Checklist (vs. Organization Default v{result.baseChecklistVersion}):
          </span>
          <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
            {result.proposal.effectiveChecklist.map((item) => (
              <div
                key={item.id}
                className={cn(
                  "flex items-center justify-between rounded border p-2 text-[11px]",
                  item.enabled !== false
                    ? "border-[var(--border)] bg-[var(--surface-alt)]"
                    : "border-dashed border-[var(--border)] opacity-50",
                )}
              >
                <div>
                  <span className="font-semibold">{item.label}</span>
                  <span className="ml-2 font-mono text-[var(--text-muted)]">{item.id}</span>
                </div>
                <div className="flex gap-2 text-[9px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
                  <span>{item.mandatory ? "Mandatory" : "Optional"}</span>
                  <span>{item.enforcementStage.replace("before-", "")}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mb-4 rounded border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-[var(--text-xs)] text-[var(--text-muted)]">
        <span className="mb-1 block font-semibold">Impact Preview (matches only; active cases remain unchanged)</span>
        <ul className="list-disc space-y-1 pl-5">
          <li>Considered active cases: {result.preview.activeCasesConsidered}{result.preview.activeCasesTruncated ? " (sample truncated)" : ""}</li>
          <li>Matches proposed criteria: {result.preview.matchingActiveCases}</li>
          <li>Guaranteed unchanged: {result.preview.unchangedActiveCases}</li>
          {result.preview.missingContextActiveCases > 0 && (
            <li>Missing required context: {result.preview.missingContextActiveCases}</li>
          )}
        </ul>
      </div>

      <div className="mt-6 flex flex-col justify-between gap-4 border-t border-[var(--border)] pt-4 sm:flex-row sm:items-center">
        <Label className="flex cursor-pointer items-center gap-2 text-[var(--text-sm)]">
          <input
            data-testid="input-acknowledge-draft"
            type="checkbox"
            className="h-4 w-4 rounded border-[var(--border)] text-[var(--primary)] focus:ring-[var(--primary)]"
            checked={state.humanAcknowledged}
            onChange={(event) => onAcknowledge(event.target.checked)}
          />
          I have reviewed the policy and acknowledge any warnings or limitations.
        </Label>
        <Button
          data-testid="button-review-draft-profile"
          disabled={!state.humanAcknowledged}
          onClick={onReview}
        >
          Review &amp; Edit Profile
        </Button>
      </div>
    </div>
  );
}