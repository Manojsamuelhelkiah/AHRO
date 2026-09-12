import React, { useState } from 'react';
import { ShieldCheck, CalendarClock, AlertTriangle, ShieldAlert, X } from 'lucide-react';
import { Card, CardContent, Button, Badge, Label, cn } from '@/components/ui-shared';
import { 
  useListLifecycleHolds,
  useSetLifecycleHold,
  useReleaseLifecycleHold,
  useGetLifecyclePolicies,
  usePreviewRetentionShortening,
  useConfirmRetentionShortening,
  type RetentionPolicy
} from '../../../hooks/use-privacy-api';

export function CasePrivacyControls({ caseId }: { caseId: number }) {
  const { data: holdsData, isLoading: holdsLoading, error: holdsError } = useListLifecycleHolds();
  const setHold = useSetLifecycleHold();
  const releaseHold = useReleaseLifecycleHold();
  const { data: policiesData } = useGetLifecyclePolicies();
  
  const [shorteningMode, setShorteningMode] = useState<false | 'configure' | 'preview'>(false);
  const [selectedPolicyIndex, setSelectedPolicyIndex] = useState<number>(0);
  const [proposedRetentionDays, setProposedRetentionDays] = useState<number | ''>('');
  const [previewData, setPreviewData] = useState<any>(null);
  const [savedRetention, setSavedRetention] = useState<string | null>(null);
  
  const previewShortening = usePreviewRetentionShortening();
  const confirmShortening = useConfirmRetentionShortening();

  if (holdsLoading) return null;

  const currentHolds = holdsData?.holds?.filter(h => h.active && (h.caseId === caseId || h.caseId === null)) || [];
  const policies = policiesData?.policies || [];

  const handlePreview = () => {
    setSavedRetention(null);
    const basePolicy = policies[selectedPolicyIndex];
    if (!basePolicy || proposedRetentionDays === '') return;
    
    const draftPolicy: RetentionPolicy = {
      ...basePolicy,
      retentionDays: proposedRetentionDays,
      expectedRevision: basePolicy.revision
    };

    previewShortening.mutate(draftPolicy, {
      onSuccess: (data) => {
        setPreviewData({ ...data, proposedPolicy: draftPolicy });
        setShorteningMode('preview');
      }
    });
  };

  const handleConfirm = () => {
    if (!previewData) return;
    confirmShortening.mutate({
      confirmationId: previewData.confirmationId,
      confirmationPhrase: previewData.confirmationPhrase,
      policy: previewData.proposedPolicy,
    }, {
      onSuccess: () => {
        setSavedRetention(`${previewData.proposedPolicy.dataClass} / ${previewData.proposedPolicy.jurisdiction}: approved retention is now ${previewData.proposedPolicy.retentionDays} days.`);
        setShorteningMode(false);
        setPreviewData(null);
      }
    });
  };

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] p-4 shadow-[var(--shadow-sm)]">
      <div className="flex items-center gap-2 mb-4">
        <ShieldCheck className="w-4 h-4 text-[var(--text-muted)]" />
        <h3 className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider">Privacy & Retention</h3>
      </div>
      
      {holdsError && (
        <div className="mb-4 text-[10px] text-[var(--status-red-fg)] bg-[var(--status-red-bg)] p-2 rounded">
          Could not load holds: {(holdsError as any).message}
        </div>
      )}
      {(setHold.error || releaseHold.error) && (
        <p role="alert" className="mb-4 text-xs text-[var(--status-red-fg)]">
          {(setHold.error || releaseHold.error)?.message}
        </p>
      )}

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-[var(--text-normal)]">Legal Hold</div>
            <div className="text-xs text-[var(--text-muted)] mt-0.5">Prevents automated deletion.</div>
          </div>
          <Button 
            variant="outline" 
            size="sm"
            disabled={setHold.isPending}
            onClick={() => {
              const reason = window.prompt("Reason for legal hold?");
              const reference = window.prompt("Ticket/Approval Reference?");
              if (reason && reference) setHold.mutate({ caseId, reason, reference });
            }}
          >
            Place Hold
          </Button>
        </div>

        {currentHolds.length > 0 && (
          <div className="space-y-2 mt-2">
            {currentHolds.map(hold => (
              <div key={hold.id} className="text-xs p-2 bg-[var(--surface-sunken)] rounded-md border border-[var(--border)] relative group">
                <div className="pr-16">
                  <div className="text-[var(--text-normal)]"><span className="font-semibold text-[var(--status-amber-fg)]">Active Hold:</span> {hold.reason}</div>
                  <div className="text-[var(--text-muted)] font-mono mt-1 flex items-center justify-between">
                    Ref: {hold.reference}
                  </div>
                </div>
                <Button 
                  variant="ghost" 
                  size="sm"
                  className="absolute right-1 top-1 h-6 px-2 text-[10px] text-[var(--status-red-fg)]"
                  onClick={() => {
                    const ref = window.prompt("Reference/reason for releasing this hold?");
                    if (ref) releaseHold.mutate({ holdId: hold.id, reference: ref });
                  }}
                  disabled={releaseHold.isPending}
                >
                  Release
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="pt-4 border-t border-[var(--border)]">
          {savedRetention && <p role="status" className="mb-3 text-xs text-[var(--status-green-fg)]">{savedRetention}</p>}
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-sm font-medium text-[var(--text-normal)]">Policy Retention</div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5">Changes apply to every matching record in this organization and jurisdiction, not just this case.</div>
            </div>
          </div>
          
          {!shorteningMode && (
            <Button variant="outline" size="sm" className="w-full text-xs" onClick={() => setShorteningMode('configure')} disabled={currentHolds.length > 0 || policies.length === 0}>
              <CalendarClock className="w-3.5 h-3.5 mr-1.5" />
              Shorten Policy Retention
            </Button>
          )}

          {shorteningMode === 'configure' && (
            <div className="p-3 bg-[var(--surface-sunken)] border border-[var(--border)] rounded-md space-y-3">
              <div className="flex justify-between items-center mb-1">
                <span className="text-xs font-semibold">Propose Shortening</span>
                <button onClick={() => setShorteningMode(false)} className="text-[var(--text-muted)]"><X className="w-3 h-3" /></button>
              </div>
              
              <div className="text-[10px] text-[var(--status-amber-fg)] leading-tight mb-2">
                <strong>Warning:</strong> This proposes a revision to the TENANT jurisdiction policy. 
                It will affect ALL cases governed by this policy, not just this individual case.
              </div>
              
              <div>
                <Label className="text-[10px] uppercase block mb-1">Select Policy</Label>
                <select 
                  className="w-full text-xs p-1.5 border border-[var(--border)] rounded bg-[var(--surface)]"
                  value={selectedPolicyIndex}
                  onChange={(e) => setSelectedPolicyIndex(Number(e.target.value))}
                >
                  {policies.map((p, i) => (
                    <option key={i} value={i}>{p.dataClass} - {p.jurisdiction} ({p.retentionDays} days)</option>
                  ))}
                </select>
              </div>

              <div>
                <Label className="text-[10px] uppercase block mb-1">Proposed Days</Label>
                <input 
                  type="number" 
                  value={proposedRetentionDays}
                  onChange={(e) => setProposedRetentionDays(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full text-xs p-1.5 border border-[var(--border)] rounded bg-[var(--surface)]"
                />
              </div>

              {previewShortening.error && (
                <div className="text-[10px] text-[var(--status-red-fg)]">
                  {(previewShortening.error as any).message}
                </div>
              )}

              <Button size="sm" className="w-full text-xs" onClick={handlePreview} disabled={previewShortening.isPending}>
                {previewShortening.isPending ? 'Previewing...' : 'Preview Impact'}
              </Button>
            </div>
          )}

          {shorteningMode === 'preview' && previewData && (
            <div className="p-3 bg-[var(--status-amber-bg)] border border-[var(--status-amber-fg)] rounded-md space-y-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-[var(--status-amber-fg)] shrink-0 mt-0.5" />
                <div className="text-xs text-[var(--status-amber-fg)]">
                  <strong>Shorten retention?</strong>
                  <div className="mt-1">Policy: {previewData.proposedPolicy.dataClass} / {previewData.proposedPolicy.jurisdiction}</div>
                  <div className="mt-1">New Retention: {previewData.proposedPolicy.retentionDays} days</div>
                  <div className="mt-1 font-semibold">Eligible records in this organization: {previewData.affectedObjectCount}</div>
                  <div className="mt-1">Records protected by holds: {previewData.heldRecordCount ?? 0}</div>
                  <div className="mt-1">Confirming changes the policy for all matching cases. Eligible records and their managed derivatives may be permanently deleted.</div>
                  <div className="mt-1 font-mono text-[9px] break-all opacity-80 mt-2">Phrase: {previewData.confirmationPhrase}</div>
                </div>
              </div>
              
              {confirmShortening.error && (
                <div className="text-[10px] text-[var(--status-red-fg)] bg-[var(--surface)] p-1 rounded">
                  {(confirmShortening.error as any).message}
                </div>
              )}

              <div className="flex items-center gap-2 mt-2">
                <Button size="sm" variant="outline" className="flex-1 text-xs" onClick={() => setShorteningMode('configure')}>Cancel</Button>
                <Button size="sm" variant="default" className="flex-1 text-xs bg-[var(--status-red-bg)] text-[var(--status-red-fg)] hover:bg-[var(--status-red-bg)] border border-[var(--status-red-fg)]" 
                  disabled={confirmShortening.isPending}
                  onClick={handleConfirm}
                >
                  {confirmShortening.isPending ? 'Confirming...' : 'Authorize'}
                </Button>
              </div>
            </div>
          )}

          {currentHolds.length > 0 && !shorteningMode && (
            <div className="text-[10px] text-[var(--status-amber-fg)] mt-2 flex gap-1">
              <ShieldAlert className="w-3 h-3" /> Cannot shorten while active holds exist.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
