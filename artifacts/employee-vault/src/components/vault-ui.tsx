import { type ReactNode } from 'react';
import { Link } from 'wouter';
import { UserButton } from '@clerk/react';
import { tone, label } from '@/lib/vault';
import { basePath } from '@/lib/vault';

export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <circle cx="16" cy="16" r="14" stroke="hsl(var(--primary))" strokeWidth="2" />
      <circle cx="16" cy="16" r="8.5" stroke="hsl(var(--primary))" strokeWidth="2" opacity=".55" />
      <circle cx="16" cy="16" r="3.4" fill="hsl(var(--accent))" />
    </svg>
  );
}
export function Wordmark() {
  return (
    <Link href="/" className="flex items-center gap-2.5" data-testid="link-home">
      <Mark />
      <span className="font-display text-xl font-semibold text-primary">Employee Vault</span>
    </Link>
  );
}

const toneCls = {
  good: 'bg-[hsl(150_35%_88%)] text-[hsl(150_45%_20%)]',
  warn: 'bg-[hsl(36_95%_85%)] text-[hsl(30_70%_22%)]',
  bad: 'bg-[hsl(8_70%_90%)] text-[hsl(8_66%_32%)]',
  idle: 'bg-muted text-muted-foreground',
};
export function StateBadge({ state, testid }: { state: string; testid?: string }) {
  const t = tone(state);
  const dot = { good: 'bg-[hsl(150_45%_32%)]', warn: 'bg-[hsl(36_90%_46%)]', bad: 'bg-[hsl(8_66%_46%)]', idle: 'bg-muted-foreground' }[t];
  return (
    <span data-testid={testid} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${toneCls[t]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label(state)}
    </span>
  );
}

export function AppHeader({ nav }: { nav?: ReactNode }) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Wordmark />
        <div className="flex items-center gap-4">
          {nav}
          <UserButton />
        </div>
      </div>
    </header>
  );
}

export function StatusScreen({ code, title, body, actions }: { code: string; title: string; body: string; actions: ReactNode }) {
  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden px-6 py-16">
      <svg className="ring-breathe pointer-events-none absolute -right-40 -top-40 h-[560px] w-[560px] text-primary/10" viewBox="0 0 100 100" fill="none" stroke="currentColor">
        {[48, 36, 24, 12].map((r) => <circle key={r} cx="50" cy="50" r={r} strokeWidth=".6" />)}
      </svg>
      <div className="relative max-w-md">
        <Mark size={40} />
        <p className="mt-8 font-mono text-sm tracking-widest text-muted-foreground">{code}</p>
        <h1 className="font-display mt-2 text-4xl font-medium text-foreground sm:text-5xl" data-testid="text-error-title">{title}</h1>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">{body}</p>
        <div className="mt-8 flex flex-wrap gap-3">{actions}</div>
      </div>
    </main>
  );
}
export function homeHref() { return basePath || '/'; }
