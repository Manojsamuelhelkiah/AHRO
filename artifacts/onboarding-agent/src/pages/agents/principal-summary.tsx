import type { AgentCatalogue } from '@workspace/api-client-react';
import { identityLabel } from '@/components/member-identity';

export function principalBlocker(catalogue: AgentCatalogue, role: string, id: string): string | null {
  if (!id) return 'Select an existing principal to review.';
  const principal = catalogue.principals.find(p => p.id === id);
  if (!principal) return 'This principal is unavailable in the current client snapshot. Select another principal.';
  if (principal.status !== 'active') return `This principal is ${principal.status}. Only active principals can be bound.`;
  if (!catalogue.owners.some(o => o.clerkUserId === principal.ownerUserId))
    return 'The accountable owner is unavailable in the current eligible member list. Resolve ownership elsewhere before binding.';
  const other = catalogue.registrations.find(r => r.agentId === id && r.catalogueKey !== role);
  if (other) return `Already bound to another role (${other.catalogueKey}). Bindings cannot be moved from this form.`;
  return null;
}

export function PrincipalSummary({ catalogue, id, title, testId }: {
  catalogue: AgentCatalogue; id: string; title: string; testId: string;
}) {
  const principal = catalogue.principals.find(p => p.id === id);
  const owner = catalogue.owners.find(o => o.clerkUserId === principal?.ownerUserId);
  return <section aria-label={title} data-testid={testId}
    className="min-w-0 rounded-md border border-[var(--border)] p-3 text-xs text-[var(--text-secondary)]">
    <h4 className="mb-2 font-semibold text-[var(--text-primary)]">{title}</h4>
    <dl className="grid min-w-0 gap-2 sm:grid-cols-2">
      <div className="min-w-0"><dt className="font-semibold">Saved principal name</dt><dd className="break-words">{principal?.name ?? 'Unavailable in this client snapshot'}</dd></div>
      <div className="min-w-0"><dt className="font-semibold">Immutable principal ID</dt><dd><code className="select-all break-all">{id}</code></dd></div>
      <div className="min-w-0"><dt className="font-semibold">Accountable owner (kept as is)</dt>
        <dd className="break-all" data-testid={`${testId}-owner`}>{owner ? identityLabel(owner, catalogue.owners) : 'Owner unavailable in the current eligible member list'}</dd>
        {principal && <dd><code className="select-all break-all">{principal.ownerUserId}</code></dd>}
        {owner?.identityResolution === 'unavailable' && <dd>Directory profile unavailable; no name or email inferred.</dd>}
        {owner?.identityResolution === 'missing' && <dd>No directory profile found.</dd>}
      </div>
      <div className="min-w-0"><dt className="font-semibold">Saved status / principal version</dt>
        <dd>{principal ? `${principal.status} / ${principal.version}` : 'Unavailable'}</dd>
      </div>
    </dl>
  </section>;
}
