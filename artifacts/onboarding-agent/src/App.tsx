import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

import { Layout } from './components/layout';
import { DashboardPage } from './pages/dashboard';
import { CasesPage } from './pages/cases/index';
import { CaseDetailPage } from './pages/cases/detail';
import { ApprovalsPage } from './pages/approvals';
import { SystemsPage } from './pages/systems';
import { AnalyticsPage } from './pages/analytics';

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <RoutedErrorBoundary>
        <Switch>
          <Route path="/" component={DashboardPage} />
          <Route path="/cases" component={CasesPage} />
          <Route path="/cases/:id" component={CaseDetailPage} />
          <Route path="/approvals" component={ApprovalsPage} />
          <Route path="/systems" component={SystemsPage} />
          <Route path="/analytics" component={AnalyticsPage} />
          <Route component={NotFound} />
        </Switch>
      </RoutedErrorBoundary>
    </Layout>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;