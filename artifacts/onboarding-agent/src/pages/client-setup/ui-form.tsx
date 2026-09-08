import * as React from 'react';
import { cn } from '@/components/ui-shared';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn('flex h-[32px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[4px] text-[var(--text-sm)] shadow-sm transition-colors focus-visible:outline-none focus-visible:border-[var(--primary)] focus-visible:ring-1 focus-visible:ring-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50', className)}
    {...props}
  />
));
Select.displayName = 'Select';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn('flex min-h-[80px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[8px] text-[var(--text-sm)] shadow-sm transition-colors placeholder:text-[var(--text-muted)] focus-visible:outline-none focus-visible:border-[var(--primary)] focus-visible:ring-1 focus-visible:ring-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50', className)}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

export function FormField({ label, error, children, className }: { label: string, error?: string, children: React.ReactNode, className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label className="text-[var(--text-xs)] uppercase tracking-wider font-semibold text-[var(--text-muted)] leading-none">{label}</label>
      {children}
      {error && <p className="text-[var(--status-red)] text-[var(--text-xs)] m-0">{error}</p>}
    </div>
  );
}
