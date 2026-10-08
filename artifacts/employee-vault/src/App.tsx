import { useEffect, useRef, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { pinOrganizationIdForPage, setAuthTokenGetter } from '@workspace/api-client-react';
import { ClerkProvider, SignIn, SignUp, Show, useAuth } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { ErrorBoundary } from '@/components/error-boundary';
import { Crash } from '@/components/crash';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Mark } from '@/components/vault-ui';
import { Skeleton } from '@/components/ui/skeleton';
import NotFound from '@/pages/not-found';
import Landing from '@/pages/landing';
import Dashboard from '@/pages/dashboard';
import RequestPage from '@/pages/request';
import { Redirect, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { basePath } from '@/lib/vault';

const queryClient = new QueryClient();
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/favicon.svg`,
  },
  variables: {
    colorPrimary: 'hsl(188 62% 22%)',
    colorForeground: 'hsl(196 40% 13%)',
    colorMutedForeground: 'hsl(195 14% 36%)',
    colorDanger: 'hsl(8 66% 44%)',
    colorBackground: 'hsl(40 45% 98%)',
    colorInput: 'hsl(40 45% 99%)',
    colorInputForeground: 'hsl(196 40% 13%)',
    colorNeutral: 'hsl(195 14% 40%)',
    fontFamily: "'Hanken Grotesk', sans-serif",
    borderRadius: '0.75rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'rounded-3xl w-[440px] max-w-full overflow-hidden shadow-[0_30px_60px_-30px_hsl(188_62%_22%/0.35)] border border-[hsl(38_22%_84%)]',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'font-semibold',
    logoBox: 'justify-center',
    logoImage: 'h-10 w-10',
    footerAction: 'justify-center',
  },
};

/** Binds Clerk identity to the API client; wipes user-scoped cache on identity change. */
function IdentityBridge({ children }: { children: ReactNode }) {
  const { isLoaded, userId, getToken } = useAuth();
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const prev = useRef<string | null | undefined>(undefined);

  // Set synchronously so child queries never fire without the getter or with an org header.
  pinOrganizationIdForPage(null);
  setAuthTokenGetter(() => tokenRef.current());

  useEffect(() => {
    if (!isLoaded) return;
    if (prev.current !== undefined && prev.current !== (userId ?? null)) queryClient.clear();
    prev.current = userId ?? null;
  }, [isLoaded, userId]);

  useEffect(() => () => setAuthTokenGetter(null), []);

  if (!isLoaded) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4">
        <Mark size={44} />
        <Skeleton className="h-3 w-40" />
      </div>
    );
  }
  return <>{children}</>;
}

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-[100dvh] lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-primary p-12 text-primary-foreground lg:flex lg:flex-col lg:justify-between">
        <svg className="ring-breathe absolute -bottom-48 -left-32 h-[720px] w-[720px] text-primary-foreground/15" viewBox="0 0 100 100" fill="none" stroke="currentColor">
          {[48, 38, 28, 18, 8].map((r) => <circle key={r} cx="50" cy="50" r={r} strokeWidth=".4" />)}
          <circle cx="50" cy="50" r="2.2" fill="hsl(36 95% 62%)" stroke="none" />
        </svg>
        <div className="relative flex items-center gap-2.5 font-display text-xl font-semibold"><Mark /> Employee Vault</div>
        <div className="relative max-w-md">
          <h2 className="font-display text-5xl font-medium leading-[1.05]">Your proof, kept by you.</h2>
          <p className="mt-5 text-lg text-primary-foreground/75">Approve employer access one request at a time. You can stop future access; information already received cannot be recalled.</p>
        </div>
        <p className="relative text-sm text-primary-foreground/60">Independent of any employer.</p>
      </aside>
      <main className="flex items-center justify-center px-4 py-10">{children}</main>
    </div>
  );
}

function SignInPage() {
  return <AuthShell><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} fallbackRedirectUrl={`${basePath}/dashboard`} /></AuthShell>;
}
function SignUpPage() {
  return <AuthShell><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} fallbackRedirectUrl={`${basePath}/dashboard`} /></AuthShell>;
}

function Protected({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return (
    <>
      <Show when="signed-in">{children}</Show>
      <Show when="signed-out">
        <Redirect to={`/sign-in?redirect_url=${encodeURIComponent(`${basePath}${location}`)}`} />
      </Show>
    </>
  );
}

function Router() {
  const [location] = useLocation();
  return (
    <ErrorBoundary resetKey={location} FallbackComponent={Crash}>
      <Switch>
        <Route path="/" component={Landing} />
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route path="/dashboard"><Protected><Dashboard /></Protected></Route>
        <Route path="/requests/:id"><Protected><RequestPage /></Protected></Route>
        <Route component={NotFound} />
      </Switch>
    </ErrorBoundary>
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
      localization={{
        signIn: { start: { title: 'Open your vault', subtitle: 'Welcome back' } },
        signUp: { start: { title: 'Start your vault', subtitle: 'Private and independent of any employer' } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <IdentityBridge>
          <TooltipProvider>
            <Router />
            <Toaster />
          </TooltipProvider>
        </IdentityBridge>
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
