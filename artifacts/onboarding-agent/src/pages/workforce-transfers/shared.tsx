import { useQueries, useQueryClient } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { getPopulationReconciliation, type TransferWorker, type WorkforceTransferProgram } from '@/lib/workforce-transfers-api';
import { Button, Card, Label } from '@/components/ui-shared';

export const selectClass = 'flex h-[36px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text-sm)]';
export const dateLabel = (value: string | null | undefined) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : '—';
export const humanize = (value: string) => value.replace(/-/g, ' ');
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.';
export function Section({ title, children, description }: { title: string; children: ReactNode; description?: string }) {
  return <Card className="p-6 space-y-4"><div className="border-b border-[var(--border)] pb-2"><h3 className="text-sm font-bold uppercase tracking-wider text-[var(--text-muted)]">{title}</h3>{description && <p className="mt-1 text-xs normal-case tracking-normal font-normal">{description}</p>}</div>{children}</Card>;
}
export function MutationError({ error }: { error: unknown }) {
  return error ? <p role="alert" className="rounded bg-[var(--status-red-bg)] px-3 py-2 text-xs text-[var(--status-red-fg)]">{errorMessage(error)}</p> : null;
}
export function RefreshButton({ programId }: { programId: string }) {
  const client = useQueryClient();
  return <Button type="button" variant="outline" size="sm" onClick={() => client.invalidateQueries({ queryKey: ['workforce-transfers', 'program', programId] })}>Refresh live versions</Button>;
}
export function useProgramWorkers(program: WorkforceTransferProgram) {
  const results = useQueries({
    queries: program.populations.map((population) => ({
      queryKey: ['workforce-transfers', 'population', population.id, 'reconciliation'],
      queryFn: () => getPopulationReconciliation(population.id),
    })),
  });
  const workers = results.flatMap((result, index) => (result.data?.workers ?? []).map((worker) => ({
    ...worker, populationId: program.populations[index]!.id, country: program.populations[index]!.country,
  })));
  return { workers, isLoading: results.some((result) => result.isLoading), errors: results.map((result) => result.error).filter(Boolean) };
}
export type ProgramWorker = TransferWorker & { populationId: string; country: string };

export function WorkerPicker({ workers, value, onChange, label = 'Worker' }: { workers: ProgramWorker[]; value: string; onChange: (id: string) => void; label?: string }) {
  return <div className="space-y-1"><Label>{label}</Label><select className={selectClass} required value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="">Select a worker…</option>
    {workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.id} · {worker.country} · v{worker.version} · {humanize(worker.migrationStatus)}</option>)}
  </select></div>;
}