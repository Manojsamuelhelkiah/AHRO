import { Link } from "wouter";
import { Button, Card } from "@/components/ui-shared";
import { usePolicyCapabilities, usePolicyUploadSettings, useSavePolicyUploadSettings, usePolicyScope } from "@/hooks/use-policies";

export function ClientPolicyUploadSettings() {
  const scope = usePolicyScope();
  return <SettingsContent key={`${scope.organizationId}:${scope.userId}`} />;
}
function SettingsContent() {
  const capabilities = usePolicyCapabilities();
  const canReadSettings = !capabilities.isError && capabilities.data?.canMaintain === true;
  const canConfigure = canReadSettings && (capabilities.data?.platformAdministration || ['owner', 'admin'].includes(capabilities.data?.membershipRole ?? ''));
  const query = usePolicyUploadSettings(canReadSettings);
  const save = useSavePolicyUploadSettings();
  const settings = !query.isError ? query.data : undefined;
  return <Card className="my-4 space-y-3 p-4">
    <h2 className="font-semibold">Client policy documents</h2>
    <p className="text-sm text-[var(--text-muted)]">An authorized upload approves the policy by default. Enable a separate review only when this client requires it.</p>
    <Link href="/hr-policy-library" className="inline-flex min-h-10 items-center text-sm font-medium text-[var(--primary)]">Upload, replace or retire a policy document</Link>
    {canConfigure && settings && <label className="flex min-h-11 items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={settings.requiresSeparateReview} disabled={save.isPending}
        onChange={e => save.mutate({ expectedRevision: settings.revision, requiresSeparateReview: e.target.checked })} />
      Require a separate review for uploaded policies
    </label>}
    {query.isError && canReadSettings && <div role="alert" className="text-sm">{query.error.message} <Button size="sm" variant="outline" onClick={() => query.refetch()}>Reload settings</Button></div>}
    {save.isError && <p role="alert" className="text-sm">{save.error.message}</p>}
    {save.isSuccess && <p role="status" className="text-sm">Policy upload settings saved.</p>}
  </Card>;
}
