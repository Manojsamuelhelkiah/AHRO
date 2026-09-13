import React, { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, Button, Input, Label, cn } from '@/components/ui-shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import {
  useGetFrontlineReadiness,
  useGetFrontlineEvidenceHistory,
  useGetFrontlineKpis,
  usePostFrontlineEvidence,
  usePostFrontlineFulfillment,
  usePostFrontlineFloorRelease,
  usePostFrontlineKpiInput,
  usePostFrontlinePolicyException,
  useRevokeFrontlineEvidence,
  useRevokeFrontlinePolicyException,
  type FrontlineAcknowledgementMethod,
  type FrontlineEvidenceHistory,
  type FrontlineReadiness,
} from '../../../hooks/use-frontline-api';
import { format } from 'date-fns';
import { AlertTriangle, CheckCircle2, ShieldAlert, Package, Info, Target, FileWarning } from 'lucide-react';

export function FrontlineTab({ caseId }: { caseId: number }) {
  const { data: readiness, isLoading } = useGetFrontlineReadiness(caseId);
  const {
    data: evidenceHistory,
    isLoading: isEvidenceHistoryLoading,
    error: evidenceHistoryError,
  } = useGetFrontlineEvidenceHistory(caseId, { enabled: Boolean(readiness?.applicable) });

  if (isLoading) {
    return <div className="p-4 text-[var(--text-muted)] text-sm">Loading frontline data...</div>;
  }

  if (!readiness || !readiness.applicable) {
    return (
      <div className="p-8 text-center text-[var(--text-muted)]">
        <Package className="w-12 h-12 mx-auto mb-4 opacity-20" />
        <h3 className="text-lg font-bold text-[var(--text-primary)]">Frontline Not Applicable</h3>
        <p className="mt-2 text-sm max-w-md mx-auto">This case does not have a frontline or site-based workforce classification. If this is incorrect, correct the job context first.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12 max-w-4xl mx-auto">
      <ReadinessOverview readiness={readiness} caseId={caseId} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <FulfillmentSection
          readiness={readiness}
          caseId={caseId}
          evidenceHistory={evidenceHistory}
          isEvidenceHistoryLoading={isEvidenceHistoryLoading}
          evidenceHistoryError={evidenceHistoryError}
        />
        <EvidenceSection
          readiness={readiness}
          caseId={caseId}
          evidenceHistory={evidenceHistory}
          isEvidenceHistoryLoading={isEvidenceHistoryLoading}
          evidenceHistoryError={evidenceHistoryError}
        />
        <KpiSection caseId={caseId} />
        <ExceptionSection
          readiness={readiness}
          caseId={caseId}
          evidenceHistory={evidenceHistory}
          isEvidenceHistoryLoading={isEvidenceHistoryLoading}
          evidenceHistoryError={evidenceHistoryError}
        />
      </div>
    </div>
  );
}

type EvidenceHistoryProps = {
  evidenceHistory?: FrontlineEvidenceHistory;
  isEvidenceHistoryLoading: boolean;
  evidenceHistoryError: unknown;
};

function historyErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Restricted evidence history could not be loaded.';
}

function ReadinessOverview({ readiness, caseId }: { readiness: FrontlineReadiness, caseId: number }) {
  const floorRelease = usePostFrontlineFloorRelease();

  const onRelease = () => {
    floorRelease.mutate({
      caseId,
      data: {
        expectedVersion: readiness.version
      }
    });
  };

  return (
    <Card className={cn(
      "border-2",
      readiness.release.eligible ? "border-[var(--status-green)]" : "border-[var(--border)]"
    )}>
      <CardHeader className="pb-3 border-b flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-[var(--text-base)]">Floor Release Readiness</CardTitle>
          <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1">Version: {readiness.version}</p>
        </div>
        <div>
          {readiness.release.eligible && readiness.release.recorded ? (
            <span className="flex items-center gap-2 text-sm font-bold text-[var(--status-green)]">
              <CheckCircle2 className="w-5 h-5" /> Release Recorded
            </span>
          ) : readiness.release.eligible ? (
            <span className="flex items-center gap-2 text-sm font-bold text-[var(--status-green)]">
              <CheckCircle2 className="w-5 h-5" /> Eligible for Release
            </span>
          ) : (
            <span className="flex items-center gap-2 text-sm font-bold text-[var(--status-amber)]">
              <AlertTriangle className="w-5 h-5" /> Blocked
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {!readiness.release.eligible && readiness.release.blockers?.length > 0 && (
          <div className="p-3 bg-[var(--status-amber-bg)] border border-[var(--status-amber)]/30 rounded-[var(--radius-md)] text-[var(--status-amber-fg)] text-sm">
            <strong>Active Blockers:</strong>
            <ul className="list-disc pl-5 mt-1">
              {readiness.release.blockers.map((b: string, i: number) => <li key={i}>{b}</li>)}
            </ul>
          </div>
        )}

        {readiness.release.reblocked && (
          <div className="p-3 bg-[var(--status-red-bg)] border border-[var(--status-red)]/30 rounded-[var(--radius-md)] text-[var(--status-red-fg)] text-sm">
            <ShieldAlert className="inline w-4 h-4 mr-1 -mt-0.5" />
            <strong>Re-blocked:</strong> Evidence or fulfillment has expired or been revoked since last approval.
          </div>
        )}

        <div className="flex justify-end pt-2">
          <Button
            disabled={!readiness.release.eligible || readiness.release.recorded || floorRelease.isPending}
            onClick={onRelease}
            className={cn(readiness.release.eligible ? "bg-[var(--status-green)] text-white hover:bg-[var(--status-green)]/90" : "")}
          >
            {readiness.release.eligible && readiness.release.recorded ? 'Floor Release Recorded' : 'Authorize Floor Release'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function FulfillmentSection({
  readiness,
  caseId,
  evidenceHistory,
  isEvidenceHistoryLoading,
  evidenceHistoryError,
}: { readiness: FrontlineReadiness, caseId: number } & EvidenceHistoryProps) {
  const submitFulfillment = usePostFrontlineFulfillment();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    item: 'ppe',
    assetRef: '',
    size: '',
    requested: 1,
    issued: 1,
    ack: true,
    ackRecipientRef: '',
    ackMethod: 'in-person' as FrontlineAcknowledgementMethod,
    status: 'issued' as 'issued' | 'shortage' | 'substituted' | 'deferred',
    exceptionId: '',
  });

  const items = ['badge', 'ppe', 'uniform', 'tool', 'locker'];
  
  // Exception IDs are restricted to the current HR-authorized history response.
  // The broad readiness projection deliberately does not contain exception IDs.
  const exceptionType = form.status === 'substituted' ? 'substitution' : form.status === 'deferred' ? 'deferment' : null;
  const validExceptions = evidenceHistory?.exceptions.filter((exception) =>
    exception.status === 'current' &&
    exception.item === form.item &&
    exception.type === exceptionType,
  ) ?? [];

  const onSave = () => {
    let finalStatus = form.status;
    if (form.status === 'issued' && form.issued < form.requested) {
      finalStatus = 'shortage';
    }

    submitFulfillment.mutate({
      caseId,
      data: {
        expectedVersion: readiness.version,
        item: form.item,
        assetReference: form.assetRef,
        size: form.size || undefined,
        requestedQuantity: Number(form.requested),
        issuedQuantity: Number(form.issued),
        issuerTimestamp: new Date().toISOString(),
        acknowledgedAt: form.ack ? new Date().toISOString() : undefined,
         acknowledgementRecipientReference: form.ack ? form.ackRecipientRef.trim() : undefined,
         acknowledgementMethod: form.ack ? form.ackMethod : undefined,
        status: finalStatus,
        exceptionId: (finalStatus === 'substituted' || finalStatus === 'deferred') && form.exceptionId ? parseInt(form.exceptionId, 10) : undefined
      }
    }, {
      onSuccess: () => setOpen(false)
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3 border-b flex flex-row justify-between items-center">
        <CardTitle className="text-[var(--text-base)]">Asset Fulfillment</CardTitle>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Record Issue</Button>
      </CardHeader>
      <CardContent className="pt-4">
        {readiness.fulfillments?.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)] italic">No assets issued yet.</p>
        ) : (
          <div className="space-y-3">
            {readiness.fulfillments?.map((f: any, i: number) => {
              const isException = f.status === 'substituted' || f.status === 'deferred';
              const shortage = f.status === 'shortage';
              
              return (
                <div key={i} className="p-3 border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface-alt)]">
                  <div className="flex justify-between font-bold text-sm text-[var(--text-primary)]">
                    <span className="uppercase">{f.item}</span>
                    <span>{f.issuedQuantity} / {f.requestedQuantity}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-[var(--text-secondary)]">
                     {f.sizeRecorded && <span>Size recorded</span>}
                     <span>Issued: {format(new Date(f.issuerTimestamp), 'PP p')}</span>
                  </div>
                  <div className="mt-2 text-xs flex justify-between items-end">
                    <div>
                      {isException ? (
                        <span className="text-[var(--status-blue)] font-semibold flex items-center gap-1"><Info className="w-3 h-3" /> Exception: {f.status.toUpperCase()}</span>
                      ) : shortage ? (
                        <span className="text-[var(--status-amber)] font-semibold flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Shortage recorded</span>
                      ) : (
                        <span className="text-[var(--status-green)] font-semibold flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Fully fulfilled</span>
                      )}
                       {f.acknowledged && <span className="block mt-1 text-[var(--text-muted)]">Accountable acknowledgement recorded</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Issue Asset</DialogTitle>
              <DialogDescription>Record physical asset issuance or exception usage.</DialogDescription>
            </DialogHeader>
            <div className="py-2 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Item Type</Label>
                  <select className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={form.item} onChange={e => setForm({...form, item: e.target.value, exceptionId: ''})}>
                    {items.map(i => <option key={i} value={i}>{i.toUpperCase()}</option>)}
                  </select>
                </div>
                <div>
                  <Label>Issuance Status</Label>
                   <select className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={form.status} onChange={e => setForm({...form, status: e.target.value as typeof form.status, exceptionId: ''})}>
                    <option value="issued">Issued / Shortage</option>
                    <option value="substituted">Substituted (Exception)</option>
                    <option value="deferred">Deferred (Exception)</option>
                  </select>
                </div>
              </div>
              
              {(form.status === 'substituted' || form.status === 'deferred') && (
                <div>
                  <Label>Apply Policy Exception</Label>
                  <select
                    className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm"
                    value={form.exceptionId}
                    disabled={isEvidenceHistoryLoading || Boolean(evidenceHistoryError)}
                    onChange={e => setForm({...form, exceptionId: e.target.value})}
                  >
                    <option value="">Select active exception...</option>
                    {validExceptions.map((exception) => (
                      <option key={exception.id} value={exception.id}>{exception.type.toUpperCase()} #{exception.id}</option>
                    ))}
                  </select>
                  {isEvidenceHistoryLoading && <p className="text-[11px] text-[var(--text-muted)] mt-1">Loading current exception history…</p>}
                  {evidenceHistoryError ? <p className="text-[11px] text-[var(--status-red)] mt-1">{historyErrorMessage(evidenceHistoryError)}</p> : null}
                  {!isEvidenceHistoryLoading && !evidenceHistoryError && validExceptions.length === 0 && <p className="text-[11px] text-[var(--status-red)] mt-1">No current matching exception recorded for this item and status.</p>}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div><Label>Asset Ref / SN</Label><Input value={form.assetRef} onChange={e => setForm({...form, assetRef: e.target.value})} placeholder="Barcode/SN" /></div>
                <div><Label>Size (if applicable)</Label><Input value={form.size} onChange={e => setForm({...form, size: e.target.value})} placeholder="e.g. XL, 42" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Requested Qty</Label><Input type="number" min="1" value={form.requested} onChange={e => setForm({...form, requested: parseInt(e.target.value) || 1})} /></div>
                <div><Label>Issued Qty</Label><Input type="number" min="0" value={form.issued} onChange={e => setForm({...form, issued: parseInt(e.target.value) || 0})} /></div>
              </div>
              <label className="flex items-center gap-2 mt-4 text-sm font-semibold cursor-pointer">
                <input type="checkbox" checked={form.ack} onChange={e => setForm({...form, ack: e.target.checked})} className="rounded border-[var(--border)] text-[var(--primary)]" />
                Recipient physically acknowledged receipt
              </label>
              {form.ack && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <Label>Acknowledgement Recipient Reference</Label>
                    <Input
                      value={form.ackRecipientRef}
                      onChange={e => setForm({...form, ackRecipientRef: e.target.value})}
                      placeholder="Worker or recipient reference"
                    />
                  </div>
                  <div>
                    <Label>Acknowledgement Method</Label>
                    <select
                      className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm"
                      value={form.ackMethod}
                      onChange={e => setForm({...form, ackMethod: e.target.value as FrontlineAcknowledgementMethod})}
                    >
                      <option value="in-person">In person</option>
                      <option value="signed-receipt">Signed receipt</option>
                      <option value="verified-digital">Verified digital</option>
                    </select>
                  </div>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                onClick={onSave}
                disabled={
                  submitFulfillment.isPending ||
                  (form.ack && !form.ackRecipientRef.trim()) ||
                  ((form.status === 'substituted' || form.status === 'deferred') && !form.exceptionId)
                }
              >
                Save Issuance
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function EvidenceSection({
  readiness,
  caseId,
  evidenceHistory,
  isEvidenceHistoryLoading,
  evidenceHistoryError,
}: { readiness: FrontlineReadiness, caseId: number } & EvidenceHistoryProps) {
  const submitEvidence = usePostFrontlineEvidence();
  const revokeEvidence = useRevokeFrontlineEvidence();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ kind: 'wage-setup', evidenceRef: '', expiresAt: '', statutoryKey: '', subjectAgeYears: '', skillRequirementKey: '' });

  const evidenceKinds = ['age-proof', 'skill-certificate', 'medical-fitness', 'safety-competency', 'wage-setup', 'timesheet-setup', 'statutory-registration'];

  const onRevoke = (evidenceId: number) => {
    const revocationReference = window.prompt('Enter the authority reference for this evidence revocation:')?.trim();
    if (!revocationReference) return;
    revokeEvidence.mutate({
      caseId,
      evidenceId,
      data: { expectedVersion: readiness.version, revocationReference },
    });
  };

  const onSave = () => {
    submitEvidence.mutate({
      caseId,
      data: {
        expectedVersion: readiness.version,
        kind: form.kind,
        evidenceReference: form.evidenceRef,
        issuerTimestamp: new Date().toISOString(),
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined,
        statutoryKey: form.statutoryKey || undefined,
        skillRequirementKey: form.skillRequirementKey || undefined,
        subjectAgeYears: form.subjectAgeYears ? parseInt(form.subjectAgeYears, 10) : undefined,
        status: 'verified'
      }
    }, {
      onSuccess: () => setOpen(false)
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3 border-b flex flex-row justify-between items-center">
        <CardTitle className="text-[var(--text-base)] flex items-center gap-2">
          Private Evidence Summary <Info className="w-4 h-4 text-[var(--text-muted)]" />
        </CardTitle>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Record</Button>
      </CardHeader>
      <CardContent className="pt-4">
        <p className="text-sm text-[var(--text-muted)] mb-4">
          Statutory, wage, and medical evidence records. Detailed history and revocation are restricted to authorized reviewers.
        </p>

        {readiness.evidenceStatuses && readiness.evidenceStatuses.length > 0 && (
          <div className="space-y-3 mb-4">
            {readiness.evidenceStatuses.map((e: any, index: number) => (
              <div key={index} className="p-3 border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface-alt)]">
                <div className="flex justify-between font-bold text-sm text-[var(--text-primary)]">
                  <span className="uppercase">{e.kind}</span>
                  <span className={e.status === 'verified' ? 'text-[var(--status-green)]' : 'text-[var(--status-red)]'}>{e.status.toUpperCase()}</span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-[var(--text-secondary)]">
                  {e.statutoryKey && <span>Statutory: {e.statutoryKey}</span>}
                  {e.skillRequirementKey && <span>Skill: {e.skillRequirementKey}</span>}
                  <span>Expiry: {e.expiryState.replace(/-/g, ' ')}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-[var(--border)] pt-4 space-y-3">
          <h4 className="text-xs font-bold text-[var(--text-muted)] uppercase">Restricted Evidence History</h4>
          {isEvidenceHistoryLoading && <p className="text-sm text-[var(--text-muted)]">Loading current HR-authorized evidence history…</p>}
          {evidenceHistoryError ? <p className="text-sm text-[var(--status-red)]">{historyErrorMessage(evidenceHistoryError)}</p> : null}
          {!isEvidenceHistoryLoading && !evidenceHistoryError && evidenceHistory?.evidence.length === 0 && (
            <p className="text-sm text-[var(--text-muted)] italic">No restricted evidence history recorded.</p>
          )}
          {evidenceHistory?.evidence.map((evidence) => (
            <div key={evidence.id} className="p-3 border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface-alt)]">
              <div className="flex justify-between gap-2 text-sm font-semibold text-[var(--text-primary)]">
                <span>{evidence.kind.replace(/-/g, ' ').toUpperCase()} #{evidence.id}</span>
                <span className={evidence.status === 'revoked' ? 'text-[var(--status-red)]' : 'text-[var(--status-green)]'}>{evidence.status.toUpperCase()}</span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-xs text-[var(--text-secondary)]">
                {evidence.statutoryKey && <span>Statutory: {evidence.statutoryKey}</span>}
                {evidence.skillRequirementKey && <span>Skill: {evidence.skillRequirementKey}</span>}
                <span>Expiry: {evidence.expiryState.replace(/-/g, ' ')}</span>
              </div>
              {evidence.status !== 'revoked' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 text-[var(--status-red)]"
                  disabled={revokeEvidence.isPending}
                  onClick={() => onRevoke(evidence.id)}
                >
                  Revoke evidence
                </Button>
              )}
            </div>
          ))}
        </div>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Record External Evidence</DialogTitle>
              <DialogDescription>Reference an external authority record. No medical files should be uploaded here.</DialogDescription>
            </DialogHeader>
            <div className="py-2 space-y-3">
              <div>
                <Label>Evidence Kind</Label>
                <select className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={form.kind} onChange={e => setForm({...form, kind: e.target.value})}>
                  {evidenceKinds.map(k => <option key={k} value={k}>{k.replace(/-/g, ' ').toUpperCase()}</option>)}
                </select>
              </div>
              <div>
                <Label>External Record Reference</Label>
                <Input value={form.evidenceRef} onChange={e => setForm({...form, evidenceRef: e.target.value})} placeholder="URL or system ID (e.g. EHS-992)" />
              </div>
              {form.kind === 'age-proof' && (
                <div>
                  <Label>Subject Age (Years)</Label>
                  <Input type="number" value={form.subjectAgeYears} onChange={e => setForm({...form, subjectAgeYears: e.target.value})} placeholder="e.g. 18" />
                </div>
              )}
              {form.kind === 'skill-certificate' && (
                <div>
                  <Label>Skill Requirement Key</Label>
                  <Input value={form.skillRequirementKey} onChange={e => setForm({...form, skillRequirementKey: e.target.value})} placeholder="e.g. FORKLIFT-OP" />
                </div>
              )}
              {form.kind === 'statutory-registration' && (
                <div>
                  <Label>Statutory Key (if applicable)</Label>
                  <Input value={form.statutoryKey} onChange={e => setForm({...form, statutoryKey: e.target.value})} placeholder="e.g. UAN, SSN Hash" />
                </div>
              )}
              <div>
                <Label>Authority Expiry Date (Optional)</Label>
                <Input type="date" value={form.expiresAt} onChange={e => setForm({...form, expiresAt: e.target.value})} />
                <p className="text-[11px] text-[var(--text-muted)] mt-1">If set, floor readiness will re-block after this date.</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={onSave} disabled={submitEvidence.isPending || !form.evidenceRef.trim()}>Submit Evidence</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function KpiSection({ caseId }: { caseId: number }) {
  const { data: kpis } = useGetFrontlineKpis(caseId);
  const submitKpi = usePostFrontlineKpiInput();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ kind: 'intake', occurredAt: '', actualExitAt: '', evidenceRef: '' });

  // Use the readiness expected version for KPIs, wait we don't have it here...
  // Wait, I need readiness.version! Let me pass readiness to this component
  const { data: readiness } = useGetFrontlineReadiness(caseId);

  const kpiKinds = ['intake', 'medical-result', 'safety-completed', 'ppe-issued', 'statutory-registered', 'actual-exit'];

  const onSave = () => {
    if (!readiness) return;
    submitKpi.mutate({
      caseId,
      data: {
        expectedVersion: readiness.version,
        kind: form.kind,
        occurredAt: new Date(form.occurredAt || new Date()).toISOString(),
        actualExitAt: form.kind === 'actual-exit' && form.actualExitAt ? new Date(form.actualExitAt).toISOString() : undefined,
        evidenceReference: form.evidenceRef
      }
    }, {
      onSuccess: () => setOpen(false)
    });
  };

  if (kpis === undefined) {
    return <Card><CardContent className="p-4"><p className="text-sm text-[var(--text-muted)]">Loading metrics...</p></CardContent></Card>;
  }

  return (
    <Card>
      <CardHeader className="pb-3 border-b flex flex-row justify-between items-center">
        <CardTitle className="text-[var(--text-base)] flex items-center gap-2">
          KPI Metrics <Target className="w-4 h-4 text-[var(--text-muted)]" />
        </CardTitle>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Record</Button>
      </CardHeader>
      <CardContent className="pt-4">
        {kpis === null ? (
          <div className="p-3 bg-[var(--surface-alt)] border border-[var(--border)] rounded-[var(--radius-md)] text-sm text-[var(--text-muted)]">
            Detailed metrics are restricted and require specific reporting authority.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="p-2 border border-[var(--border)] rounded-[var(--radius-md)]">
                <span className="text-[var(--text-muted)] text-xs block">Cycle Time</span>
                <span className="font-semibold">{kpis.metrics.floorReadyCycleSeconds ? `${Math.round(kpis.metrics.floorReadyCycleSeconds / 3600)}h` : 'Pending'}</span>
              </div>
              <div className="p-2 border border-[var(--border)] rounded-[var(--radius-md)]">
                <span className="text-[var(--text-muted)] text-xs block">Medical Turnaround</span>
                <span className="font-semibold">{kpis.metrics.medicalTurnaroundSeconds ? `${Math.round(kpis.metrics.medicalTurnaroundSeconds / 3600)}h` : 'Pending'}</span>
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="text-xs font-bold text-[var(--text-muted)] uppercase">Milestone Status</h4>
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className={cn("w-4 h-4", kpis.metrics.safetyInductionCompleted ? "text-[var(--status-green)]" : "text-[var(--border)]")} />
                <span>Safety Induction</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className={cn("w-4 h-4", kpis.metrics.ppeIssuanceCompliant ? "text-[var(--status-green)]" : "text-[var(--border)]")} />
                <span>PPE Compliant</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className={cn("w-4 h-4", kpis.metrics.statutoryRegistrationRecorded ? "text-[var(--status-green)]" : "text-[var(--border)]")} />
                <span>Statutory Complete</span>
              </div>
            </div>

            {kpis.inputs.length > 0 && (
              <div className="mt-4 pt-4 border-t border-[var(--border)]">
                <h4 className="text-xs font-bold text-[var(--text-muted)] uppercase mb-2">Input History Summary</h4>
                <div className="space-y-2">
                  {kpis.inputs.map((input) => (
                    <div key={input.kind} className="flex justify-between text-xs">
                      <span>{input.kind} ({input.count})</span>
                      <span className="text-[var(--text-muted)]">{format(new Date(input.lastObservedAt), 'PP')}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Record KPI Input</DialogTitle>
            </DialogHeader>
            <div className="py-2 space-y-3">
              <div>
                <Label>KPI Kind</Label>
                <select className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={form.kind} onChange={e => setForm({...form, kind: e.target.value})}>
                  {kpiKinds.map(k => <option key={k} value={k}>{k.replace(/-/g, ' ').toUpperCase()}</option>)}
                </select>
              </div>
              <div>
                <Label>Occurred At</Label>
                <Input type="datetime-local" value={form.occurredAt} onChange={e => setForm({...form, occurredAt: e.target.value})} />
              </div>
              {form.kind === 'actual-exit' && (
                <div>
                  <Label>Actual Exit At (must match occurred at)</Label>
                  <Input type="datetime-local" value={form.actualExitAt} onChange={e => setForm({...form, actualExitAt: e.target.value})} />
                </div>
              )}
              <div>
                <Label>Evidence Reference</Label>
                <Input value={form.evidenceRef} onChange={e => setForm({...form, evidenceRef: e.target.value})} placeholder="System ID or doc link" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={onSave} disabled={submitKpi.isPending || !form.evidenceRef.trim() || !readiness}>Save KPI</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function ExceptionSection({
  readiness,
  caseId,
  evidenceHistory,
  isEvidenceHistoryLoading,
  evidenceHistoryError,
}: { readiness: FrontlineReadiness, caseId: number } & EvidenceHistoryProps) {
  const submitException = usePostFrontlinePolicyException();
  const revokeException = useRevokeFrontlinePolicyException();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ item: 'ppe', type: 'substitution' as 'substitution'|'deferment', reviewRef: '', effectiveAt: '', expiresAt: '' });

  const items = ['badge', 'ppe', 'uniform', 'tool', 'locker'];

  const onRevoke = (exceptionId: number) => {
    const revocationReference = window.prompt('Enter the authority reference for this policy exception revocation:')?.trim();
    if (!revocationReference) return;
    revokeException.mutate({
      caseId,
      exceptionId,
      data: { expectedVersion: readiness.version, revocationReference },
    });
  };

  const onSave = () => {
    submitException.mutate({
      caseId,
      data: {
        expectedVersion: readiness.version,
        item: form.item,
        type: form.type,
        reviewReference: form.reviewRef,
        effectiveAt: new Date(form.effectiveAt || new Date()).toISOString(),
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined
      }
    }, {
      onSuccess: () => setOpen(false)
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3 border-b flex flex-row justify-between items-center">
        <CardTitle className="text-[var(--text-base)] flex items-center gap-2">
          Policy Exceptions <FileWarning className="w-4 h-4 text-[var(--text-muted)]" />
        </CardTitle>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Record</Button>
      </CardHeader>
      <CardContent className="pt-4">
        <p className="text-sm text-[var(--text-muted)] mb-4">
          Record authorized substitution or deferment of required frontline items as per policy. History and revocation are restricted to authorized reviewers.
        </p>

        <div className="border-b border-[var(--border)] pb-4 mb-4 space-y-3">
          <h4 className="text-xs font-bold text-[var(--text-muted)] uppercase">Restricted Exception History</h4>
          {isEvidenceHistoryLoading && <p className="text-sm text-[var(--text-muted)]">Loading current HR-authorized exception history…</p>}
          {evidenceHistoryError ? <p className="text-sm text-[var(--status-red)]">{historyErrorMessage(evidenceHistoryError)}</p> : null}
          {!isEvidenceHistoryLoading && !evidenceHistoryError && evidenceHistory?.exceptions.length === 0 && (
            <p className="text-sm text-[var(--text-muted)] italic">No restricted policy exceptions recorded.</p>
          )}
          {evidenceHistory?.exceptions.map((exception) => (
            <div key={exception.id} className="p-3 border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface-alt)]">
              <div className="flex justify-between gap-2 text-sm font-semibold text-[var(--text-primary)]">
                <span>{exception.item.toUpperCase()} · {exception.type.toUpperCase()} #{exception.id}</span>
                <span className={exception.status === 'current' ? 'text-[var(--status-green)]' : 'text-[var(--text-muted)]'}>{exception.status.toUpperCase()}</span>
              </div>
              {exception.status !== 'revoked' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 text-[var(--status-red)]"
                  disabled={revokeException.isPending}
                  onClick={() => onRevoke(exception.id)}
                >
                  Revoke exception
                </Button>
              )}
            </div>
          ))}
        </div>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Record Policy Exception</DialogTitle>
              <DialogDescription>Substitution or deferment of standard policy rules.</DialogDescription>
            </DialogHeader>
            <div className="py-2 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Item</Label>
                  <select className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={form.item} onChange={e => setForm({...form, item: e.target.value})}>
                    {items.map(i => <option key={i} value={i}>{i.toUpperCase()}</option>)}
                  </select>
                </div>
                <div>
                  <Label>Exception Type</Label>
                  <select className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={form.type} onChange={e => setForm({...form, type: e.target.value as 'substitution'|'deferment'})}>
                    <option value="substitution">Substitution</option>
                    <option value="deferment">Deferment</option>
                  </select>
                </div>
              </div>
              <div>
                <Label>Review Reference</Label>
                <Input value={form.reviewRef} onChange={e => setForm({...form, reviewRef: e.target.value})} placeholder="Exception authority / doc ref" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Effective Date</Label>
                  <Input type="date" value={form.effectiveAt} onChange={e => setForm({...form, effectiveAt: e.target.value})} />
                </div>
                <div>
                  <Label>Expiry Date (Optional)</Label>
                  <Input type="date" value={form.expiresAt} onChange={e => setForm({...form, expiresAt: e.target.value})} />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={onSave} disabled={submitException.isPending || !form.reviewRef.trim()}>Record Exception</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
