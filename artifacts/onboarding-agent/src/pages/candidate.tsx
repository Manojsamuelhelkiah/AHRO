import { useEffect, useState, type ReactNode } from 'react';
import { CalendarDays, FileUp, Monitor, Upload, ExternalLink, CheckCircle2, AlertCircle, Loader2, Clock } from 'lucide-react';

type Portal = {
  case: { workerName: string; role: string; department: string; joiningDate: string };
  logistics: null | Record<string, string | null>;
  documents: Array<{
    id: number;
    label: string;
    required: boolean;
    status: string;
    note?: string | null;
    validationState: 'queued' | 'processing' | 'passed' | 'manual_review' | 'correction_requested' | 'rejected' | null;
    correctionGuidance: string | null;
  }>;
};

export function CandidatePage() {
  const [portal, setPortal] = useState<Portal | null>(null);
  const [error, setError] = useState('');
  const [docErrors, setDocErrors] = useState<Record<number, string>>({});
  const [uploading, setUploading] = useState<number | null>(null);

  const load = async () => {
    const response = await fetch('/api/candidate/portal', { credentials: 'include' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || 'This portal link is invalid or has expired');
    setPortal(body);
  };

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    (async () => {
      if (token) {
        const response = await fetch('/api/candidate/session', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.message || 'This portal link is invalid or has expired');
        }
      }
      await load();
    })().catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to open portal'));
  }, []);

  const validationPending = portal?.documents.some(
    (doc) => doc.validationState === 'queued' || doc.validationState === 'processing',
  ) ?? false;

  useEffect(() => {
    if (!validationPending) return;
    const timer = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [validationPending]);

  const upload = async (documentId: number, file?: File) => {
    if (!file) return;

    // Preflight checks
    if (file.size === 0) {
      setDocErrors(prev => ({ ...prev, [documentId]: 'File is empty.' }));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setDocErrors(prev => ({ ...prev, [documentId]: 'File exceeds the 10MB limit.' }));
      return;
    }
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) {
      setDocErrors(prev => ({ ...prev, [documentId]: 'Only PDF, JPEG, and PNG files are allowed.' }));
      return;
    }

    setDocErrors(prev => ({ ...prev, [documentId]: '' }));
    setError(''); setUploading(documentId);
    try {
      const response = await fetch(`/api/candidate/documents/${documentId}/upload`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': file.name, 'x-file-type': file.type },
        body: file,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || 'Upload failed');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Upload failed');
    } finally { setUploading(null); }
  };

  if (error && !portal) {
    return (
      <main className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
          <AlertCircle className="mx-auto h-8 w-8 text-red-500 mb-3" />
          <h1 className="text-base font-semibold text-slate-900">Portal Unavailable</h1>
          <p role="alert" className="mt-2 text-sm text-slate-600">{error}</p>
        </div>
      </main>
    );
  }

  if (!portal) {
    return (
      <main className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="flex items-center gap-3 text-sm font-medium text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin text-indigo-600" />
          Opening secure portal...
        </div>
      </main>
    );
  }

  const l = portal.logistics;
  return (
    <main className="min-h-screen bg-slate-50/50 pb-12">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur-md">
        <div className="mx-auto max-w-4xl px-4 py-3 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-base font-bold text-slate-900 tracking-tight">{portal.case.workerName}</h1>
            <p className="text-xs font-medium text-slate-500">{portal.case.role} &middot; {portal.case.department}</p>
          </div>
          <div className="flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-600/10">
            Onboarding Portal
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-4xl gap-4 px-4 pt-6 md:grid-cols-[280px_1fr] items-start">
        <section className="rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden md:sticky md:top-20">
          <div className="border-b border-slate-100 bg-slate-50/50 px-4 py-2.5">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-2">
              <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
              Day-1 Logistics
            </h2>
          </div>

          <div className="p-4">
            {!l ? (
              <p className="text-xs text-slate-500 italic">Your joining details will appear here once finalized.</p>
            ) : (
              <dl className="space-y-4">
                <Log label="Date & Time" value={`${l.orientationDate || portal.case.joiningDate}${l.orientationTime ? ` at ${l.orientationTime}` : ''} ${l.timezone || ''}`.trim()} />
                <Log label="Format" value={l.format} />
                <Log label="Venue" value={l.venueAddress} link={l.googleMapsUrl} />
                <Log label="Reporting Contact" value={l.reportingContact} />

                {l.meetingUrl && (
                  <div className="pt-2">
                    <a className="flex w-full items-center justify-center gap-2 rounded bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-700 transition-colors shadow-sm" href={l.meetingUrl} target="_blank" rel="noreferrer">
                      <Monitor className="h-3.5 w-3.5" />
                      Join Virtual Meeting
                    </a>
                  </div>
                )}

                {l.arrivalInstructions && (
                  <div className="rounded bg-slate-50 p-2.5 border border-slate-100 mt-2">
                    <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Instructions</dt>
                    <dd className="whitespace-pre-wrap text-xs text-slate-700 leading-relaxed">{l.arrivalInstructions}</dd>
                  </div>
                )}
              </dl>
            )}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-slate-100 bg-slate-50/50 px-4 py-2.5 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-2">
              <FileUp className="h-3.5 w-3.5 text-slate-400" />
              Required Documents
            </h2>
            <span className="text-[11px] font-medium text-slate-500">PDF, JPG, PNG (Max 10MB)</span>
          </div>

          {error && (
            <div className="border-b border-red-100 bg-red-50 p-3 text-xs font-medium text-red-800 flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
              {error}
            </div>
          )}

          <div className="divide-y divide-slate-100">
            {portal.documents.length === 0 && (
              <div className="p-8 text-center text-sm text-slate-500">No documents required at this time.</div>
            )}

            {portal.documents.map((doc) => {
              const vs = doc.validationState;
              let label: string | null = vs;
              let bgColor = 'bg-slate-50';
              let textColor = 'text-slate-700';
              let ringColor = 'ring-slate-600/20';
              let icon = null;

              if (vs === 'queued' || vs === 'processing') {
                label = 'Validating...';
                bgColor = 'bg-blue-50'; textColor = 'text-blue-700'; ringColor = 'ring-blue-600/20';
                icon = <Loader2 className="h-3 w-3 animate-spin" />;
              } else if (vs === 'passed') {
                label = 'Verified';
                bgColor = 'bg-green-50'; textColor = 'text-green-700'; ringColor = 'ring-green-600/20';
                icon = <CheckCircle2 className="h-3 w-3" />;
              } else if (vs === 'correction_requested') {
                label = 'Correction Required';
                bgColor = 'bg-amber-50'; textColor = 'text-amber-700'; ringColor = 'ring-amber-600/20';
                icon = <AlertCircle className="h-3 w-3" />;
              } else if (vs === 'manual_review') {
                label = 'Under HR Review';
                bgColor = 'bg-amber-50'; textColor = 'text-amber-700'; ringColor = 'ring-amber-600/20';
                icon = <Clock className="h-3 w-3" />;
              } else if (vs === 'rejected') {
                label = 'Rejected — HR review required';
                bgColor = 'bg-red-50'; textColor = 'text-red-700'; ringColor = 'ring-red-600/10';
                icon = <AlertCircle className="h-3 w-3" />;
              } else if (doc.status === 'pending') {
                label = 'Pending';
                bgColor = 'bg-amber-50'; textColor = 'text-amber-700'; ringColor = 'ring-amber-600/20';
              } else if (doc.status === 'verified') {
                label = 'Verified';
                bgColor = 'bg-green-50'; textColor = 'text-green-700'; ringColor = 'ring-green-600/20';
                icon = <CheckCircle2 className="h-3 w-3" />;
              } else {
                label = doc.status;
              }

              return (
              <div key={doc.id} className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 p-4 hover:bg-slate-50/50 transition-colors group">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-slate-900 truncate">{doc.label}</p>
                    {!doc.required && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">Optional</span>}
                  </div>

                  <div className="mt-1 flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${bgColor} ${textColor} ring-1 ring-inset ${ringColor}`}>
                      {icon}
                      <span className="capitalize">{label}</span>
                    </span>
                    {doc.note && <span className="text-xs text-slate-500 truncate" title={doc.note}>&middot; {doc.note}</span>}
                  </div>

                  {vs === 'correction_requested' && doc.correctionGuidance && (
                    <div className="mt-2 text-xs text-amber-800 bg-amber-50/50 border border-amber-100 rounded-md p-2 flex gap-1.5 items-start">
                      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                      <span>{doc.correctionGuidance}</span>
                    </div>
                  )}

                  {vs === 'passed' && (
                    <p className="mt-1.5 text-[10px] text-slate-500">Automated checks passed. Authenticity may require HR/provider review.</p>
                  )}

                  {docErrors[doc.id] && (
                    <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1"><AlertCircle className="h-3 w-3" /> {docErrors[doc.id]}</p>
                  )}
                </div>

                <label className={`
                  shrink-0 inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-all focus-within:ring-2 focus-within:ring-indigo-500 focus-within:ring-offset-1
                  ${uploading === doc.id
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                    : doc.status === 'verified'
                      ? 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900 shadow-sm'
                      : 'bg-indigo-50 border border-indigo-100 text-indigo-700 hover:bg-indigo-100 hover:border-indigo-200 shadow-sm'
                  }
                `}>
                  {uploading === doc.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                  {uploading === doc.id ? 'Uploading...' : doc.status === 'pending' ? 'Upload File' : 'Replace File'}
                  <input className="sr-only" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" disabled={uploading !== null} onChange={(event) => { upload(doc.id, event.target.files?.[0]); event.target.value = ''; }} />
                </label>
              </div>
            )})}
          </div>
        </section>
      </div>
    </main>
  );
}

function Log({ label, value, link }: { label: string; value?: string | null; link?: string | null }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-slate-900 flex items-center flex-wrap gap-x-2 gap-y-1">
        {value}
        {link && (
          <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded transition-colors">
            <ExternalLink className="h-3 w-3" /> Map
          </a>
        )}
      </dd>
    </div>
  );
}
