import { useState, type ReactNode } from 'react';
import { useAuth, useClerk } from '@clerk/react';
import { useLocation, useSearch } from 'wouter';
import { ClipboardCheck, ArrowRight, Loader2, ShieldCheck, FlaskConical, Scale, AlertTriangle } from 'lucide-react';
import { safeNext } from '@/lib/admission';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

const POINTS = [
  { icon: FlaskConical, title: 'Test runs', text: 'Guided scenarios with expected and observed evidence.' },
  { icon: ShieldCheck, title: 'Policy quality', text: 'Test benchmarks for the constrained Policy Assistant.' },
  { icon: Scale, title: 'Fairness evidence', text: 'Governed paired observations, not certification.' },
];

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-[100dvh] bg-[var(--midnight)] text-[var(--dark-text)] lg:grid-cols-[1.1fr_1fr]">
      <section className="flex flex-col justify-between gap-10 bg-[radial-gradient(circle_at_20%_10%,var(--control-tower),var(--midnight)_65%)] px-6 py-10 sm:px-12 lg:py-14">
        <div className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <ClipboardCheck className="h-6 w-6 text-[var(--lavender)]" /> UAT Test Center
        </div>
        <div className="max-w-xl">
          <p className="text-xs font-bold uppercase tracking-widest text-[var(--lavender-soft)]">Agentic HRO Suite</p>
          <h1 className="mt-3 text-3xl font-bold leading-tight sm:text-4xl">Acceptance testing with its own front door.</h1>
          <p className="mt-4 text-[var(--dark-text-2)]">Every UAT visit starts with a fresh sign-in and a verified workspace choice, so test evidence is always tied to a person and a client.</p>
          <ul className="mt-8 grid gap-3">
            {POINTS.map((point) => (
              <li key={point.title} className="flex gap-3 rounded-xl border border-[var(--dark-border)] bg-[var(--dark-raised)] p-3">
                <point.icon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--lavender)]" />
                <div><p className="text-sm font-semibold">{point.title}</p><p className="text-xs text-[var(--dark-text-muted)]">{point.text}</p></div>
              </li>
            ))}
          </ul>
        </div>
        <p className="hidden text-xs text-[var(--dark-text-muted)] lg:block">Test evidence is not certification and never changes operational readiness.</p>
      </section>
      <section className="flex items-center justify-center bg-[var(--surface-alt)] px-4 py-10 text-[var(--text-primary)]">{children}</section>
    </div>
  );
}

export function LoginPage({ notice }: { notice?: string }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const next = safeNext(`${location}${search ? `?${search}` : ''}`);
  const target = `${basePath}/sign-in?next=${encodeURIComponent(next)}`;

  async function begin() {
    setBusy(true);
    setError('');
    try {
      if (isSignedIn) {
        // A fresh session is required; end the shared one first.
        await signOut({ redirectUrl: target });
        return;
      }
      setLocation(`/sign-in?next=${encodeURIComponent(next)}`);
    } catch {
      setError('Could not prepare a fresh sign-in. Try again.');
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-md)] sm:p-8">
        <h2 className="text-2xl font-bold">Sign in to UAT</h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">UAT never reuses an existing Control Tower session. You will sign in again, then choose a workspace you have been granted.</p>
        {notice && <p role="status" className="mt-4 rounded-lg bg-[var(--status-info-bg)] p-3 text-sm text-[var(--status-info-fg)]" data-testid="text-uat-notice">{notice}</p>}
        <div role="note" className="mt-5 flex gap-2 rounded-lg border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--status-amber-fg)]" data-testid="text-shared-session-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{isSignedIn ? 'You are signed in to the shared account. Continuing ends that session, so other tabs or apps may ask you to sign in again.' : 'A fresh sign-in may replace a shared account session in other tabs or apps.'}</span>
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-[var(--status-red-fg)]">{error}</p>}
        <button
          type="button"
          onClick={() => void begin()}
          disabled={busy || !isLoaded}
          className="mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-[var(--primary)] px-4 text-sm font-semibold text-white hover:bg-[var(--primary-dark)] disabled:opacity-60"
          data-testid="button-start-uat-sign-in"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          {isSignedIn ? 'End shared session and sign in fresh' : 'Start fresh UAT sign-in'}
        </button>
        <a href="/" className="mt-4 block text-center text-xs text-[var(--text-muted)] underline" data-testid="link-back-control-tower">Back to Control Tower</a>
      </div>
    </AuthShell>
  );
}
