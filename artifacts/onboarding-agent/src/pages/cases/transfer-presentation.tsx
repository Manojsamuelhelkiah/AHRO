import React from 'react';
import { Link, useLocation } from 'wouter';
import type { WorkforceTransferProgramSummary } from '@/lib/workforce-transfers-api';

export const PROGRAM_FILTER = 'Workforce Transfer Programs' as const;
export const programHref = (id: string) => `/workforce-transfers/${encodeURIComponent(id)}`;

export function plannedCutoverLabel(value: string | null | undefined) {
  if (!value || Number.isNaN(Date.parse(value))) return 'Unknown';
  // Legal Day 1 is a calendar date, not a local-time instant or execution receipt.
  return value.slice(0, 10);
}

export function matchesTransferProgram(p: WorkforceTransferProgramSummary, input: {
  type: string; query: string; geography: string; programStatus: string;
  caseOnly: boolean; dateFrom: string; dateTo: string;
}) {
  if (input.caseOnly || !['All Cases', PROGRAM_FILTER].includes(input.type)) return false;
  if (input.geography && !p.countries.includes(input.geography)) return false;
  if (input.programStatus && p.status !== input.programStatus) return false;
  const date = plannedCutoverLabel(p.legalDay1);
  if ((input.dateFrom || input.dateTo) && date === 'Unknown') return false;
  if (input.dateFrom && date < input.dateFrom) return false;
  if (input.dateTo && date > input.dateTo) return false;
  const q = input.query.trim().toLowerCase();
  return !q || [p.name, p.id, p.sourceLegalEntity, p.destinationLegalEntity].some((v) => v?.toLowerCase().includes(q));
}

function Population({ p }: { p: WorkforceTransferProgramSummary }) {
  return <div className="text-xs">
    <div>Affected workers: {p.populationSummary?.importedHeadcount ?? 'Unknown'} imported</div>
    <div>{p.populationSummary?.expectedHeadcount ?? 'Unknown'} expected</div>
    {p.partialCountryScope && <div className="font-semibold">Partial country scope — readable populations only</div>}
  </div>;
}

function ProgramInfo({ p }: { p: WorkforceTransferProgramSummary }) {
  return <>
    <div className="font-semibold">{p.name}</div>
    <div className="text-xs break-all">{p.id}</div>
    <div className="text-xs break-words">{p.sourceLegalEntity} → {p.destinationLegalEntity}</div>
    <div className="text-xs">{p.countries.join(', ') || 'Country unknown'}</div>
    <div className="text-xs font-semibold">Workforce Transfer Program</div>
  </>;
}

function ProgramFacts({ p }: { p: WorkforceTransferProgramSummary }) {
  return <div className="text-xs space-y-1">
    <div>Recorded program status: {p.status || 'Unknown'}</div>
    <div>HR integration owner: {p.hrIntegrationOwner || 'Unknown'}</div>
    <div>Planned cutover (legal Day 1): {plannedCutoverLabel(p.legalDay1)}</div>
    <div className="text-[var(--text-muted)]">Planned date is not proof of cutover.</div>
  </div>;
}

export function TransferProgramRow({ p }: { p: WorkforceTransferProgramSummary }) {
  const [, setLocation] = useLocation();
  return <tr data-program-id={p.id} tabIndex={0} aria-label={`Open Workforce Transfer Program ${p.name}`}
    onKeyDown={(e) => {
      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        setLocation(programHref(p.id));
      }
    }}
    onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) setLocation(programHref(p.id)); }}
    className="border-b border-[var(--border)] align-top cursor-pointer hover:bg-[var(--surface-soft)] focus-visible:outline-none focus-visible:ring-2">
    <td className="p-4"><ProgramInfo p={p} />
      <div className="lg:hidden mt-2"><ProgramFacts p={p} /></div>
    </td>
    <td className="p-4"><Population p={p} /></td>
    <td className="p-4 text-xs">Workforce Transfer Program</td>
    <td className="hidden lg:table-cell p-4 text-xs">Planned cutover (legal Day 1): {plannedCutoverLabel(p.legalDay1)}<div>Not proof of cutover</div></td>
    <td className="hidden lg:table-cell p-4 text-xs">Separate program workflow</td>
    <td className="p-4 text-xs">Recorded program status: {p.status || 'Unknown'}</td>
    <td className="hidden lg:table-cell p-4 text-xs">HR integration owner: {p.hrIntegrationOwner || 'Unknown'}</td>
    <td className="p-4 text-right"><Link className="text-sm font-semibold text-[var(--primary)] hover:underline focus-visible:ring-2" href={programHref(p.id)} aria-label={`Open Workforce Transfer Program ${p.name}`}>View Program</Link></td>
  </tr>;
}

export function TransferProgramCard({ p }: { p: WorkforceTransferProgramSummary }) {
  return <div data-program-id={p.id} className="p-4 space-y-2 border-b border-[var(--border)]">
    <ProgramInfo p={p} /><Population p={p} /><ProgramFacts p={p} />
    <Link href={programHref(p.id)} aria-label={`Open Workforce Transfer Program ${p.name}`} className="inline-block text-sm font-semibold text-[var(--primary)] hover:underline focus-visible:ring-2">View Program</Link>
  </div>;
}
