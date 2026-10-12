import { type ReactNode } from 'react';
import { ClerkProvider } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { setBaseUrl } from '@workspace/api-client-react';
import { Loader2 } from 'lucide-react';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Layout } from '@/components/layout';
import { AdmissionHost, AdmittedBoundary, useAdmissionHost } from '@/lib/admission';
import NotFound from '@/pages/not-found';
import PolicyQualityPage from '@/pages/policy-quality';
import UatTestCenterPage from '@/pages/uat-test-center';
import FairnessProgrammePage from '@/pages/fairness-programme';
import { LoginPage } from '@/pages/login';
import { SignInPage, VerifyPage } from '@/pages/auth-flow';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
// Every generated client call goes to /uat/api/...
setBaseUrl(basePath || null);

const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  variables: {
    colorPrimary: '#4C42EE',
    colorForeground: '#0B1230',
    colorMutedForeground: '#68708D',
    colorDanger: '#D92D20',
    colorBackground: '#FFFFFF',
    colorInput: '#FFFFFF',
    colorInputForeground: '#0B1230',
    fontFamily: "'Inter', sans-serif",
    borderRadius: '0.75rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-xl border border-slate-200',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!hidden',
  },
};

function Splash({ text }: { text: string }) {
  return <div className="flex min-h-[100dvh] items-center justify-center gap-2 text-sm text-[var(--text-secondary)]" role="status"><Loader2 className="h-4 w-4 animate-spin" />{text}</div>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Protected({ children }: { children: ReactNode }) {
  const { status, recheck } = useAdmissionHost();
  if (status.kind === 'checking') return <Splash text="Checking UAT admission…" />;
  if (status.kind === 'error') {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 px-4">
        <p role="alert" className="text-sm text-[var(--status-red-fg)]">{status.message}</p>
        <button type="button" onClick={recheck} className="min-h-11 rounded-lg border px-4 text-sm font-semibold" data-testid="button-retry-admission">Retry</button>
      </div>
    );
  }
  if (status.kind === 'none') return <LoginPage notice={status.notice} />;
  const { admission } = status;
  return (
    <AdmittedBoundary key={`${admission.organizationId}:${admission.userId}:${admission.expiresAt}`} admission={admission}>
      <Layout><RoutedErrorBoundary>{children}</RoutedErrorBoundary></Layout>
    </AdmittedBoundary>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/verify" component={VerifyPage} />
      <Route path="/"><Protected><UatTestCenterPage /></Protected></Route>
      <Route path="/policy-quality"><Protected><PolicyQualityPage /></Protected></Route>
      <Route path="/fairness"><Protected><FairnessProgrammePage /></Protected></Route>
      <Route component={NotFound} />
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
      localization={{ signIn: { start: { title: 'Sign in to UAT', subtitle: 'A fresh sign-in is required for every UAT visit' } } }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <AdmissionHost>
        <TooltipProvider>
          <Router />
          <Toaster />
        </TooltipProvider>
      </AdmissionHost>
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
