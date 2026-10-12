import { useUser } from '@clerk/react';
import { getPinnedOrganizationIdForPage } from '@workspace/api-client-react';
export function useSeparationQueryScope() {
  const { user } = useUser();
  return `${getPinnedOrganizationIdForPage() ?? 'no-tenant'}:${user?.id ?? 'signed-out'}`;
}
import { Children, cloneElement, isValidElement, useId, type ReactNode } from 'react';
import { Link } from 'wouter';
import type { SeparationFacts } from '@workspace/api-client-react';
import { Button, Input, Label } from '@/components/ui-shared';

export const CLOSURE_WARNING = 'Final closure blocked: section 4.6 requirements pending';

export function errMsg(e: unknown): string {
  const x = e as { response?: { data?: { message?: string; error?: string }; status?: number }; message?: string; status?: number };
  const status = x?.response?.status ?? x?.status;
  const m = x?.response?.data?.message || x?.response?.data?.error || x?.message || 'The request failed.';
  return status === 403 ? `Access denied: ${m}` : m;
}

export const FACT_FIELDS: { key: keyof SeparationFacts; label: string; hint?: string; type?: 'date' | 'area' }[] = [
  { key: 'employeeId', label: 'Employee ID' },
  { key: 'workerName', label: 'Worker name' },
  { key: 'exitType', label: 'Exit type', hint: 'e.g. resignation, termination' },
  { key: 'exitReason', label: 'Exit reason (restricted)', hint: 'Visible only to HR and Legal readers. Up to 2000 characters.', type: 'area' },
  { key: 'lastWorkingDay', label: 'Last working day', type: 'date' },
  { key: 'terminationDate', label: 'Termination date', type: 'date', hint: 'Not before last working day' },
  { key: 'timeZone', label: 'IANA time zone', hint: 'e.g. Asia/Kolkata' },
  { key: 'role', label: 'Role' },
  { key: 'department', label: 'Department' },
  { key: 'country', label: 'Country (2-letter, upper case)', hint: 'e.g. IN' },
  { key: 'legalEntity', label: 'Legal entity' },
  { key: 'workerCategory', label: 'Worker category' },
  { key: 'manager', label: 'Manager' },
];
export const emptyFacts = (): SeparationFacts => Object.fromEntries(FACT_FIELDS.map((f) => [f.key, ''])) as unknown as SeparationFacts;

export function validateFacts(f: Partial<Record<string, string>>): Record<string, string> {
  const e: Record<string, string> = {};
  for (const { key } of FACT_FIELDS) {
    const v = (f[key] ?? '').trim();
    if (!v) e[key] = 'Required';
    else if (v.length > (key === 'exitReason' ? 2000 : 160)) e[key] = 'Too long';
  }
  const real = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  for (const k of ['lastWorkingDay', 'terminationDate']) if (!e[k] && !real(f[k]!.trim())) e[k] = 'Use a real YYYY-MM-DD date';
  if (!e.terminationDate && !e.lastWorkingDay && f.terminationDate!.trim() < f.lastWorkingDay!.trim()) e.terminationDate = 'Cannot precede last working day';
  if (!e.country && !/^[A-Z]{2}$/.test(f.country!.trim())) e.country = 'Two uppercase letters';
  if (!e.timeZone) { try { new Intl.DateTimeFormat('en', { timeZone: f.timeZone!.trim() }); } catch { e.timeZone = 'Not a valid IANA zone'; } }
  return e;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  const id = useId();
  const controls = Children.map(children, child => {
    if (!isValidElement<Record<string, unknown>>(child)) return child;
    if (child.type !== Input && !(typeof child.type === 'string' && ['input', 'select', 'textarea'].includes(child.type))) return child;
    return cloneElement(child, { 'aria-labelledby': child.props['aria-labelledby'] ?? id, ...((hint || error) ? { 'aria-describedby': child.props['aria-describedby'] ?? `${id}-note` } : {}) });
  });
  return (
    <div className="space-y-1 min-w-0 break-words">
      <Label id={id}>{label}</Label>
      {controls}
      {error ? <p id={`${id}-note`} role="alert" className="text-xs text-[var(--status-red-fg)]">{error}</p> : hint ? <p id={`${id}-note`} className="text-xs text-[var(--text-muted)]">{hint}</p> : null}
    </div>
  );
}

export const selectCls = 'flex h-9 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-2 text-sm focus:border-[var(--primary)] focus:outline-none';
export const areaCls = 'w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-2 text-sm focus:border-[var(--primary)] focus:outline-none';

export function FactsForm({ value, onChange, errors, disabled }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; errors: Record<string, string>; disabled?: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {FACT_FIELDS.map((f) => (
        <div key={f.key} className={f.type === 'area' ? 'sm:col-span-2' : ''}>
          <Field label={f.label} hint={f.hint} error={errors[f.key]}>
            {f.type === 'area'
              ? <textarea data-testid={`input-${f.key}`} disabled={disabled} rows={3} className={areaCls} value={value[f.key] ?? ''} onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} />
              : <Input data-testid={`input-${f.key}`} disabled={disabled} type={f.type === 'date' ? 'date' : 'text'} value={value[f.key] ?? ''} onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} />}
          </Field>
        </div>
      ))}
    </div>
  );
}

export function Pill({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'green' | 'amber' | 'red' | 'blue' }) {
  const t = { muted: ['var(--surface-alt)', 'var(--text-secondary)'], green: ['var(--status-green-bg)', 'var(--status-green-fg)'], amber: ['var(--status-amber-bg)', 'var(--status-amber-fg)'], red: ['var(--status-red-bg)', 'var(--status-red-fg)'], blue: ['var(--primary-light)', 'var(--primary-dark)'] }[tone];
  return <span style={{ backgroundColor: t[0], color: t[1] }} className="inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide">{children}</span>;
}
export const statusTone = (s: string) => (['active', 'verified', 'approved', 'clear', 'converted'].includes(s) ? 'green' : ['restricted', 'blocked', 'withdrawn', 'cancelled'].includes(s) ? 'red' : ['paused', 'uncertain', 'held', 'proposed', 'pending', 'transfer-review'].includes(s) ? 'amber' : 'muted') as 'green' | 'red' | 'amber' | 'muted';

export function ClosureWarning() {
  return <div role="status" data-testid="text-closure-blocker" className="rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] px-3 py-2 text-sm font-medium text-[var(--status-amber-fg)]">{CLOSURE_WARNING}</div>;
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--status-red)] bg-[var(--status-red-bg)] p-3 text-sm text-[var(--status-red-fg)]">
      <span>{errMsg(error)}</span>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export function SkeletonRows({ n = 4 }: { n?: number }) {
  return <div className="space-y-2" aria-busy="true">{Array.from({ length: n }, (_, i) => <div key={i} className="h-12 animate-pulse rounded-md bg-[var(--surface-alt)]" />)}</div>;
}

export function SubNav({ active }: { active: 'list' | 'new' | 'intake' | 'policies' }) {
  const items = [['list', '/cases/separations', 'Separations'], ['new', '/cases/separations/new', 'New separation'], ['intake', '/cases/separations/intake', 'Batch and mailbox'], ['policies', '/cases/separations/policies', 'Policies']] as const;
  return (
    <nav aria-label="Separation sections" className="flex gap-1 overflow-x-auto border-b border-[var(--border)]">
      {items.map(([k, href, label]) => (
        <Link key={k} href={href} data-testid={`link-sep-${k}`} className={`shrink-0 border-b-2 px-3 py-2 text-sm ${active === k ? 'border-[var(--primary)] font-semibold text-[var(--primary)]' : 'border-transparent text-[var(--text-muted)]'}`}>{label}</Link>
      ))}
    </nav>
  );
}

export function LwdNote() {
  return (
    <div data-testid="text-lwd-docs" className="rounded-md border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-xs text-[var(--text-secondary)]">
      <b>End of last working day.</b> Standard access closure is not due until the end of the last working day, as defined by the approved policy for the exact country, role, worker category and IANA time zone: an HH:mm time in that zone. There is no built-in default; a country without an approved policy has no standard closure schedule. The server enforces the time, and this page does not calculate it or invent country rules. Urgent restricted handling uses the separate emergency security path.
    </div>
  );
}
