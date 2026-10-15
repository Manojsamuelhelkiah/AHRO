import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSaveOffboardingGmailDefaults, type GetOffboardingExchangeSetup200, type OffboardingGmailDefaults } from "@workspace/api-client-react";
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
  return <details className="min-w-0 rounded-md border p-3" aria-label="Client Gmail defaults">
    <summary className="min-h-11 cursor-pointer font-medium">Client defaults</summary>
    <p className="mb-3 text-sm text-[var(--text-muted)]">Configure contacts once. New case settings start with these defaults; existing case settings stay unchanged. Saving defaults sends no email.</p>
    {stale && <p role="alert">Defaults changed. <Button type="button" variant="outline" onClick={() => { setDraft(undefined); setError(""); }}>Reload defaults</Button></p>}
    <div className="space-y-3">
      <Field label="Default registered agent"><select className={selectCls} value={form.agentId} onChange={e => change({ agentId: e.target.value })}>
        <option value="">Choose your registered agent</option>{choices.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select></Field>
      {tasks.map(([id, label]) => {
        const r = form.recipients.find(r => r.taskId === id);
        return <fieldset key={id} className="min-w-0 space-y-2 rounded-md border p-3">
          <legend className="px-1 text-sm"><label><input type="checkbox" checked={!!r} onChange={e => change({
            recipients: e.target.checked ? [...form.recipients, { ...blankGmailRecipient(id), persona: label }] : form.recipients.filter(r => r.taskId !== id),
          })} /> Default {label}</label></legend>
          {r && <GmailContactFields choices={choices} recipient={r} onChange={value => change({ recipients: form.recipients.map(item => item.taskId === id ? { ...item, ...value } : item) })} />}
        </fieldset>;
      })}
      {error && <p role="alert">{error}</p>}{saved && <p role="status">Client Gmail defaults saved.</p>}
      <Button type="button" disabled={stale || mutation.isPending} onClick={() => {
        setError(""); setSaved(false);
        mutation.mutate({ data: { expectedRevision: form.revision, agentId: form.agentId, recipients: form.recipients } }, {
          onSuccess: defaults => { setDraft(defaults); qc.setQueryData(queryKey, { ...choices, defaults }); setSaved(true); },
          onError: e => setError(errMsg(e)),
        });
      }}>Save client defaults</Button>
    </div>
  </details>;
}
