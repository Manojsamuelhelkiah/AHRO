import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSaveOffboardingGmailDefaults, getGetOffboardingExchangesQueryKey, type GetOffboardingExchangeSetup200, type OffboardingGmailDefaults } from "@workspace/api-client-react";
import { Button } from "@/components/ui-shared";
import { Field, selectCls, errMsg } from "../cases/separations/shared";
import { GmailContactFields, blankGmailRecipient } from "./gmail-contact-fields";

const tasks = [["access-inventory", "Access inventory"], ["shared-accounts", "Shared accounts"], ["kt-access-exception", "Temporary KT access"],
  ["access-closure", "Access removal"], ["asset-inventory", "Equipment inventory"], ["asset-return", "Equipment return"]];

export function ClientGmailDefaults({ choices, queryKey }: { choices: GetOffboardingExchangeSetup200; queryKey: readonly unknown[] }) {
  const [draft, setDraft] = useState<OffboardingGmailDefaults>();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const form = draft ?? choices.defaults;
  const mutation = useSaveOffboardingGmailDefaults(), qc = useQueryClient();
  const stale = form.revision !== choices.defaults.revision;
  const change = (value: Partial<OffboardingGmailDefaults>) => { setSaved(false); setDraft({ ...form, ...value }); };
  return <details open className="min-w-0 rounded-md border p-3" aria-label="Client Gmail defaults">
    <summary className="min-h-11 cursor-pointer font-medium">Client defaults</summary>
    <p className="mb-3 text-sm text-[var(--text-muted)]">Enable email once for this client's eligible Access and equipment cases. Existing and new cases use these settings unless explicitly overridden or paused. Saving sends no email; start each request from its case after the plan is ready.</p>
    {stale && <p role="alert">Defaults changed. <Button type="button" variant="outline" onClick={() => { setDraft(undefined); setError(""); }}>Reload defaults</Button></p>}
    <div className="space-y-3">
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={e => change({ enabled: e.target.checked })} />Enable email for client</label>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={form.escalationEnabled} onChange={e => change({ escalationEnabled: e.target.checked })} />Enable escalation for client</label>
      {!form.escalationEnabled && <p className="text-xs text-[var(--text-muted)]">Escalation contacts are not required. Task-owner requests and follow-ups remain available.</p>}
      <Field label="Default registered agent"><select className={selectCls} value={form.agentId} onChange={e => change({ agentId: e.target.value })}>
        <option value="">Choose your registered agent</option>{choices.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select></Field>
      {tasks.map(([id, label]) => {
        const r = form.recipients.find(r => r.taskId === id);
        return <fieldset key={id} className="min-w-0 space-y-2 rounded-md border p-3">
          <legend className="px-1 text-sm"><label><input type="checkbox" checked={!!r} onChange={e => change({
            recipients: e.target.checked ? [...form.recipients, { ...blankGmailRecipient(id), persona: label }] : form.recipients.filter(r => r.taskId !== id),
          })} /> Default {label}</label></legend>
          {r && <GmailContactFields choices={choices} recipient={r} escalationEnabled={form.escalationEnabled} onChange={value => change({ recipients: form.recipients.map(item => item.taskId === id ? { ...item, ...value } : item) })} />}
        </fieldset>;
      })}
      {error && <p role="alert">{error}</p>}{saved && <p role="status">Client Gmail defaults saved.</p>}
      <Button type="button" disabled={stale || mutation.isPending} onClick={() => {
        setError(""); setSaved(false);
        mutation.mutate({ data: { expectedRevision: form.revision, enabled: form.enabled, escalationEnabled: form.escalationEnabled,
          agentId: form.agentId, recipients: form.recipients.map(({ escalationMemberId, escalationAddress, ...r }) =>
            form.escalationEnabled ? { ...r, escalationMemberId, escalationAddress } : r) } }, {
          onSuccess: defaults => {
            setDraft(defaults); qc.setQueryData(queryKey, { ...choices, defaults }); setSaved(true);
            for (const c of choices.cases) void qc.invalidateQueries({ queryKey: getGetOffboardingExchangesQueryKey(c.id) });
          },
          onError: e => setError(errMsg(e)),
        });
      }}>Save client email settings</Button>
    </div>
  </details>;
}
