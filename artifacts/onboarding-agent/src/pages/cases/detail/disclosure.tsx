import React, { useEffect, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/** Accessible collapsible section. Content stays mounted (hidden) so form state survives toggling. */
export function Disclosure({ title, summary, defaultOpen = false, forceOpen = false, revealKey, children, testId }: {
  title: string; summary?: string; defaultOpen?: boolean; forceOpen?: boolean; revealKey?: string; children: React.ReactNode; testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen || forceOpen);
  const id = useId();
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen, revealKey]);
  return (
    <section data-testid={testId} className="mb-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]">
      <h2 className="m-0">
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
          className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left">
          <span className="min-w-0">
            <span className="block text-[var(--text-base)] font-bold text-[var(--text-primary)]">{title}</span>
            {summary && <span className="block text-xs font-normal text-[var(--text-muted)]">{summary}</span>}
          </span>
          <ChevronDown aria-hidden className={`h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </h2>
      <div id={id} hidden={!open} className="border-t border-[var(--border)] p-4">{children}</div>
    </section>
  );
}
