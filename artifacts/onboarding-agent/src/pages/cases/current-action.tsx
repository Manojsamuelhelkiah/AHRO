import React from 'react';
import type { OnbCase } from '@workspace/api-client-react';

type Action = NonNullable<OnbCase['currentAction']>;
const STATUS_TEXT: Record<Action['status'], string> = { pending: 'Pending', 'in-progress': 'In progress', blocked: 'Blocked' };

export function currentActionText(c: Pick<OnbCase, 'currentAction'> & { offlineSample?: boolean }, terminal = false): string {
  const a = c.currentAction;
  if (!a) return terminal ? 'No current action' : 'Not recorded';
  const more = a.additionalCount > 0 ? ` (+${a.additionalCount} more)` : '';
  return `${a.label}${more}`;
}

export function currentActionTitle(c: Pick<OnbCase, 'currentAction'>, terminal = false): string {
  const a = c.currentAction;
  if (!a) return `Current action: ${terminal ? 'No current action' : 'Not recorded'}`;
  return `Current action: ${currentActionText(c)} — ${STATUS_TEXT[a.status]} — source: ${a.source === 'action-center' ? 'Action Center' : 'Workstream'}`;
}

export function CurrentAction({ c, terminal = false, label = false }: { c: Pick<OnbCase, 'currentAction'>; terminal?: boolean; label?: boolean }) {
  const a = c.currentAction;
  return (
    <span className="block min-w-0 flex-1 truncate text-xs text-[var(--text-secondary)]" title={currentActionTitle(c, terminal)} data-testid="current-action">
      {label && <span className="font-semibold">Current action: </span>}
      <span className={a ? '' : 'text-[var(--text-muted)]'}>{currentActionText(c, terminal)}</span>
      {a && <span className="text-[var(--text-muted)]">{` · ${STATUS_TEXT[a.status]}`}</span>}
    </span>
  );
}
