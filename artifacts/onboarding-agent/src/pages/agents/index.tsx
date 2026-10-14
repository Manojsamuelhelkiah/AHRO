import React, { useEffect, useState } from 'react';
import { useListOnboardingAgents, getListOnboardingAgentsQueryKey, OnbAgent } from '@workspace/api-client-react';
import { Search, Bot, Server, Globe, RotateCcw } from 'lucide-react';
import { CatalogueSection } from './catalogue-section';
import { Input, Button, Card, CardHeader, CardTitle, CardContent } from '@/components/ui-shared';

export function AgentsPage() {
  const [searchTerm, setSearchTerm] = useState('');

  const { data, isLoading, isError, error, refetch } = useListOnboardingAgents({
    query: {
      queryKey: getListOnboardingAgentsQueryKey(),
      retry: 1
    }
  });

  const agents = data || [];

  useEffect(() => {
    const focusAgent = () => {
      const id = window.location.hash.slice(1);
      if (!id || !data?.some(agent => agent.id === id)) return;
      document.getElementById(id)?.scrollIntoView({ block: 'center' });
    };
    focusAgent();
    window.addEventListener('hashchange', focusAgent);
    return () => window.removeEventListener('hashchange', focusAgent);
  }, [data]);

  const filteredAgents = agents.filter(agent => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return agent.name.toLowerCase().includes(term) || 
           agent.capabilities.some(c => c.toLowerCase().includes(term));
  });

  return (
    <div className="max-w-6xl mx-auto space-y-6 pt-6 pb-12 px-0 sm:px-4">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">AI Agents</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-2xl">
             Review agent responsibilities and client-owned identities. Registration does not grant permissions or authorize work.
          </p>
        </div>
        <div className="relative w-full sm:w-72 shrink-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--text-muted)]" />
          <Input 
             aria-label="Search agent roles and identities"
            placeholder="Search role, responsibility, mapping, family..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9 h-10 w-full bg-[var(--surface)] border-[var(--border)] focus:border-[var(--primary)]"
          />
        </div>
      </div>

      <CatalogueSection searchTerm={searchTerm} />

      <div className="pt-4 border-t border-[var(--border)]">
        <h2 className="text-lg font-bold text-[var(--text-primary)]">Operational agents</h2>
        <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-2xl">Agent responsibilities and capabilities. System availability is shown in Systems; each action requires current authorization.</p>
      </div>

      {isLoading && (
        <div className="flex flex-col items-center justify-center p-12 text-[var(--text-muted)] space-y-3 bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-sm">
          <Bot className="h-8 w-8 animate-pulse text-[var(--violet)]" />
          <p className="text-sm font-medium">Loading agent catalog...</p>
        </div>
      )}

      {isError && (
        <div className="flex flex-col items-center justify-center p-12 text-[var(--status-red)] space-y-4 bg-[var(--status-red-bg)] border border-[var(--status-red)] rounded-[var(--radius-lg)] shadow-sm">
          <div className="bg-white p-3 rounded-full shadow-sm">
            <Server className="h-6 w-6 text-[var(--status-red)]" />
          </div>
          <div className="text-center">
            <p className="font-bold">Failed to load agents</p>
            <p className="text-xs opacity-80 mt-1 max-w-md mx-auto">
              {(error as any)?.data?.message || (error as any)?.message || 'An unexpected error occurred.'}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="border-[var(--status-red)] text-[var(--status-red-fg)] hover:bg-[var(--status-red-bg)] h-9 px-4 mt-2">
            <RotateCcw className="h-4 w-4 mr-2" /> Retry
          </Button>
        </div>
      )}

      {!isLoading && !isError && filteredAgents.length === 0 && (
        <div className="flex flex-col items-center justify-center p-12 text-[var(--text-muted)] space-y-3 bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-sm">
          <Bot className="h-10 w-10 opacity-20" />
          <p className="text-sm font-medium">No agents match your search.</p>
        </div>
      )}

      {!isLoading && !isError && filteredAgents.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-5">
          {filteredAgents.map(agent => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent }: { agent: OnbAgent }) {
  const isInternal = agent.origin === 'internal';

  return (
    <Card id={agent.id} className="border-[var(--border)] shadow-sm hover:shadow-md transition-shadow h-full min-w-0 flex flex-col scroll-mt-24 bg-[var(--surface)] target:ring-2 target:ring-[var(--primary)]">
      <CardHeader className="pb-4 border-b border-[var(--border)] bg-[var(--surface-alt)] flex-none">
        <div className="flex justify-between items-start gap-2">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center bg-[var(--surface)] border border-[var(--border)] shrink-0 shadow-sm">
              <Bot className="w-5 h-5 text-[var(--violet)]" />
            </div>
            <div>
              <CardTitle className="text-base font-bold text-[var(--text-primary)] leading-tight">{agent.name}</CardTitle>
              <div className="text-[11px] text-[var(--text-muted)] font-mono mt-0.5">{agent.id}</div>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-4">
          {isInternal ? (
            <span className="inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-1 rounded border border-[var(--violet)] text-[var(--violet-fg)] bg-[var(--violet-light-bg)] tracking-wider uppercase">
              <Server className="w-3.5 h-3.5" /> Internal
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-1 rounded border border-[var(--status-amber)] text-[var(--status-amber-fg)] bg-[var(--status-amber-bg)] tracking-wider uppercase">
              <Globe className="w-3.5 h-3.5" /> External
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-5 flex-1 flex flex-col gap-5">
        <div className="text-sm text-[var(--text-secondary)] leading-relaxed">
          {agent.description}
        </div>
        
        <div className="mt-auto space-y-4 pt-4 border-t border-[var(--border)]">
          <div>
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1.5">Owner</h4>
            <div className="text-xs font-medium text-[var(--text-primary)] break-words">{agent.owner}</div>
          </div>
          <div>
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-2">Capabilities</h4>
            <div className="flex flex-wrap gap-1.5">
              {agent.capabilities.map((cap, i) => (
                <span key={i} className="text-[11px] bg-[var(--surface-soft)] text-[var(--text-secondary)] border border-[var(--border)] px-2 py-1 rounded font-medium">
                  {cap}
                </span>
              ))}
              {agent.capabilities.length === 0 && (
                <span className="text-xs text-[var(--text-muted)] italic">None documented</span>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
