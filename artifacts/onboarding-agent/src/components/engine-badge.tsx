import React from 'react';
import { cn } from './ui-shared';

export function EngineBadge({ engine, className }: { engine: string, className?: string }) {
  let style = {};
  let label = engine.toUpperCase();

  switch (engine.toLowerCase()) {
    case 'system':
      style = { backgroundColor: 'var(--surface-alt)', color: 'var(--text-muted)' };
      label = 'SYS';
      break;
    case 'llm':
      style = { backgroundColor: 'var(--primary-light-bg)', color: 'var(--primary)' };
      label = 'AI';
      break;
    case 'orchestrator':
      style = { backgroundColor: 'var(--violet-light-bg)', color: 'var(--violet-fg)' };
      label = 'ORCH';
      break;
    case 'rules':
      style = { backgroundColor: 'var(--surface-alt)', color: 'var(--text-primary)', border: '1px solid var(--border)' };
      label = 'RULES';
      break;
    case 'ldm':
      style = { backgroundColor: 'var(--surface-soft)', color: 'var(--status-blue)' };
      label = 'LDM';
      break;
    case 'human':
      style = { backgroundColor: 'var(--surface-soft)', color: 'var(--status-amber)' };
      label = 'HUMAN';
      break;
    default:
      style = { backgroundColor: 'var(--surface-alt)', color: 'var(--text-muted)' };
  }

  return (
    <div 
      className={cn("inline-flex items-center justify-center font-semibold tracking-wider", className)}
      style={{
        ...style,
        fontSize: '10px',
        padding: '6px 8px',
        borderRadius: 'var(--radius-sm)',
        textTransform: 'uppercase',
        lineHeight: 1
      }}
    >
      {label}
    </div>
  );
}

export function HitlBadge({ pattern, className }: { pattern?: string, className?: string }) {
  if (!pattern) return null;
  
  let label = pattern.replace(/-/g, ' ').toUpperCase();
  let style = {};

  switch (pattern) {
    case 'notify-only': 
      style = { backgroundColor: 'var(--surface-alt)', color: 'var(--text-muted)' }; 
      break;
    case 'approve-before-act': 
      style = { backgroundColor: 'var(--surface-soft)', color: 'var(--status-amber)' }; 
      break;
    case 'act-then-review': 
      style = { backgroundColor: 'var(--primary-light-bg)', color: 'var(--primary)' }; 
      break;
    case 'hard-block': 
      style = { backgroundColor: 'var(--surface)', color: 'var(--status-red)', border: '1px solid var(--status-red)' }; 
      break;
    default: 
      style = { backgroundColor: 'var(--surface-alt)', color: 'var(--text-muted)' };
  }

  return (
    <span 
      className={cn("inline-flex items-center font-bold tracking-wider", className)}
      style={{
        ...style,
        fontSize: '10px',
        padding: '6px 8px',
        borderRadius: 'var(--radius-sm)',
        textTransform: 'uppercase',
        lineHeight: 1
      }}
    >
      {label}
    </span>
  );
}
