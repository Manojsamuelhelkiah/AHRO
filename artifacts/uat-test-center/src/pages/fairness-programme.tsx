import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetFairnessProgramme, useApplyFairnessAction, getGetFairnessProgrammeQueryKey, downloadFairnessEvidenceReport,
  type FairnessProgrammeAction, type FairnessCriterion, type FairnessReview,
} from "@workspace/api-client-react";
import { Button, Card, PageHeader } from "@/components/ui-shared";
import { usePolicyScope } from "@/hooks/use-policies";
import { FairnessRunEvidence } from "./fairness-run-evidence";

const field = "w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm";
const outcomes = ["supported", "insufficient", "conflicting", "injected"] as const;
type Action = Omit<FairnessProgrammeAction, "expectedVersion">;
type Role = "business" | "hr-compliance" | "legal";
function errorText(error: unknown) {
  const value = error as { data?: { error?: string }; message?: string };
  return value?.data?.error ?? value?.message ?? "Action failed. Refresh the programme; no local success was assumed.";
}
function Receipts({ reviews }: { reviews: FairnessReview[] }) {
  return <ul className="space-y-1 text-sm">{(["business", "hr-compliance", "legal"] as const).map(role => {
    const review = reviews.find(r => r.role === role);
    return <li key={role}><strong>{role}</strong>: {review ? `${review.approved ? "Approved" : "Rejected"} by ${review.userId} at ${review.at}` : "Awaiting review"}
      {review && <div className="text-[var(--text-muted)]">{review.note} {review.assignmentId ? `Verified assignment ${review.assignmentId}` : "Business membership role"}</div>}</li>;
  })}</ul>;
}
export function FairnessProgrammePage() {
  const scope = usePolicyScope();
  return <Programme key={`${scope.organizationId}:${scope.userId}`} organizationId={scope.organizationId} userId={scope.userId} />;
}
function Programme({ organizationId, userId }: { organizationId?: string | null; userId?: string | null }) {
  const client = useQueryClient();
  const alive = useRef(true);
  const [controller] = useState(() => new AbortController());
  useEffect(() => () => { alive.current = false; controller.abort(); }, [controller]);
  const queryKey = [...getGetFairnessProgrammeQueryKey(), organizationId, userId];
  const query = useGetFairnessProgramme({ query: { queryKey, enabled: !!organizationId && !!userId, refetchInterval: 10_000, staleTime: 0, gcTime: 0, retry: false, refetchOnMount: "always" } });
  const mutation = useApplyFairnessAction({ request: { signal: controller.signal }, mutation: { retry: false } });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [pairIds, setPairIds] = useState<string[]>([]);
  const [criteria, setCriteria] = useState<Record<string, { expected: string; rationale: string }>>({});
  const [role, setRole] = useState<Role>("business");
  const [downloading, setDownloading] = useState(false);
  const data = query.data;
  const state = data?.programme;
  useEffect(() => { setPairIds(state?.scope?.pairIds ?? []); }, [state?.scopeRevision]);
  useEffect(() => {
    setCriteria(Object.fromEntries((state?.criteria ?? []).map(c => [c.pairId, { expected: c.expected, rationale: c.rationale }])));
  }, [state?.criteriaRevision]);
  const act = async (action: Action) => {
    if (!state) return;
    setError(null); setNotice(null);
    try {
      const updated = await mutation.mutateAsync({ data: { ...action, expectedVersion: state.version } });
      if (!alive.current) return;
      client.setQueryData(queryKey, updated);
      setNotice("Recorded. Review and result evidence is saved to this organization.");
      setNote("");
      void client.invalidateQueries({ queryKey });
    } catch (caught) {
      if (alive.current) { setError(errorText(caught)); void query.refetch(); }
    }
  };
  const download = async () => {
    setDownloading(true); setError(null);
    try {
      const report = await downloadFairnessEvidenceReport({ signal: controller.signal });
      if (!alive.current) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = "synthetic-fairness-evidence.json"; anchor.click(); URL.revokeObjectURL(url);
    } catch (caught) { if (alive.current) setError(errorText(caught)); }
    finally { if (alive.current) setDownloading(false); }
  };
  if (!data) return <Card className="p-6"><h1>Synthetic fairness evaluation</h1><p>{query.isLoading ? "Loading governed programme…" : errorText(query.error)}</p><Button onClick={() => query.refetch()}>Retry</Button></Card>;
  const caps = data.capabilities;
  const running = state!.runs.find(r => r.status === "running");
  const busy = mutation.isPending || !!running;
  const validNote = note.trim().length >= 10 && note.trim().length <= 1000;
  const scopedPairs = data.catalog.pairs.filter(p => state!.scope?.pairIds.includes(p.id));
  const selectedRole = caps.reviewerRoles.includes(role) ? role : caps.reviewerRoles[0];
  const review = (kind: "review-scope" | "review-criteria", approved: boolean) => selectedRole && act({ kind, role: selectedRole, approved, note });
  const unresolved = state!.runs.flatMap(r => r.observations).filter(o => o.status !== "observed-match" && o.investigation?.disposition !== "explained").length;
  return <div className="space-y-6">
    <PageHeader title="Synthetic fairness evaluation" subtitle="Governed paired observations for the Policy Assistant — first roadmap increment, not certification."><div className="flex gap-2"><Button variant="outline" onClick={() => query.refetch()}>Refresh</Button><Button variant="outline" disabled={downloading} onClick={download}>Download evidence</Button></div></PageHeader>
    <Link href="/" className="text-sm underline">Back to UAT Test Center</Link>
    {(error || query.error) && <p role="alert" className="rounded border p-3 text-[var(--status-red)]">{error ?? errorText(query.error)}</p>}
    {notice && <p role="status">{notice}</p>}
    <Card className="p-5 space-y-3">
      <h2 className="font-semibold">Coverage and boundaries</h2>
      <p>{data.catalog.scope.title}. {data.catalog.scope.description}</p>
      <p className="text-sm">{scopedPairs.length} of {data.catalog.pairs.length} available pairs in scope · {state!.runs.length} attempts · {unresolved} unresolved pair observations</p>
      <ul className="list-disc pl-5 text-sm space-y-1">{data.catalog.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>
      <p className="text-sm">No real employee information or protected-characteristic data may be entered. Review notes are for fixture rationale and investigation only.</p>
    </Card>
    <Card className="p-5 space-y-4">
      <h2 className="font-semibold">1. Define and review decision scope</h2>
      <p className="text-sm">Business owners define the recommendation and legitimate facts first. Three distinct authenticated business, HR-compliance and legal reviewers must then confirm the scope and irrelevant fictional variations. Specialist authority must be currently verified in Governance.</p>
      <p className="text-sm">Programme revision {state!.version} · Scope revision {state!.scopeRevision} · {caps.scopeApproved ? "Scope approved with live authority" : "Scope not approved / review required"}</p>
      <fieldset disabled={!caps.canDefine || busy} className="space-y-3">
        <legend className="font-medium">{data.catalog.scope.title}</legend>
        {data.catalog.pairs.map(pair => <label key={pair.id} className="block rounded border border-[var(--border)] p-3">
          <input type="checkbox" checked={pairIds.includes(pair.id)} onChange={e => setPairIds(e.target.checked ? [...pairIds, pair.id] : pairIds.filter(id => id !== pair.id))} /> <strong>{pair.title}</strong>
          <div className="text-sm mt-1">{pair.variation}</div><div className="text-sm">Held constant: {pair.relevantFacts}</div>
          <details className="text-sm mt-2"><summary>Inspect both synthetic inputs and full policy</summary><pre className="whitespace-pre-wrap">{pair.variants.map(v => `${v.label}: ${v.question}`).join("\n\n") + "\n\nCandidate extract:\n" + pair.excerpt + "\n\nFull context:\n" + pair.sourceContext}</pre></details>
        </label>)}
      </fieldset>
      {state!.scope && <p className="text-sm">Recorded business rationale: {state!.scope.note}</p>}
      <label className="block text-sm">Scope, review or investigation rationale (10–1,000 characters; no personal data)
        <textarea className={field} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} disabled={busy} />
      </label>
      <p className="text-sm text-[var(--text-muted)]">Saving an action clears this box. Enter a fresh rationale of at least 10 characters to enable review or investigation. Each reviewer signs in separately; the role selector only shows that person's current authority.</p>
      {caps.canDefine && <Button disabled={busy || !validNote || !pairIds.length} onClick={() => act({ kind: "define-scope", decisionType: "policy-extract-recommendation", pairIds, note })}>Save scope / reset approvals and criteria</Button>}
      <Receipts reviews={state!.scopeReviews} />
      {caps.reviewerRoles.length > 0 && <div className="flex flex-wrap items-center gap-2">
        <label>Review as <select className={field} value={selectedRole} onChange={e => setRole(e.target.value as Role)} disabled={busy}>{caps.reviewerRoles.map(r => <option key={r}>{r}</option>)}</select></label>
        <Button disabled={busy || !state!.scope || !validNote} onClick={() => review("review-scope", true)}>Approve scope and variations</Button>
        <Button variant="outline" disabled={busy || !state!.scope || !validNote} onClick={() => review("review-scope", false)}>Reject scope</Button>
      </div>}
      {!validNote && caps.reviewerRoles.length > 0 && <p className="text-sm">Review buttons are disabled until a fresh review rationale is entered above.</p>}
    </Card>
    <Card className="p-5 space-y-4">
      <h2 className="font-semibold">2. Human-defined expected behavior</h2>
      {data.catalog.identity && <p className="text-sm">Review target: {data.catalog.identity.model} · Prompt {data.catalog.identity.promptVersion} · Output contract {data.catalog.identity.outputContractVersion}. Fixture/policy or configured model/prompt changes require renewed review.</p>}
      {!caps.scopeApproved ? <p>Acceptance criteria are locked until the scope is approved by all three reviewers with current authority.</p> : <>
        <p className="text-sm">Select the expected recommendation explicitly for both variants and explain why the legitimate facts support it. Equal but incorrect outputs remain discrepancies.</p>
        {scopedPairs.map(pair => <div key={pair.id} className="space-y-2">
          <label className="block">{pair.title}
            <select className={field} disabled={busy || !caps.canDefine} value={criteria[pair.id]?.expected ?? ""} onChange={e => setCriteria({ ...criteria, [pair.id]: { rationale: criteria[pair.id]?.rationale ?? "", expected: e.target.value } })}>
              <option value="">Choose expected recommendation</option>{outcomes.map(o => <option key={o}>{o}</option>)}
            </select>
          </label>
          <label className="block text-sm">Job-relevant rationale<textarea className={field} maxLength={1000} disabled={busy || !caps.canDefine} value={criteria[pair.id]?.rationale ?? ""} onChange={e => setCriteria({ ...criteria, [pair.id]: { expected: criteria[pair.id]?.expected ?? "", rationale: e.target.value } })} /></label>
        </div>)}
        {caps.canDefine && <Button disabled={busy || !scopedPairs.length || scopedPairs.some(p => !outcomes.includes(criteria[p.id]?.expected as typeof outcomes[number]) || (criteria[p.id]?.rationale.trim().length ?? 0) < 10)}
          onClick={() => act({ kind: "set-criteria", criteria: scopedPairs.map(p => ({ pairId: p.id, expected: criteria[p.id].expected, rationale: criteria[p.id].rationale })) as FairnessCriterion[] })}>Save criteria / reset criteria reviews</Button>}
      </>}
      <Receipts reviews={state!.criteriaReviews} />
      {caps.reviewerRoles.length > 0 && <div className="flex gap-2">
        <Button disabled={busy || !caps.scopeApproved || !state!.criteria.length || !validNote} onClick={() => review("review-criteria", true)}>Approve criteria as {selectedRole}</Button>
        <Button variant="outline" disabled={busy || !caps.scopeApproved || !state!.criteria.length || !validNote} onClick={() => review("review-criteria", false)}>Reject criteria</Button>
      </div>}
    </Card>
    <Card className="p-5 space-y-3">
      <h2 className="font-semibold">3. Run paired observations</h2>
      <p className="text-sm">Uses the production bounded AI extract selector against fixed synthetic inputs. No live case reads, registered-agent tools or workflow effects are invoked. Each run makes two model requests per scoped pair; failed or interrupted requests remain blocked, not passed.</p>
      <Button disabled={busy || !caps.canDefine || !caps.criteriaApproved} onClick={() => act({ kind: "run" })}>{mutation.isPending ? "Recording / running…" : running ? "Paired run in progress" : "Run approved synthetic pairs"}</Button>
      {!caps.criteriaApproved && <p className="text-sm">Current scope and criteria approvals are required before execution.</p>}
      {running && caps.canDefine && <Button variant="outline" disabled={mutation.isPending || Date.now() - new Date(running.at).getTime() < 600000} onClick={() => act({ kind: "recover" })}>Close interrupted run (after 10 minutes)</Button>}
    </Card>
    {state!.runs.map(run => <FairnessRunEvidence key={run.id} run={run} canInvestigate={caps.reviewerRoles.includes("hr-compliance") && !busy} note={note} validNote={validNote}
      onInvestigate={(pairId, disposition) => act({ kind: "investigate", runId: run.id, pairId, disposition, note })} />)}
    <Card className="p-5"><h2 className="font-semibold">Review and observation history</h2><ul className="text-sm space-y-2 mt-3">{[...state!.evidence].reverse().map((event, i) => <li key={`${event.version}-${i}`}>Revision {event.version} · {event.at} · {event.kind} · {event.provenance}<div>{event.actor}: {event.note}</div></li>)}</ul></Card>
  </div>;
}
