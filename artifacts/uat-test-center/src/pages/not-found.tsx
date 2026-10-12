import { Link } from 'wouter';
import { SearchX } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 px-4 text-center">
      <SearchX className="h-8 w-8 text-[var(--text-muted)]" />
      <h1 className="text-xl font-semibold text-[var(--text-primary)]">This UAT page does not exist</h1>
      <p className="text-sm text-[var(--text-muted)]">Use the scenario catalog, policy quality or fairness pages.</p>
      <Link href="/" className="text-sm font-medium text-[var(--primary)] underline" data-testid="link-not-found-home">
        Back to scenario catalog
      </Link>
    </div>
  );
}
