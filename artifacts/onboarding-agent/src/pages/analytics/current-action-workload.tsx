import React, { useMemo } from 'react';
import type { OnbCase } from '@workspace/api-client-react';

type Row = { key: string; label: string; pending: number; inProgress: number; blocked: number };
type WorkloadCase = Pick<OnbCase, 'currentAction' | 'offlineSample' | 'fictionalOfflineIdentity'>;

export function summarizeCurrentActions(cases: readonly WorkloadCase[]) {
  const rows = new Map<string, Row>();
  let unknown = 0, excluded = 0;
  for (const c of cases) {
    if (c.offlineSample || c.fictionalOfflineIdentity) { excluded++; continue; }
    const a = c.currentAction;
    if (!a) { unknown++; continue; }
    const id = `${a.key}\u0000${a.label}`;
    const r = rows.get(id) ?? { key: a.key, label: a.label, pending: 0, inProgress: 0, blocked: 0 };
    if (a.status === 'pending') r.pending++; else if (a.status === 'in-progress') r.inProgress++; else r.blocked++;
    rows.set(id, r);
  }
  const list = [...rows.values()].sort((x, y) => (y.pending + y.inProgress + y.blocked) - (x.pending + x.inProgress + x.blocked) || x.label.localeCompare(y.label) || x.key.localeCompare(y.key));
  const recorded = list.reduce((n, r) => n + r.pending + r.inProgress + r.blocked, 0);
  return { rows: list, recorded, unknown, excluded, total: cases.length };
}

export function CurrentActionWorkload({ cases }: { cases: readonly WorkloadCase[] }) {
  const s = useMemo(() => summarizeCurrentActions(cases), [cases]);
  const th = 'py-2 px-4 text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)]';
  const td = 'py-2 px-4 text-[13px] text-[var(--text-secondary)] text-right';
  return (
    <section className="mb-14" data-testid="current-action-workload">
      <div className="mb-4">
        <h2 className="text-[22px] font-semibold text-[var(--text-primary)] tracking-tight m-0">Current Action Workload</h2>
        <p className="text-[13px] text-[var(--text-muted)] mt-1">
          Snapshot of each case's current action in the selected case creation window. The agent selector affects approval metrics, not this workload.
          Counts show recorded work only and make no claim about duration or cause.
          Open human assignments take priority, then blocked, in-progress and pending workstreams. Each case is counted once, not once per parallel task.
        </p>
      </div>
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-[var(--shadow-sm)]">
        <div className="sm:hidden divide-y divide-[var(--border)]">
          {s.rows.map(r => <div key={`${r.key}|${r.label}`} className="p-3">
            <p className="text-sm font-semibold break-words">{r.label}</p>
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-[var(--text-secondary)]">
              <span>Pending <strong>{r.pending}</strong></span>
              <span>In progress <strong>{r.inProgress}</strong></span>
              <span>Blocked <strong>{r.blocked}</strong></span>
            </div>
          </div>)}
          {!s.rows.length && <p className="p-3 text-sm text-[var(--text-muted)]">No recorded current actions in this selection.</p>}
          <p className="p-3 text-sm">Not recorded / no current action <strong>{s.unknown}</strong></p>
        </div>
        <table className="hidden sm:table w-full text-left border-collapse table-fixed">
          <thead><tr className="bg-[var(--surface-alt)] border-b border-[var(--border)]">
            <th className={`${th} w-[46%]`}>Current action</th><th className={`${th} text-right`}>Pending</th><th className={`${th} text-right`}>In progress</th><th className={`${th} text-right`}>Blocked</th>
          </tr></thead>
          <tbody>
            {s.rows.map(r => (
              <tr key={`${r.key}|${r.label}`} className="border-b border-[var(--border)]">
                <td className="py-2 px-4 text-[13px] break-words text-[var(--text-primary)]">{r.label}</td>
                <td className={td}>{r.pending}</td><td className={td}>{r.inProgress}</td><td className={td}>{r.blocked}</td>
              </tr>
            ))}
            {s.rows.length === 0 && <tr><td colSpan={4} className="py-4 px-4 text-[13px] text-[var(--text-muted)]">No recorded current actions in this selection.</td></tr>}
            <tr className="border-b border-[var(--border)]"><td className="py-2 px-4 text-[13px] text-[var(--text-primary)]">Not recorded / no current action</td><td colSpan={3} className={td}>{s.unknown}</td></tr>
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-[var(--text-muted)] mt-2" data-testid="current-action-reconcile">
        {s.recorded} recorded + {s.unknown} not recorded = {s.recorded + s.unknown} measured cases; {s.excluded} offline example case{s.excluded === 1 ? '' : 's'} excluded; {s.total} cases in the filtered population.
      </p>
    </section>
  );
}
