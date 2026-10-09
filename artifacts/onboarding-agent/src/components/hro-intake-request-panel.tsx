import { AlertTriangle } from 'lucide-react';
import type { HroBatchRequest } from '@workspace/api-client-react';

export function HroIntakeRequestPanel({ request }: { request: HroBatchRequest }) {
  if (!request) return null;
  const fields = Object.entries(request.data);
  const specialist = request.executionMode === 'specialist-review-only';
  return (
    <section data-testid="panel-hro-intake-request" className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-[var(--space-lg)]">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">Intake request</h3>
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
        <div><dt className="text-[var(--text-muted)]">Request type</dt><dd data-testid="text-request-type" className="break-words text-[var(--text-primary)]">{request.requestType}</dd></div>
        <div><dt className="text-[var(--text-muted)]">Source ID</dt><dd data-testid="text-request-id" className="break-all font-mono text-[var(--text-primary)]">{request.requestId}</dd></div>
        <div><dt className="text-[var(--text-muted)]">Template</dt><dd data-testid="text-request-template" className="break-all text-[var(--text-primary)]">{request.templateId} v{request.templateVersion}</dd></div>
        <div><dt className="text-[var(--text-muted)]">Employee reference</dt><dd data-testid="text-employee-reference" className="text-[var(--text-primary)]">{request.employeeReferenceStatus === 'supplied-not-verified' ? 'Supplied, not verified' : 'Not applicable'}</dd></div>
      </dl>
      {specialist && <p role="note" data-testid="text-specialist-warning" className="mt-3 rounded border border-[var(--status-amber)]/30 bg-[var(--status-amber-bg)] p-2 text-xs text-[var(--status-amber-fg)]"><AlertTriangle className="mr-1 inline h-3.5 w-3.5" />Specialist review only. This request does not execute or authorize any action.</p>}
      <h4 className="mt-4 text-xs font-semibold text-[var(--text-primary)]">Submitted fields</h4>
      <dl className="mt-2 divide-y divide-[var(--border)] text-xs">
        {fields.map(([k, v]) => <div key={k} className="grid grid-cols-1 gap-1 py-1.5 sm:grid-cols-3"><dt className="text-[var(--text-muted)]">{k}</dt><dd data-testid={`text-field-${k}`} className="break-words text-[var(--text-primary)] sm:col-span-2">{v || '-'}</dd></div>)}
      </dl>
    </section>
  );
}
