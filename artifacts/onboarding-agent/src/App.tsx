import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { pinOrganizationIdForPage } from '@workspace/api-client-react';
import { ClerkProvider, SignIn, SignUp, Show } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter, Redirect } from 'wouter';
import { Server } from 'lucide-react';

import { Layout } from './components/layout';
import { DashboardPage } from './pages/dashboard';
import { CasesPage } from './pages/cases/index';
import { CaseDetailPage } from './pages/cases/detail';
import { ApprovalsPage } from './pages/approvals';
import { WorkforceTransfersListPage } from './pages/workforce-transfers/index';
import { WorkforceTransfersCreatePage } from './pages/workforce-transfers/new';
import { WorkforceTransfersDetailPage } from './pages/workforce-transfers/detail';
import { SystemsPage } from './pages/systems';
import { AgentsPage } from './pages/agents';
import { AnalyticsPage } from './pages/analytics';
import { SettingsPage } from './pages/settings';
import { RecommendationsPage } from './pages/recommendations';
import { GuardrailsPage } from './pages/guardrails';
import { LoginPage } from './pages/login';
import { PrivateAdminSession } from './components/private-admin-session';
import { ClientSetupPage } from './pages/client-setup';
import { CandidatePage } from './pages/candidate';
import {
  resolveOrganizationBootstrap,
  resolveOrganizationSwitch,
  type OrganizationBootstrapResponse,
} from './lib/organization-bootstrap';
import { PolicyAssistantPage } from './pages/policy-assistant';
import { HrPolicyLibraryIndexPage } from './pages/hr-policy-library';
import { HrPolicyLibraryDetailPage } from './pages/hr-policy-library/detail';
import { AuditPage } from './pages/audit';
import { PolicyReviewPage } from './pages/policy-review';
import { LearningGuidePage } from './pages/learning-guide';

const queryClient = new QueryClient();

// REQUIRED — resolves the key from window.location.hostname so the same
// build serves multiple Clerk custom domains.
const initialCandidatePath = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/candidate`
  .replace(/^$/, '/candidate');
const isCandidateRoute = window.location.pathname === initialCandidatePath;
const clerkPubKey = isCandidateRoute
  ? ''
  : publishableKeyFromHost(
      window.location.hostname,
      import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
    );

// Empty in dev (Clerk hits dev FAPI directly), auto-set in prod.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

// Clerk passes full paths to routerPush/routerReplace, but wouter's
// setLocation prepends the base — strip it to avoid doubling.
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
}

if (!clerkPubKey && !isCandidateRoute) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: 'hsl(243 75% 59%)',
    colorForeground: 'hsl(222 47% 11%)',
    colorMutedForeground: 'hsl(215 16% 47%)',
    colorDanger: 'hsl(0 84% 60%)',
    colorBackground: '#ffffff',
    colorInput: '#ffffff',
    colorInputForeground: 'hsl(222 47% 11%)',
    colorNeutral: 'hsl(215 20% 65%)',
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    borderRadius: '0.5rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-xl border border-slate-200',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-slate-900 font-bold',
    headerSubtitle: 'text-slate-500',
    socialButtonsBlockButtonText: 'text-slate-700 font-medium',
    formFieldLabel: 'text-slate-700 font-medium',
    footerActionLink: 'text-indigo-600 font-semibold hover:text-indigo-700',
    footerActionText: 'text-slate-500',
    dividerText: 'text-slate-400',
    identityPreviewEditButton: 'text-indigo-600',
    formFieldSuccessText: 'text-emerald-600',
    alertText: 'text-red-600',
    logoBox: 'justify-center',
    logoImage: 'h-10 w-10 rounded-lg',
    socialButtonsBlockButton: 'border-slate-200 hover:bg-slate-50',
    formButtonPrimary: 'bg-indigo-600 hover:bg-indigo-700 text-white font-semibold',
    formFieldInput: 'border-slate-200 focus:border-indigo-500',
    footerAction: 'justify-center',
    dividerLine: 'bg-slate-200',
    alert: 'border-red-200 bg-red-50',
    otpCodeFieldInput: 'border-slate-200',
    formFieldRow: 'gap-2',
    main: 'gap-6',
  },
};

function AuthScreenShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-slate-50 px-4 py-10 gap-8">
      <div className="flex items-center gap-2 font-bold text-xl tracking-tight text-primary">
        <Server className="h-6 w-6" />
        <span>Agentic HRO Suite</span>
      </div>
      {children}
    </div>
  );
}

function SignInPage() {
  return (
    <AuthScreenShell>
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </AuthScreenShell>
  );
}

function SignUpPage() {
  return (
    <AuthScreenShell>
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        forceRedirectUrl={`${basePath}/client-setup`}
      />
    </AuthScreenShell>
  );
}

function HomeRoute() {
  return (
    <>
      <Show when="signed-in">
        <OrganizationBootstrapGate>
          <AppShell>
            <DashboardPage />
          </AppShell>
        </OrganizationBootstrapGate>
      </Show>
      <Show when="signed-out">
        <LoginPage />
      </Show>
    </>
  );
}

function Protected({ children }: { children: ReactNode }) {
  return (
    <>
      <Show when="signed-in">
        <OrganizationBootstrapGate>
          <AppShell>{children}</AppShell>
        </OrganizationBootstrapGate>
      </Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

function getStoredOrganizationId(): string | null {
  try {
    return localStorage.getItem('activeOrganizationId');
  } catch {
    return null;
  }
}

function OrganizationBootstrapGate({ children }: { children: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'loading' | 'setup' | 'choose' | 'ready' | 'error'>('loading');
  const [memberships, setMemberships] = useState<Array<{ organizationId: string; name: string }>>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    pinOrganizationIdForPage(null);
    const storedOrganizationId = getStoredOrganizationId();
    const headers = storedOrganizationId
      ? { 'x-organization-id': storedOrganizationId }
      : undefined;

    setState('loading');
    fetch('/api/organizations/current', {
      credentials: 'include',
      headers,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.message || 'Could not load organization access');
        }
        return body as OrganizationBootstrapResponse;
      })
      .then((response) => {
        if (!active) return;
        const decision = resolveOrganizationBootstrap(response, storedOrganizationId);
        if (decision.kind === 'setup') {
          setState('setup');
          return;
        }
        if (decision.kind === 'choose') {
          setMemberships(response.memberships.filter(
            (membership): membership is { organizationId: string; name: string } =>
              typeof membership.organizationId === 'string' &&
              'name' in membership && typeof membership.name === 'string',
          ));
          setState('choose');
          return;
        }
        if (decision.selectorChanged) {
          localStorage.setItem('activeOrganizationId', decision.organizationId);
          queryClient.clear();
        }
        pinOrganizationIdForPage(decision.organizationId);
        setState('ready');
      })
      .catch((caught) => {
        if (!active) return;
        pinOrganizationIdForPage(null);
        setError(caught instanceof Error ? caught.message : 'Could not load organization access');
        setState('error');
      });

    return () => {
      active = false;
    };
  }, [attempt]);

  if (state === 'setup') return <Redirect to="/client-setup" />;
  if (state === 'ready') return <>{children}</>;
  if (state === 'choose') {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-slate-50 px-4 py-8">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <h1 className="text-xl font-bold text-slate-900">Choose a workspace</h1>
          <p className="mt-2 text-sm text-slate-600">Select a client workspace you have been granted access to. Your access is checked again when you open it.</p>
          {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
          <div className="mt-6 flex flex-col gap-3">
            {memberships.map((membership) => (
              <button
                key={membership.organizationId}
                type="button"
                disabled={pendingId !== null}
                aria-busy={pendingId === membership.organizationId}
                className="min-h-12 w-full rounded-lg border border-slate-300 px-4 py-3 text-left text-sm font-semibold text-slate-900 hover:border-indigo-500 hover:bg-indigo-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60"
                onClick={async () => {
                  if (pendingId !== null) return;
                  setPendingId(membership.organizationId);
                  setError('');
                  try {
                    const response = await fetch('/api/organizations/current', {
                      credentials: 'include',
                      headers: { 'x-organization-id': membership.organizationId },
                    });
                    const body = await response.json().catch(() => ({}));
                    if (!response.ok) throw new Error(body.message || 'Could not validate workspace access');
                    const decision = resolveOrganizationSwitch(body as OrganizationBootstrapResponse, membership.organizationId);
                    if (decision.kind !== 'ready') throw new Error('You no longer have access to this workspace. Refresh to see your current choices.');
                    localStorage.setItem('activeOrganizationId', decision.organizationId);
                    queryClient.clear();
                    pinOrganizationIdForPage(decision.organizationId);
                    setState('ready');
                  } catch (caught) {
                    setError(caught instanceof Error ? caught.message : 'Could not open workspace');
                  } finally {
                    setPendingId(null);
                  }
                }}
              >
                {membership.name}{pendingId === membership.organizationId ? ' — Opening…' : ''}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => { setError(''); setAttempt((value) => value + 1); }} className="mt-6 min-h-11 text-sm font-medium text-indigo-700 underline underline-offset-2">
            Refresh access
          </button>
        </div>
      </main>
    );
  }
  if (state === 'error') {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-4">
        <p role="alert" className="text-sm text-red-600">{error}</p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)} className="rounded-md border px-4 py-2 text-sm font-semibold">
          Retry
        </button>
      </div>
    );
  }
  return <div className="flex min-h-[60vh] items-center justify-center text-sm text-slate-500">Loading organization…</div>;
}

function AppShell({ children }: { children: ReactNode }) {
  return (
    <Layout>
      <RoutedErrorBoundary>{children}</RoutedErrorBoundary>
    </Layout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomeRoute} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route path="/cases">
        <Protected><CasesPage /></Protected>
      </Route>
      <Route path="/cases/:id">
        <Protected><CaseDetailPage /></Protected>
      </Route>
      <Route path="/approvals">
        <Protected><ApprovalsPage /></Protected>
      </Route>
      <Route path="/workforce-transfers">
        <Protected><WorkforceTransfersListPage /></Protected>
      </Route>
      <Route path="/workforce-transfers/new">
        <Protected><WorkforceTransfersCreatePage /></Protected>
      </Route>
      <Route path="/workforce-transfers/:id">
        <Protected><WorkforceTransfersDetailPage /></Protected>
      </Route>
      <Route path="/agents">
        <Protected><AgentsPage /></Protected>
      </Route>
      <Route path="/systems">
        <Protected><SystemsPage /></Protected>
      </Route>
      <Route path="/guardrails">
        <Protected><GuardrailsPage /></Protected>
      </Route>
      <Route path="/policy-assistant">
        <Protected><PolicyAssistantPage /></Protected>
      </Route>
      <Route path="/analytics">
        <Protected><AnalyticsPage /></Protected>
      </Route>
      <Route path="/settings">
        <Protected><SettingsPage /></Protected>
      </Route>
      <Route path="/policy-review">
        <Protected><PolicyReviewPage /></Protected>
      </Route>
      <Route path="/hr-policy-library">
        <Protected><HrPolicyLibraryIndexPage /></Protected>
      </Route>
      <Route path="/hr-policy-library/:id">
        <Protected><HrPolicyLibraryDetailPage /></Protected>
      </Route>
      <Route path="/recommendations">
        <Protected><RecommendationsPage /></Protected>
      </Route>
      <Route path="/audit">
        <Protected><AuditPage /></Protected>
      </Route>
      <Route path="/uat-test-center/*?">
        <UatRelocation />
      </Route>
      <Route path="/learning-guide">
        <Protected><LearningGuidePage /></Protected>
      </Route>
      <Route path="/client-setup">
        <>
          <Show when="signed-in"><AppShell><ClientSetupPage /></AppShell></Show>
          <Show when="signed-out"><Redirect to="/" /></Show>
        </>
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function UatRelocation() {
  const fairness = window.location.pathname.endsWith('/fairness');
  const run = new URLSearchParams(window.location.search).get('run');
  const destination = fairness ? '/uat/fairness' : `/uat/${run ? `?run=${encodeURIComponent(run)}` : ''}`;
  return <main className="min-h-[100dvh] flex items-center justify-center bg-slate-50 px-4">
    <section className="max-w-lg rounded-xl border bg-white p-8">
      <h1 className="text-2xl font-bold">UAT has moved</h1>
      <p className="mt-3">Acceptance testing and evaluation now have a separate app. Sign in explicitly to UAT using your existing account. Your workspace permissions and saved runs are unchanged.</p>
      <a className="mt-6 inline-block rounded-md bg-indigo-600 px-4 py-3 font-semibold text-white" href={destination}>Open UAT sign-in</a>
      <a className="ml-4 inline-block underline" href="/">Control Tower</a>
    </section>
  </main>;
}
function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: 'Welcome back',
            subtitle: 'Sign in to open the control tower',
          },
        },
        signUp: {
          start: {
            title: 'Create your account',
            subtitle: 'Get access to the onboarding control tower',
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Show when="signed-in"><PrivateAdminSession /></Show>
          <Router />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  if (isCandidateRoute) {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider><CandidatePage /><Toaster /></TooltipProvider>
      </QueryClientProvider>
    );
  }
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
