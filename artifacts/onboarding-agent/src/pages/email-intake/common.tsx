import { useUser } from '@clerk/react';
import { getPinnedOrganizationIdForPage } from '@workspace/api-client-react';
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui-shared';

export function useEmailScope() {
  const { user } = useUser();
  const org = getPinnedOrganizationIdForPage();
  return { org, scope: `${org ?? 'no-tenant'}:${user?.id ?? 'signed-out'}`, headers: org ? { 'x-organization-id': org } : {} } as { org: string | null; scope: string; headers: Record<string, string> };
}

export function safeError(e: unknown): string {
  const x = e as { status?: number; response?: { status?: number }; data?: { message?: string }; response2?: unknown };
  const status = x?.status ?? x?.response?.status;
  if (status === 403) return 'You do not have permission for this action in this workspace.';
  if (status === 401) return 'Your session has expired. Sign in again.';
  if (status === 404) return 'This item was not found or is not visible to you.';
  if (status === 409) return 'This record changed since you loaded it. Reload to see the latest version and retry.';
  if (status === 429) return 'Too many requests. Wait a moment and retry.';
  const m = x?.data?.message;
  return typeof m === 'string' && m.length < 200 ? m : 'The request could not be completed. Retry, or contact an administrator if it persists.';
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--status-red)] bg-[var(--status-red-bg)] p-3 text-sm text-[var(--status-red-fg)]">
      <span>{safeError(error)}</span>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export function Skeleton({ n = 3 }: { n?: number }) {
  return <div aria-busy="true" aria-label="Loading" className="space-y-2">{Array.from({ length: n }, (_, i) => <div key={i} className="h-12 animate-pulse rounded-md bg-[var(--surface-alt)]" />)}</div>;
}

type Tone = 'muted' | 'green' | 'amber' | 'red' | 'blue';
const TONES: Record<Tone, [string, string]> = { muted: ['var(--surface-alt)', 'var(--text-secondary)'], green: ['var(--status-green-bg)', 'var(--status-green-fg)'], amber: ['var(--status-amber-bg)', 'var(--status-amber-fg)'], red: ['var(--status-red-bg)', 'var(--status-red-fg)'], blue: ['var(--primary-light)', 'var(--primary-dark)'] };
export function Pill({ tone = 'muted', children }: { tone?: Tone; children: React.ReactNode }) {
  return <span style={{ backgroundColor: TONES[tone][0], color: TONES[tone][1] }} className="inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide">{children}</span>;
}
export const statusTone = (s: string): Tone => s === 'converted' ? 'green' : s === 'blocked' || s === 'rejected' ? 'red' : s === 'needs-review' ? 'amber' : s === 'received' ? 'blue' : 'muted';

export function CopyButton({ value, label, testId }: { value: string; label: string; testId?: string }) {
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <Button type="button" size="sm" variant="outline" className="gap-1.5" data-testid={testId} aria-label={`Copy ${label}`}
      onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); setFailed(false); setTimeout(() => setDone(false), 1800); } catch { setFailed(true); } }}>
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{failed ? 'Copy failed' : done ? 'Copied' : 'Copy'}
    </Button>
  );
}

export const inputCls = 'w-full min-h-9 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] disabled:opacity-60';
export const fmtDate = (s: string) => { const d = new Date(s); return isNaN(d.getTime()) ? 'Unknown' : d.toLocaleString(); };
