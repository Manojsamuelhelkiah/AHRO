import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { ClipboardCheck, ExternalLink, FlaskConical, LogOut, Repeat, Scale, ShieldCheck } from 'lucide-react';
import { useAdmission, useAdmissionHost } from '@/lib/admission';
import { cn } from '@/components/ui-shared';
import { DriftNotificationBanner } from './drift-notifications';

const NAV = [
  { path: '/', label: 'Acceptance history', icon: ClipboardCheck },
  { path: '/policy-quality', label: 'Policy governance', icon: ShieldCheck },
];

function useMinutesLeft(expiresAt: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 60_000));
}

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const admission = useAdmission();
  const { end } = useAdmissionHost();
  const minutes = useMinutesLeft(admission.expiresAt);
  const active = (path: string) => (path === '/' ? location === '/' : location.startsWith(path));

  return (
    <div data-uat-shell className="flex min-h-[100dvh] min-w-0 flex-col bg-[var(--surface-alt)] md:flex-row">
      <aside className="hidden w-64 shrink-0 flex-col justify-between bg-[var(--midnight)] p-5 text-[var(--dark-text)] md:flex">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <ClipboardCheck className="h-5 w-5 text-[var(--lavender)]" />
            UAT Test Center
          </div>
          <p className="mt-1 text-xs text-[var(--dark-text-muted)]">Acceptance evidence, kept apart from operations.</p>
          <nav className="mt-8 flex flex-col gap-1" aria-label="UAT navigation">
            {NAV.map((item) => (
              <Link
                key={item.path}
                href={item.path}
                data-testid={`link-nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
                className={cn(
                  'flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium',
                  active(item.path) ? 'bg-[var(--dark-raised)] text-white ring-1 ring-[var(--dark-border)]' : 'text-[var(--dark-text-2)] hover:bg-[var(--dark-raised)]',
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <a href="/" className="flex items-center gap-1 text-xs text-[var(--dark-text-muted)] underline-offset-2 hover:underline" data-testid="link-control-tower">
          Open Control Tower <ExternalLink className="h-3 w-3" />
        </a>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3 sm:px-6">
          <div className="min-w-0 text-xs text-[var(--text-muted)]" data-testid="text-uat-admission">
            <span className="font-semibold text-[var(--text-primary)]">Workspace</span>{' '}
            <span className="font-mono">{admission.organizationId}</span> · admission closes in {minutes} min
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => end('Workspace changes need a fresh UAT sign-in.')}
              className="flex min-h-9 items-center gap-1.5 rounded-md border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-alt)]"
              data-testid="button-change-workspace"
            >
              <Repeat className="h-3.5 w-3.5" /> Change workspace
            </button>
            <button
              type="button"
              onClick={() => end('You have logged out of UAT. Other apps were not signed out.')}
              className="flex min-h-9 items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 text-xs font-semibold text-white hover:bg-[var(--primary-dark)]"
              data-testid="button-uat-logout"
            >
              <LogOut className="h-3.5 w-3.5" /> Log out
            </button>
          </div>
        </header>

        <nav className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 md:hidden" aria-label="UAT navigation">
          {NAV.map((item) => (
            <Link
              key={item.path}
              href={item.path}
              className={cn(
                'flex min-h-10 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium',
                active(item.path) ? 'bg-[var(--surface-selected)] text-[var(--primary)]' : 'text-[var(--text-secondary)]',
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
        </nav>

        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
