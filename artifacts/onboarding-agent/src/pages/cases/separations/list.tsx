import { useSeparationQueryScope } from './shared';
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { Card, Input, PageHeader, Button } from '@/components/ui-shared';
import { Plus } from 'lucide-react';
import { originalIntentOf } from '../case-presentation';
import { useListSeparationCases, useProvisionOffboardingExchanges } from '@workspace/api-client-react';
import { useUser } from '@clerk/react';
import { useHumanPermissions } from '@/hooks/use-human-permissions';
import { caseListReference } from '../case-presentation';
import { ClosureWarning, ErrorBox, errMsg, Pill, SkeletonRows, SubNav, statusTone } from './shared';

export function SeparationsListPage() {
  const q = useListSeparationCases({ query: { queryKey: ['/api/offboarding/cases', useSeparationQueryScope()], staleTime: 15_000, refetchInterval: 30_000, retry: false } as never });
  const [term, setTerm] = useState('');
  const { user } = useUser();
  const perms = useHumanPermissions();
  const canProvision = !!user && !perms.isError && ['flow.case.edit', 'data.case.profile.edit', 'tool.external.dispatch', 'tool.notification.send', 'tool.approval.decide'].every((k) => perms.data?.allows.includes(k));
  const prov = useProvisionOffboardingExchanges();
  const [confirmProv, setConfirmProv] = useState(false);
  const [provMsg, setProvMsg] = useState<string | null>(null);
  const [provErr, setProvErr] = useState<string | null>(null);
  const rows = useMemo(() => (q.data ?? []).filter((c) => [c.facts.workerName, c.facts.employeeId, c.facts.country, c.facts.role, String(c.id), c.status].some((v) => v.toLowerCase().includes(term.trim().toLowerCase()))), [q.data, term]);
  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader title="Separations" subtitle="Source-backed offboarding with accountable owners, contextual requests and confirmed results.">
        <Link href="/cases/separations/new"><Button className="gap-2" data-testid="button-new-separation"><Plus className="h-4 w-4" /> New separation</Button></Link>
      </PageHeader>
      <SubNav active="list" />
      <ClosureWarning />
      {canProvision && (
        <Card className="space-y-2 p-4" data-testid="panel-provision-exchanges">
          <h2 className="font-semibold">Add resignation cases</h2>
          <p className="text-xs text-[var(--text-muted)]">Adds three separate resignation cases with access and equipment tasks. Existing records are unchanged. Nothing is sent.</p>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmProv} onChange={(e) => setConfirmProv(e.target.checked)} /> I confirm adding these three conversations.</label>
          {provMsg && <p role="status" className="text-sm text-[var(--status-green-fg)]">{provMsg}</p>}
          {provErr && <p role="alert" className="text-sm text-[var(--status-red-fg)]">{provErr}</p>}
          <Button size="sm" disabled={!confirmProv || prov.isPending} onClick={() => { setProvErr(null); setProvMsg(null); prov.mutate({ data: { confirmAddThree: true } }, { onSuccess: (r) => { setProvMsg(`Added to ${r.caseIds.length} case(s). ${r.sent} sent.`); setConfirmProv(false); q.refetch(); }, onError: (e) => setProvErr(errMsg(e)) }); }}>{prov.isPending ? 'Adding...' : 'Add conversations'}</Button>
        </Card>
      )}
      <Card className="p-4 space-y-4">
        <Input aria-label="Search separations" data-testid="input-search-separations" placeholder="Search name, employee ID, country, role" value={term} onChange={(e) => setTerm(e.target.value)} className="max-w-sm" />
        {q.isLoading ? <SkeletonRows /> : q.isError ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--text-muted)]">
            {(q.data ?? []).length ? 'No separations match the search.' : 'No separations are visible to you yet. Cases you lack authority for are not listed.'}
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {rows.map((c) => (
              <Link key={c.id} href={`/cases/separations/${c.id}`} data-testid={`row-separation-${c.id}`} className="flex flex-wrap items-center justify-between gap-2 py-3 hover:bg-[var(--surface-alt)] sm:px-2">
                <div className="min-w-0">
                  <div className="font-semibold text-[var(--text-primary)]">{c.facts.workerName}</div>
                  <div className="break-words text-xs text-[var(--text-muted)]">Original intent: {originalIntentOf(c)} · {!c.fictionalOfflineIdentity && <>{c.facts.employeeId} · </>}{c.facts.role} · {c.facts.country} · LWD {c.facts.lastWorkingDay}</div>
                </div>
                <div className="flex items-center gap-2"><span className="text-xs text-[var(--text-muted)]">Case {caseListReference(c)} · v{c.version}</span><Pill tone={statusTone(c.status)}>{c.status}</Pill></div>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
