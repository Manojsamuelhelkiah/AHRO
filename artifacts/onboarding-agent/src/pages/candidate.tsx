import { useEffect, useState, type ReactNode } from 'react';
import { CalendarDays, Clock3, FileUp, MapPin, Monitor, UserRound } from 'lucide-react';

type Portal = {
  case: { workerName: string; role: string; department: string; joiningDate: string };
  logistics: null | Record<string, string | null>;
  documents: Array<{ id: number; label: string; required: boolean; status: string; note?: string | null }>;
};

export function CandidatePage() {
  const [portal, setPortal] = useState<Portal | null>(null);
  const [error, setError] = useState('');
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

  const upload = async (documentId: number, file?: File) => {
    if (!file) return;
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

  if (error && !portal) return <main className="min-h-screen bg-slate-50 grid place-items-center p-6"><div className="max-w-md rounded-xl border bg-white p-8 text-center"><h1 className="text-xl font-bold text-slate-900">Portal unavailable</h1><p role="alert" className="mt-3 text-sm text-slate-600">{error}</p></div></main>;
  if (!portal) return <main className="min-h-screen bg-slate-50 grid place-items-center text-sm text-slate-500">Opening your secure portal...</main>;
  const l = portal.logistics;
  return (
    <main className="min-h-screen bg-slate-50">
      <header className="border-b bg-white"><div className="mx-auto max-w-5xl px-5 py-6"><p className="text-sm font-semibold text-indigo-600">Onboarding portal</p><h1 className="mt-1 text-2xl font-bold text-slate-900">Welcome, {portal.case.workerName}</h1><p className="mt-1 text-sm text-slate-600">{portal.case.role} · {portal.case.department}</p></div></header>
      <div className="mx-auto grid max-w-5xl gap-6 px-5 py-8 lg:grid-cols-[1fr_1.35fr]">
        <section className="rounded-xl border bg-white p-5 shadow-sm">
          <h2 className="text-lg font-bold text-slate-900">Day-1 logistics</h2>
          {!l && <p className="mt-4 text-sm text-slate-500">Your Day-1 details will be shared here soon.</p>}
          {l && <dl className="mt-5 space-y-4 text-sm">
            <Log icon={<CalendarDays />} label="Date" value={l.orientationDate || portal.case.joiningDate} />
            <Log icon={<Clock3 />} label="Time" value={[l.orientationTime, l.timezone].filter(Boolean).join(' · ')} />
            <Log icon={<Monitor />} label="Format" value={l.format} />
            <Log icon={<MapPin />} label="Venue" value={l.venueAddress} link={l.googleMapsUrl} />
            <Log icon={<UserRound />} label="Reporting contact" value={l.reportingContact} />
            {l.meetingUrl && <a className="block rounded-md bg-indigo-600 px-4 py-2.5 text-center font-semibold text-white" href={l.meetingUrl} target="_blank" rel="noreferrer">Open meeting link</a>}
            {l.arrivalInstructions && <div className="rounded-lg bg-slate-50 p-3"><dt className="font-semibold text-slate-800">Arrival instructions</dt><dd className="mt-1 whitespace-pre-wrap text-slate-600">{l.arrivalInstructions}</dd></div>}
          </dl>}
        </section>
        <section className="rounded-xl border bg-white p-5 shadow-sm">
          <h2 className="text-lg font-bold text-slate-900">Document checklist</h2>
          <p className="mt-1 text-sm text-slate-500">PDF, JPEG, or PNG only. Maximum 10MB per file.</p>
          {error && <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          <div className="mt-5 divide-y">
            {portal.documents.map((doc) => <div key={doc.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1"><p className="font-semibold text-slate-900">{doc.label}{!doc.required && <span className="ml-2 text-xs font-normal text-slate-500">Optional</span>}</p><p className="mt-1 text-xs capitalize text-slate-500">{doc.status}</p></div>
              <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                <FileUp className="h-4 w-4" />{uploading === doc.id ? 'Uploading...' : doc.status === 'pending' ? 'Upload' : 'Replace'}
                <input className="sr-only" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" disabled={uploading !== null} onChange={(event) => upload(doc.id, event.target.files?.[0])} />
              </label>
            </div>)}
          </div>
        </section>
      </div>
    </main>
  );
}

function Log({ icon, label, value, link }: { icon: ReactNode; label: string; value?: string | null; link?: string | null }) {
  if (!value) return null;
  return <div className="flex gap-3"><span className="mt-0.5 [&>svg]:h-4 [&>svg]:w-4 text-indigo-600">{icon}</span><div><dt className="font-semibold text-slate-800">{label}</dt><dd className="text-slate-600">{value}{link && <> · <a className="text-indigo-600 underline" href={link} target="_blank" rel="noreferrer">Map</a></>}</dd></div></div>;
}