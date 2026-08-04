import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter } from 'wouter';

import { AppLayout } from '@/components/layout';
import NotFound from '@/pages/not-found';
import Dashboard from '@/pages/dashboard';
import Intents from '@/pages/intents';
import IntentDetail from '@/pages/intent-detail';
import Flows from '@/pages/flows';
import Scenario from '@/pages/scenario';
import Assumptions from '@/pages/assumptions';
import Compare from '@/pages/compare';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

function Router() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/intents" component={Intents} />
        <Route path="/intents/:key" component={IntentDetail} />
        <Route path="/flows" component={Flows} />
        <Route path="/scenario" component={Scenario} />
        <Route path="/compare" component={Compare} />
        <Route path="/assumptions" component={Assumptions} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
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
