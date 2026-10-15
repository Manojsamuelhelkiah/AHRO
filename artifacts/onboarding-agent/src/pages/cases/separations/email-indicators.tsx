import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useUpdateOffboardingEmailIndicators, useReviewOffboardingEmailIndicators, getGetOffboardingExchangesQueryKey, type OffboardingExchangeView } from "@workspace/api-client-react";
import { Button, Input } from "@/components/ui-shared";
import { Field, errMsg } from "./shared";

export function EmailIndicators({ view, scope }: { view: NonNullable<OffboardingExchangeView>; scope: string }) {
  const update = useUpdateOffboardingEmailIndicators(), review = useReviewOffboardingEmailIndicators(), qc = useQueryClient();
  const [error, setError] = useState(""), [consent, setConsent] = useState(""), [email, setEmail] = useState("");
  const checks = view.communicationChecks;
  const busy = update.isPending || review.isPending;
  const done = (saved: OffboardingExchangeView) => { if (saved) qc.setQueryData([...getGetOffboardingExchangesQueryKey(view.caseId), scope], saved); setError(""); setConsent(""); setEmail(""); };
  return <div className="min-w-0 space-y-2" aria-label="Case email indicators">
    <div className="flex flex-wrap gap-x-4 gap-y-2" title="Client-declared defaults; not independent recipient verification">
      <label className="inline-flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={checks.emailConsent} disabled={busy}
        onChange={e => { setError(""); update.mutate({ caseId: view.caseId, data: { expectedVersion: view.version, emailConsent: e.target.checked, emailVerified: checks.emailVerified } }, { onSuccess: done, onError: e => setError(errMsg(e)) }); }} />
        Email consent: {checks.emailConsent ? "Yes" : "No"}</label>
      <label className="inline-flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={checks.emailVerified} disabled={busy}
        onChange={e => { setError(""); update.mutate({ caseId: view.caseId, data: { expectedVersion: view.version, emailConsent: checks.emailConsent, emailVerified: e.target.checked } }, { onSuccess: done, onError: e => setError(errMsg(e)) }); }} />
        Email verified: {checks.emailVerified ? "Yes" : "No"}</label>
    </div>
    {checks.reviewRequired && <details open className="min-w-0 space-y-3 rounded-md border p-3">
      <summary className="text-sm font-medium">Emails paused — manual review required</summary>
      <p className="text-sm text-[var(--text-muted)]">Rechecking an indicator does not resume email. Record the consent and address review for the configured case contacts.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Consent review evidence"><Input value={consent} maxLength={512} onChange={e => setConsent(e.target.value)} /></Field>
        <Field label="Email review evidence"><Input value={email} maxLength={512} onChange={e => setEmail(e.target.value)} /></Field>
      </div>
      <Button size="sm" type="button" disabled={busy || !consent.trim() || !email.trim()} onClick={() => {
        setError(""); review.mutate({ caseId: view.caseId, data: { expectedVersion: view.version, consentReference: consent.trim(), emailReference: email.trim() } }, { onSuccess: done, onError: e => setError(errMsg(e)) });
      }}>Complete manual review</Button>
    </details>}
    {error && <p role="alert" className="text-sm">{error}</p>}
  </div>;
}
