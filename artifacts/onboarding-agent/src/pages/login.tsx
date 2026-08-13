import { useEffect, useState } from 'react';
import { useSignIn } from '@clerk/react';
import { Server, Loader2, Lock, ArrowRight } from 'lucide-react';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

/** Demo account shared with reviewers — real Clerk credentials under the hood. */
const DEMO_EMAIL = 'demo.reviewer@example.com';
const DEMO_PASSWORD = 'OnboardOS-Demo-2026!';

const ROLES = ['Reviewer', 'Admin', 'Agent Supervisor'] as const;

const METRICS = [
  { label: 'ACTIVE CASES', value: '13', trend: '↑ 2 from last week', trendClass: 'text-green-400' },
  { label: 'SLA ADHERENCE', value: '99.2%', trend: '↑ 0.3% from last week', trendClass: 'text-green-400' },
  { label: 'HARD BLOCKS', value: '0', trend: '✓ Clear today', trendClass: 'text-green-400' },
];

const AGENTS = ['Onboarding Agent', 'Payroll Agent', 'Compliance Agent', 'Helpdesk Agent'];

const FEED_ITEMS: { badge: 'AI' | 'SYS' | 'RULES'; text: string; time: string }[] = [
  { badge: 'AI', text: 'Reply drafted & dispatched', time: 'just now' },
  { badge: 'SYS', text: 'Background verification complete', time: '1m ago' },
  { badge: 'AI', text: 'Payroll setup initiated', time: '2m ago' },
  { badge: 'RULES', text: 'Rehire flagged for HR review', time: '4m ago' },
  { badge: 'SYS', text: 'Employment archive queried', time: '5m ago' },
];

const BADGE_STYLES: Record<string, string> = {
  AI: 'bg-indigo-500/30 text-indigo-200 border border-indigo-400/30',
  SYS: 'bg-slate-500/30 text-slate-200 border border-slate-400/30',
  RULES: 'bg-amber-500/25 text-amber-200 border border-amber-400/30',
};

function ActivityFeed() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, []);
  const rows = Array.from({ length: 5 }, (_, i) => FEED_ITEMS[(tick + i) % FEED_ITEMS.length]);
  return (
    <div className="space-y-2.5" aria-hidden="true">
      <p className="text-[11px] uppercase tracking-[0.25em] text-indigo-300 font-semibold">Live agent activity</p>
      {rows.map((item, i) => (
        <div
          key={`${tick}-${i}`}
          className="flex items-center gap-3 animate-in fade-in slide-in-from-bottom-1 duration-700"
          style={{ opacity: 1 - i * 0.13 }}
        >
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold shrink-0 ${BADGE_STYLES[item.badge]}`}>
            {item.badge}
          </span>
          <span className="text-[13px] text-white/90 flex-1 truncate">{item.text}</span>
          <span className="text-xs text-slate-400 shrink-0">{item.time}</span>
        </div>
      ))}
    </div>
  );
}

export function LoginPage() {
  const { signIn } = useSignIn();
  const [email, setEmail] = useState(DEMO_EMAIL);
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [role, setRole] = useState<(typeof ROLES)[number]>('Reviewer');
  const [authing, setAuthing] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!signIn || authing) return;
    setAuthing(true);
    const startedAt = Date.now();
    try {
      if (email.trim().toLowerCase() === DEMO_EMAIL) {
        // The demo account's @example.com inbox can't receive Clerk's
        // device-verification code, so the server issues a one-time
        // sign-in ticket for it instead.
        const resp = await fetch('/api/onboarding/demo-login', {
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
      localStorage.setItem('hro_role', role);
      // Keep the branded "Authenticating…" moment visible (~1.5s total).
      const remaining = 1500 - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      const { error: finalizeError } = await signIn.finalize();
      if (finalizeError) throw new Error(finalizeError.message);
    } catch {
      // Demo spec: no visible error messages — quietly return to the form.
      setAuthing(false);
    }
  }

  return (
    <div className="min-h-[100dvh] flex flex-col-reverse lg:flex-row">
      {/* LEFT — branding panel (65%) */}
      <div
        className="lg:w-[65%] text-white flex flex-col px-8 py-10 lg:px-14 lg:py-12 min-h-[50dvh] relative"
        style={{ background: 'linear-gradient(to bottom, #0f0c29, #1e1b4b, #302b63)' }}
      >
        {/* dot-grid overlay */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: 'radial-gradient(circle, #ffffff 1px, transparent 1px)',
            backgroundSize: '22px 22px',
            opacity: 0.05,
          }}
        />
        <div className="relative flex flex-col flex-1 gap-8">
          {/* wordmark */}
          <div>
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-indigo-500/30 border border-indigo-300/30 flex items-center justify-center shrink-0">
                <Server className="h-6 w-6 text-indigo-200" />
              </div>
              <div>
                <p className="text-[28px] leading-tight font-bold tracking-tight">Agentic HRO</p>
                <p className="text-sm font-light text-indigo-300">Platform</p>
              </div>
            </div>
            <p className="mt-5 border-l-2 border-indigo-400 pl-3 text-base italic text-slate-300 max-w-md">
              Intelligent HR operations, autonomously delivered
            </p>
          </div>

          {/* metric cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
            {METRICS.map((m) => (
              <div key={m.label} className="rounded-xl bg-white/[0.06] border border-white/10 backdrop-blur px-5 py-4">
                <p className="text-[11px] uppercase tracking-widest text-indigo-300 font-semibold">{m.label}</p>
                <p className="text-[32px] font-bold text-white leading-tight mt-1">{m.value}</p>
                <p className={`text-xs mt-1 ${m.trendClass}`}>{m.trend}</p>
              </div>
            ))}
          </div>

          {/* agent coverage */}
          <div className="max-w-2xl">
            <div className="border-t border-white/10 pt-6">
              <p className="text-[11px] uppercase tracking-[0.25em] text-indigo-300 font-semibold mb-3">Agent coverage</p>
              <div className="space-y-2.5">
                {AGENTS.map((a) => (
                  <div key={a} className="flex items-center gap-3">
                    <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
                    <span className="text-sm text-white/90 flex-1">{a}</span>
                    <span className="text-xs text-green-400">Active · 0 errors</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* live feed pinned toward bottom */}
          <div className="mt-auto max-w-2xl space-y-6">
            <ActivityFeed />
            <p className="text-center text-[11px] text-slate-500">Powered by HCLTech</p>
          </div>
        </div>
      </div>

      {/* RIGHT — login panel (35%) */}
      <div className="lg:w-[35%] bg-white flex flex-col relative">
        {/* top logo mark */}
        <div className="flex justify-center py-5 border-b border-slate-100">
          <div className="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center">
            <Server className="h-5 w-5 text-white" />
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center px-6 py-12">
          <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-6">
            <div className="space-y-1">
              <h1 className="text-[28px] font-bold" style={{ color: '#0f0c29' }}>Welcome back</h1>
              <p className="text-sm text-slate-500">Sign in to your control tower</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="login-email" className="text-sm font-medium text-slate-700">Email</label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/25"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="login-password" className="text-sm font-medium text-slate-700">Password</label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/25"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="login-role" className="text-sm font-medium text-slate-700">Role</label>
              <select
                id="login-role"
                value={role}
                onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-900 bg-white focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/25"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={!signIn}
              className="w-full h-12 rounded-lg text-white font-semibold text-sm transition-all hover:-translate-y-px flex items-center justify-center gap-2 disabled:opacity-60"
              style={{ background: 'linear-gradient(to right, #4f46e5, #6366f1)' }}
            >
              Sign In <ArrowRight className="h-4 w-4" />
            </button>
            <p className="text-xs text-slate-400 text-center">Demo mode · No credentials required</p>
            <p className="text-xs text-slate-400 text-center">
              <a href={`${basePath}/sign-up`} className="text-indigo-500 hover:text-indigo-600 font-medium">Sign up</a>
              {' · '}
              <a href={`${basePath}/sign-in`} className="text-indigo-500 hover:text-indigo-600 font-medium">Full sign-in</a>
            </p>
          </form>
        </div>

        {/* bottom trust bar */}
        <div className="border-t border-slate-100 py-4 flex items-center justify-center gap-5 grayscale">
          <span className="flex items-center gap-1.5 text-xs text-slate-400 font-medium">
            <Lock className="h-3.5 w-3.5" /> Secured by
          </span>
          <span className="text-sm font-bold text-slate-500 tracking-tight">HCLTech</span>
        </div>

        {/* authenticating overlay */}
        {authing && (
          <div className="absolute inset-0 bg-white/95 z-10 flex flex-col items-center justify-center gap-4">
            <Loader2 className="h-9 w-9 animate-spin text-indigo-600" />
            <p className="text-sm font-medium text-slate-600">Authenticating...</p>
          </div>
        )}
      </div>
    </div>
  );
}
