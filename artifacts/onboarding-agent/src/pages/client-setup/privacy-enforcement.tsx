import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch, type PrivacyEnforcementSettings, type PrivacyEnforcementInput } from "@workspace/api-client-react";
import { usePolicyScope } from "@/hooks/use-policies";
import { Button, Card } from "@/components/ui-shared";

export function ClientPrivacyEnforcement() {
  const scope = usePolicyScope();
  return <PrivacySettings key={`${scope.organizationId}:${scope.userId}`} />;
}
function PrivacySettings() {
  const scope = usePolicyScope();
  const client = useQueryClient();
  const key = ["privacy-enforcement", scope.organizationId, scope.userId];
  const query = useQuery({
    queryKey: key, enabled: !!scope.organizationId && !!scope.userId,
    queryFn: () => customFetch<PrivacyEnforcementSettings>("/api/privacy/enforcement", { responseType: "json", credentials: "include" }),
  });
  const [draft, setDraft] = useState<{ mode: PrivacyEnforcementInput["mode"]; revision: number } | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (data: PrivacyEnforcementInput) => customFetch<PrivacyEnforcementSettings>("/api/privacy/enforcement", {
      method: "PUT", responseType: "json", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    }),
    onSuccess: data => {
      client.setQueryData(key, data); setDraft(null); setSaved(true);
      void client.invalidateQueries({ queryKey: ["privacy-enforcement"] });
    },
    onError: () => { void query.refetch(); },
  });
  const settings = query.data;
  const stale = !!draft && draft.revision !== settings?.revision;
  return <Card className="my-4 min-w-0 space-y-3 p-4">
    <h2 className="font-semibold">Data sensitivity and privacy</h2>
    <p className="text-sm text-[var(--text-muted)]">Deferred is the default in development and the published app. It pauses privacy-policy and classification requirements across this client’s workflows, without marking them approved. Automatic privacy-retention deletion is paused.</p>
    <p className="text-sm text-[var(--text-muted)]">Sign-in, permissions, client isolation, private files, malware scanning and verified email-response identity remain protected.</p>
    {query.isLoading && <p role="status" className="text-sm">Loading enforcement settings…</p>}
    {query.isError && <div role="alert" className="text-sm">{query.error.message} <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>Reload settings</Button></div>}
    {settings && !query.isError && <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
      <label className="flex min-w-0 flex-col gap-1 text-sm sm:min-w-56">
        Enforcement
        <select className="min-h-11 rounded-md border bg-[var(--surface)] px-3" value={draft?.mode ?? settings.mode}
          disabled={!settings.canManage || save.isPending} onChange={e => {
            setSaved(false); save.reset();
            setDraft({ mode: e.target.value as PrivacyEnforcementInput["mode"], revision: draft?.revision ?? settings.revision });
          }}>
          <option value="deferred">Deferred</option>
          <option value="active">Active</option>
        </select>
      </label>
      {settings.canManage && <Button type="button" className="min-h-11 sm:self-end" disabled={!draft || stale || save.isPending}
        onClick={() => draft && save.mutate({ mode: draft.mode, expectedRevision: draft.revision })}>
        {save.isPending ? "Saving…" : "Save enforcement"}
      </Button>}
    </div>}
    {draft?.mode === "active" && <p className="text-sm">Active enforces the saved privacy rules and resumes retention cleanup under approved rules. Incomplete rules will block affected work; earlier records are not automatically approved.</p>}
    {stale && <div role="alert" className="text-sm">Settings changed. Your selection has been retained. <Button type="button" size="sm" variant="outline"
      onClick={async () => {
        const fresh = await query.refetch();
        if (fresh.data && draft) setDraft({ ...draft, revision: fresh.data.revision });
      }}>Reload before saving</Button></div>}
    {save.isError && <p role="alert" className="text-sm">{save.error.message}</p>}
    {saved && <p role="status" className="text-sm">Privacy enforcement saved.</p>}
  </Card>;
}
