import { useQueryClient } from '@tanstack/react-query';
import {
  useUpdateVaultExpiryPreferences, useDismissVaultExpiryNotice,
  getGetVaultDashboardQueryKey, type VaultDashboard,
} from '@workspace/api-client-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { errMsg, fmtDate } from '@/lib/vault';

export function ExpiryNotices({ dashboard, userId }: { dashboard: VaultDashboard; userId: string | null | undefined }) {
  const qc = useQueryClient(), { toast } = useToast();
  const preference = useUpdateVaultExpiryPreferences();
  const dismiss = useDismissVaultExpiryNotice();
  const key = [...getGetVaultDashboardQueryKey(), userId];
  const error = (e: unknown) => toast({ variant: 'destructive', title: 'Could not save notice settings', description: errMsg(e) });
  return <section className="mt-6 rounded-3xl border bg-card p-5 sm:p-6" aria-labelledby="expiry-heading" data-testid="section-expiry-notices">
    <h2 id="expiry-heading" className="font-display text-2xl font-medium">Private expiry notices</h2>
    <p className="mt-2 text-sm text-muted-foreground">
      Opt in to notices here in your signed-in Vault during the seven days before a recorded check or employer sharing grant expires.
      No emails are sent. You can turn these off without employer membership.
    </p>
    <label className="mt-4 flex items-center gap-3 text-sm">
      <Checkbox checked={dashboard.expiryNoticesEnabled} disabled={preference.isPending}
        data-testid="checkbox-expiry-notices"
        onCheckedChange={value => preference.mutate({ data: { enabled: value === true } }, {
          onSuccess: result => {
            qc.setQueryData<VaultDashboard>(key, old => old && ({
              ...old, expiryNoticesEnabled: result.enabled, expiryNotices: result.enabled ? old.expiryNotices : [],
            }));
            qc.invalidateQueries({ queryKey: key });
          }, onError: error,
        })} />
      Notify me privately before expiry
    </label>
    <p className="mt-3 text-xs text-muted-foreground">
      A notice is not verification clearance. It does not renew evidence, extend consent, or restore revoked sharing.
      Renew checks with an approved source and review sharing separately.
    </p>
    {dashboard.expiryNoticesEnabled && <div className="mt-4 space-y-3" aria-live="polite">
      {dashboard.expiryNotices.length === 0 ? <p className="text-sm text-muted-foreground">No upcoming expiries to notify you about.</p> :
        dashboard.expiryNotices.map(n => <div key={n.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4" data-testid={`expiry-notice-${n.id}`}>
          <div className="min-w-0 break-words">
            <p className="font-medium">{n.label}</p>
            <p className="text-sm text-muted-foreground">Recorded expiry: {fmtDate(n.expiresAt)}.
              {n.targetType === 'check' ? ' Arrange renewed evidence if you still need this check.' : ' Review this grant in Employer requests if sharing is still needed.'}</p>
          </div>
          <Button variant="outline" size="sm" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ id: n.id }, {
            onSuccess: () => {
              qc.setQueryData<VaultDashboard>(key, old => old && ({ ...old, expiryNotices: old.expiryNotices.filter(item => item.id !== n.id) }));
              qc.invalidateQueries({ queryKey: key });
            }, onError: error,
          })}>Dismiss</Button>
        </div>)}
    </div>}
  </section>;
}
