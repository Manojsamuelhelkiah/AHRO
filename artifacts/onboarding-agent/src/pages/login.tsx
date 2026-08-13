import { useEffect, useState } from 'react';
import { useSignIn } from '@clerk/react';
import { Server, Loader2 } from 'lucide-react';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

/** Demo account shared with reviewers — real Clerk credentials under the hood. */
const DEMO_EMAIL = 'demo.reviewer@example.com';
const DEMO_PASSWORD = 'OnboardOS-Demo-2026!';

const ROLES = ['Reviewer', 'Admin', 'Agent Supervisor'] as const;

const STATS = [
  '13 Active Cases',
  '99.2% SLA Adherence',
  '0 Hard Blocks Today',
];

const FEED_ITEMS = [
  'AI Agent — Reply drafted & dispatched · just now',
  'SYS — Background verification complete · 1m ago',
  'AI Agent — Payroll setup initiated · 2m ago',
  'LDM — Employment archive queried (2 stints) · 3m ago',
  'RULES — Rehire flagged for HR review · 4m ago',
  'AI Agent — Kick-off call slots offered · 6m ago',
  'SYS — Laptop dispatch confirmed · 8m ago',
  'HUMAN — Approval AP-44 decided · 11m ago',
];

function StatPills() {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setActive((a) => (a + 1) % STATS.length), 2600);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex flex-wrap gap-3">
      {STATS.map((s, i) => (
        <span
          key={s}
          className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-all duration-500 ${
            i === active
              ? 'border-indigo-300/60 bg-indigo-400/20 text-white scale-105'
              : 'border-white/15 bg-white/5 text-indigo-200/80'
          }`}
        >
          {s}
        </span>
      ))}
    </div>
  );
}

function ActivityFeed() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 3200);
    return () => clearInterval(t);
  }, []);
  const visible = Array.from({ length: 4 }, (_, i) => FEED_ITEMS[(tick + i) % FEED_ITEMS.length]);
  return (
    <div className="space-y-2" aria-hidden="true">
      <p className="text-[10px] uppercase tracking-[0.2em] text-indigo-300/60 font-semibold">Live agent activity</p>
      {visible.map((item, i) => (
        <p
          key={`${tick}-${i}`}
          className="font-mono text-xs text-indigo-100/60 animate-in fade-in slide-in-from-bottom-1 duration-700"
          style={{ opacity: 1 - i * 0.18 }}
        >
          {item}
        </p>
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
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!signIn || authing) return;
    setAuthing(true);
    setError(null);
    const startedAt = Date.now();
    try {
      const { error: pwError } = await signIn.password({ identifier: email.trim(), password });
      if (pwError) {
        throw new Error(pwError.message || 'Sign-in failed. Please check your credentials.');
      }
      if (signIn.status !== 'complete') {
        throw new Error('Additional verification required — use the full sign-in page.');
      }
      localStorage.setItem('hro_authed', 'true');
      localStorage.setItem('hro_role', role);
      // Keep the branded "Authenticating…" moment visible (~1.5s total).
      const remaining = 1500 - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      const { error: finalizeError } = await signIn.finalize();
      if (finalizeError) throw new Error(finalizeError.message || 'Could not start the session.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign-in failed. Please try again.');
      setAuthing(false);
    }
  }

  return (
    <div className="min-h-[100dvh] flex flex-col-reverse lg:flex-row">
      {/* LEFT — branding panel (65%) */}
      <div className="lg:w-[65%] bg-[#1e1b4b] text-white flex flex-col justify-between px-8 py-10 lg:px-14 lg:py-12 min-h-[45dvh]">
        <div className="space-y-8">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-indigo-500/30 border border-indigo-300/30 flex items-center justify-center">
              <Server className="h-6 w-6 text-indigo-200" />
            </div>
            <span className="text-2xl lg:text-3xl font-bold tracking-tight">Autonomous HRO</span>
          </div>
          <p className="text-lg text-indigo-200/90 max-w-md">Intelligent HR operations, autonomously delivered</p>
          <StatPills />
        </div>
        <div className="pt-10">
          <ActivityFeed />
        </div>
      </div>

      {/* RIGHT — login panel (35%) */}
      <div className="lg:w-[35%] bg-white flex items-center justify-center px-6 py-12 lg:py-0">
        <div className="w-full max-w-sm">
          {authing ? (
            <div className="flex flex-col items-center gap-4 text-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
              <p className="text-sm font-medium text-slate-600">Authenticating with HRO platform...</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-1">
                <h1 className="text-2xl font-bold text-slate-900">Welcome back</h1>
                <p className="text-sm text-slate-500">Sign in to your HRO control tower</p>
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
                  className="w-full rounded-md border border-slate-200 px-3 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
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
                  className="w-full rounded-md border border-slate-200 px-3 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="login-role" className="text-sm font-medium text-slate-700">Role</label>
                <select
                  id="login-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
                  className="w-full rounded-md border border-slate-200 px-3 py-2.5 text-sm text-slate-900 bg-white focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
              <button
                type="submit"
                disabled={!signIn}
                className="w-full rounded-md bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold py-3 text-sm transition-colors"
              >
                Sign In
              </button>
              <p className="text-xs text-slate-400 text-center">Demo mode — the demo reviewer account is pre-filled</p>
              <p className="text-xs text-slate-400 text-center">
                Need your own account?{' '}
                <a href={`${basePath}/sign-up`} className="text-indigo-600 font-semibold hover:text-indigo-700">Sign up</a>
                {' '}or use the{' '}
                <a href={`${basePath}/sign-in`} className="text-indigo-600 font-semibold hover:text-indigo-700">full sign-in page</a>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
