import { useState } from 'react';
import { useSignIn } from '@clerk/react';
import { Server, Loader2, Lock, ArrowRight, Workflow, ShieldCheck, UserCheck } from 'lucide-react';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

/** Demo account shared with reviewers — real Clerk credentials under the hood. */
const DEMO_EMAIL = 'demo.reviewer@example.com';
const DEMO_ADMIN_EMAIL = 'demo.admin@example.com';
const DEMO_EMAILS = new Set([DEMO_EMAIL, DEMO_ADMIN_EMAIL]);

const CAPABILITIES = [
  {
    icon: Workflow,
    title: 'Autonomous Operations',
    text: 'AI agents execute HR workflows across the employee lifecycle.',
  },
  {
    icon: ShieldCheck,
    title: 'Governed Execution',
    text: 'Policies, rules, permissions, and controls guide every automated action.',
  },
  {
    icon: UserCheck,
    title: 'Human Oversight',
    text: 'Exceptions, approvals, and sensitive decisions are routed to the right people.',
  },
];

const OPERATING_MODEL = [
  { title: 'Agents', text: 'Execute workflows' },
  { title: 'Policies', text: 'Govern decisions' },
  { title: 'Humans', text: 'Handle exceptions' },
];

export function LoginPage() {
  const { signIn } = useSignIn();
  const [email, setEmail] = useState(DEMO_EMAIL);
  const [password, setPassword] = useState('');
  const [authing, setAuthing] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!signIn || authing) return;
    setAuthing(true);
    setLoginError(null);
    const startedAt = Date.now();
    try {
      // Demo accounts use a generic one-time ticket to bypass Clerk 2FA.
      // This is a controlled feature for demos only.
      if (DEMO_EMAILS.has(email.trim().toLowerCase())) {
        // The demo account's @example.com inbox can't receive Clerk's
        // device-verification code, so the server issues a one-time
        // sign-in ticket for it instead.
        const resp = await fetch(`${basePath}/api/onboarding/demo-login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email: email.trim().toLowerCase(), ...(email.trim().toLowerCase() === DEMO_ADMIN_EMAIL ? { password } : {}) }),
        });
        if (!resp.ok) {
          const failure = await resp.json().catch(() => null);
          throw new Error(failure?.message || 'demo-login unavailable');
        }
        const { ticket } = (await resp.json()) as { ticket: string };
        const { error: ticketError } = await signIn.ticket({ ticket });
        if (ticketError) throw new Error(ticketError.message);
      } else {
        const { error: pwError } = await signIn.password({ identifier: email.trim(), password });
        if (pwError) throw new Error(pwError.message);
      }
      if (signIn.status !== 'complete') throw new Error('additional verification required');
      localStorage.setItem('hro_authed', 'true');
      setPassword('');
      // Keep the branded "Authenticating…" moment visible (~1.5s total).
      const remaining = 1500 - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      const { error: finalizeError } = await signIn.finalize();
      if (finalizeError) throw new Error(finalizeError.message);
    } catch (err) {
      setLoginError(
        err instanceof Error && err.message === 'demo-login unavailable'
          ? 'Sign-in service is temporarily unavailable. Please try again in a moment.'
          : err instanceof Error ? err.message : 'Sign-in failed. Please check your credentials and try again.',
      );
      setAuthing(false);
    }
  }

  return (
    <div className="min-h-[100dvh] lg:h-[100dvh] lg:overflow-hidden flex flex-col-reverse lg:flex-row">
      {/* LEFT — branding panel (65%) */}
      <div
        className="lg:w-[65%] lg:h-full lg:overflow-hidden text-[var(--dark-text)] flex flex-col px-8 py-10 lg:px-12 lg:py-8 min-h-[50dvh] relative"
        style={{ background: 'linear-gradient(to bottom, var(--midnight), var(--deep-navy), var(--control-tower))' }}
      >
        {/* dot-grid overlay */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: 'radial-gradient(circle, var(--dark-border) 1px, transparent 1px)',
            backgroundSize: '22px 22px',
          }}
        />
        <div className="relative flex flex-col flex-1 gap-6 lg:gap-[clamp(16px,3vh,40px)] lg:justify-evenly lg:pb-[4vh] lg:min-h-0">
          {/* wordmark */}
          <div>
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-[var(--radius-lg)] flex items-center justify-center shrink-0 border border-[var(--dark-border)]" style={{ backgroundColor: 'var(--dark-raised)' }}>
                <Server className="h-6 w-6 text-[var(--lavender)]" />
              </div>
              <div>
                <p className="text-[28px] leading-tight font-bold tracking-tight text-[var(--dark-text)]">Agentic HRO</p>
                <p className="text-[13px] font-medium uppercase tracking-widest text-[var(--lavender)]">Suite</p>
              </div>
            </div>
            <p className="mt-4 border-l-2 pl-3 text-base italic text-[var(--dark-text-2)] max-w-md border-[var(--violet)]">
              Intelligent HR operations, autonomously delivered
            </p>
            <p className="mt-4 text-[15px] font-medium text-[var(--dark-text)] max-w-lg">
              AI-powered HR operations, orchestrated with control, governance, and human oversight.
            </p>
          </div>

          {/* capability cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
            {CAPABILITIES.map((c) => (
              <div
                key={c.title}
                className="rounded-[var(--radius-lg)] px-5 py-5 transition-all duration-200 hover:-translate-y-0.5 border border-[var(--dark-border)] bg-[var(--dark-raised)]"
              >
                <c.icon className="h-5 w-5 text-[var(--lavender)]" aria-hidden="true" />
                <p className="mt-3 text-[11px] uppercase tracking-widest font-semibold text-[var(--lavender)]">{c.title}</p>
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--dark-text-2)]">{c.text}</p>
              </div>
            ))}
          </div>

          {/* operating model */}
          <div className="max-w-2xl">
            <div className="border-t border-[var(--dark-border)] pt-5">
              <div className="flex items-start justify-between gap-2 max-w-lg">
                {OPERATING_MODEL.map((step, i) => (
                  <div key={step.title} className="flex items-start flex-1 min-w-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] uppercase tracking-widest text-[var(--dark-text)] font-semibold">{step.title}</p>
                      <p className="mt-1 text-xs text-[var(--dark-text-2)]">{step.text}</p>
                    </div>
                    {i < OPERATING_MODEL.length - 1 && (
                      <ArrowRight className="h-4 w-4 shrink-0 mx-3 mt-0.5 text-[var(--lavender)]" aria-hidden="true" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* trust statement + footer pinned toward bottom */}
          <div className="mt-auto lg:mt-0 max-w-2xl space-y-4 lg:overflow-hidden">
            <div>
              <p className="text-sm font-semibold text-[var(--dark-text)]">Designed for enterprise HR operations</p>
              <p className="mt-1 text-xs text-[var(--dark-text-2)]">Secure workflows · governed automation · human-in-the-loop</p>
            </div>
            <p className="text-[11px] text-[var(--dark-text-muted)]">Powered by HCLTech</p>
          </div>
        </div>
      </div>

      {/* RIGHT — login panel (35%) */}
      <div className="lg:w-[35%] lg:h-full lg:overflow-y-auto bg-[var(--surface)] flex flex-col relative">
        {/* top logo mark */}
        <div className="flex justify-center py-4 border-b border-[var(--border)] shrink-0">
          <div className="w-9 h-9 rounded-[var(--radius-md)] flex items-center justify-center bg-[var(--primary)]">
            <Server className="h-5 w-5 text-white" />
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center px-6 py-8">
          <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-5 lg:space-y-[clamp(10px,2vh,24px)]">
            <div className="space-y-1">
              <h1 className="text-[28px] font-bold text-[var(--text-primary)]">Welcome back</h1>
              <p className="text-[var(--text-sm)] text-[var(--text-secondary)]">Sign in to your control tower</p>
            </div>
             <div className="space-y-2" aria-label="Demo access profiles">
               <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                 Choose a demo profile
               </p>
               <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                 <button
                   type="button"
                   onClick={() => {
                     setEmail(DEMO_EMAIL);
                     setPassword('');
                   }}
                   className={`rounded-[var(--radius-md)] border p-3 text-left transition-colors ${
                     email.trim().toLowerCase() === DEMO_EMAIL
                       ? 'border-[var(--primary)] bg-[var(--primary-light)]'
                       : 'border-[var(--border)] hover:border-[var(--primary)]'
                   }`}
                 >
                   <span className="block text-sm font-semibold text-[var(--text-primary)]">Demo Reviewer</span>
                   <span className="mt-1 block text-xs text-[var(--text-secondary)]">Low-access review</span>
                 </button>
                 <button
                   type="button"
                   onClick={() => {
                     setEmail(DEMO_ADMIN_EMAIL);
                     setPassword('');
                   }}
                   className={`rounded-[var(--radius-md)] border p-3 text-left transition-colors ${
                     email.trim().toLowerCase() === DEMO_ADMIN_EMAIL
                       ? 'border-[var(--primary)] bg-[var(--primary-light)]'
                       : 'border-[var(--border)] hover:border-[var(--primary)]'
                   }`}
                 >
                   <span className="block text-sm font-semibold text-[var(--text-primary)]">Super Admin</span>
                   <span className="mt-1 block text-xs text-[var(--text-secondary)]">Password-protected development access</span>
                 </button>
               </div>
               {email.trim().toLowerCase() === DEMO_ADMIN_EMAIL && (
                 <p className="rounded border border-[var(--status-amber)]/30 bg-[var(--status-amber-bg)] px-3 py-2 text-xs text-[var(--status-amber-fg)]">
                   Use your private development password. This account can administer clients in development; production access, verification and execution safeguards remain separate.
                 </p>
               )}
             </div>
            <div className="space-y-1.5">
              <label htmlFor="login-email" className="text-[var(--text-sm)] font-medium text-[var(--text-primary)]">Email</label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
                className="w-full rounded-[var(--radius-md)] border px-3 py-2.5 text-[var(--text-sm)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)] transition-all bg-[var(--surface)] border-[var(--border)]"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="login-password" className="text-[var(--text-sm)] font-medium text-[var(--text-primary)]">Password</label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required={email.trim().toLowerCase() !== DEMO_EMAIL}
                disabled={email.trim().toLowerCase() === DEMO_EMAIL}
                placeholder={email.trim().toLowerCase() === DEMO_EMAIL ? 'Not required for restricted demo review' : 'Enter your password'}
                className="w-full rounded-[var(--radius-md)] border px-3 py-2.5 text-[var(--text-sm)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)] transition-all bg-[var(--surface)] border-[var(--border)]"
              />
            </div>
            {loginError && (
              <div
                role="alert"
                className="rounded-[var(--radius-md)] border px-3 py-2.5 text-[var(--text-sm)] border-[var(--status-red)] bg-[var(--status-red-bg)] text-[var(--status-red-fg)]"
              >
                {loginError}
              </div>
            )}
            <button
              type="submit"
              disabled={!signIn}
              className="w-full h-12 rounded-[var(--radius-md)] text-white font-semibold text-[var(--text-sm)] transition-all hover:-translate-y-px flex items-center justify-center gap-2 disabled:opacity-60 bg-[var(--primary)] shadow-[var(--shadow-sm)] hover:bg-[var(--primary-dark)]"
            >
              Sign In <ArrowRight className="h-4 w-4" />
            </button>
            <p className="text-[var(--text-xs)] text-center text-[var(--text-muted)] mt-4">
              <a href={`${basePath}/sign-up`} className="font-medium hover:underline text-[var(--primary)]">Sign up</a>
              {' · '}
              <a href={`${basePath}/sign-in`} className="font-medium hover:underline text-[var(--primary)]">Full sign-in</a>
            </p>
          </form>
        </div>

        {/* bottom trust bar */}
        <div className="border-t border-[var(--border)] py-4 flex items-center justify-center gap-5 grayscale">
          <span className="flex items-center gap-1.5 text-[var(--text-xs)] font-medium text-[var(--text-muted)]">
            <Lock className="h-3.5 w-3.5" /> Secured by
          </span>
          <span className="text-[var(--text-sm)] font-bold tracking-tight text-[var(--text-secondary)]">HCLTech</span>
        </div>

        {/* authenticating overlay */}
        {authing && (
          <div className="absolute inset-0 bg-[var(--surface)]/95 z-10 flex flex-col items-center justify-center gap-4">
            <Loader2 className="h-9 w-9 animate-spin text-[var(--primary)]" />
            <p className="text-[var(--text-sm)] font-medium text-[var(--text-secondary)]">Authenticating...</p>
          </div>
        )}
      </div>
    </div>
  );
}
