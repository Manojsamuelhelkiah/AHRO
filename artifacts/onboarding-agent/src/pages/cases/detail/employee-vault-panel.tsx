import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetEmployeeVaultSettings, useGetCaseVaultReuse, useRequestCaseVaultReuse, useConsumeCaseVaultReuse,
  getGetCaseVaultReuseQueryKey, getGetOnboardingCaseQueryKey, downloadCaseVaultDocument,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function EmployeeVaultPanel({ caseId }: { caseId: number }) {
  const settings = useGetEmployeeVaultSettings();
  const query = useGetCaseVaultReuse(caseId, { query: { queryKey: getGetCaseVaultReuseQueryKey(caseId), enabled: settings.data?.enabled === true, refetchInterval: 30000 } });
  const request = useRequestCaseVaultReuse(), consume = useConsumeCaseVaultReuse();
  const qc = useQueryClient();
  const [purpose, setPurpose] = useState("Reuse current authoritative verification for this onboarding case.");
  const [expiry, setExpiry] = useState(() => new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  const [vaultId, setVaultId] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  async function refresh() {
    await qc.invalidateQueries({ queryKey: getGetCaseVaultReuseQueryKey(caseId) });
    await qc.invalidateQueries({ queryKey: getGetOnboardingCaseQueryKey(caseId) });
  }
  async function create() {
    try {
      await request.mutateAsync({ caseId, data: { purpose, expiresAt: new Date(`${expiry}T23:59:59Z`).toISOString() } });
      await refresh(); setNotice("Request created. Send the non-authorizing link to the intended employee through your approved channel.");
    } catch (e) { setNotice(e instanceof Error ? e.message : "Request failed."); }
  }
  async function useEvidence(requestId: string) {
    try {
      await consume.mutateAsync({ caseId, data: { requestId, vaultId, acknowledgeEmployeeBinding: confirmed } });
      await refresh(); setNotice("Current reusable checks recorded. This does not verify candidate files or approve final onboarding.");
    } catch (e) { setNotice(e instanceof Error ? e.message : "Reuse failed."); }
  }
  if (settings.data?.enabled !== true) return null;
  return <section className="my-5 rounded-lg border bg-[var(--surface)] p-5 space-y-4">
    <h3 className="font-semibold">Employee Vault · optional BGV reuse</h3>
    {query.error ? <p role="alert" className="text-sm">{query.error.message}</p> : query.isLoading ? <p>Checking current consent and evidence…</p> : query.data && <>
      <p className="text-sm">{query.data.explanation}</p>
      <div className="grid gap-3 sm:grid-cols-2 text-sm">
        <div><strong>Reusable checks</strong><p>{query.data.reused.join(", ") || "None"}</p></div>
        <div><strong>Outstanding checks</strong><p>{query.data.outstanding.join(", ") || "None"}</p></div>
      </div>
      <p className="text-sm font-medium">{query.data.complete ? "Complete reusable BGV set — current consent and evidence only" : "BGV remains incomplete through Vault"}</p>
      <p className="text-xs text-[var(--text-muted)]">All employer-required checks are needed. Acceptance, candidate-document checks, governance, and final HR approval remain separate.</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] items-end">
        <div className="space-y-1"><Label htmlFor="vault-purpose">Purpose shown to employee</Label><Input id="vault-purpose" maxLength={400} value={purpose} onChange={e => setPurpose(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="vault-expiry">Request expiry</Label><Input id="vault-expiry" type="date" value={expiry} onChange={e => setExpiry(e.target.value)} /></div>
        <Button onClick={() => void create()} disabled={request.isPending || !purpose.trim()}>Request reuse</Button>
      </div>
      <div className="space-y-2 border-t pt-4">
        <Label htmlFor="confirmed-vault-id">Employee-confirmed Vault ID (not a lookup or credential)</Label>
        <Input id="confirmed-vault-id" value={vaultId} onChange={e => setVaultId(e.target.value)} placeholder="EV-…" />
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I independently confirmed this consenting employee is the person in this case. I did not infer identity from an email match or the ID alone.</label>
      </div>
      {query.data.requests.map(r => <div className="rounded-md border p-3 space-y-2 text-sm" key={r.id}>
        <div className="flex flex-wrap justify-between gap-2"><strong>{r.employer} · {r.state}</strong><span>Expires {new Date(r.expiresAt).toLocaleDateString()}</span></div>
        <p>{r.purpose}</p><p>Scope: {r.scope.join(", ")} · {r.employeeBound ? "Independently linked to this case" : "Case binding outstanding"}</p>
        <a className="break-all underline" href={`/employee-vault/requests/${r.id}`} target="_blank" rel="noreferrer">Employee consent link</a>
        {r.state === "approved" && <Button size="sm" onClick={() => void useEvidence(r.id)} disabled={!confirmed || !vaultId || consume.isPending}>Evaluate and record reuse</Button>}
        {r.state === "approved" && r.employeeBound && r.documentIds.length > 0 && <div className="flex flex-wrap gap-2">
          <p className="w-full text-xs">Separate document grants. Live sensitive-record authority is checked for each download.</p>
          {r.documentIds.map(id => <Button variant="secondary" size="sm" key={id} onClick={async () => {
            try { const blob = await downloadCaseVaultDocument(caseId, r.id, id); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "authorized-vault-document"; a.click(); URL.revokeObjectURL(url); }
            catch (e) { setNotice(e instanceof Error ? e.message : "Document access blocked."); }
          }}>Download authorized document</Button>)}
        </div>}
      </div>)}
    </>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
  </section>;
}
