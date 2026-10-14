import type { FairnessRun } from "@workspace/api-client-react";
import { Button, Card } from "@/components/ui-shared";

type Disposition = "open" | "remediation-required" | "explained";
export function FairnessRunEvidence({ run, canInvestigate, note, validNote, onInvestigate }: {
  run: FairnessRun; canInvestigate: boolean; note: string; validNote: boolean;
  onInvestigate: (pairId: string, disposition: Disposition) => void;
}) {
  return <Card className="p-5 space-y-4">
    <h2 className="font-semibold">Attempt {run.id} — {run.status}</h2>
    <p className="text-sm">{run.at} · {run.provenance} · Programme {run.programmeVersion} / scope {run.scopeRevision} / criteria {run.criteriaRevision}</p>
    <p className="text-sm">Requested model {run.model} · Prompt {run.promptVersion} · Test policy/catalog {run.catalogVersion} · Output contract {run.outputContractVersion}</p>
    <details className="text-sm"><summary>Prompt digest and reviewer receipts</summary><p className="break-all">{run.promptDigest}</p><pre className="whitespace-pre-wrap">{JSON.stringify(run.approvals, null, 2)}</pre></details>
    {run.limitation && <p role="status" className="text-[var(--status-amber)]">{run.limitation}</p>}
    {run.observations.length === 0 && <p>No completed pair observations. This attempt establishes no equality conclusion.</p>}
    {run.observations.map(observation => <div key={observation.pairId} className="rounded border border-[var(--border)] p-4 space-y-3">
      <h3 className="font-medium">{observation.pairId} — {observation.status}</h3>
      <p className="text-sm">Human-reviewed expectation: {observation.expected}. {observation.rationale}</p>
      <div className="grid md:grid-cols-2 gap-3">{observation.outputs.map((output, index) => <div key={index} className="bg-[var(--surface-alt)] p-3 rounded text-sm">
        <strong>Variant {index === 0 ? "A" : "B"}: {output?.outcome ?? "blocked"}</strong>
        <p>{output?.quotedText ?? observation.errors[index] ?? "No quotation returned."}</p>
        {observation.modelReceipts?.[index] && <p>Observed model: {observation.modelReceipts[index]?.resolvedModel}</p>}
      </div>)}</div>
      <ul className="list-disc pl-5 text-sm">{observation.differences.map(diff => <li key={diff}>{diff}</li>)}</ul>
      {observation.status === "observed-match" && <p className="text-sm">Matched expected behavior in these two observations only; not evidence of bias-free decisions.</p>}
      <details className="text-sm"><summary>Fixture, policy and input provenance</summary>
        <p className="break-all">Policy version {observation.policyVersion ?? run.catalogVersion}; digest {observation.policyDigest}</p>
        <pre className="whitespace-pre-wrap break-all">{JSON.stringify({ inputs: run.fixtures?.find(p => p.id === observation.pairId), inputDigests: observation.inputDigests, modelReceipts: observation.modelReceipts }, null, 2)}</pre>
      </details>
      {observation.status !== "observed-match" && <>
        <p className="text-sm">Investigation: {observation.investigation?.disposition ?? "open / unresolved"}. {observation.investigation?.note}</p>
        {observation.investigation && <p className="text-sm">Reviewed by {observation.investigation.reviewedBy} at {observation.investigation.at}. Original observations and discrepancy status remain unchanged.</p>}
        {canInvestigate && <div className="flex flex-wrap gap-2">{(["open", "remediation-required", "explained"] as const).map(disposition =>
          <Button key={disposition} variant="outline" disabled={!validNote || !note} onClick={() => onInvestigate(observation.pairId, disposition)}>{disposition}</Button>)}</div>}
      </>}
    </div>)}
  </Card>;
}
