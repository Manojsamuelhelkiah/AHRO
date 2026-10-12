import { useSeparationQueryScope } from './shared';
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useListSeparationCases } from '@workspace/api-client-react';
import { Card, Input, PageHeader, Button } from '@/components/ui-shared';
import { Plus } from 'lucide-react';
import { ClosureWarning, ErrorBox, Pill, SkeletonRows, SubNav, statusTone } from './shared';

export function SeparationsListPage() {
  const q = useListSeparationCases({ query: { queryKey: ['/api/offboarding/cases', useSeparationQueryScope()], staleTime: 15_000, refetchInterval: 30_000, retry: false } as never });
  const [term, setTerm] = useState('');
  const rows = useMemo(() => (q.data ?? []).filter((c) => [c.facts.workerName, c.facts.employeeId, c.facts.country, c.facts.role, String(c.id), c.status].some((v) => v.toLowerCase().includes(term.trim().toLowerCase()))), [q.data, term]);
  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader title="Separations" subtitle="Source-backed offboarding. Every step is manual and evidenced; nothing is executed remotely.">
        <Link href="/cases/separations/new"><Button className="gap-2" data-testid="button-new-separation"><Plus className="h-4 w-4" /> New separation</Button></Link>
      </PageHeader>
      <SubNav active="list" />
      <ClosureWarning />
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
                  <div className="text-xs text-[var(--text-muted)]">{c.facts.employeeId} · {c.facts.role} · {c.facts.country} · LWD {c.facts.lastWorkingDay}</div>
                </div>
                <div className="flex items-center gap-2"><span className="text-xs text-[var(--text-muted)]">Case {c.id} · v{c.version}</span><Pill tone={statusTone(c.status)}>{c.status}</Pill></div>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
