import { useState } from 'react';
import { Search } from 'lucide-react';
import { CatalogueSection } from './catalogue-section';
import { Input } from '@/components/ui-shared';

export function AgentsPage() {
  const [searchTerm, setSearchTerm] = useState('');
  return (
    <div className="max-w-6xl mx-auto space-y-6 pt-6 pb-12 px-0 sm:px-4 min-w-0 overflow-x-hidden">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">AI Agents</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-2xl">
            Review agent roles, their saved definitions and client-owned identities. Intake Conversion registration authorizes new valid email requests to become held cases; other registrations remain setup only.
          </p>
        </div>
        <div className="relative w-full sm:w-72 shrink-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--text-muted)]" />
          <Input
            aria-label="Search agent roles and identities"
            data-testid="input-search-agents"
            placeholder="Search role, skill, family, mapping..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9 h-10 w-full bg-[var(--surface)] border-[var(--border)] focus:border-[var(--primary)]"
          />
        </div>
      </div>
      <CatalogueSection searchTerm={searchTerm} />
    </div>
  );
}
