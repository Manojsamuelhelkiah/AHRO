import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetEmployeeVaultSettings, useUpdateEmployeeVaultSettings, getGetEmployeeVaultSettingsQueryKey } from "@workspace/api-client-react";
import { Button } from "./ui/button";

export function EmployeeVaultSettings() {
  const query = useGetEmployeeVaultSettings();
  const mutation = useUpdateEmployeeVaultSettings();
  const qc = useQueryClient();
  const [notice, setNotice] = useState("");
  async function toggle() {
    if (!query.data) return;
    if (query.data.enabled && !window.confirm("Disable new Vault requests and live reuse? Existing grants will not revive when re-enabled. Employee accounts and dated history remain.")) return;
    try {
      await mutation.mutateAsync({ data: { enabled: !query.data.enabled, expectedVersion: query.data.version } });
      await qc.invalidateQueries({ queryKey: getGetEmployeeVaultSettingsQueryKey() });
      await qc.invalidateQueries({ queryKey: ["/api/onboarding/cases"] });
      setNotice("Saved. Product access does not grant verifier or sensitive-record authority.");
    } catch (e) { setNotice(e instanceof Error ? e.message : "Setting could not be saved."); }
  }
  return <section className="rounded-lg border bg-[var(--surface)] p-5 space-y-3" aria-labelledby="vault-product-title">
    <h3 id="vault-product-title" className="font-semibold">Employee Vault consumption</h3>
    <p className="text-sm text-[var(--text-muted)]">Optional, default off. Employees keep their independent accounts. Only the tenant owner can change this setting.</p>
    {query.isLoading ? <p>Loading product configuration…</p> : query.error ? <p role="alert">{query.error.message}</p> : query.data && <>
      <p className="text-sm"><strong>{query.data.enabled ? "Enabled" : "Disabled"}</strong> · configuration version {query.data.version}</p>
      <p className="text-sm">{query.data.providerReadiness}</p>
      <p className="text-sm text-[var(--text-muted)]">{query.data.requirementPolicy}</p>
      <Button onClick={() => void toggle()} disabled={mutation.isPending}>{query.data.enabled ? "Disable consumption" : "Enable consumption"}</Button>
    </>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
  </section>;
}
