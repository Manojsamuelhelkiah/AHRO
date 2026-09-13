import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { listWorkforceTransferPrograms } from '@/lib/workforce-transfers-api';
import { PageHeader, Card, Button, Input, cn } from '@/components/ui-shared';
import { Plus, Search, Building2, Network, ArrowRight } from 'lucide-react';
import { format } from 'date-fns';

export function WorkforceTransfersListPage() {
  const { data: programs, isLoading, isError } = useQuery({
    queryKey: ['workforce-transfers', 'programs'],
    queryFn: () => listWorkforceTransferPrograms(),
  });

  const [search, setSearch] = useState('');

  const filteredPrograms = (programs ?? []).filter((p) => 
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.sourceLegalEntity.toLowerCase().includes(search.toLowerCase()) ||
    p.destinationLegalEntity.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      <PageHeader 
        title="Workforce Transfers" 
        subtitle="Manage bulk worker transitions, entity mergers, and cross-border legal transfers."
      >
        <Link href="/cases" className="inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius-md)] text-sm font-medium transition-colors border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-alt)] h-9 px-4 py-2 mr-2">
          Cases
        </Link>
        <Link href="/workforce-transfers/new" className="inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius-md)] text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-transparent bg-[var(--primary)] text-white hover:bg-[var(--primary-dark)] h-9 px-4 py-2 gap-2 shadow-sm">
          <Plus className="h-4 w-4" /> New Program
        </Link>
      </PageHeader>

      <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
        <div style={{ padding: 'var(--space-md) var(--space-lg)', borderBottom: '1px solid var(--border)' }} className="flex items-center gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4" style={{ color: 'var(--text-muted)' }} />
            <Input className="pl-9" placeholder="Search by program name or legal entity..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        {isLoading ? (
          <div className="p-12 text-center text-[var(--text-muted)] flex flex-col items-center gap-3">
            <div className="w-6 h-6 border-2 border-[var(--primary)] border-t-transparent rounded-full animate-spin" />
            <p>Loading programs...</p>
          </div>
        ) : isError ? (
          <div className="p-12 text-center">
            <p className="text-[var(--status-red)]">Failed to load workforce transfers.</p>
          </div>
        ) : filteredPrograms.length === 0 ? (
          <div className="p-12 text-center text-[var(--text-muted)] flex flex-col items-center">
            <Network className="h-10 w-10 mb-3 opacity-20" />
            <p className="text-sm font-medium">No transfer programs found.</p>
            <p className="text-xs mt-1">Create a new program to start planning a workforce transfer.</p>
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {filteredPrograms.map((program) => (
              <div key={program.id} className="flex items-center justify-between hover:bg-[var(--surface-soft)] transition-colors" style={{ padding: 'var(--space-md) var(--space-lg)' }}>
                <div className="flex items-start gap-4">
                  <div className="mt-1 p-2 rounded-md bg-[var(--surface-alt)] border border-[var(--border)]">
                    <Building2 className="w-5 h-5" style={{ color: 'var(--text-secondary)' }} />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                      <Link href={`/workforce-transfers/${program.id}`} className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">{program.name}</Link>
                    </h3>
                    <div className="flex items-center gap-2 mt-1 text-xs text-[var(--text-secondary)]">
                      <span className="font-medium">{program.sourceLegalEntity}</span>
                      <ArrowRight className="w-3 h-3 text-[var(--text-muted)]" />
                      <span className="font-medium">{program.destinationLegalEntity}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-[11px] text-[var(--text-muted)]">
                      <span>Basis: {program.proposedBasis.replace(/-/g, ' ')}</span>
                      <span>•</span>
                      <span>Day 1: {format(new Date(program.legalDay1), 'MMM d, yyyy')}</span>
                      <span>•</span>
                      <span>{program.countries.join(', ')}</span>
                    </div>
                  </div>
                </div>
                <div>
                  <Link href={`/workforce-transfers/${program.id}`} className="inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius-md)] text-xs font-medium border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-alt)] text-[var(--text-primary)] h-8 px-3 transition-colors">
                    Manage
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
