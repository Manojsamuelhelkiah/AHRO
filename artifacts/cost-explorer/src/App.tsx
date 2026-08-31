import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp, Show } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';

import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter, useLocation, Redirect } from 'wouter';
import { Workflow } from 'lucide-react';

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
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </AuthScreenShell>
  );
}

function Protected({ children }: { children: ReactNode }) {
  return (
    <>
      <Show when="signed-in">
        {children}
      </Show>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
    </>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />

      {/* Existing public/unprotected routes */}
      <Route path="/" component={() => <AppLayout><Dashboard /></AppLayout>} />
      <Route path="/intents" component={() => <AppLayout><Intents /></AppLayout>} />
      <Route path="/intents/:key" component={() => <AppLayout><IntentDetail /></AppLayout>} />
      <Route path="/flows" component={() => <AppLayout><Flows /></AppLayout>} />
      <Route path="/scenario" component={() => <AppLayout><Scenario /></AppLayout>} />
      <Route path="/compare" component={() => <AppLayout><Compare /></AppLayout>} />
      <Route path="/pricing" component={() => <AppLayout><Pricing /></AppLayout>} />
      <Route path="/product-pricing" component={() => <AppLayout><ProductPricing /></AppLayout>} />
      <Route path="/assumptions" component={() => <AppLayout><Assumptions /></AppLayout>} />
      <Route path="/calibration" component={() => <AppLayout><Calibration /></AppLayout>} />

      {/* Protected routes */}
      <Route path="/enterprise-architecture">
        <Protected>
          <AppLayout>
            <EnterpriseArchitecture />
          </AppLayout>
        </Protected>
      </Route>

      <Route path="/rates">
        <Protected>
          <AppLayout>
            <RateRegister />
          </AppLayout>
        </Protected>
      </Route>

      <Route component={() => <AppLayout><NotFound /></AppLayout>} />
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
