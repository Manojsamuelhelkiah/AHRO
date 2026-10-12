import React, { useState, useMemo } from 'react';
import {
  usePolicies, useHandoffs, useCreatePolicy, useResolveHandoff, usePolicyCapabilities, usePolicyScope,
  type PolicyMembershipRole, type PolicyReviewAuthorityRole, type PolicyVersion,
} from '../../hooks/use-policies';
import { Link, useLocation } from 'wouter';
import { Plus, BookOpen, CheckCircle, ShieldAlert, ArrowRight, Loader2, Shield } from 'lucide-react';
import { useToast } from '../../hooks/use-toast';
import { PolicyReminders } from './reminders';
import { PolicyDocumentImport } from './document-import';

export function HrPolicyLibraryIndexPage() {
  const scope = usePolicyScope();
  const policiesQuery = usePolicies();
  const capabilitiesQuery = usePolicyCapabilities();
  // Do not continue to render a successful capability/list result after its
  // mandatory revalidation has reported revoked/forbidden access.
  const policies = policiesQuery.isError ? undefined : policiesQuery.data;
  const capabilities = capabilitiesQuery.isError ? undefined : capabilitiesQuery.data;
  const loadingPolicies = policiesQuery.isLoading;
  const { data: handoffs, isLoading: loadingHandoffs } = useHandoffs(Boolean(capabilities?.canResolveHandoffs));
  const [activeTab, setActiveTab] = useState<'policies' | 'inbox'>('policies');

  // Group versions by policyId to show one card per policy
  const groupedPolicies = useMemo(() => {
    if (!policies) return [];
    const map = new Map<string, { current?: PolicyVersion; draft?: PolicyVersion }>();
    for (const p of policies) {
      if (!map.has(p.policyId)) map.set(p.policyId, {});
      const entry = map.get(p.policyId)!;
      if (p.status === 'published' || p.status === 'superseded' || p.status === 'retired') {
        if (!entry.current || entry.current.version < p.version) entry.current = p;
      } else {
        if (!entry.draft || entry.draft.version < p.version) entry.draft = p;
      }
    }
    return Array.from(map.values()).map(g => ({
      id: (g.current || g.draft)!.policyId,
      currentVersion: g.current,
      draftVersion: g.draft,
      displayVersion: g.draft || g.current!
    }));
  }, [policies]);

  return (
    <div className="max-w-6xl mx-auto py-8">
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-[var(--text-3xl)] font-bold text-[var(--text-primary)]">HR Policy Library</h1>
          <p className="text-[var(--text-muted)] text-[var(--text-base)] mt-1">
            Maintain authorized HR policy sources and review clarification requests.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-6 border-b border-[var(--border)] mb-6">
        <button
          onClick={() => setActiveTab('policies')}
          className={`pb-3 text-[var(--text-sm)] font-bold uppercase tracking-wider transition-colors ${
            activeTab === 'policies' 
              ? 'border-b-2 border-[var(--primary)] text-[var(--primary)]' 
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
          }`}
        >
          Policy Sources
        </button>
        <button
          onClick={() => setActiveTab('inbox')}
          className={`pb-3 text-[var(--text-sm)] font-bold uppercase tracking-wider transition-colors flex items-center gap-2 ${
            activeTab === 'inbox' 
              ? 'border-b-2 border-[var(--primary)] text-[var(--primary)]' 
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
          }`}
        >
          Handoff Inbox
          {handoffs && handoffs.filter(h => h.status === 'open').length > 0 && (
            <span className="bg-[var(--status-red)] text-white text-[10px] px-1.5 py-0.5 rounded-full">
              {handoffs.filter(h => h.status === 'open').length}
            </span>
          )}
        </button>
      </div>

      {activeTab === 'policies' && (
        <div className="flex flex-col gap-6">
          {capabilities?.canMaintain && <PolicyReminders />}
          {capabilities?.canMaintain && (
            <div className="flex justify-end">
              <CreatePolicyDialog key={`${scope.organizationId}:${scope.userId}`} membershipRole={capabilities.membershipRole} />
            </div>
          )}
          
          {loadingPolicies ? (
            <div className="flex items-center justify-center p-12 text-[var(--text-muted)]">
              <Loader2 className="h-6 w-6 animate-spin mr-2" /> Loading library...
            </div>
          ) : policiesQuery.isError ? (
            <div className="bg-white rounded-xl border p-12 text-center text-[var(--text-muted)]">
              Policy sources could not be loaded with your current tenant membership. Refresh after access is restored.
            </div>
          ) : groupedPolicies.length === 0 ? (
            <div className="bg-white rounded-xl border border-dashed border-[var(--border-strong)] p-12 flex flex-col items-center justify-center text-center">
              <BookOpen className="h-12 w-12 text-[var(--text-muted)] mb-4 opacity-50" />
              <h3 className="text-[var(--text-lg)] font-bold text-[var(--text-primary)] mb-1">No policies found</h3>
              <p className="text-[var(--text-sm)] text-[var(--text-muted)] max-w-md">
                Create your first governed HR policy source to enable the Policy Assistant.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {groupedPolicies.map(policy => (
                <PolicyCard key={policy.id} group={policy} />
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'inbox' && (
        <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
          {!capabilities?.canResolveHandoffs ? (
            <div className="p-12 flex flex-col items-center justify-center text-center">
              <Shield className="h-12 w-12 text-[var(--text-muted)] mb-4 opacity-60" />
              <h3 className="text-[var(--text-lg)] font-bold text-[var(--text-primary)] mb-1">Specialist access required</h3>
              <p className="text-[var(--text-sm)] text-[var(--text-muted)]">Only a current verified handoff resolver can view and resolve clarification requests.</p>
            </div>
          ) : loadingHandoffs ? (
            <div className="flex items-center justify-center p-12 text-[var(--text-muted)]">
              <Loader2 className="h-6 w-6 animate-spin mr-2" /> Loading handoffs...
            </div>
          ) : !handoffs || handoffs.length === 0 ? (
            <div className="p-12 flex flex-col items-center justify-center text-center">
              <CheckCircle className="h-12 w-12 text-[var(--status-green)] mb-4 opacity-70" />
              <h3 className="text-[var(--text-lg)] font-bold text-[var(--text-primary)] mb-1">Inbox Zero</h3>
              <p className="text-[var(--text-sm)] text-[var(--text-muted)]">All policy clarification requests have been resolved.</p>
            </div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {handoffs.map(handoff => (
                <HandoffRow key={handoff.id} handoff={handoff} canResolve={!!capabilities?.canResolveHandoffs} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PolicyCard({ group }: { group: any }) {
  const p = group.displayVersion as PolicyVersion;
  const isPending = group.draftVersion?.status === 'in_review';
  const isActive = group.currentVersion?.status === 'published';
  const isRetired = group.currentVersion?.status === 'retired';

  let statusColor = 'bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)]';
  let statusText = 'Draft';

  if (isRetired) {
    statusColor = 'bg-slate-100 text-slate-500';
    statusText = 'Retired';
  } else if (isPending) {
    statusColor = 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]';
    statusText = 'In Review';
  } else if (isActive) {
    statusColor = 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]';
    statusText = 'Published';
  }

  return (
    <Link href={`/hr-policy-library/${group.id}`}>
      <div className="bg-white rounded-xl border p-5 hover:border-[var(--primary)] hover:shadow-md transition-all cursor-pointer group flex flex-col h-full">
        <div className="flex items-start justify-between mb-4">
          <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-md ${statusColor}`}>
            {statusText}
          </span>
          <ArrowRight className="h-4 w-4 text-[var(--text-muted)] group-hover:text-[var(--primary)] group-hover:translate-x-0.5 transition-all" />
        </div>
        
        <h3 className="font-bold text-[var(--text-lg)] mb-1 group-hover:text-[var(--primary)] transition-colors">{p.title}</h3>
        <p className="text-[var(--text-xs)] text-[var(--text-muted)] font-mono mb-4">{p.sourceReference}</p>
        
        <div className="mt-auto pt-4 border-t border-[var(--border)] flex flex-wrap gap-2">
          {p.applicability?.country && (
            <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded uppercase font-bold tracking-wider">{p.applicability.country}</span>
          )}
          {p.applicability?.workerType && (
            <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-semibold">{p.applicability.workerType}</span>
          )}
        </div>
      </div>
    </Link>
  );
}

function HandoffRow({ handoff, canResolve }: { handoff: any; canResolve: boolean }) {
  const { mutate: resolveHandoff, isPending } = useResolveHandoff();
  const { toast } = useToast();
  const [resolution, setResolution] = useState('');

  const handleResolve = () => {
    if (!resolution.trim()) {
      toast({ title: 'Resolution required', description: 'Enter the resolution that will be stored with this handoff.', variant: 'destructive' });
      return;
    }
    resolveHandoff({ handoffId: handoff.id, resolution }, {
      onSuccess: () => {
        toast({ title: 'Resolved', description: 'Handoff request marked as resolved.' });
      },
      onError: (err) => {
        toast({ title: 'Error', description: err.message, variant: 'destructive' });
      }
    });
  };

  return (
    <div className={`p-4 flex items-start gap-4 transition-colors ${handoff.status === 'resolved' ? 'bg-slate-50 opacity-60' : 'hover:bg-slate-50'}`}>
      <ShieldAlert className={`h-5 w-5 mt-1 shrink-0 ${handoff.status === 'resolved' ? 'text-slate-400' : 'text-amber-500'}`} />
      <div className="flex-1 min-w-0">
        <p className="text-[var(--text-sm)] font-medium text-[var(--text-primary)] mb-1">"{handoff.question}"</p>
        <div className="flex flex-wrap gap-2 text-[var(--text-xs)] text-[var(--text-muted)]">
          <span>Date: {handoff.appliesOn}</span>
          {handoff.applicability?.country && <span>• {handoff.applicability.country}</span>}
          {handoff.applicability?.workerType && <span>• {handoff.applicability.workerType}</span>}
        </div>
         <p className="mt-2 text-[var(--text-xs)] text-[var(--text-muted)]">
           Requested {formatDate(handoff.createdAt)} by {handoff.requesterUserId}
           {handoff.status === 'resolved' && ` · Resolved ${handoff.resolvedAt ? formatDate(handoff.resolvedAt) : 'at an unknown time'} by ${handoff.resolvedByUserId ?? 'unknown'}`}
         </p>
         {handoff.status === 'resolved' && handoff.resolution && (
           <p className="mt-1 text-[var(--text-xs)] text-slate-700"><b>Resolution:</b> {handoff.resolution}</p>
         )}
      </div>
       {handoff.status === 'open' && canResolve && (
         <div className="shrink-0 flex flex-col gap-2 w-56">
           <input
             value={resolution}
             onChange={(event) => setResolution(event.target.value)}
             maxLength={4000}
             placeholder="Resolution (required)"
             aria-label={`Resolution for handoff ${handoff.id}`}
             className="h-9 px-2 rounded border text-xs"
           />
           <button
             onClick={handleResolve}
             disabled={isPending || !resolution.trim()}
             className="text-[var(--text-xs)] font-bold text-[var(--primary)] hover:bg-[var(--primary-light)] px-3 py-1.5 rounded-lg transition-colors border border-transparent hover:border-[var(--primary-light-bg)] disabled:opacity-50"
           >
             {isPending ? 'Resolving...' : 'Resolve handoff'}
           </button>
         </div>
      )}
       {handoff.status === 'resolved' && (
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-slate-400 border border-slate-200 px-2 py-1 rounded-md">
          Resolved
        </span>
      )}
    </div>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function CreatePolicyDialog({ membershipRole }: { membershipRole: PolicyMembershipRole }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [sourceReference, setSourceReference] = useState('');
  const [text, setText] = useState('');
  const [importId, setImportId] = useState<string>();
  const [importBusy, setImportBusy] = useState(false);
  const [importBlocked, setImportBlocked] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().split('T')[0]);
  const [effectiveUntil, setEffectiveUntil] = useState('');
  const [reviewBy, setReviewBy] = useState('');
  const [reviewAuthorityRole, setReviewAuthorityRole] = useState<PolicyReviewAuthorityRole>('hr-compliance');
  // The actor must remain in a policy's audience under the current API rule.
  const [audience, setAudience] = useState<PolicyMembershipRole[]>([membershipRole]);
  const [country, setCountry] = useState('');
  const [workerType, setWorkerType] = useState('');
  const [policyLocation, setPolicyLocation] = useState('');
  
  const { mutate: createPolicy, isPending } = useCreatePolicy();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (importBusy || importBlocked || isPending) return;
    createPolicy(
      { 
        title, 
        importId,
        sourceReference,
        text,
        audience: [...new Set([...audience, membershipRole])],
        // An explicit empty object means global applicability; there are no
        // hidden country or worker-type defaults.
        applicability: Object.fromEntries(
          Object.entries({ country, workerType, location: policyLocation }).filter(([, value]) => value.trim()),
        ),
        effectiveFrom,
        effectiveUntil: effectiveUntil || undefined,
        reviewBy: reviewBy || undefined,
        reviewAuthorityRole
      },
      {
        onSuccess: (data) => {
          setOpen(false);
          setImportId(undefined);
          setText('');
          if (data && data.policy) {
            setLocation(`/hr-policy-library/${data.policy.policyId}`);
          }
        },
        onError: (err) => {
          toast({ title: 'Error', description: err.message, variant: 'destructive' });
        }
      }
    );
  };

  return (
    <>
      <button 
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-4 py-2 bg-[var(--primary)] text-white rounded-lg font-bold text-[var(--text-sm)] hover:bg-[var(--primary-dark)] transition-colors shadow-sm"
      >
        <Plus className="h-4 w-4" /> New Policy
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl p-6 animate-in zoom-in-95 my-auto max-h-[90vh] flex flex-col">
            <h2 className="font-bold text-[var(--text-xl)] mb-1">Create Policy Source</h2>
            <p className="text-[var(--text-sm)] text-[var(--text-muted)] mb-6">Initialize a new versioned HR policy.</p>
            
            <form onSubmit={handleSubmit} className="flex flex-col gap-4 overflow-y-auto flex-1 pr-2">
              <PolicyDocumentImport
                onBusy={setImportBusy}
                onExtracted={(extracted, id) => { setText(extracted); setImportId(id); setImportBlocked(false); }}
                onClear={() => { setText(''); setImportId(undefined); setImportBlocked(false); }}
                onBlocked={() => { setText(''); setImportId(undefined); setImportBlocked(true); }}
              />
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[var(--text-sm)] font-semibold mb-1.5">Policy Title</label>
                  <input type="text" value={title} onChange={e => setTitle(e.target.value)} required placeholder="e.g. Global Leave Policy" className="w-full h-10 px-3 rounded-lg border focus:border-[var(--primary)] outline-none" />
                </div>
                <div>
                  <label className="block text-[var(--text-sm)] font-semibold mb-1.5">Source Reference ID</label>
                  <input type="text" value={sourceReference} onChange={e => setSourceReference(e.target.value)} required placeholder="e.g. HR-POL-001" className="w-full h-10 px-3 rounded-lg border focus:border-[var(--primary)] outline-none font-mono text-sm" />
                </div>
              </div>
              
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-[var(--text-sm)] font-semibold mb-1.5">Effective From</label>
                  <input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} required className="w-full h-10 px-3 rounded-lg border focus:border-[var(--primary)] outline-none" />
                </div>
                <div>
                  <label className="block text-[var(--text-sm)] font-semibold mb-1.5">Effective Until <span className="text-slate-400 font-normal">(Optional)</span></label>
                  <input type="date" value={effectiveUntil} onChange={e => setEffectiveUntil(e.target.value)} className="w-full h-10 px-3 rounded-lg border focus:border-[var(--primary)] outline-none" />
                </div>
                <div>
                  <label className="block text-[var(--text-sm)] font-semibold mb-1.5">Review By <span className="text-slate-400 font-normal">(Optional)</span></label>
                  <input type="date" value={reviewBy} onChange={e => setReviewBy(e.target.value)} className="w-full h-10 px-3 rounded-lg border focus:border-[var(--primary)] outline-none" />
                </div>
              </div>

               <fieldset>
                 <legend className="block text-[var(--text-sm)] font-semibold mb-1.5">Applicability <span className="text-slate-400 font-normal">(optional)</span></legend>
                 <p className="text-xs text-[var(--text-muted)] mb-2">Leave every field blank for a global policy. Blank values are submitted as an explicit empty applicability object.</p>
                 <div className="grid grid-cols-3 gap-4">
                   <div>
                     <label className="block text-xs font-semibold mb-1">Country</label>
                     <input value={country} onChange={(event) => setCountry(event.target.value)} maxLength={160} placeholder="e.g. USA" className="w-full h-10 px-3 rounded-lg border focus:border-[var(--primary)] outline-none" />
                   </div>
                   <div>
                     <label className="block text-xs font-semibold mb-1">Worker type</label>
                     <input value={workerType} onChange={(event) => setWorkerType(event.target.value)} maxLength={160} placeholder="e.g. Full-Time" className="w-full h-10 px-3 rounded-lg border focus:border-[var(--primary)] outline-none" />
                   </div>
                   <div>
                     <label className="block text-xs font-semibold mb-1">Location</label>
                     <input value={policyLocation} onChange={(event) => setPolicyLocation(event.target.value)} maxLength={160} placeholder="e.g. London" className="w-full h-10 px-3 rounded-lg border focus:border-[var(--primary)] outline-none" />
                   </div>
                 </div>
               </fieldset>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[var(--text-sm)] font-semibold mb-1.5">Review Authority Role</label>
                  <select value={reviewAuthorityRole} onChange={e => setReviewAuthorityRole(e.target.value as PolicyReviewAuthorityRole)} className="w-full h-10 px-3 rounded-lg border focus:border-[var(--primary)] outline-none">
                    <option value="hr-compliance">HR Compliance</option>
                    <option value="legal">Legal</option>
                    <option value="occupational-health">Occupational Health</option>
                    <option value="payroll">Payroll</option>
                  </select>
                </div>
                <fieldset>
                  <label className="block text-[var(--text-sm)] font-semibold mb-1.5">Visibility Audience</label>
                  <div className="flex flex-wrap gap-3 min-h-10 items-center rounded-lg border px-3">
                    {(['member', 'admin', 'owner'] as PolicyMembershipRole[]).map((role) => (
                      <label key={role} className="flex items-center gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          checked={audience.includes(role)}
                          disabled={role === membershipRole}
                          onChange={(event) => setAudience((current) => event.target.checked
                            ? [...new Set([...current, role])]
                            : current.filter((item) => item !== role))}
                        />
                        {role === 'member' ? 'Members' : role === 'admin' ? 'Admins' : 'Owners'}{role === membershipRole ? ' (you)' : ''}
                      </label>
                    ))}
                  </div>
                  {audience.length === 0 && <p className="mt-1 text-xs text-red-600">Select at least one membership role.</p>}
                </fieldset>
              </div>

              <div>
                <label className="block text-[var(--text-sm)] font-semibold mb-1.5">Initial Curated Text</label>
                <textarea 
                  value={text} 
                  onChange={e => setText(e.target.value)} 
                  required 
                  maxLength={40000}
                  placeholder="Paste policy text or correct the extracted text. This remains an unapproved draft."
                  className="w-full h-40 p-3 rounded-lg border focus:border-[var(--primary)] outline-none resize-none font-serif"
                />
              </div>

              <div className="flex justify-end gap-3 mt-4 pt-4 border-t">
                <button type="button" disabled={importBusy || isPending} onClick={() => { setOpen(false); setImportId(undefined); setText(''); setImportBlocked(false); }} className="px-4 py-2 rounded-lg font-semibold text-slate-600 hover:bg-slate-100">Cancel</button>
                 <button type="submit" disabled={isPending || importBusy || importBlocked || !title || !sourceReference || !text || audience.length === 0} className="px-4 py-2 rounded-lg font-semibold bg-[var(--primary)] text-white hover:bg-[var(--primary-dark)] disabled:opacity-50 flex items-center gap-2">
                  {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Create Policy Draft
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
