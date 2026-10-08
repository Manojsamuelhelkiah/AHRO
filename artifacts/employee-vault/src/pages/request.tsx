import { useState } from 'react';
import { Link, useParams } from 'wouter';
import { useAuth } from '@clerk/react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarClock, Briefcase, RefreshCw } from 'lucide-react';
import {
  useGetVaultShareRequest, getGetVaultShareRequestQueryKey, useGetVaultDashboard, getGetVaultDashboardQueryKey,
  useDecideVaultShareRequest,
} from '@workspace/api-client-react';
import { AppHeader, StateBadge } from '@/components/vault-ui';
import { RevokeButton } from '@/components/revoke-button';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { errMsg, fmtDate, label } from '@/lib/vault';

export default function RequestPage() {
  const { userId } = useAuth();
  const { id = '' } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useGetVaultShareRequest(id, { query: { enabled: !!id, queryKey: [...getGetVaultShareRequestQueryKey(id), userId], refetchInterval: 30000 } });
  const dash = useGetVaultDashboard({ query: { queryKey: [...getGetVaultDashboardQueryKey(), userId], refetchInterval: 30000 } });
  const decide = useDecideVaultShareRequest();
  const [own, setOwn] = useState(false);
  const [raw, setRaw] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const r = q.data;
  const clean = (dash.data?.documents ?? []).filter((x) => x.state === 'clean');

  const send = (decision: 'approve' | 'decline') => {
    if (!r) return;
    setErr('');
    decide.mutate({ id, data: { decision, expectedVersion: r.version, acknowledgeCaseBinding: true, documentIds: decision === 'approve' && raw ? sel : [] } }, {
      onSuccess: (n) => {
        qc.setQueryData(getGetVaultShareRequestQueryKey(id), n);
        qc.invalidateQueries({ queryKey: getGetVaultShareRequestQueryKey(id) });
        qc.invalidateQueries({ queryKey: getGetVaultDashboardQueryKey() });
        toast({ title: decision === 'approve' ? 'Request approved' : 'Request declined' });
      },
      onError: (e) => { setErr(errMsg(e)); qc.invalidateQueries({ queryKey: getGetVaultShareRequestQueryKey(id) }); },
    });
  };

  return (
    <div className="min-h-[100dvh]">
      <AppHeader />
      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        <Button asChild variant="ghost" size="sm" className="mb-4 -ml-3"><Link href="/dashboard" data-testid="link-back"><ArrowLeft className="mr-1.5 h-4 w-4" />Vault</Link></Button>
        {q.isLoading ? <div className="space-y-4"><Skeleton className="h-12 w-2/3" /><Skeleton className="h-48 rounded-3xl" /></div> :
          q.isError || !r ? (
            <div className="rounded-3xl border border-dashed p-10 text-center" data-testid="state-request-error">
              <h1 className="font-display text-3xl font-medium">We couldn't open this request</h1>
              <p className="mx-auto mt-2 max-w-md text-muted-foreground">It may belong to a different account, have been withdrawn, or the link may be wrong. {errMsg(q.error)}</p>
              <div className="mt-5 flex justify-center gap-2"><Button onClick={() => q.refetch()} data-testid="button-retry-request"><RefreshCw className="mr-2 h-4 w-4" />Retry</Button><Button asChild variant="outline"><Link href="/dashboard">Go to vault</Link></Button></div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3"><StateBadge state={r.state} testid="status-request" /><span className="font-mono text-xs text-muted-foreground">version {r.version}</span></div>
              <h1 className="font-display mt-3 text-4xl font-medium sm:text-5xl" data-testid="text-employer"><span className="text-primary">{r.employer}</span> is asking to see your record</h1>
              <dl className="mt-8 grid gap-px overflow-hidden rounded-3xl border bg-border sm:grid-cols-2">
                {[['Case ID', String(r.caseId), 'case'], ['Purpose', r.purpose, 'purpose'], ['Jurisdiction', r.jurisdiction, 'jurisdiction']].map(([k, v, t]) => (
                  <div key={k} className="bg-card p-5"><dt className="text-xs uppercase tracking-wide text-muted-foreground">{k}</dt><dd className="mt-1 font-semibold" data-testid={`text-${t}`}>{v}</dd></div>
                ))}
                <div className="bg-card p-5 sm:col-span-2"><dt className="text-xs uppercase tracking-wide text-muted-foreground">Scope requested</dt>
                  <dd className="mt-2 flex flex-wrap gap-2" data-testid="text-scope">{r.scope.length ? r.scope.map((s) => <span key={s} className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 text-sm font-medium"><Briefcase className="h-3.5 w-3.5" />{label(s)}</span>) : 'No scope listed'}</dd></div>
                <div className="bg-card p-5 sm:col-span-2"><dt className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground"><CalendarClock className="h-3.5 w-3.5" />Expires</dt><dd className="mt-1 font-semibold" data-testid="text-expires">{fmtDate(r.expiresAt)}</dd></div>
              </dl>

              {r.state === 'pending' ? (
                <section className="mt-8 space-y-5 rounded-3xl border bg-card p-5 sm:p-7" data-testid="section-decision">
                  <h2 className="font-display text-2xl font-medium">Your decision</h2>
                  <p className="text-sm text-muted-foreground">Approving shares a <strong>summary only</strong> by default. Nothing is shared until you choose.</p>
                  <label className="flex cursor-pointer gap-3 rounded-xl bg-secondary/70 p-4 text-sm leading-relaxed">
                    <Checkbox checked={own} onCheckedChange={(v) => setOwn(v === true)} className="mt-0.5" data-testid="checkbox-case-binding" />
                    <span>I assert that case <strong>{r.caseId}</strong> is mine. I understand the employer must separately match me to it after I consent.</span>
                  </label>
                  <div className="rounded-xl border p-4">
                    <label className="flex cursor-pointer gap-3 text-sm font-medium">
                      <Checkbox checked={raw} onCheckedChange={(v) => { setRaw(v === true); if (v !== true) setSel([]); }} className="mt-0.5" data-testid="checkbox-share-raw" />
                      <span>Also share raw documents (optional)<span className="block font-normal text-muted-foreground">Pick exactly which ones. Leave unticked to share a summary only.</span></span>
                    </label>
                    {raw && (clean.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">You have no clean documents to share.</p> :
                      <ul className="mt-3 space-y-2">{clean.slice(0, 50).map((x) => (
                        <li key={x.id}><label className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm"><Checkbox checked={sel.includes(x.id)} disabled={!sel.includes(x.id) && sel.length >= 10}
                          onCheckedChange={(v) => setSel((s) => (v === true ? [...s, x.id] : s.filter((y) => y !== x.id)))} data-testid={`checkbox-share-doc-${x.id}`} />{x.name}</label></li>))}</ul>)}
                    {raw && <p className="mt-2 text-xs text-muted-foreground">{sel.length} of 10 selected</p>}
                  </div>
                  {err && <p role="alert" className="text-sm font-medium text-destructive" data-testid="text-decision-error">{err}</p>}
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <Button disabled={!own || decide.isPending || (raw && sel.length === 0)} onClick={() => send('approve')} data-testid="button-approve">{raw ? `Approve with ${sel.length} document${sel.length === 1 ? '' : 's'}` : 'Approve summary only'}</Button>
                    <Button variant="outline" disabled={!own || decide.isPending} onClick={() => send('decline')} data-testid="button-decline">Decline</Button>
                  </div>
                </section>
              ) : (
                <section className="mt-8 rounded-3xl border bg-card p-5 sm:p-7" data-testid="section-resolved">
                  <h2 className="font-display text-2xl font-medium">This request is {label(r.state).toLowerCase()}</h2>
                  <p className="mt-2 text-sm text-muted-foreground">{r.documentIds.length > 0 ? `${r.documentIds.length} raw document${r.documentIds.length === 1 ? ' is' : 's are'} included.` : 'Summary only: no raw documents are included.'}{r.employeeBound ? ' The employer has bound you to this case.' : ' The employer has not yet bound you to this case.'}</p>
                  {r.state === 'approved' && <div className="mt-4"><RevokeButton id={r.id} employer={r.employer} /></div>}
                </section>
              )}
            </>
          )}
      </main>
    </div>
  );
}
