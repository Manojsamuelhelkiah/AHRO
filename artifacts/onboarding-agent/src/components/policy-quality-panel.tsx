import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  getHrPolicyEvaluation, reviewHrPolicyEvaluation, runHrPolicyEvaluation,
  configureHrPolicyDrift, type HrPolicyDriftInput,
  type HrPolicyEvaluationRun, type HrPolicyEvaluationReviewInput, type HrPolicyEvaluationRunInput,
} from "@workspace/api-client-react";
import { usePolicyScope } from "../hooks/use-policies";
import { Button, Card, Input, Label } from "./ui-shared";

export function PolicyQualityPanel() {
  const scope = usePolicyScope();
  const identity = `${scope.organizationId}:${scope.userId}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const [reference, setReference] = useState("");
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [liveConfirmed, setLiveConfirmed] = useState(false);
  const [driftConfirmed, setDriftConfirmed] = useState(false);
  const [baselineRunId, setBaselineRunId] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<HrPolicyEvaluationRun | null>(null);
  const query = useQuery({
    queryKey: ["policy-quality", scope.organizationId, scope.userId],
    queryFn: ({ signal }) => getHrPolicyEvaluation({ signal }),
    enabled: Boolean(scope.organizationId && scope.userId),
    staleTime: 0, refetchInterval: 15000,
  });
  const review = useMutation({ mutationFn: (data: HrPolicyEvaluationReviewInput) => reviewHrPolicyEvaluation(data) });
  const run = useMutation({ mutationFn: (data: HrPolicyEvaluationRunInput) => runHrPolicyEvaluation(data) });
  const drift = useMutation({ mutationFn: (data: HrPolicyDriftInput) => configureHrPolicyDrift(data) });
  useEffect(() => {
    setReference(""); setReviewConfirmed(false); setLiveConfirmed(false); setDriftConfirmed(false); setBaselineRunId(""); setError(""); setSelected(null);
  }, [identity]);
  const data = query.data;
  useEffect(() => { setReviewConfirmed(false); setLiveConfirmed(false); setDriftConfirmed(false); }, [data?.benchmarkHash, data?.review?.reviewId, data?.drift?.programme?.programmeId]);
  const visibleReport = selected ? data?.runs.find(r => r.runId === selected.runId) ?? selected : null;
  const busy = review.isPending || run.isPending || drift.isPending;
  async function configureDrift(action: "approve" | "stop") {
    if (!data?.drift) return;
    const submittedIdentity = identity;
    setError("");
    try {
      await drift.mutateAsync({ action, expectedProgrammeId: data.drift.programme?.programmeId ?? null,
        ...(action === "approve" ? { baselineRunId, confirmation: data.drift.confirmation } : {}) });
      if (currentIdentity.current !== submittedIdentity) return;
      setDriftConfirmed(false); await query.refetch();
    } catch (e) {
      if (currentIdentity.current === submittedIdentity) setError(e instanceof Error ? e.message : "Drift consent could not be recorded.");
    }
  }
  async function decide(decision: "approved" | "rejected") {
    if (!data) return;
    const submittedIdentity = identity;
    setError("");
    try {
      await review.mutateAsync({
        benchmarkHash: data.benchmarkHash, expectedReviewId: data.review?.reviewId ?? null,
        decision, reference, confirmation: data.reviewConfirmation,
      });
      if (currentIdentity.current !== submittedIdentity) return;
      setReviewConfirmed(false); setLiveConfirmed(false); await query.refetch();
    } catch (e) {
      if (currentIdentity.current === submittedIdentity) setError(e instanceof Error ? e.message : "Review could not be saved.");
    }
  }
  async function evaluate(mode: "offline" | "live") {
    if (!data) return;
    const submittedIdentity = identity;
    setError("");
    try {
      const response = await run.mutateAsync({
        benchmarkHash: data.benchmarkHash, mode, requestId: crypto.randomUUID(),
        ...(mode === "live" ? { confirmation: data.liveConfirmation } : {}),
      });
      if (currentIdentity.current !== submittedIdentity) return;
      setSelected(response.run); setLiveConfirmed(false); await query.refetch();
    } catch (e) {
      if (currentIdentity.current === submittedIdentity) {
        setError(`${e instanceof Error ? e.message : "Evaluation could not be completed."} Refresh history before starting another run; an interrupted run is not a pass.`);
        void query.refetch();
      }
    }
  }
  return <Card className="p-5 space-y-4" id="policy-quality">
    <div>
      <h2 className="font-semibold text-lg">Policy answer-quality benchmarks</h2>
      <p className="text-sm text-[var(--text-secondary)]">Review fictional questions and their answer key before evaluating the constrained Policy Assistant. No employee records are used.</p>
      <p className="mt-2 text-sm font-medium">Roadmap assurance work, not a current accuracy guarantee. Offline replay checks the contract; it does not test the model’s understanding.</p>
    </div>
    {query.isLoading && <p>Loading the synthetic benchmark…</p>}
    {query.isError && <div role="alert"><p>Benchmark evidence could not be loaded.</p><Button onClick={() => void query.refetch()}>Retry</Button></div>}
    {error && <p role="alert" className="text-[var(--status-red)]">{error}</p>}
    {data && <>
      <p className="text-sm"><strong>{data.approved ? "Business-approved answer key" : "Not approved for evaluation"}</strong> · {data.cases.length} synthetic cases · {data.model} · prompt {data.promptVersion}</p>
      <p className="text-sm">{data.limitation}</p>
      <p className="text-sm">{data.currentLiveEvidence ? "A passing real-model run matches the current benchmark and selection contract." : "No passing real-model evidence matches the current model, prompt and benchmark. Offline passes do not satisfy this check."}</p>
      {data.drift && <section className="border rounded-md p-3 space-y-3" aria-label="Provider model drift programme">
        <h3 className="font-semibold">Provider model drift checks — separately opt in</h3>
        <p className="text-sm">A provider may change {data.model} without changing its name. Compare fresh fictional results and provider model/fingerprint receipts with a live baseline you have reviewed. No employee content is sent.</p>
        <p className="text-sm">At most {data.drift.maxChecks} checks over {data.drift.durationDays} days, no more than one every {data.drift.intervalHours} hours. Each check shares the tenant’s existing three-runs-per-day budget (up to {data.limits.calls} calls, {data.limits.totalCompletionTokens.toLocaleString()} completion tokens, bounded input and {data.limits.milliseconds / 1000} seconds). Input tokens also cost money. Approval does not call the provider; the runtime heartbeat runs due checks. Builds and policy publication never authorize spending.</p>
        {data.drift.programme && <div className="text-sm space-y-1">
          <p>Programme: {data.drift.programme.status} · {data.drift.programme.checksReserved}/{data.drift.maxChecks} reservations used · expires {data.drift.programme.expiresAt}</p>
          <p>Reviewed baseline: {data.drift.programme.baselineRunId} · next due {data.drift.programme.nextDueAt}</p>
          {data.drift.programme.warning && <p role="alert" className="font-semibold text-[var(--status-red)]">{data.drift.programme.warning}</p>}
          {data.drift.programme.latestRunId && <p>Latest drift evidence: {data.drift.programme.latestRunId}. Open its report below. A missing completion is unfinished, never a stability pass.</p>}
        </div>}
        {data.canReview && <>
          <Label htmlFor="policy-drift-baseline">Previously completed live baseline to review</Label>
          <select id="policy-drift-baseline" className="w-full border rounded p-2" value={baselineRunId} onChange={e => { setBaselineRunId(e.target.value); setDriftConfirmed(false); }}>
            <option value="">Select a current real-model baseline</option>
            {data.drift.eligibleBaselineIds.map(id => <option key={id} value={id}>{id}</option>)}
          </select>
          {!data.drift.eligibleBaselineIds.length && <p className="text-sm">First authorize a live benchmark, inspect every result and provider receipt, then select its passing report. Scripted, failed, interrupted or isolated runs cannot be baselines.</p>}
          {baselineRunId && <Button variant="outline" onClick={() => setSelected(data.runs.find(r => r.runId === baselineRunId) ?? null)}>Inspect baseline results and receipts</Button>}
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={driftConfirmed} onChange={e => setDriftConfirmed(e.target.checked)} />{data.drift.confirmation}</label>
          <div className="flex gap-2">
            <Button disabled={busy || !data.approved || !baselineRunId || !driftConfirmed || data.drift.programme?.status === "active"} onClick={() => void configureDrift("approve")}>Approve bounded drift programme</Button>
            <Button variant="outline" disabled={busy || !data.drift.programme || data.drift.programme.status === "stopped"} onClick={() => void configureDrift("stop")}>Stop drift spending</Button>
          </div>
        </>}
        <p className="text-sm">Changed receipts or answers, failed checks and revoked authority pause the programme for review. Missing provider fingerprints mean unknown implementation stability, not proof that the model is unchanged. No automatic baseline replacement or retry of interrupted calls.</p>
      </section>}
      {data.review && <p className="text-sm">Last decision: {data.review.decision}, {data.review.reviewedAt}. Review reference: {data.review.reference}{data.review.benchmarkHash !== data.benchmarkHash ? " (superseded benchmark — review again)" : ""}</p>}
      <details>
        <summary className="cursor-pointer font-medium">Review questions, sources, audiences and expected abstentions</summary>
        <div className="mt-3 space-y-3">
          {data.cases.map(c => <article key={c.id} className="border rounded-md p-3 text-sm">
            <h3 className="font-semibold">{c.id} · {c.category}</h3>
            <p>Question: {c.question}</p>
            {c.pairing && <p>Equivalence group: {c.pairing.groupId} · language {c.pairing.language} · {c.pairing.variant}. Source, audience, dates and expected quote are unchanged across this group.</p>}
            <p>Expected: {c.expected.outcome} · {c.expected.abstain ? "Abstain; no quote or citation" : "Exact server-created quote only"} · {c.expected.modelCalled ? "Selection required" : "Blocked before model disclosure"}</p>
            {c.expected.quotedText && <p>Reviewed quote: “{c.expected.quotedText}” ({c.expected.excerptId})</p>}
            <p className="my-1">{c.expected.rationale}</p>
            <blockquote className="bg-[var(--surface-soft)] p-2">{c.source.text}</blockquote>
            <p>Source {c.source.id} v{c.source.version} ({c.source.status}); audience {c.source.audience.join(", ")}; acting role {c.role}.</p>
            <p>Source applicability: {JSON.stringify(c.source.applicability)}; requested: {JSON.stringify(c.applicability)}.</p>
            <p>Effective: {c.source.effectiveFrom}–{c.source.effectiveUntil ?? "open"}; review by {c.source.reviewBy ?? "not set"}; selected date {c.appliesOn}; fixed benchmark clock 2026-10-08.</p>
          </article>)}
        </div>
      </details>
      {data.canReview ? <div className="border rounded-md p-3 space-y-3">
        <Label htmlFor="policy-quality-review-reference">Business review evidence reference (no personal data)</Label>
        <Input id="policy-quality-review-reference" value={reference} maxLength={500} onChange={e => setReference(e.target.value)} placeholder="Approved review record or meeting reference" />
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={reviewConfirmed} onChange={e => setReviewConfirmed(e.target.checked)} />{data.reviewConfirmation}</label>
        <div className="flex gap-2">
          <Button disabled={busy || !reviewConfirmed || !reference.trim()} onClick={() => void decide("approved")}>Approve answer key</Button>
          <Button disabled={busy || !reviewConfirmed || !reference.trim()} variant="outline" onClick={() => void decide("rejected")}>Reject answer key</Button>
        </div>
      </div> : <p className="text-sm">Only a currently verified HR compliance reviewer can approve the answer key or authorize real-model runs. Organization administration alone is not sufficient.</p>}
      <div className="space-y-3">
        <Button disabled={busy || !data.approved} onClick={() => void evaluate("offline")}>Run provider-free contract replay</Button>
        {data.canReview && <div className="border rounded-md p-3 space-y-3">
        <p className="text-sm">Real-model budget: at most {data.limits.calls} calls, {data.limits.completionTokensPerCall.toLocaleString()} completion tokens per call ({data.limits.totalCompletionTokens.toLocaleString()} total), {data.limits.inputCharactersPerCall.toLocaleString()} input characters per call, {data.limits.milliseconds / 1000} seconds, and {data.limits.liveRunsPerTenantPerDay ?? 3} runs per tenant per UTC day. No automatic retries. Only fixed fictional policy text is sent.</p>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={liveConfirmed} onChange={e => setLiveConfirmed(e.target.checked)} />{data.liveConfirmation}</label>
          <Button variant="outline" disabled={busy || !data.approved || !liveConfirmed} onClick={() => void evaluate("live")}>Authorize and run real-model benchmark</Button>
        </div>}
        {busy && <p role="status">Recording review or evaluation evidence…</p>}
      </div>
      <div>
        <h3 className="font-semibold">Recent evidence</h3>
        {data.runs.length === 0 && <p className="text-sm">No evaluated runs. Approval alone is not a model-quality result.</p>}
        {data.runs.map(r => <button key={r.runId} className="block text-left text-sm underline mt-2" onClick={() => setSelected(r)}>
          {r.mode === "offline" ? "Scripted contract replay" : "Real-model synthetic run"} · {r.status} · {r.passed ?? "—"}/{r.total ?? "—"} · {r.runId}
          {r.benchmarkHash !== data.benchmarkHash || r.requestHash !== data.requestHash || r.contractHash !== data.contractHash ? " · older benchmark or selection configuration" : ""}
        </button>)}
      </div>
      {visibleReport && <div className="border rounded-md p-3 space-y-2">
        <h3 className="font-semibold">{visibleReport.mode === "offline" ? "Contract replay — not model accuracy" : "Real-model benchmark evidence"}: {visibleReport.status}</h3>
        <p className="text-sm">Outcome agreement: {visibleReport.outcomeAgreement == null ? "not measured" : `${Math.round(visibleReport.outcomeAgreement * 100)}%`} · Unsafe supported answers: {visibleReport.unsafeSupportCount ?? "not measured"}.</p>
        <p className="text-sm">Model-language pair consistency: {visibleReport.pairedConsistency == null ? "not measured (scripted replay is not model consistency)" : `${Math.round(visibleReport.pairedConsistency * 100)}%`} · Supported pair agreement: {visibleReport.pairedSupportAgreement == null ? "not measured" : `${Math.round(visibleReport.pairedSupportAgreement * 100)}%`} · Abstention pair agreement: {visibleReport.pairedAbstentionAgreement == null ? "not measured" : `${Math.round(visibleReport.pairedAbstentionAgreement * 100)}%`} · Paired failures: {visibleReport.pairedFailed ?? "not measured"}.</p>
        {visibleReport.comparison && <div className="text-sm space-y-1">
          <p className="font-semibold">Drift comparison: {visibleReport.comparison.verdict} · baseline {visibleReport.comparison.baselineRunId}</p>
          {visibleReport.comparison.warning && <p role="alert">{visibleReport.comparison.warning}</p>}
          <p>Changed cases: {visibleReport.comparison.changedCases.join(", ") || "none observed"} · fingerprint coverage: {visibleReport.comparison.fingerprintCoverage}</p>
          <p className="break-all">Baseline identities: {visibleReport.comparison.oldIdentity.join(", ")}<br />Fresh identities: {visibleReport.comparison.newIdentity.join(", ")}</p>
        </div>}
        {visibleReport.providerReceipts?.length ? <details><summary>Provider receipts (resolved model and fingerprint)</summary>
          {visibleReport.providerReceipts.map(r => <p className="text-xs break-all" key={r.responseId}>{r.responseId} · {r.resolvedModel} · fingerprint {r.systemFingerprint ?? "not supplied"}</p>)}
        </details> : null}
        {visibleReport.status === "running" && <p className="text-sm">No completion evidence has been recorded. An interrupted run remains unfinished and will not be automatically retried.</p>}
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr><th className="text-left">Case</th><th>Expected</th><th>Observed</th><th>Result</th></tr></thead>
          <tbody>{visibleReport.results?.map(r => <tr key={r.caseId}><td>{r.caseId}</td><td className="text-center">{r.expected}</td><td className="text-center">{r.actual}</td><td className="text-center">{r.passed ? "Passed" : "Failed"}</td></tr>)}</tbody>
        </table></div>
        {visibleReport.pairs && <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr><th className="text-left">Paired questions</th><th>Language / variant</th><th>Evidence</th><th>Consistent</th><th>Both correct</th></tr></thead>
          <tbody>{visibleReport.pairs.map(p => <tr key={p.variantCaseId}>
            <td>{p.anchorCaseId} / {p.variantCaseId}</td><td className="text-center">{p.language} / {p.variant}</td>
            <td className="text-center">{p.modelRequired ? visibleReport.mode === "live" ? "Model selection" : "Scripted replay" : "Pre-disclosure gate"}</td>
            <td className="text-center">{p.consistent ? "Yes" : "No"}</td><td className="text-center">{p.passed ? "Passed" : "Failed"}</td>
          </tr>)}</tbody>
        </table></div>}
        <Button variant="outline" onClick={() => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(visibleReport, null, 2)], { type: "application/json" }));
          const a = document.createElement("a"); a.href = url; a.download = `policy-quality-${visibleReport.runId}.json`; a.click(); URL.revokeObjectURL(url);
        }}>Download provenance and evidence</Button>
      </div>}
      <details><summary className="cursor-pointer text-sm">Current provenance</summary><p className="break-all text-xs mt-2">Benchmark: {data.benchmarkHash}<br />Prompt/request: {data.requestHash}</p></details>
    </>}
  </Card>;
}
