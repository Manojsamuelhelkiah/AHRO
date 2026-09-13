import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useParams } from 'wouter';
import { ArrowLeft, BarChart, Building2, FileSpreadsheet, Server, ShieldCheck, Users } from 'lucide-react';
import { getWorkforceTransferProgram, type WorkforceTransferProgram } from '@/lib/workforce-transfers-api';
import { Button, Card, PageHeader, cn } from '@/components/ui-shared';
import { GovernanceSection } from './governance';
import { PopulationImportSection } from './populations';
import { OperationsSection } from './operations';
import { CutoverSection } from './cutover';
import { KpisSection } from './kpis';
import { dateLabel, humanize } from './shared';

type Tab = 'overview' | 'governance' | 'populations' | 'operations' | 'cutover' | 'kpis';
const tabs: Array<{ id: Tab; label: string; icon: typeof Building2 }> = [
  { id: 'overview', label: 'Overview', icon: Building2 }, { id: 'governance', label: 'Legal & governance', icon: ShieldCheck },
  { id: 'populations', label: 'Populations & import', icon: FileSpreadsheet }, { id: 'operations', label: 'Consultation & integration', icon: Users },
  { id: 'cutover', label: 'Cutover & readiness', icon: Server }, { id: 'kpis', label: 'KPIs & evidence', icon: BarChart },
];

export function WorkforceTransfersDetailPage() {
  const { id } = useParams<{ id: string }>(); const [, setLocation] = useLocation(); const [activeTab, setActiveTab] = useState<Tab>('overview');
  const programQuery = useQuery({ queryKey: ['workforce-transfers', 'program', id], queryFn: () => getWorkforceTransferProgram(id!), enabled: Boolean(id) });
  if (programQuery.isLoading) return <div className="p-12 text-center text-[var(--text-muted)]">Loading transfer program…</div>;
  if (programQuery.isError || !programQuery.data) return <div className="p-12 text-center space-y-3"><p role="alert" className="text-[var(--status-red)]">{programQuery.error instanceof Error ? programQuery.error.message : 'Failed to load transfer program.'}</p><Button onClick={() => programQuery.refetch()}>Retry</Button><Button variant="outline" onClick={() => setLocation('/workforce-transfers')}>Back</Button></div>;
  const program = programQuery.data;
  return <div className="space-y-6 max-w-7xl mx-auto pb-12">
    <div className="flex items-center gap-4"><Button variant="ghost" size="icon" onClick={() => setLocation('/workforce-transfers')} className="rounded-full"><ArrowLeft className="h-4 w-4" /></Button><PageHeader title={program.name} subtitle={`${program.sourceLegalEntity} → ${program.destinationLegalEntity} · Day 1 ${dateLabel(program.legalDay1)} · Program v${program.version}`} /></div>
    <div className="flex flex-col md:flex-row gap-6 items-start"><Card className="w-full md:w-64 shrink-0 flex flex-col p-2 space-y-1 bg-[var(--surface)]">{tabs.map((tab) => <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={cn('flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] text-sm font-medium text-left', activeTab === tab.id ? 'bg-[var(--primary-light)] text-[var(--primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-soft)]')}><tab.icon className="w-4 h-4" />{tab.label}</button>)}</Card>
      <main className="flex-1 min-w-0 space-y-6">{activeTab === 'overview' && <Overview program={program} />}{activeTab === 'governance' && <GovernanceSection program={program} />}{activeTab === 'populations' && <PopulationImportSection program={program} />}{activeTab === 'operations' && <OperationsSection program={program} />}{activeTab === 'cutover' && <CutoverSection program={program} />}{activeTab === 'kpis' && <KpisSection program={program} />}</main>
    </div>
  </div>;
}

function Overview({ program }: { program: WorkforceTransferProgram }) {
  return <div className="space-y-6"><Card className="p-6 space-y-4"><h3 className="text-sm font-bold border-b border-[var(--border)] pb-2 uppercase tracking-wider text-[var(--text-muted)]">Program definition</h3><div className="grid grid-cols-2 gap-4 text-sm"><div><p className="text-xs text-[var(--text-muted)]">Source entity</p><p className="font-medium">{program.sourceLegalEntity}</p></div><div><p className="text-xs text-[var(--text-muted)]">Destination entity</p><p className="font-medium">{program.destinationLegalEntity}</p></div><div><p className="text-xs text-[var(--text-muted)]">Basis</p><p className="font-medium capitalize">{humanize(program.proposedBasis)}</p></div><div><p className="text-xs text-[var(--text-muted)]">Status</p><p className="font-medium capitalize">{humanize(program.status)}</p></div><div className="col-span-2"><p className="text-xs text-[var(--text-muted)]">Countries</p><p>{program.countries.join(', ')}</p></div></div></Card><Card className="p-6"><h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-[var(--text-muted)]">Accountable owners</h3><div className="grid grid-cols-2 gap-4 text-sm">{Object.entries(program.owners).map(([role, owner]) => <div key={role}><p className="text-xs text-[var(--text-muted)] capitalize">{humanize(role)}</p><p className="font-medium break-all">{owner}</p></div>)}</div></Card></div>;
}