import { useEffect, useRef, useState } from 'react';
import { SignIn, useAuth, useClerk } from '@clerk/react';
import { Redirect, useLocation, useSearch } from 'wouter';
import { Loader2 } from 'lucide-react';
import { admitUatSession, getCurrentOrganization, pinOrganizationIdForPage, startUatSignIn } from '@workspace/api-client-react';
import { AuthShell } from '@/pages/login';
import { safeNext, useAdmissionHost } from '@/lib/admission';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

function Waiting({ text }: { text: string }) {
  return <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]" role="status"><Loader2 className="h-4 w-4 animate-spin" />{text}</div>;
}

export function SignInPage() {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const [location] = useLocation();
  const search = useSearch();
  const [next] = useState(() => safeNext(new URLSearchParams(search).get('next')));
  const [phase, setPhase] = useState<'wait' | 'ready' | 'shared' | 'error'>('wait');
  const started = useRef(false);
  const restart = `${basePath}/sign-in?next=${encodeURIComponent(next)}`;

  useEffect(() => {
    if (!isLoaded || started.current) return;
    started.current = true;
    // Sub-steps (factor, SSO callback) must not re-issue a challenge mid sign-in.
    if (location !== '/sign-in') { setPhase('ready'); return; }
    if (isSignedIn) { setPhase('shared'); return; }
    startUatSignIn().then(() => setPhase('ready')).catch(() => setPhase('error'));
  }, [isLoaded, isSignedIn, location]);

  return (
    <AuthShell>
      {phase === 'wait' && <Waiting text="Preparing a fresh UAT sign-in…" />}
      {phase === 'error' && (
        <div className="max-w-sm text-center">
          <p role="alert" className="text-sm text-[var(--status-red-fg)]">Could not start a UAT sign-in challenge.</p>
          <button type="button" className="mt-3 min-h-11 rounded-lg border px-4 text-sm font-semibold" onClick={() => window.location.reload()} data-testid="button-retry-challenge">Retry</button>
        </div>
      )}
      {phase === 'shared' && (
        <div className="w-full max-w-md rounded-2xl border bg-[var(--surface)] p-6 text-sm">
          <p>You are already signed in. UAT requires a brand-new sign-in, which ends the shared session first.</p>
          <button type="button" className="mt-4 min-h-12 w-full rounded-lg bg-[var(--primary)] font-semibold text-white" onClick={() => void signOut({ redirectUrl: restart })} data-testid="button-end-shared-session">End shared session and continue</button>
        </div>
      )}
      {phase === 'ready' && (
        <SignIn routing="path" path={`${basePath}/sign-in`} forceRedirectUrl={`${basePath}/verify?next=${encodeURIComponent(next)}`} fallbackRedirectUrl={`${basePath}/verify?next=${encodeURIComponent(next)}`} />
      )}
    </AuthShell>
  );
}

type Choice = { organizationId: string; name: string };

export function VerifyPage() {
  const { status } = useAdmissionHost();
  const { isLoaded, isSignedIn } = useAuth();
  const search = useSearch();
  const next = safeNext(new URLSearchParams(search).get('next'));
  if (status.kind === 'admitted') return <Redirect to={next} replace />;
  if (status.kind === 'checking' || !isLoaded) return <AuthShell><Waiting text="Checking UAT access…" /></AuthShell>;
  if (!isSignedIn) return <Redirect to={next} replace />;
  return <Chooser next={next} />;
}

function Chooser({ next }: { next: string }) {
  const { admit } = useAdmissionHost();
  const { signOut } = useClerk();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [choices, setChoices] = useState<Choice[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const restart = `${basePath}/sign-in?next=${encodeURIComponent(next)}`;

  useEffect(() => {
    let active = true;
    pinOrganizationIdForPage(null);
    setState('loading');
    getCurrentOrganization()
      .then((response) => {
        if (!active) return;
        setChoices(response.memberships.flatMap((m) => {
          const item = m as { organizationId?: unknown; name?: unknown };
          return typeof item.organizationId === 'string' && typeof item.name === 'string' ? [{ organizationId: item.organizationId, name: item.name }] : [];
        }));
        setState('ready');
      })
      .catch(() => { if (active) { setError('Could not load your verified workspaces.'); setState('error'); } });
    return () => { active = false; };
  }, [attempt]);

  async function choose(id: string) {
    if (pending) return;
    setPending(id);
    setError('');
    try {
      const admission = await admitUatSession({ headers: { 'x-organization-id': id } });
      admit(admission);
    } catch (caught) {
      const message = caught instanceof Error && caught.message ? caught.message : 'Admission was refused.';
      setError(`${message} Start a fresh UAT sign-in if the challenge expired or was already used.`);
      setPending(null);
    }
  }

  return (
    <AuthShell>
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-md)] sm:p-8">
        <h2 className="text-xl font-bold">Choose a workspace</h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">Only workspaces you have been granted appear here. The server checks again before admitting you for 30 minutes.</p>
        {error && <p role="alert" className="mt-4 text-sm text-[var(--status-red-fg)]" data-testid="text-admission-error">{error}</p>}
        {state === 'loading' && <div className="mt-6"><Waiting text="Loading verified workspaces…" /></div>}
        {state === 'ready' && choices.length === 0 && <p className="mt-6 text-sm">No workspace is available to this account. Ask an administrator for access.</p>}
        {state === 'ready' && (
          <div className="mt-6 flex flex-col gap-3">
            {choices.map((choice) => (
              <button key={choice.organizationId} type="button" disabled={pending !== null} aria-busy={pending === choice.organizationId} onClick={() => void choose(choice.organizationId)} data-testid={`button-workspace-${choice.organizationId}`}
                className="min-h-12 w-full rounded-lg border border-[var(--border-strong)] px-4 py-3 text-left text-sm font-semibold hover:border-[var(--primary)] hover:bg-[var(--surface-selected)] disabled:opacity-60">
                {choice.name}{pending === choice.organizationId ? ' — Admitting…' : ''}
              </button>
            ))}
          </div>
        )}
        <div className="mt-6 flex flex-wrap gap-4 text-sm font-medium text-[var(--primary)]">
          {state === 'error' && <button type="button" className="min-h-11 underline" onClick={() => setAttempt((v) => v + 1)} data-testid="button-retry-workspaces">Retry</button>}
          <button type="button" className="min-h-11 underline" onClick={() => void signOut({ redirectUrl: restart })} data-testid="button-fresh-sign-in">Start fresh UAT sign-in</button>
        </div>
      </div>
    </AuthShell>
  );
}
