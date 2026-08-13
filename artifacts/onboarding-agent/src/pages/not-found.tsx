import { Card, CardContent } from '@/components/ui-shared';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import { Link } from 'wouter';

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[var(--surface-alt)] p-4">
      <Card className="w-full max-w-md shadow-[var(--shadow-md)] border-[var(--border)]">
        <CardContent className="pt-[var(--space-xl)] pb-[var(--space-lg)] px-[var(--space-xl)] flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-full bg-[var(--status-amber-bg)] flex items-center justify-center mb-[var(--space-md)]">
            <AlertCircle className="h-6 w-6 text-[var(--status-amber-fg)]" />
          </div>
          
          <h1 className="text-[var(--text-2xl)] font-bold text-[var(--text-primary)] mb-[var(--space-sm)] tracking-tight">
            Page Not Found
          </h1>
          
          <p className="text-[var(--text-sm)] text-[var(--text-muted)] mb-[var(--space-xl)] max-w-[280px]">
            The page you're looking for doesn't exist or has been moved.
          </p>

          <Link href="/" className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-md)] text-[var(--text-sm)] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--primary)] bg-[var(--primary)] text-white hover:bg-[var(--primary-dark)] shadow-[var(--shadow-sm)] h-[36px] px-[16px]">
            <ArrowLeft className="w-4 h-4" /> Back to Control Tower
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
