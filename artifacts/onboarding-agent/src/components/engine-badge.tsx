import React from 'react';
import { cn } from './ui-shared';

export function EngineBadge({ engine, className }: { engine: string, className?: string }) {
  let style = {};
  let label = engine.toUpperCase();

  switch (engine.toLowerCase()) {
    case 'system':
      style = { backgroundColor: '#f3f4f6', color: '#6b7280' };
      label = 'SYS';
      break;
    case 'llm':
      style = { backgroundColor: 'var(--primary-light)', color: 'var(--primary)' };
      label = 'AI';
      break;
    case 'orchestrator':
      style = { backgroundColor: '#f3e8ff', color: '#7e22ce' }; // purple-100, purple-700
      label = 'ORCH';
      break;
    case 'rules':
      style = { backgroundColor: '#fef3c7', color: '#b45309' }; // amber-100, amber-700
      label = 'RULES';
      break;
    case 'ldm':
      style = { backgroundColor: '#cffafe', color: '#0e7490' }; // cyan-100, cyan-700
      label = 'LDM';
      break;
    case 'human':
      style = { backgroundColor: '#dbeafe', color: '#1d4ed8' }; // blue-100, blue-700
      label = 'HUMAN';
      break;
    default:
      style = { backgroundColor: '#f3f4f6', color: '#6b7280' };
  }

  return (
    <div 
      className={cn("inline-flex items-center justify-center font-semibold tracking-wider", className)}
      style={{
        ...style,
        fontSize: '10px',
        padding: '6px 8px',
        borderRadius: '4px',
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
      style = { backgroundColor: '#f3f4f6', color: '#4b5563' }; 
      break;
    case 'approve-before-act': 
      style = { backgroundColor: '#fef3c7', color: '#b45309' }; 
      break;
    case 'act-then-review': 
      style = { backgroundColor: '#dbeafe', color: '#1d4ed8' }; 
      break;
    case 'hard-block': 
      style = { backgroundColor: '#fee2e2', color: '#b91c1c' }; 
      break;
    default: 
      style = { backgroundColor: '#f3f4f6', color: '#4b5563' };
  }

  return (
    <span 
      className={cn("inline-flex items-center font-bold tracking-wider", className)}
      style={{
        ...style,
        fontSize: '10px',
        padding: '6px 8px',
        borderRadius: '4px',
        textTransform: 'uppercase',
        lineHeight: 1
      }}
    >
      {label}
    </span>
  );
}
