import React from 'react';
import { cn } from './ui-shared';
import { Cpu, BrainCircuit, Network, User, Settings } from 'lucide-react';

export function EngineBadge({ engine, className }: { engine: string, className?: string }) {
  let color = '';
  let Icon = Cpu;
  let label = engine.toUpperCase();

  switch (engine.toLowerCase()) {
    case 'llm':
      color = 'bg-purple-100 text-purple-700 border-purple-200';
      Icon = BrainCircuit;
      label = 'AI';
      break;
    case 'ldm':
      color = 'bg-emerald-100 text-emerald-700 border-emerald-200';
      Icon = Cpu;
      label = 'RULES';
      break;
    case 'human':
      color = 'bg-blue-100 text-blue-700 border-blue-200';
      Icon = User;
      label = 'HUMAN';
      break;
    case 'orchestrator':
      color = 'bg-amber-100 text-amber-700 border-amber-200';
      Icon = Network;
      label = 'ORCH';
      break;
    case 'system':
      color = 'bg-slate-100 text-slate-700 border-slate-200';
      Icon = Settings;
      label = 'SYS';
      break;
    default:
      color = 'bg-gray-100 text-gray-700 border-gray-200';
  }

  return (
    <div className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider border", color, className)}>
      <Icon className="h-3 w-3" />
      {label}
    </div>
  );
}

export function HitlBadge({ pattern, className }: { pattern?: string, className?: string }) {
  if (!pattern) return null;
  
  let color = '';
  let label = pattern.replace(/-/g, ' ').toUpperCase();

  switch (pattern) {
    case 'notify-only': color = 'bg-slate-100 text-slate-600 border border-slate-200'; break;
    case 'approve-before-act': color = 'bg-amber-100 text-amber-700 border border-amber-200'; break;
    case 'act-then-review': color = 'bg-blue-100 text-blue-700 border border-blue-200'; break;
    case 'hard-block': color = 'bg-red-100 text-red-700 border border-red-200'; break;
    default: color = 'bg-gray-100 text-gray-600 border border-gray-200';
  }

  return (
    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider", color, className)}>
      {label}
    </span>
  );
}