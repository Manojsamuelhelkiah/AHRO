import React, { useState } from 'react';
import { useConfirmOnboardingOfferAcceptance, getGetOnboardingCaseQueryKey, getListOnboardingCaseEventsQueryKey, getListOnboardingCasesQueryKey, getGetOnboardingDashboardQueryKey, getListOnboardingApprovalsQueryKey, getListOnboardingCaseDocumentsQueryKey, getListOnboardingCaseCommunicationsQueryKey, OnbCase } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Input, Label } from '@/components/ui-shared';
import { Link } from 'wouter';
import { StatusBadgeText } from './components';
import { useApprovalCapability } from '../../../hooks/use-approval-action';

type GateApprovalTarget = {
  id: number;
  version: number;
  status: string;
} | null | undefined;

export function GatewaysStrip({ c, gateApproval }: {
  c: Pick<OnbCase, 'id' | 'gateways' | 'offerAcceptanceComplete'>;
  gateApproval?: GateApprovalTarget;
}) {
  const queryClient = useQueryClient();
  const confirmOffer = useConfirmOnboardingOfferAcceptance();
  const gateAuthority = useApprovalCapability(gateApproval);
  const [note, setNote] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  // The Gate A write endpoint repeats its current-state check. Never expose
  // this control based on a browser owner/admin role: only its pending,
  // scoped authority-bound approval can enable it.
  const canConfirmGateA =
    gateApproval?.status === 'pending' &&
    gateAuthority.data?.canDecide === true &&
    !gateAuthority.isLoading;

  if (!c.gateways) return null;

  const gates = [
    { key: 'a', title: 'Gateway A: Offer-Acceptance Package', g: c.gateways.a },
    { key: 'b', title: 'Gateway B: Background Checks', g: c.gateways.b },
    { key: 'c', title: 'Gateway C: Day-1 Readiness', g: c.gateways.c },
  ];

  const handleConfirm = () => {
    if (!note.trim()) return;
    confirmOffer.mutate({ id: c.id, data: { note } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetOnboardingCaseQueryKey(c.id) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(c.id) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCasesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetOnboardingDashboardQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListOnboardingApprovalsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseDocumentsQueryKey(c.id) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseCommunicationsQueryKey(c.id) });
        setShowConfirm(false);
        setNote('');
      }
    });
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
      {gates.map(({ key, title, g }) => {
        if (!g) return null;
        const isA = key === 'a';
        let bg = 'var(--surface)';
        let border = 'var(--border)';
        let iconBg = 'var(--surface-alt)';
        let iconFg = 'var(--text-muted)';
        
        if (g.status === 'complete') { border = 'var(--status-green)'; iconBg = 'var(--status-green-bg)'; iconFg = 'var(--status-green-fg)'; }
        else if (g.status === 'blocked') { border = 'var(--status-red)'; iconBg = 'var(--status-red-bg)'; iconFg = 'var(--status-red-fg)'; }
        else if (g.status === 'human-review') { border = 'var(--status-amber)'; iconBg = 'var(--status-amber-bg)'; iconFg = 'var(--status-amber-fg)'; }
        else if (g.status === 'pending') { border = 'var(--primary)'; iconBg = 'var(--primary-light)'; iconFg = 'var(--primary)'; }

        return (
          <div key={key} className="flex flex-col p-4 rounded-[var(--radius-lg)] shadow-[var(--shadow-sm)] border-l-4 bg-[var(--surface)] relative" style={{ borderTop: '1px solid var(--border)', borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)', borderLeftColor: border }}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="flex items-center justify-center rounded-sm font-mono text-[10px] font-bold" style={{ width: '22px', height: '22px', backgroundColor: iconBg, color: iconFg }}>{key.toUpperCase()}</span>
                <span className="text-[var(--text-sm)] font-bold text-[var(--text-primary)]">{title}</span>
              </div>
              <StatusBadgeText status={g.status} />
            </div>
            <p className="text-[var(--text-xs)] text-[var(--text-secondary)] flex-1">{g.label}</p>
            {g.reason && <p className="text-[11px] text-[var(--text-muted)] mt-1">{g.reason}</p>}
            
            {g.status === 'blocked' && (
              <p className="text-[11px] font-medium mt-1 text-[var(--status-red)]">Exceptions and blocked outcomes require human review.</p>
            )}
            
            {isA && (g.status === 'pending' || g.status === 'human-review' || g.status === 'blocked') && !c.offerAcceptanceComplete && canConfirmGateA && (
              <div className="mt-3 pt-3 border-t border-[var(--border)]">
                {showConfirm ? (
                  <div className="space-y-2">
                    <Label className="text-[11px]">Confirmation Note (Required)</Label>
                    <Input className="h-7 text-xs" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g., Received via DocuSign..." />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleConfirm} disabled={!note.trim() || confirmOffer.isPending} className="h-7 text-xs flex-1">Confirm</Button>
                      <Button size="sm" variant="ghost" onClick={() => setShowConfirm(false)} disabled={confirmOffer.isPending} className="h-7 text-xs">Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" className="w-full text-xs h-7" onClick={() => setShowConfirm(true)}>Confirm Offer Package</Button>
                )}
              </div>
            )}
            
            {(key === 'b' || key === 'c') && g.status === 'human-review' && (
              <div className="mt-3 pt-3 border-t border-[var(--border)]">
                <Link href="/approvals" className="text-[var(--primary)] text-xs font-semibold hover:underline flex items-center justify-center">View Pending Interventions →</Link>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}