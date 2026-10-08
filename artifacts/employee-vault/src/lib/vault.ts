import { format } from 'date-fns';

export const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
export const MAX_BYTES = 10 * 1024 * 1024;
export const ACCEPTED = ['application/pdf', 'image/jpeg', 'image/png'] as const;

export function errMsg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong. Please try again.';
}
export function fmtDate(v?: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : format(d, 'd MMM yyyy, HH:mm');
}
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
export function tone(state: string): 'good' | 'warn' | 'bad' | 'idle' {
  const s = state.toLowerCase();
  if (['clean', 'approved', 'verified', 'complete', 'ready'].includes(s)) return 'good';
  if (['pending', 'scanning', 'reserved', 'uploaded', 'submitted', 'in_progress', 'in-progress'].includes(s)) return 'warn';
  if (['infected', 'quarantined', 'declined', 'revoked', 'failed', 'rejected', 'expired', 'malicious'].includes(s)) return 'bad';
  return 'idle';
}
export function label(s: string): string {
  const t = s.replace(/[_-]+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
