import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { useAuth } from '@clerk/react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Eye, FileText, Trash2, ShieldQuestion, Inbox, RefreshCw, ChevronRight } from 'lucide-react';
import {
  useGetVaultDashboard, getGetVaultDashboardQueryKey, useDeleteVaultDocument, useDownloadVaultDocument,
  getDownloadVaultDocumentQueryKey, useSubmitVaultCheck, type VaultDocument, type VaultCheckInputKind,
} from '@workspace/api-client-react';
import { AppHeader, StateBadge } from '@/components/vault-ui';
import { UploadDialog } from '@/components/upload-dialog';
import { RevokeButton } from '@/components/revoke-button';
import { ExpiryNotices } from '@/components/expiry-notices';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { errMsg, fmtDate, fmtSize, label } from '@/lib/vault';

const KINDS: VaultCheckInputKind[] = ['identity', 'criminal', 'employment', 'education', 'address', 'sanctions', 'reference', 'medical'];

function DownloadButton({ doc }: { doc: VaultDocument }) {
  const { toast } = useToast();
  const q = useDownloadVaultDocument(doc.id, { query: { enabled: false, queryKey: getDownloadVaultDocumentQueryKey(doc.id), gcTime: 0, retry: false } });
  const go = async () => {
    const r = await q.refetch();
    if (r.data) {
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = doc.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } else toast({ variant: 'destructive', title: 'Download failed', description: errMsg(r.error) });
  };
  return <Button variant="outline" size="sm" onClick={go} disabled={q.isFetching} data-testid={`button-download-${doc.id}`}><Download className="mr-1.5 h-4 w-4" />{q.isFetching ? 'Preparing…' : 'Download'}</Button>;
}

function PreviewButton({ doc }: { doc: VaultDocument }) {
  const [url, setUrl] = useState<string | null>(null);
  const { toast } = useToast();
  const q = useDownloadVaultDocument(doc.id, { query: { queryKey: getDownloadVaultDocumentQueryKey(doc.id), enabled: false, gcTime: 0 } });
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  async function preview() {
    const result = await q.refetch();
    if (result.error || !result.data) { toast({ variant: 'destructive', title: 'Preview unavailable', description: errMsg(result.error) }); return; }
    setUrl(URL.createObjectURL(result.data));
  }
  return <>
    <Button variant="outline" size="icon" aria-label={`Preview ${doc.name}`} onClick={preview} disabled={q.isFetching}><Eye className="h-4 w-4" /></Button>
    <Dialog open={!!url} onOpenChange={open => { if (!open) setUrl(null); }}>
      <DialogContent className="max-w-3xl"><DialogHeader><DialogTitle>{doc.name}</DialogTitle></DialogHeader>
        {url && (doc.contentType.startsWith('image/') ? <img src={url} alt={doc.name} className="max-h-[70vh] w-full object-contain" /> :
          <iframe src={url} title={doc.name} sandbox="allow-same-origin" className="h-[70vh] w-full" />)}
      </DialogContent>
    </Dialog>
  </>;
}
function DeleteButton({ doc }: { doc: VaultDocument }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const del = useDeleteVaultDocument();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild><Button variant="ghost" size="icon" aria-label={`Delete ${doc.name}`} data-testid={`button-delete-${doc.id}`}><Trash2 className="h-4 w-4" /></Button></AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{doc.name}”?</AlertDialogTitle>
          <AlertDialogDescription>This permanently removes the document from your vault. Checks that relied on it may be affected.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction data-testid={`button-delete-confirm-${doc.id}`} onClick={() => del.mutate({ id: doc.id }, {
            onSuccess: () => { toast({ title: 'Document deleted' }); qc.invalidateQueries({ queryKey: getGetVaultDashboardQueryKey() }); },
            onError: (e) => toast({ variant: 'destructive', title: 'Could not delete', description: errMsg(e) }),
          })}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Empty({ icon: I, title, body, action }: { icon: typeof Inbox; title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-3xl border border-dashed bg-card/60 px-6 py-14 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-primary"><I className="h-5 w-5" /></div>
      <h3 className="font-display text-2xl font-medium">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-muted-foreground">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

function CheckForm({ docs }: { docs: VaultDocument[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const submit = useSubmitVaultCheck();
  const [kind, setKind] = useState<VaultCheckInputKind>('identity');
  const [jur, setJur] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const clean = docs.filter((d) => d.state === 'clean');
  const valid = jur.trim().length >= 2 && sel.length >= 1 && sel.length <= 10;
  const toggle = (id: string, on: boolean) => setSel((s) => (on ? [...s, id] : s.filter((x) => x !== id)));
  return (
    <form className="space-y-5 rounded-3xl border bg-card p-5 sm:p-6" onSubmit={(e) => {
      e.preventDefault();
      if (!valid) return;
      submit.mutate({ data: { kind, jurisdiction: jur.trim(), documentIds: sel } }, {
        onSuccess: (c) => { toast({ title: 'Check submitted', description: `Current state: ${label(c.state)}. ${c.explanation}` }); setSel([]); setJur(''); qc.invalidateQueries({ queryKey: getGetVaultDashboardQueryKey() }); },
        onError: (er) => toast({ variant: 'destructive', title: 'Could not submit', description: errMsg(er) }),
      });
    }}>
      <div>
        <h3 className="font-display text-2xl font-medium">Request a check</h3>
        <p className="text-sm text-muted-foreground">Results depend on a verification provider. If none is available, the check will say so rather than guess.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label>Kind</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as VaultCheckInputKind)}>
            <SelectTrigger data-testid="select-check-kind"><SelectValue /></SelectTrigger>
            <SelectContent>{KINDS.map((k) => <SelectItem key={k} value={k}>{label(k)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-2"><Label htmlFor="jur">Jurisdiction</Label>
          <Input id="jur" value={jur} maxLength={80} placeholder="Issuer jurisdiction code, e.g. IN" onChange={(e) => setJur(e.target.value)} data-testid="input-jurisdiction" />
          <p className="text-xs text-muted-foreground">Use the issuer’s jurisdiction code or the exact jurisdiction named in an employer request.</p>
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Supporting documents (clean only, up to 10)</legend>
        {clean.length === 0 ? <p className="rounded-xl bg-secondary/70 p-3 text-sm text-muted-foreground">No clean documents yet. Add one and wait for its scan to finish.</p> :
          clean.map((d) => (
            <label key={d.id} className="flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm hover:bg-secondary/50">
              <Checkbox checked={sel.includes(d.id)} onCheckedChange={(v) => toggle(d.id, v === true)} data-testid={`checkbox-check-doc-${d.id}`} />
              <span className="font-medium">{d.name}</span><span className="text-muted-foreground">rev {d.revision}</span>
            </label>
          ))}
      </fieldset>
      <Button type="submit" disabled={!valid || submit.isPending} data-testid="button-submit-check">{submit.isPending ? 'Submitting…' : 'Submit check'}</Button>
    </form>
  );
}

export default function Dashboard() {
  const { userId } = useAuth();
  const qc = useQueryClient();
  const q = useGetVaultDashboard({ query: { queryKey: [...getGetVaultDashboardQueryKey(), userId], refetchInterval: 30000 } });
  const d = q.data;
  const pending = d?.requests.filter((r) => r.state === 'pending') ?? [];

  return (
    <div className="min-h-[100dvh]">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        {q.isLoading ? (
          <div className="space-y-6" data-testid="skeleton-dashboard"><Skeleton className="h-40 rounded-3xl" /><Skeleton className="h-10 w-72" /><Skeleton className="h-64 rounded-3xl" /></div>
        ) : q.isError || !d ? (
          <Empty icon={RefreshCw} title="We couldn't open your vault" body={errMsg(q.error)} action={<Button onClick={() => q.refetch()} data-testid="button-retry-dashboard">Try again</Button>} />
        ) : (
          <>
            <section className="relative overflow-hidden rounded-[2rem] bg-primary p-6 text-primary-foreground sm:p-10" data-testid="section-readiness">
              <svg className="pointer-events-none absolute -right-20 -top-20 h-80 w-80 text-primary-foreground/15" viewBox="0 0 100 100" fill="none" stroke="currentColor">{[48, 36, 24, 12].map((r) => <circle key={r} cx="50" cy="50" r={r} strokeWidth=".5" />)}</svg>
              <p className="font-mono text-xs uppercase tracking-widest text-primary-foreground/60">Vault {d.vaultId.slice(0, 8)}</p>
              <h1 className="font-display mt-2 text-4xl font-medium sm:text-5xl">Readiness: <span className="text-accent" data-testid="text-readiness">{label(d.readiness)}</span></h1>
              <div className="mt-6 flex flex-wrap gap-x-10 gap-y-3 text-sm">
                <div><p className="text-3xl font-display">{d.documents.length}</p><p className="text-primary-foreground/70">documents</p></div>
                <div><p className="text-3xl font-display">{d.checks.length}</p><p className="text-primary-foreground/70">checks</p></div>
                <div><p className="text-3xl font-display" data-testid="text-outstanding">{pending.length}</p><p className="text-primary-foreground/70">requests awaiting you</p></div>
              </div>
              <p className="mt-6 max-w-xl text-sm text-primary-foreground/70">Readiness reflects checks reported for you, not how many files you've stored.</p>
            </section>
            <ExpiryNotices key={userId} dashboard={d} userId={userId} />

            {pending.length > 0 && (
              <section className="mt-6 rounded-3xl border border-accent bg-[hsl(36_95%_92%)] p-5" data-testid="section-outstanding">
                <h2 className="font-semibold">Outstanding: {pending.length} request{pending.length > 1 ? 's' : ''} need your decision</h2>
                <ul className="mt-3 space-y-2">{pending.map((r) => (
                  <li key={r.id}><Link href={`/requests/${r.id}`} className="flex items-center justify-between rounded-xl bg-card px-4 py-3 text-sm font-medium" data-testid={`link-outstanding-${r.id}`}>{r.employer} · case {r.caseId}<ChevronRight className="h-4 w-4" /></Link></li>
                ))}</ul>
              </section>
            )}

            <Tabs defaultValue="documents" className="mt-10">
              <TabsList className="h-auto flex-wrap">
                <TabsTrigger value="documents" data-testid="tab-documents">Documents</TabsTrigger>
                <TabsTrigger value="checks" data-testid="tab-checks">Checks</TabsTrigger>
                <TabsTrigger value="requests" data-testid="tab-requests">Requests{pending.length ? ` (${pending.length})` : ''}</TabsTrigger>
              </TabsList>

              <TabsContent value="documents" className="mt-6 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-display text-3xl font-medium">Documents</h2>
                  <UploadDialog documents={d.documents} privacyNotice={d.privacyNotice} policyRevision={d.policyRevision} policyJurisdiction={d.policyJurisdiction} />
                </div>
                {d.documents.length === 0 ? (
                  <Empty icon={FileText} title="Your vault is empty" body="Add a passport scan, a certificate, or a reference letter when approved private processing is available. Files stay quarantined until malware clearance." action={<UploadDialog documents={d.documents} privacyNotice={d.privacyNotice} policyRevision={d.policyRevision} policyJurisdiction={d.policyJurisdiction} />} />
                ) : (
                  <ul className="divide-y rounded-3xl border bg-card">
                    {d.documents.map((doc) => (
                      <li key={doc.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid={`row-document-${doc.id}`}>
                        <div className="min-w-0">
                          <p className="truncate font-semibold" data-testid={`text-doc-name-${doc.id}`}>{doc.name}</p>
                          <p className="text-sm text-muted-foreground">rev {doc.revision} · {fmtSize(doc.sizeBytes)} · {doc.contentType.split('/')[1].toUpperCase()} · {fmtDate(doc.createdAt)}{doc.replacesId ? ' · replaces earlier revision' : ''}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <StateBadge state={doc.state} testid={`status-doc-${doc.id}`} />
                          {doc.state === 'clean' ? <><PreviewButton doc={doc} /><DownloadButton doc={doc} /></> : <span className="text-xs text-muted-foreground">Download after clean scan</span>}
                          <DeleteButton doc={doc} />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="checks" className="mt-6 space-y-6">
                <h2 className="font-display text-3xl font-medium">Checks</h2>
                <CheckForm docs={d.documents} />
                {d.checks.length === 0 ? (
                  <Empty icon={ShieldQuestion} title="No checks yet" body="Nothing here counts as verified. A check appears once you submit one, with its issuer, source and expiry as the provider reports them." />
                ) : (
                  <ul className="grid gap-4 md:grid-cols-2">
                    {d.checks.map((c) => (
                      <li key={c.id} className="rounded-3xl border bg-card p-5" data-testid={`card-check-${c.id}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div><p className="font-display text-xl font-medium">{label(c.kind)}</p><p className="text-sm text-muted-foreground">{c.jurisdiction}</p></div>
                          <StateBadge state={c.state} testid={`status-check-${c.id}`} />
                        </div>
                        <p className="mt-3 text-sm leading-relaxed" data-testid={`text-check-explanation-${c.id}`}>{c.explanation}</p>
                        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                          {[['Issuer', c.issuer || 'Not reported'], ['Source', c.source || 'Not reported'], ['Verified', fmtDate(c.verifiedAt)], ['Expires', fmtDate(c.expiresAt)]].map(([k, v]) => (
                            <div key={k}><dt className="text-xs uppercase tracking-wide text-muted-foreground">{k}</dt><dd className="font-medium">{v}</dd></div>
                          ))}
                        </dl>
                        <p className="mt-3 text-xs text-muted-foreground">{c.documentIds.length} supporting document{c.documentIds.length === 1 ? '' : 's'}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="requests" className="mt-6 space-y-4">
                <div className="flex items-center justify-between"><h2 className="font-display text-3xl font-medium">Employer requests</h2>
                  <Button variant="ghost" size="sm" onClick={() => qc.invalidateQueries({ queryKey: getGetVaultDashboardQueryKey() })} data-testid="button-refresh"><RefreshCw className="mr-1.5 h-4 w-4" />Refresh</Button></div>
                {d.requests.length === 0 ? (
                  <Empty icon={Inbox} title="No requests yet" body="When an employer sends you a consent link, open it while signed in and it will appear here. Nobody can see your vault without your approval." />
                ) : (
                  <ul className="divide-y rounded-3xl border bg-card">
                    {d.requests.map((r) => (
                      <li key={r.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid={`row-request-${r.id}`}>
                        <div>
                          <p className="font-semibold">{r.employer} <span className="font-normal text-muted-foreground">· case {r.caseId}</span></p>
                          <p className="text-sm text-muted-foreground">{r.purpose} · expires {fmtDate(r.expiresAt)}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <StateBadge state={r.state} />
                          {r.state === 'approved' && <RevokeButton id={r.id} employer={r.employer} />}
                          <Button asChild size="sm" variant={r.state === 'pending' ? 'default' : 'outline'}><Link href={`/requests/${r.id}`} data-testid={`link-request-${r.id}`}>{r.state === 'pending' ? 'Review' : 'View'}</Link></Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
      </main>
    </div>
  );
}
