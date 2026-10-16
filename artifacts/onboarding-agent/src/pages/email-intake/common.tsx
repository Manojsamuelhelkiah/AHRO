import { useAuth, useUser } from '@clerk/react';
import { getPinnedOrganizationIdForPage, useGetHroEmailIntake, getGetHroEmailIntakeQueryKey } from '@workspace/api-client-react';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { accessDenied } from '@/lib/session-access';
import { SessionAccessNotice } from '@/components/session-access-notice';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui-shared';

export function useEmailScope() {
  const { user } = useUser();
  const { sessionId } = useAuth();
  const org = getPinnedOrganizationIdForPage();
  return { org, scope: `${org ?? 'no-tenant'}:${user?.id ?? 'signed-out'}:${sessionId ?? 'no-session'}`, headers: org ? { 'x-organization-id': org } : {} } as { org: string | null; scope: string; headers: Record<string, string> };
}

/** Same authorized read contract on both pages; never fetch request contents. */
export function useEmailReadiness() {
  const { scope, headers, org } = useEmailScope();
  return useGetHroEmailIntake({ request: { headers }, query: {
    queryKey: [...getGetHroEmailIntakeQueryKey(), scope], enabled: Boolean(org), retry: false,
    refetchInterval: q => emailAccessRefresh(q) ? 60_000 : false,
    refetchOnWindowFocus: emailAccessRefresh, refetchOnMount: 'always',
  } });
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
  if (accessDenied(error)) return <SessionAccessNotice error={error} />;
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--status-red)] bg-[var(--status-red-bg)] p-3 text-sm text-[var(--status-red-fg)]">
      <span>{safeError(error)}</span>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export const emailAccessRefresh = (query: { state: { error: unknown } }) => !accessDenied(query.state.error);

/** A readiness denial unmounts editors and removes every cached private view. */
export function useClearDeniedEmailData(error: unknown, reviewAccessLost = false) {
  const client = useQueryClient();
  useEffect(() => {
    if (!accessDenied(error) && !reviewAccessLost) return;
    const filters = { predicate: (query: { queryKey: readonly unknown[] }) =>
      typeof query.queryKey[0] === 'string' && (query.queryKey[0].startsWith('/api/onboarding/email-intake/') ||
        query.queryKey[0] === 'hro-email-private-source') };
    void client.cancelQueries(filters).then(() => client.removeQueries(filters));
  }, [error, reviewAccessLost, client]);
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

export function CopyButton({ value, html, label, testId }: { value: string; html?: string; label: string; testId?: string }) {
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <Button type="button" size="sm" variant="outline" className="gap-1.5" data-testid={testId} aria-label={`Copy ${label}`}
      onClick={async () => { try {
        if (html) await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([value], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })]);
        else await navigator.clipboard.writeText(value);
        setDone(true); setFailed(false); setTimeout(() => setDone(false), 1800);
      } catch { setDone(false); setFailed(true); } }}>
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{failed ? html ? 'Copy failed — use plain text' : 'Copy failed' : done ? 'Copied' : `Copy ${label}`}
    </Button>
  );
}

export const inputCls = 'w-full min-h-9 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] disabled:opacity-60';
export const fmtDate = (s: string) => { const d = new Date(s); return isNaN(d.getTime()) ? 'Unknown' : d.toLocaleString(); };
