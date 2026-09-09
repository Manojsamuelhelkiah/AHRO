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
import { SystemsPage } from './pages/systems';
import { AnalyticsPage } from './pages/analytics';
import { SettingsPage } from './pages/settings';
import { GuardrailsPage } from './pages/guardrails';
import { LoginPage } from './pages/login';
import { ClientSetupPage } from './pages/client-setup';
import { CandidatePage } from './pages/candidate';
import {
  resolveOrganizationBootstrap,
  type OrganizationBootstrapResponse,
} from './lib/organization-bootstrap';

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
  const [state, setState] = useState<'loading' | 'setup' | 'ready' | 'error'>('loading');
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
      <Route path="/systems">
        <Protected><SystemsPage /></Protected>
      </Route>
      <Route path="/guardrails">
        <Protected><GuardrailsPage /></Protected>
      </Route>
      <Route path="/analytics">
        <Protected><AnalyticsPage /></Protected>
      </Route>
      <Route path="/settings">
        <Protected><SettingsPage /></Protected>
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
