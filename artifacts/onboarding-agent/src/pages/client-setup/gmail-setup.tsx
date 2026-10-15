import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetOffboardingExchangeSetup, getGetOffboardingExchangeSetupQueryKey,
  useGetOffboardingExchanges, getGetOffboardingExchangesQueryKey,
  useEnrollOffboardingExchange, useProvisionOffboardingExchanges,
  getPinnedOrganizationIdForPage,
} from "@workspace/api-client-react";
import type { GetOffboardingExchangeSetup200, OffboardingExchangeView, OffboardingRecipient } from "@workspace/api-client-react";
import { Button, Card } from "@/components/ui-shared";
import { GmailContactFields, blankGmailRecipient as blank } from "./gmail-contact-fields";
import { ClientGmailDefaults } from "./gmail-defaults";
import { useSeparationQueryScope, ErrorBox, Field, selectCls, errMsg } from "../cases/separations/shared";

type Draft = { revision: number; agentId: string; escalationEnabled: boolean; recipients: Record<string, OffboardingRecipient> };
const fresh = (view: NonNullable<OffboardingExchangeView>, choices: GetOffboardingExchangeSetup200): Draft => {
  const initial = !view.enrollment.operator && !view.enrollment.recipients.length;
  return { revision: view.enrollment.revision, escalationEnabled: view.enrollment.escalationEnabled ?? choices.defaults.escalationEnabled,
    agentId: view.enrollment.agentId ?? (initial && choices.agents.some(a => a.id === choices.defaults.agentId) ? choices.defaults.agentId : ""),
    recipients: Object.fromEntries((initial ? choices.defaults.recipients : view.enrollment.recipients).map(r => [r.taskId, { ...r }])) };
};

export function ClientGmailSetup() {
  const scope = useSeparationQueryScope();
  if (getPinnedOrganizationIdForPage() !== "demo") return null;
  return <ScopedSetup key={scope} scope={scope} />;
}
function ScopedSetup({ scope }: { scope: string }) {
  const search = useSearch();
  const [caseId, setCaseId] = useState(Number(new URLSearchParams(search).get("offboardingCaseId")) || 0);
  useEffect(() => {
    const requested = Number(new URLSearchParams(search).get("offboardingCaseId"));
    if (Number.isSafeInteger(requested) && requested > 0) setCaseId(requested);
  }, [search]);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const requestedCase = Number(new URLSearchParams(search).get("offboardingCaseId"));
  const params = Number.isSafeInteger(requestedCase) && requestedCase > 0 ? { caseId: requestedCase } : undefined;
  const key = [...getGetOffboardingExchangeSetupQueryKey(params), scope];
  const q = useGetOffboardingExchangeSetup(params, { query: { queryKey: key, retry: false, staleTime: 0, refetchInterval: 30_000 } as never });
  const provision = useProvisionOffboardingExchanges();
  const qc = useQueryClient();
  return <Card className="my-4 space-y-3 p-4" id="gmail-communication">
    <h2 className="font-semibold">Access and equipment</h2>
    <p className="text-sm text-[var(--text-muted)]">Enable email and configure contacts for the client below. Case settings are only needed for overrides or pauses. Saving sends no initial request; start the conversation from the case.</p>
    {q.isLoading ? <p role="status">Loading communication settings…</p> : q.isError ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : q.data && <>
      <ClientGmailDefaults choices={q.data} queryKey={key} />
      <Field label="Case"><select className={selectCls} value={caseId} onChange={e => setCaseId(Number(e.target.value))}>
        <option value={0}>Choose case</option>{q.data.cases.map(c => <option key={c.id} value={c.id}>S{c.id} — {c.name}</option>)}
      </select></Field>
      {!q.data.cases.length && <Button type="button" disabled={provision.isPending} onClick={() => provision.mutate({ data: { confirmAddThree: true } }, {
        onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); }, })}>Add three resignation cases</Button>}
      {provision.isError && <ErrorBox error={provision.error} />}
      {caseId > 0 && q.data.cases.some(c => c.id === caseId) && <Enrollment key={`${scope}:${caseId}`} scope={scope} caseId={caseId} choices={q.data}
        draft={drafts[caseId]} onDraft={draft => setDrafts(prev => ({ ...prev, [caseId]: draft }))} />}
    </>}
  </Card>;
}
function Enrollment({ caseId, scope, choices, draft, onDraft }: { caseId: number; scope: string; choices: GetOffboardingExchangeSetup200; draft?: Draft; onDraft: (draft: Draft) => void }) {
  const key = [...getGetOffboardingExchangesQueryKey(caseId), scope];
  const q = useGetOffboardingExchanges(caseId, { query: { queryKey: key, retry: false, staleTime: 0, refetchInterval: 20_000 } as never });
  const mutation = useEnrollOffboardingExchange();
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  if (q.isLoading) return <p role="status">Loading case contacts…</p>;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <p>No conversations are configured for this case.</p>;
  const view = q.data;
  const form = draft ?? fresh(view, choices);
  const escalationEnabled = form.escalationEnabled && choices.defaults.escalationEnabled;
  const stale = form.revision !== view.enrollment.revision;
  const patch = (value: Partial<Draft>) => { setMessage(""); onDraft({ ...form, ...value }); };
  const change = (id: string, value: Partial<OffboardingRecipient>) => patch({ recipients: { ...form.recipients, [id]: { ...(form.recipients[id] ?? blank(id)), ...value } } });
  const save = (enabled: boolean) => {
    const recipients = Object.values(form.recipients).filter(r => r.memberId);
    if (enabled && (!form.agentId || !recipients.length)) { setError("Choose an owned agent and at least one task owner."); return; }
    if (enabled && recipients.some(r => !r.address || (escalationEnabled &&
      (!r.escalationMemberId || r.escalationMemberId === r.memberId || !r.escalationAddress)))) {
      setError("Each selected task needs an owner email. Escalation contacts are required only when escalation is enabled."); return;
    }
    setError(""); setMessage("");
    mutation.mutate({ caseId, data: { expectedRevision: form.revision, enabled, escalationEnabled,
      agentId: (enabled ? form.agentId : view.enrollment.agentId) || undefined, confirmCommunicationOnly: true,
      recipients: enabled ? recipients.map(({ escalationMemberId, escalationAddress, ...r }) =>
        escalationEnabled ? { ...r, escalationMemberId, escalationAddress } : r) : view.enrollment.recipients } }, {
      onSuccess: saved => { if (saved) { qc.setQueryData(key, saved); onDraft(fresh(saved, choices)); } setMessage(enabled ? "Gmail settings saved for this case." : "Conversations paused."); },
      onError: e => setError(errMsg(e)),
    });
  };
  return <div className="min-w-0 space-y-3 break-words" aria-label="Gmail enrollment">
    <p className="text-sm">{view.enrollment.inheritsClientDefaults ? "This case uses the client's email settings. Saving below creates a case-specific override." : "Case-specific email settings."}</p>
    {view.blockers.length > 0 && <ul className="list-disc pl-5 text-sm">{view.blockers.map(b => <li key={b}>{b}</li>)}</ul>}
    {stale && <p role="alert">These settings changed. <Button type="button" variant="outline" onClick={() => onDraft(fresh(view, choices))}>Reload saved settings</Button></p>}
    <Field label="Registered agent"><select className={selectCls} value={form.agentId} onChange={e => patch({ agentId: e.target.value })}>
      <option value="">Choose your registered agent</option>{choices.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
    </select></Field>
    {!choices.agents.length && <p className="text-sm">Register an agent owned by your named account before enabling Gmail.</p>}
    {!choices.members.length && <p className="text-sm">No current contacts have approved email addresses. Configure the contacts and allowed addresses before enabling Gmail.</p>}
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={escalationEnabled}
      disabled={!choices.defaults.escalationEnabled} onChange={e => patch({ escalationEnabled: e.target.checked })} />Enable escalation for this case</label>
    {!choices.defaults.escalationEnabled && <p className="text-xs">Client escalation is disabled; no escalation contact is required.</p>}
    {view.tasks.map(t => {
      const r = form.recipients[t.id] ?? blank(t.id);
      return <fieldset key={t.id} className="min-w-0 rounded-md border p-3 space-y-2">
        <legend className="px-1 text-sm"><label><input type="checkbox" checked={!!r.memberId || !!form.recipients[t.id]} onChange={e => {
          const recipients = { ...form.recipients };
          if (e.target.checked) recipients[t.id] = { ...blank(t.id), persona: t.label };
          else delete recipients[t.id];
          patch({ recipients });
        }} /> Configure {t.label}</label></legend>
        {form.recipients[t.id] && <GmailContactFields choices={choices} recipient={r} escalationEnabled={escalationEnabled} onChange={value => change(t.id, value)} />}
      </fieldset>;
    })}
    {error && <p role="alert" className="text-sm">{error}</p>}{message && <p role="status">{message}</p>}
    <div className="flex flex-wrap gap-2"><Button type="button" disabled={mutation.isPending || stale} onClick={() => save(true)}>Save and enable case override</Button>
      <Button type="button" variant="outline" disabled={mutation.isPending || !view.enrollment.enabled || stale} onClick={() => save(false)}>Pause conversations</Button></div>
  </div>;
}
