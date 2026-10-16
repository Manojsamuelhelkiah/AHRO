import { Bot, Briefcase, FileText, GraduationCap, Wallet, KeyRound, Mail, ShieldCheck, Boxes, Laptop, HeartPulse, Users, Compass, Workflow, ClipboardList, Package } from 'lucide-react';
import type { ComponentType } from 'react';

const ICONS: ComponentType<{ className?: string }>[] = [FileText, KeyRound, Boxes, Wallet, GraduationCap, Mail, ShieldCheck, Briefcase, Laptop, HeartPulse, Users, Compass, Workflow, ClipboardList, Package, Bot];
const HUES = [262, 200, 28, 152, 335, 48, 180, 12, 230, 100, 300, 170, 215, 320, 70, 280];

export function roleAccent(key: string, index: number) {
  const hue = HUES[index % HUES.length];
  return { hue, fg: `hsl(${hue} 55% 30%)`, bg: `hsl(${hue} 70% 94%)`, solid: `hsl(${hue} 60% 45%)` };
}

export function RoleIcon({ roleKey, index, className = 'h-10 w-10' }: { roleKey: string; index: number; className?: string }) {
  const Icon = ICONS[index % ICONS.length];
  const a = roleAccent(roleKey, index);
  return (
    <span aria-hidden="true" className={`${className} shrink-0 rounded-xl flex items-center justify-center`} style={{ background: a.bg, color: a.fg, boxShadow: `inset 0 0 0 1px hsl(${a.hue} 50% 75%)` }}>
      <Icon className="h-5 w-5" />
    </span>
  );
}
