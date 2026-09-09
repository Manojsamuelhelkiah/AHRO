import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { pinOrganizationIdForPage } from '@workspace/api-client-react';
import { ClerkProvider, SignIn, SignUp, Show } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';

import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter, useLocation, Redirect } from 'wouter';
import { Check, Copy, Workflow } from 'lucide-react';

import { AppLayout } from '@/components/layout';
import NotFound from '@/pages/not-found';
import Dashboard from '@/pages/dashboard';
import Intents from '@/pages/intents';
import IntentDetail from '@/pages/intent-detail';
import Flows from '@/pages/flows';
import EnterpriseArchitecture from '@/pages/enterprise-architecture';
import Scenario from '@/pages/scenario';
import Assumptions from '@/pages/assumptions';
import Compare from '@/pages/compare';
import Pricing from '@/pages/pricing';
import ProductPricing from '@/pages/product-pricing';
import Calibration from '@/pages/calibration';
import RateRegister from '@/pages/rates';
import { resolveOrganizationBootstrap, type OrganizationBootstrapResponse } from '@/lib/organization-bootstrap';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const PENDING_ORGANIZATION_KEY = 'costExplorerPendingOrganization';

type PendingOrganization = {
  organization: { id: string; name: string };
  joinCode: string;
};

function loadPendingOrganization(): PendingOrganization | null {
  try {
    const pending = JSON.parse(sessionStorage.getItem(PENDING_ORGANIZATION_KEY) || 'null');
    if (
      typeof pending?.organization?.id === 'string'
      && typeof pending?.organization?.name === 'string'
      && typeof pending?.joinCode === 'string'
      && pending.joinCode
    ) {
      return pending;
    }
  } catch {
    // Ignore corrupt or unavailable session storage.
  }
  return null;
}

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  variables: {
    colorPrimary: 'hsl(221 83% 53%)',
    colorForeground: 'hsl(222 47% 11%)',
  },
  elements: {
    cardBox: 'shadow-none border border-slate-200',
  }
};

function AuthScreenShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-4 py-10 gap-8">
      <div className="font-bold text-xl tracking-tight flex items-center gap-2">
        <div className="w-8 h-8 bg-primary rounded-sm flex items-center justify-center">
          <Workflow className="w-5 h-5 text-primary-foreground" />
        </div>
        HRO Explorer
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
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} forceRedirectUrl={`${basePath}/organization-setup`} />
    </AuthScreenShell>
  );
}

function OrganizationSetupPage() {
  const [, setLocation] = useLocation();
  const pendingOrganization = loadPendingOrganization();
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [value, setValue] = useState('');
  const [createdOrganization, setCreatedOrganization] = useState<{ id: string; name: string } | null>(
    pendingOrganization?.organization ?? null,
  );
  const [joinCode, setJoinCode] = useState(pendingOrganization?.joinCode ?? '');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (demo = false) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/organizations${mode === 'join' || demo ? '/join' : ''}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            demo ? { demo: true } : mode === 'create' ? { name: value } : { joinCode: value },
          ),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || 'Organization setup failed');
      if (!demo && mode === 'create') {
        if (
          typeof body.organization?.id !== 'string'
          || typeof body.organization?.name !== 'string'
          || typeof body.joinCode !== 'string'
          || !body.joinCode
        ) {
          throw new Error('The organization was created, but its join code was not returned. Do not create another organization; contact support.');
        }
        try {
          sessionStorage.setItem(
            PENDING_ORGANIZATION_KEY,
            JSON.stringify({ organization: body.organization, joinCode: body.joinCode }),
          );
        } catch {
          // The visible component state still preserves the code for this visit.
        }
        setCreatedOrganization(body.organization);
        setJoinCode(body.joinCode);
        return;
      }
      localStorage.setItem('activeOrganizationId', body.organization.id);
      queryClient.clear();
      setLocation('/');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Organization setup failed');
    } finally {
      setSaving(false);
    }
  };

  const copyJoinCode = async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(joinCode);
      setCopied(true);
    } catch {
      setError('Could not copy automatically. Select the join code and copy it manually.');
    }
  };

  const continueWithOrganization = () => {
    if (!createdOrganization) return;
    localStorage.setItem('activeOrganizationId', createdOrganization.id);
    try {
      sessionStorage.removeItem(PENDING_ORGANIZATION_KEY);
    } catch {
      // Continuing does not depend on session storage being available.
    }
    queryClient.clear();
    setLocation('/');
  };

  return (
    <AuthScreenShell>
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-bold text-slate-900">
          {createdOrganization ? 'Save your workspace join code' : 'Choose your organization'}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {createdOrganization
            ? 'This code is shown only once. Save it now so teammates can join your workspace.'
            : 'Your estimates and client configuration stay inside this workspace.'}
        </p>
        {createdOrganization ? (
          <>
            <div className="mt-5 rounded-lg border border-blue-200 bg-blue-50 p-4">
              <p className="text-sm font-semibold text-slate-800">{createdOrganization.name}</p>
              <label htmlFor="created-organization-join-code" className="mt-3 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                One-time join code
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  id="created-organization-join-code"
                  readOnly
                  value={joinCode}
                  onFocus={(event) => event.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-lg border border-blue-300 bg-white px-3 py-2.5 font-mono font-bold tracking-wider text-slate-900"
                />
                <button type="button" onClick={copyJoinCode} className="inline-flex items-center rounded-lg border border-blue-300 bg-white px-3 text-sm font-semibold text-primary">
                  {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="mt-3 text-xs leading-5 text-slate-600">
                Send this code to teammates you want to invite. They can enter it under “Join.”
              </p>
            </div>
            {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
            <button type="button" onClick={continueWithOrganization} className="mt-4 w-full rounded-lg bg-primary px-4 py-2.5 font-semibold text-primary-foreground">
              I’ve saved the code — Continue
            </button>
          </>
        ) : (
          <>
        <div className="mt-5 grid grid-cols-2 rounded-lg bg-slate-100 p-1 text-sm font-semibold">
          <button type="button" onClick={() => { setMode('create'); setValue(''); }} className={`rounded-md p-2 ${mode === 'create' ? 'bg-white text-primary shadow-sm' : 'text-slate-600'}`}>Create</button>
          <button type="button" onClick={() => { setMode('join'); setValue(''); }} className={`rounded-md p-2 ${mode === 'join' ? 'bg-white text-primary shadow-sm' : 'text-slate-600'}`}>Join</button>
        </div>
        <input
          className="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-primary"
          value={value}
          onChange={(event) => setValue(mode === 'join' ? event.target.value.toUpperCase() : event.target.value)}
          placeholder={mode === 'create' ? 'Organization name' : 'Workspace join code'}
        />
        {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
        <button type="button" disabled={saving || !value.trim()} onClick={() => submit()} className="mt-4 w-full rounded-lg bg-primary px-4 py-2.5 font-semibold text-primary-foreground disabled:opacity-50">
          {saving ? 'Setting up…' : mode === 'create' ? 'Create organization' : 'Join organization'}
        </button>
        <button type="button" disabled={saving} onClick={() => submit(true)} className="mt-3 w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700">
          Explore the Demo Organization
        </button>
          </>
        )}
      </div>
    </AuthScreenShell>
  );
}

function Protected({ children }: { children: ReactNode }) {
  return (
    <>
      <Show when="signed-in">
        <OrganizationBootstrapGate>{children}</OrganizationBootstrapGate>
      </Show>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
    </>
  );
}

function OrganizationBootstrapGate({ children }: { children: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'loading' | 'setup' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    pinOrganizationIdForPage(null);
    let storedOrganizationId: string | null = null;
    try {
      storedOrganizationId = localStorage.getItem('activeOrganizationId');
    } catch {
      // Continue without a stored selector.
    }
    setState('loading');
    fetch('/api/organizations/current', {
      credentials: 'include',
      headers: storedOrganizationId ? { 'x-organization-id': storedOrganizationId } : undefined,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message || 'Could not load organization access');
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
    return () => { active = false; };
  }, [attempt]);

  if (state === 'setup') return <Redirect to="/organization-setup" />;
  if (state === 'ready') return <>{children}</>;
  if (state === 'error') {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-4">
        <p role="alert" className="text-sm text-red-600">{error}</p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)} className="rounded-md border px-4 py-2 text-sm font-semibold">Retry</button>
      </div>
    );
  }
  return <div className="flex min-h-[60vh] items-center justify-center text-sm text-slate-500">Loading organization…</div>;
}

function DataRoute({ children }: { children: ReactNode }) {
  return <Protected><AppLayout>{children}</AppLayout></Protected>;
}

function Router() {
  return (
    <Switch>
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route path="/organization-setup">
        <>
          <Show when="signed-in"><OrganizationSetupPage /></Show>
          <Show when="signed-out"><Redirect to="/sign-in" /></Show>
        </>
      </Route>

      <Route path="/"><DataRoute><Dashboard /></DataRoute></Route>
      <Route path="/intents"><DataRoute><Intents /></DataRoute></Route>
      <Route path="/intents/:key"><DataRoute><IntentDetail /></DataRoute></Route>
      <Route path="/flows"><DataRoute><Flows /></DataRoute></Route>
      <Route path="/scenario"><DataRoute><Scenario /></DataRoute></Route>
      <Route path="/compare"><DataRoute><Compare /></DataRoute></Route>
      <Route path="/pricing"><DataRoute><Pricing /></DataRoute></Route>
      <Route path="/product-pricing"><DataRoute><ProductPricing /></DataRoute></Route>
      <Route path="/assumptions"><DataRoute><Assumptions /></DataRoute></Route>
      <Route path="/calibration"><DataRoute><Calibration /></DataRoute></Route>
      <Route path="/enterprise-architecture">
        <DataRoute><EnterpriseArchitecture /></DataRoute>
      </Route>

      <Route path="/rates">
        <DataRoute><RateRegister /></DataRoute>
      </Route>

      <Route component={() => <DataRoute><NotFound /></DataRoute>} />
    </Switch>
  );
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
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
