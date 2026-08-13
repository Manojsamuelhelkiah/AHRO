import { useState } from 'react';
import { useSignIn } from '@clerk/react';
import { Server, Loader2, Lock, ArrowRight, Workflow, ShieldCheck, UserCheck } from 'lucide-react';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

/** Demo account shared with reviewers — real Clerk credentials under the hood. */
const DEMO_EMAIL = 'demo.reviewer@example.com';
const DEMO_PASSWORD = 'OnboardOS-Demo-2026!';

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
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [authing, setAuthing] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!signIn || authing) return;
    setAuthing(true);
    setLoginError(null);
    const startedAt = Date.now();
    try {
      if (email.trim().toLowerCase() === DEMO_EMAIL) {
        // The demo account's @example.com inbox can't receive Clerk's
        // device-verification code, so the server issues a one-time
        // sign-in ticket for it instead.
        const resp = await fetch(`${basePath}/api/onboarding/demo-login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: DEMO_EMAIL }),
        });
        if (!resp.ok) throw new Error('demo-login unavailable');
        const { ticket } = (await resp.json()) as { ticket: string };
        const { error: ticketError } = await signIn.ticket({ ticket });
        if (ticketError) throw new Error(ticketError.message);
      } else {
        const { error: pwError } = await signIn.password({ identifier: email.trim(), password });
        if (pwError) throw new Error(pwError.message);
      }
      if (signIn.status !== 'complete') throw new Error('additional verification required');
      localStorage.setItem('hro_authed', 'true');
      localStorage.setItem('hro_role', 'Reviewer');
      // Keep the branded "Authenticating…" moment visible (~1.5s total).
      const remaining = 1500 - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      const { error: finalizeError } = await signIn.finalize();
      if (finalizeError) throw new Error(finalizeError.message);
    } catch (err) {
      setLoginError(
        err instanceof Error && err.message === 'demo-login unavailable'
          ? 'Sign-in service is temporarily unavailable. Please try again in a moment.'
          : 'Sign-in failed. Please check your credentials and try again.',
      );
      setAuthing(false);
    }
  }

  return (
    <div className="min-h-[100dvh] lg:h-[100dvh] lg:overflow-hidden flex flex-col-reverse lg:flex-row">
      {/* LEFT — branding panel (65%) */}
      <div
        className="lg:w-[65%] lg:h-full lg:overflow-hidden text-white flex flex-col px-8 py-10 lg:px-12 lg:py-8 min-h-[50dvh] relative"
        style={{ background: 'linear-gradient(to bottom, #080626, #100D3E, #15134F)' }}
      >
        {/* dot-grid overlay */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(180,175,255,0.15) 1px, transparent 1px)',
            backgroundSize: '22px 22px',
            opacity: 0.15,
          }}
        />
        <div className="relative flex flex-col flex-1 gap-6 lg:gap-[clamp(16px,3vh,40px)] lg:justify-evenly lg:pb-[4vh] lg:min-h-0">
          {/* wordmark */}
          <div>
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 border" style={{ backgroundColor: 'rgba(101, 91, 243, 0.2)', borderColor: 'rgba(180, 175, 255, 0.18)' }}>
                <Server className="h-6 w-6 text-[#B9B4FF]" />
              </div>
              <div>
                <p className="text-[28px] leading-tight font-bold tracking-tight">Agentic HRO</p>
                <p className="text-[13px] font-light uppercase tracking-widest" style={{ color: '#B9B4FF' }}>Suite</p>
              </div>
            </div>
            <p className="mt-4 border-l-2 pl-3 text-base italic text-slate-300 max-w-md" style={{ borderColor: '#655BF3' }}>
              Intelligent HR operations, autonomously delivered
            </p>
            <p className="mt-4 text-[15px] font-medium text-white/90 max-w-lg">
              AI-powered HR operations, orchestrated with control, governance, and human oversight.
            </p>
          </div>

          {/* capability cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
            {CAPABILITIES.map((c) => (
              <div
                key={c.title}
                className="rounded-xl px-5 py-5 transition-all duration-200 hover:-translate-y-0.5"
                style={{ backgroundColor: 'rgba(255,255,255,0.055)', border: '1px solid rgba(180, 175, 255, 0.18)' }}
              >
                <c.icon className="h-5 w-5" style={{ color: '#B9B4FF' }} aria-hidden="true" />
                <p className="mt-3 text-[11px] uppercase tracking-widest font-semibold" style={{ color: '#B9B4FF' }}>{c.title}</p>
                <p className="mt-2 text-[13px] leading-relaxed text-white/85">{c.text}</p>
              </div>
            ))}
          </div>

          {/* operating model */}
          <div className="max-w-2xl">
            <div className="border-t pt-5" style={{ borderColor: 'rgba(180, 175, 255, 0.18)' }}>
              <div className="flex items-start justify-between gap-2 max-w-lg">
                {OPERATING_MODEL.map((step, i) => (
                  <div key={step.title} className="flex items-start flex-1 min-w-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] uppercase tracking-widest text-white font-semibold">{step.title}</p>
                      <p className="mt-1 text-xs text-slate-300">{step.text}</p>
                    </div>
                    {i < OPERATING_MODEL.length - 1 && (
                      <ArrowRight className="h-4 w-4 shrink-0 mx-3 mt-0.5" style={{ color: '#B9B4FF' }} aria-hidden="true" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* trust statement + footer pinned toward bottom */}
          <div className="mt-auto lg:mt-0 max-w-2xl space-y-4 lg:overflow-hidden">
            <div>
              <p className="text-sm font-semibold text-white/90">Designed for enterprise HR operations</p>
              <p className="mt-1 text-xs text-slate-400">Secure workflows · governed automation · human-in-the-loop</p>
            </div>
            <p className="text-[11px] text-slate-500">Powered by HCLTech</p>
          </div>
        </div>
      </div>

      {/* RIGHT — login panel (35%) */}
      <div className="lg:w-[35%] lg:h-full lg:overflow-y-auto bg-white flex flex-col relative">
        {/* top logo mark */}
        <div className="flex justify-center py-4 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
          <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ backgroundColor: 'var(--primary)' }}>
            <Server className="h-5 w-5 text-white" />
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center px-6 py-8">
          <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-5 lg:space-y-[clamp(10px,2vh,24px)]">
            <div className="space-y-1">
              <h1 className="text-[28px] font-bold text-[var(--text-primary)]">Welcome back</h1>
              <p className="text-sm text-[var(--text-secondary)]">Sign in to your control tower</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="login-email" className="text-sm font-medium text-[var(--text-primary)]">Email</label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
                className="w-full rounded-lg border px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)' }}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="login-password" className="text-sm font-medium text-[var(--text-primary)]">Password</label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className="w-full rounded-lg border px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)' }}
              />
            </div>
            {loginError && (
              <div
                role="alert"
                className="rounded-lg border px-3 py-2.5 text-sm"
                style={{ borderColor: 'rgba(239, 68, 68, 0.35)', backgroundColor: 'rgba(239, 68, 68, 0.06)', color: '#B91C1C' }}
              >
                {loginError}
              </div>
            )}
            <button
              type="submit"
              disabled={!signIn}
              className="w-full h-12 rounded-lg text-white font-semibold text-sm transition-all hover:-translate-y-px flex items-center justify-center gap-2 disabled:opacity-60"
              style={{ background: 'linear-gradient(to right, #4C42EE, #655BF3)' }}
            >
              Sign In <ArrowRight className="h-4 w-4" />
            </button>
            <p className="text-xs text-center" style={{ color: 'var(--text-muted)' }}>
              <a href={`${basePath}/sign-up`} className="font-medium hover:underline" style={{ color: 'var(--primary)' }}>Sign up</a>
              {' · '}
              <a href={`${basePath}/sign-in`} className="font-medium hover:underline" style={{ color: 'var(--primary)' }}>Full sign-in</a>
            </p>
          </form>
        </div>

        {/* bottom trust bar */}
        <div className="border-t py-4 flex items-center justify-center gap-5 grayscale" style={{ borderColor: 'var(--border)' }}>
          <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            <Lock className="h-3.5 w-3.5" /> Secured by
          </span>
          <span className="text-sm font-bold tracking-tight" style={{ color: 'var(--text-secondary)' }}>HCLTech</span>
        </div>

        {/* authenticating overlay */}
        {authing && (
          <div className="absolute inset-0 bg-white/95 z-10 flex flex-col items-center justify-center gap-4">
            <Loader2 className="h-9 w-9 animate-spin" style={{ color: 'var(--primary)' }} />
            <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Authenticating...</p>
          </div>
        )}
      </div>
    </div>
  );
}
