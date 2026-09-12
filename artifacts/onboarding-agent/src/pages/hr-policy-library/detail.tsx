import React, { useEffect, useMemo, useState } from 'react';
import { useRoute, Link } from 'wouter';
import {
  usePolicyHistory, usePolicyVersion, useUpdateDraft, useSubmitReview, useReviewPolicy,
  usePublishPolicy, useSupersedePolicy, useRetirePolicy, usePolicyCapabilities,
  usePolicyScope, type PolicyMembershipRole, type PolicyVersion,
} from '../../hooks/use-policies';
import { ArrowLeft, Edit3, Send, CheckCircle, XCircle, Clock, Shield, AlertTriangle, Loader2, FileText } from 'lucide-react';
import { useToast } from '../../hooks/use-toast';

const fieldClass = 'w-full h-10 px-3 rounded-lg border bg-white focus:border-[var(--primary)] outline-none disabled:bg-slate-50 disabled:text-slate-500';
const actionButtonClass = 'w-full py-2.5 px-4 rounded-lg font-bold border flex items-center justify-center gap-2 transition-colors disabled:opacity-50';

export function HrPolicyLibraryDetailPage() {
  const [, params] = useRoute('/hr-policy-library/:id');
  const id = params?.id || '';
  const historyQuery = usePolicyHistory(id);
  const capabilitiesQuery = usePolicyCapabilities();
  const versions = historyQuery.isError ? undefined : historyQuery.data;
  const capabilities = capabilitiesQuery.isError ? undefined : capabilitiesQuery.data;
  const { isLoading, refetch } = historyQuery;
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);

  const policy = useMemo(() => {
    if (!versions?.length) return null;
    const current = versions.find((version) => ['published', 'superseded', 'retired'].includes(version.status));
    const draft = versions.find((version) => version.status === 'draft' || version.status === 'in_review');
    return { id, current, draft, all: versions };
  }, [versions, id]);
  const editableVersion = policy?.draft ?? policy?.current;
  const displayVersion = selectedVersion ?? editableVersion?.version ?? null;
  const versionDetail = usePolicyVersion(id, displayVersion);

  useEffect(() => {
    if (selectedVersion !== null && !versions?.some((version) => version.version === selectedVersion)) {
      setSelectedVersion(null);
    }
  }, [selectedVersion, versions]);

  if (isLoading) {
    return <div className="p-12 flex justify-center text-[var(--text-muted)]"><Loader2 className="h-8 w-8 animate-spin" /></div>;
  }
  if (!policy) {
    return <div className="p-12 text-center text-[var(--text-muted)]">Policy not found or access denied.</div>;
  }

  const latest = policy.draft || policy.current;
  return (
    <div className="max-w-5xl mx-auto py-8">
      <div className="mb-6">
        <Link href="/hr-policy-library" className="inline-flex items-center gap-2 text-[var(--text-sm)] font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)] mb-4">
          <ArrowLeft className="h-4 w-4" /> Back to Library
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[var(--text-3xl)] font-bold text-[var(--text-primary)]">{latest?.title}</h1>
            <p className="text-[var(--text-muted)] font-mono text-[var(--text-sm)] mt-1">{latest?.sourceReference}</p>
          </div>
          <StatusBadge version={latest} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-6">
          <DraftEditor
            policy={policy}
            text={displayVersion === editableVersion?.version ? versionDetail.data?.text : undefined}
            contentLoading={displayVersion === editableVersion?.version && versionDetail.isLoading}
            contentError={displayVersion === editableVersion?.version && versionDetail.isError}
            selectedForEditing={displayVersion === editableVersion?.version}
            onSaved={() => { setSelectedVersion(null); refetch(); }}
            capabilities={capabilities}
          />
          <VersionHistory
            versions={policy.all}
            selectedVersion={displayVersion}
            onSelect={setSelectedVersion}
            detail={versionDetail.data}
            loading={versionDetail.isLoading}
            denied={versionDetail.isError}
          />
        </div>
        <div className="space-y-6">
          <LifecycleActions policy={policy} onAction={() => { setSelectedVersion(null); refetch(); }} capabilities={capabilities} />
          <PolicyMetadata version={latest} />
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ version }: { version: PolicyVersion | undefined }) {
  if (!version) return null;
  const labels = {
    retired: [XCircle, 'Retired', 'bg-slate-100 text-slate-500'],
    superseded: [Clock, 'Superseded', 'bg-slate-100 text-slate-500'],
    in_review: [Clock, 'In Review', 'bg-amber-100 text-amber-700'],
    published: [CheckCircle, 'Published', 'bg-green-100 text-green-700'],
    draft: [Edit3, 'Draft', 'bg-slate-100 text-slate-600'],
  } as const;
  const [Icon, label, style] = labels[version.status];
  return <span className={`px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${style}`}><Icon className="h-4 w-4" /> {label}</span>;
}

function DraftEditor({ policy, text, contentLoading, contentError, selectedForEditing, onSaved, capabilities }: {
  policy: { id: string; current?: PolicyVersion; draft?: PolicyVersion };
  text: string | undefined;
  contentLoading: boolean;
  contentError: boolean;
  selectedForEditing: boolean;
  onSaved: () => void;
  capabilities: ReturnType<typeof usePolicyCapabilities>['data'];
}) {
  const editable = policy.draft || policy.current;
  const isReview = policy.draft?.status === 'in_review';
  const isRetired = policy.current?.status === 'retired' && !policy.draft;
  const canEdit = Boolean(selectedForEditing && capabilities?.canMaintain && editable && !isReview && !isRetired);
  const [title, setTitle] = useState('');
  const [sourceReference, setSourceReference] = useState('');
  const [policyText, setPolicyText] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [effectiveUntil, setEffectiveUntil] = useState('');
  const [reviewBy, setReviewBy] = useState('');
  const [audience, setAudience] = useState<PolicyMembershipRole[]>([]);
  const [reviewAuthorityRole, setReviewAuthorityRole] = useState<PolicyVersion['reviewAuthorityRole']>('hr-compliance');
  const [country, setCountry] = useState('');
  const [workerType, setWorkerType] = useState('');
  const [location, setLocation] = useState('');
  const { mutate: updateDraft, isPending } = useUpdateDraft(policy.id);
  const { toast } = useToast();

  // History returns metadata only. Populate editing state only from the
  // authorized version endpoint, including the actual stored text.
  useEffect(() => {
    if (!editable || text === undefined) return;
    setTitle(editable.title);
    setSourceReference(editable.sourceReference);
    setPolicyText(text);
    setEffectiveFrom(editable.effectiveFrom);
    setEffectiveUntil(editable.effectiveUntil ?? '');
    setReviewBy(editable.reviewBy ?? '');
    setAudience(editable.audience);
    setReviewAuthorityRole(editable.reviewAuthorityRole);
    setCountry(editable.applicability.country ?? '');
    setWorkerType(editable.applicability.workerType ?? '');
    setLocation(editable.applicability.location ?? '');
  }, [editable, text]);

  if (!editable) return null;
  const handleSave = () => {
    if (!policyText.trim() || !title.trim() || !sourceReference.trim() || audience.length === 0 || !effectiveFrom) return;
    const applicability = Object.fromEntries(
      Object.entries({ country, workerType, location }).filter(([, value]) => value.trim()),
    );
    updateDraft({
      expectedVersion: editable.version,
      title,
      sourceReference,
      text: policyText,
      audience: capabilities?.membershipRole
        ? [...new Set([...audience, capabilities.membershipRole])]
        : audience,
      applicability,
      effectiveFrom,
      effectiveUntil: effectiveUntil || undefined,
      reviewBy: reviewBy || undefined,
      reviewAuthorityRole,
    }, {
      onSuccess: () => {
        toast({ title: 'Draft saved', description: 'A new full replacement version was created.' });
        onSaved();
      },
      onError: (error: Error) => toast({ title: 'Unable to save draft', description: error.message, variant: 'destructive' }),
    });
  };

  return (
    <div className="bg-white rounded-xl border shadow-sm p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-[var(--text-lg)] font-bold flex items-center gap-2"><FileText className="h-5 w-5" /> Full policy version</h2>
          <p className="text-xs text-[var(--text-muted)] mt-1">Editing creates version {editable.version + 1}; the stored text is loaded only after source authorization.</p>
        </div>
        {canEdit && <button onClick={handleSave} disabled={isPending || contentLoading || contentError || !policyText.trim() || audience.length === 0} className="px-4 py-2 bg-[var(--primary)] text-white text-sm font-bold rounded-lg disabled:opacity-50 flex items-center gap-2">
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Edit3 className="h-4 w-4" />} Save full replacement
        </button>}
      </div>

      {!selectedForEditing ? <div className="p-4 rounded border bg-slate-50 text-sm text-[var(--text-muted)]">Viewing historical version metadata and any authorized source text below. Select the current editable version to create a full replacement.</div>
        : contentLoading ? <div className="py-12 flex justify-center text-[var(--text-muted)]"><Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading authorized version…</div>
        : contentError ? <div className="p-4 rounded border border-amber-200 bg-amber-50 text-sm text-amber-800">This version’s text is not available to your current authority. Metadata and provenance remain visible where permitted.</div>
        : <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Policy title"><input value={title} onChange={(e) => setTitle(e.target.value)} disabled={!canEdit} className={fieldClass} /></Field>
            <Field label="Source reference"><input value={sourceReference} onChange={(e) => setSourceReference(e.target.value)} disabled={!canEdit} className={`${fieldClass} font-mono`} /></Field>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <Field label="Effective from"><input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} disabled={!canEdit} className={fieldClass} /></Field>
            <Field label="Effective until"><input type="date" value={effectiveUntil} onChange={(e) => setEffectiveUntil(e.target.value)} disabled={!canEdit} className={fieldClass} /></Field>
            <Field label="Review by"><input type="date" value={reviewBy} onChange={(e) => setReviewBy(e.target.value)} disabled={!canEdit} className={fieldClass} /></Field>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <Field label="Country"><input value={country} onChange={(e) => setCountry(e.target.value)} disabled={!canEdit} className={fieldClass} /></Field>
            <Field label="Worker type"><input value={workerType} onChange={(e) => setWorkerType(e.target.value)} disabled={!canEdit} className={fieldClass} /></Field>
            <Field label="Location"><input value={location} onChange={(e) => setLocation(e.target.value)} disabled={!canEdit} className={fieldClass} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Review authority">
              <select value={reviewAuthorityRole} onChange={(e) => setReviewAuthorityRole(e.target.value as PolicyVersion['reviewAuthorityRole'])} disabled={!canEdit} className={fieldClass}>
                <option value="hr-compliance">HR Compliance</option><option value="legal">Legal</option><option value="occupational-health">Occupational Health</option><option value="payroll">Payroll</option>
              </select>
            </Field>
            <fieldset><legend className="block text-sm font-semibold mb-1.5 text-[var(--text-secondary)]">Visibility audience</legend>
              <div className={`${fieldClass} flex gap-3 items-center`}>
                {(['member', 'admin', 'owner'] as PolicyMembershipRole[]).map((role) => <label key={role} className="flex gap-1.5 items-center text-sm capitalize"><input type="checkbox" disabled={!canEdit || role === capabilities?.membershipRole} checked={audience.includes(role)} onChange={(e) => setAudience((current) => e.target.checked ? [...new Set([...current, role])] : current.filter((item) => item !== role))} />{role}{role === capabilities?.membershipRole ? ' (you)' : ''}</label>)}
              </div>
            </fieldset>
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1.5 text-[var(--text-secondary)]">Policy text (full replacement)</label>
            <textarea value={policyText} onChange={(e) => setPolicyText(e.target.value)} disabled={!canEdit} maxLength={40000} className="w-full h-64 p-4 rounded-xl border focus:border-[var(--primary)] outline-none font-serif resize-y disabled:bg-slate-50" />
            <p className="text-xs text-[var(--text-muted)] mt-2 flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" /> The complete current text is submitted with every edit; partial patches are not supported.</p>
          </div>
        </div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="block text-sm font-semibold mb-1.5 text-[var(--text-secondary)]">{label}</label>{children}</div>;
}

function LifecycleActions({ policy, onAction, capabilities }: {
  policy: { id: string; current?: PolicyVersion; draft?: PolicyVersion; all: PolicyVersion[] };
  onAction: () => void;
  capabilities: ReturnType<typeof usePolicyCapabilities>['data'];
}) {
  const { toast } = useToast();
  const { mutate: submitReview, isPending: submitting } = useSubmitReview(policy.id);
  const { mutate: reviewPolicy, isPending: reviewing } = useReviewPolicy(policy.id);
  const { mutate: publishPolicy, isPending: publishing } = usePublishPolicy(policy.id);
  const { mutate: supersedePolicy, isPending: superseding } = useSupersedePolicy(policy.id);
  const { mutate: retirePolicy, isPending: retiring } = useRetirePolicy(policy.id);
  const [reviewReference, setReviewReference] = useState('');
  const [publicationReference, setPublicationReference] = useState('');
  const [replacementVersion, setReplacementVersion] = useState('');
  const { userId } = usePolicyScope();
  const draft = policy.draft;
  const current = policy.current;
  const hasSpecialistAuthority = (version: PolicyVersion | undefined) => Boolean(version && capabilities?.reviewAuthorityRoles.some((role) => role.role === version.reviewAuthorityRole && role.current));
  // A rejected version retains its review outcome. The API requires a new
  // successor revision rather than resubmitting that exact rejected version.
  const requiresSuccessor = draft?.status === 'draft' && draft.reviewOutcome === 'rejected';
  const canSubmit = Boolean(capabilities?.canMaintain && draft?.status === 'draft' && draft.reviewOutcome !== 'rejected');
  const canReview = Boolean(draft?.status === 'in_review' && draft.reviewOutcome === null && draft.createdByUserId !== userId && hasSpecialistAuthority(draft));
  const canPublish = Boolean(draft?.status === 'in_review' && draft.reviewOutcome === 'approved' && hasSpecialistAuthority(draft));
  const canRetire = Boolean(current && ['published', 'superseded'].includes(current.status) && hasSpecialistAuthority(current));
  const replacements = current?.status === 'published' ? policy.all.filter((version) => version.status === 'published' && version.version > current.version) : [];
  const canSupersede = Boolean(current?.status === 'published' && hasSpecialistAuthority(current) && replacements.length);
  const act = (mutation: (data: any, callbacks: any) => void, data: unknown) => mutation(data, {
    onSuccess: () => { toast({ title: 'Policy updated', description: 'The governed lifecycle change was recorded.' }); onAction(); },
    onError: (error: Error) => toast({ title: 'Policy action failed', description: error.message, variant: 'destructive' }),
  });

  return <div className="bg-white rounded-xl border shadow-sm p-6 flex flex-col gap-3">
    <h3 className="font-bold text-lg border-b pb-3">Lifecycle</h3>
    {requiresSuccessor && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Version {draft!.version} was rejected. Save a full successor revision before submitting it for review again.</p>}
    {canSubmit && <button onClick={() => act(submitReview, { expectedVersion: draft!.version })} disabled={submitting} className={`${actionButtonClass} bg-indigo-50 text-indigo-700 border-indigo-200`}>{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}Submit for review</button>}
    {canReview && <><input value={reviewReference} onChange={(e) => setReviewReference(e.target.value)} placeholder="Reviewer verification reference" className={`${fieldClass} text-sm`} />
      <button onClick={() => act(reviewPolicy, { version: draft!.version, outcome: 'approved', verificationReference: reviewReference })} disabled={reviewing || !reviewReference.trim()} className={`${actionButtonClass} bg-emerald-50 text-emerald-700 border-emerald-200`}><CheckCircle className="h-4 w-4" />Approve version {draft!.version}</button>
      <button onClick={() => act(reviewPolicy, { version: draft!.version, outcome: 'rejected', verificationReference: reviewReference })} disabled={reviewing || !reviewReference.trim()} className={`${actionButtonClass} bg-red-50 text-red-700 border-red-200`}><XCircle className="h-4 w-4" />Reject version {draft!.version}</button></>}
    {canPublish && <><input value={publicationReference} onChange={(e) => setPublicationReference(e.target.value)} placeholder="Publication verification reference" className={`${fieldClass} text-sm`} />
      <button onClick={() => act(publishPolicy, { expectedVersion: draft!.version, publicationVerificationReference: publicationReference })} disabled={publishing || !publicationReference.trim()} className={`${actionButtonClass} bg-green-50 text-green-700 border-green-200`}><CheckCircle className="h-4 w-4" />Publish version {draft!.version}</button></>}
    {canSupersede && <><select value={replacementVersion} onChange={(e) => setReplacementVersion(e.target.value)} className={`${fieldClass} text-sm`}><option value="">Select published replacement</option>{replacements.map((version) => <option key={version.version} value={version.version}>Version {version.version}</option>)}</select>
      <button onClick={() => act(supersedePolicy, { version: current!.version, replacementVersion: Number(replacementVersion) })} disabled={superseding || !replacementVersion} className={`${actionButtonClass} bg-amber-50 text-amber-700 border-amber-200`}><Clock className="h-4 w-4" />Supersede version {current!.version}</button></>}
    {current?.status === 'published' && hasSpecialistAuthority(current) && !replacements.length && <p className="text-xs text-[var(--text-muted)]">A later published version of this source is required before version {current.version} can be superseded.</p>}
    {canRetire && <button onClick={() => act(retirePolicy, { version: current!.version })} disabled={retiring} className={`${actionButtonClass} bg-red-50 text-red-700 border-red-200`}>{retiring ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}Retire version {current!.version}</button>}
    {!canSubmit && !canReview && !canPublish && !canSupersede && !canRetire && <p className="text-sm text-[var(--text-muted)] text-center py-2">No lifecycle actions available for your current verified authority and policy state.</p>}
  </div>;
}

function VersionHistory({ versions, selectedVersion, onSelect, detail, loading, denied }: {
  versions: PolicyVersion[];
  selectedVersion: number | null;
  onSelect: (version: number) => void;
  detail: { policy: PolicyVersion; text: string } | undefined;
  loading: boolean;
  denied: boolean;
}) {
  return <div className="bg-white rounded-xl border shadow-sm p-6">
    <h2 className="font-bold text-lg mb-4">Version history &amp; provenance</h2>
    <div className="space-y-3">{versions.map((version) => <button type="button" key={version.version} onClick={() => onSelect(version.version)} className={`w-full text-left rounded-lg border p-3 hover:border-[var(--primary)] ${selectedVersion === version.version ? 'border-[var(--primary)] bg-indigo-50/40' : ''}`}>
      <div className="flex items-center justify-between gap-3"><span className="font-semibold">Version {version.version} — {version.title}</span><StatusBadge version={version} /></div>
      <p className="mt-2 text-xs text-[var(--text-muted)]">Created {formatDate(version.createdAt)} by {version.createdByUserId} · Updated {formatDate(version.updatedAt)}</p>
      <p className="mt-1 text-xs text-[var(--text-muted)]">Review: {version.reviewOutcome ?? 'not decided'}{version.reviewedByUserId ? ` by ${version.reviewedByUserId}` : ''}{version.reviewerVerificationReference ? ` · ${version.reviewerVerificationReference}` : ''}</p>
      <p className="mt-1 text-xs text-[var(--text-muted)]">Published: {version.publishedAt ? `${formatDate(version.publishedAt)} by ${version.publisherUserId ?? 'unknown'} · ${version.publicationVerificationReference ?? 'no reference'}` : 'not published'} · Retired: {version.retiredAt ? formatDate(version.retiredAt) : 'not retired'}</p>
    </button>)}</div>
    <div className="mt-4 rounded-lg border bg-slate-50 p-4">
      <p className="text-xs font-bold uppercase tracking-wide text-[var(--text-muted)] mb-2">Authorized source text for selected version</p>
      {loading ? <p className="text-sm text-[var(--text-muted)]">Checking source permission…</p>
        : denied ? <p className="text-sm text-amber-800">Source text is not available to your current membership and authority.</p>
          : detail ? <p className="whitespace-pre-wrap text-sm font-serif text-slate-800">{detail.text}</p>
            : <p className="text-sm text-[var(--text-muted)]">Select a version to request its authorized source text.</p>}
    </div>
    <p className="mt-3 text-xs text-[var(--text-muted)]">The server independently authorizes every version request. Citation excerpts are requested only from the citation endpoint and are never reconstructed from history metadata.</p>
  </div>;
}

function PolicyMetadata({ version }: { version: PolicyVersion | undefined }) {
  if (!version) return null;
  return <div className="bg-white rounded-xl border shadow-sm p-6 flex flex-col gap-4">
    <h3 className="font-bold text-lg border-b pb-3">Applicability</h3>
    <div><p className="text-xs font-bold uppercase text-[var(--text-muted)] mb-2">Audience</p><div className="flex flex-wrap gap-2">{version.audience.map((role) => <span key={role} className="px-2 py-1 rounded bg-slate-100 text-slate-700 text-xs font-semibold flex items-center gap-1"><Shield className="h-3 w-3" /> {role}</span>)}</div></div>
    <div><p className="text-xs font-bold uppercase text-[var(--text-muted)] mb-2">Selected attributes</p>{Object.keys(version.applicability).length ? <div className="flex flex-col gap-1 text-sm">{Object.entries(version.applicability).map(([key, value]) => <span key={key}><b>{key}:</b> {value}</span>)}</div> : <span className="text-sm text-[var(--text-muted)]">No restricted attributes</span>}</div>
    <div className="pt-2 border-t"><p className="text-xs font-bold uppercase text-[var(--text-muted)] mb-2">Review authority</p><span className="text-sm font-semibold">{version.reviewAuthorityRole}</span></div>
  </div>;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}