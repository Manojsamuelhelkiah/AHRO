import { useEffect, useState } from 'react';
import { Copy, Link2, Save, Unlink, Mail, CalendarDays } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '@/components/ui-shared';
import { portalAdminRequest } from '@/lib/portal-admin-request';

const fields = [
  ['orientationDate', 'Date', 'date'],
  ['orientationTime', 'Time', 'time'],
  ['timezone', 'Timezone (e.g. Asia/Kolkata)', 'text'],
  ['reportingContact', 'Reporting Contact', 'text'],
  ['venueAddress', 'Venue / Address', 'text'],
  ['googleMapsUrl', 'Maps URL', 'url'],
  ['meetingUrl', 'Meeting URL', 'url'],
] as const;

export function PortalControls({ caseId, joiningDate }: { caseId: number; joiningDate: string }) {
  const [values, setValues] = useState<Record<string, string>>({ orientationDate: joiningDate, format: '' });
  const [activeLink, setActiveLink] = useState<{ id: number; expiresAt: string } | null>(null);
  const [issuedUrl, setIssuedUrl] = useState('');
  const [sendEmail, setSendEmail] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const request = async (url: string, init?: RequestInit) => {
    return portalAdminRequest<any>(url, init);
  };

  useEffect(() => {
    request(`/api/onboarding/cases/${caseId}/portal`).then((body) => {
      if (body.logistics) setValues(Object.fromEntries(Object.entries(body.logistics as Record<string, unknown>).map(([key, value]) => [key, typeof value === 'string' ? value : ''])));
      setActiveLink(body.activeLink);
    }).catch((error) => setMessage(error.message));
  }, [caseId]);

  const save = async () => {
    setBusy(true); setMessage('');
    try {
      await request(`/api/onboarding/cases/${caseId}/logistics`, { method: 'PUT', body: JSON.stringify(values) });
      setMessage('Day-1 logistics saved.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Save failed'); } finally { setBusy(false); }
  };
  const issue = async () => {
    setBusy(true); setMessage('');
    try {
      const body = await request(`/api/onboarding/cases/${caseId}/portal-links`, { method: 'POST', body: JSON.stringify({ expiresInHours: 168, sendEmail }) });
      const absolute = new URL(body.portalUrl, window.location.origin).toString();
      setIssuedUrl(absolute); setActiveLink({ id: body.id, expiresAt: body.expiresAt });
      setMessage(sendEmail ? `Portal link issued. Email status: ${body.delivery?.status ?? 'unknown'}.` : 'Portal link issued but not emailed.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Issue failed'); } finally { setBusy(false); }
  };
  const revoke = async () => {
    if (!activeLink) return;
    setBusy(true); setMessage('');
    try {
      await request(`/api/onboarding/cases/${caseId}/portal-links/${activeLink.id}`, { method: 'DELETE' });
      setActiveLink(null); setIssuedUrl(''); setMessage('Portal link revoked.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Revoke failed'); } finally { setBusy(false); }
  };

  return (
    <Card className="mb-6 shadow-sm border-slate-200 bg-white overflow-hidden">
      <CardHeader className="border-b bg-slate-50/80 px-4 py-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <CalendarDays className="h-4 w-4 text-indigo-600" />
            Logistics & Portal Access
          </CardTitle>
          <Button size="sm" type="button" className="h-7 text-xs px-3 gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white" disabled={busy} onClick={save}>
            <Save className="h-3.5 w-3.5" /> Save Details
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid md:grid-cols-[1fr_280px] divide-y md:divide-y-0 md:divide-x border-slate-100">

          <div className="p-4 space-y-4 bg-white">
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              {fields.map(([key, label, type]) => (
                <label key={key} className={`space-y-1 block ${key === 'meetingUrl' || key === 'googleMapsUrl' || key === 'venueAddress' ? 'col-span-2' : ''}`}>
                  <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">{label}</span>
                  <Input
                    type={type}
                    className="h-8 text-xs bg-slate-50 hover:bg-white focus:bg-white transition-colors border-slate-200 shadow-none focus-visible:ring-1 focus-visible:ring-indigo-500"
                    value={values[key] ?? ''}
                    onChange={(event) => setValues((old) => ({ ...old, [key]: event.target.value }))}
                  />
                </label>
              ))}

              <label className="space-y-1 block col-span-2 sm:col-span-1">
                <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Format</span>
                <select
                  className="flex h-8 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-xs ring-offset-background hover:bg-white focus:bg-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 transition-colors shadow-none"
                  value={values.format ?? ''}
                  onChange={(event) => setValues((old) => ({ ...old, format: event.target.value }))}
                >
                  <option value="">Not set</option>
                  <option value="physical">Physical</option>
                  <option value="remote">Remote</option>
                  <option value="hybrid">Hybrid</option>
                </select>
              </label>

              <label className="space-y-1 col-span-2 block">
                <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Arrival Instructions</span>
                <textarea
                  className="flex min-h-[60px] w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs ring-offset-background hover:bg-white focus:bg-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 transition-colors resize-y shadow-none"
                  value={values.arrivalInstructions ?? ''}
                  onChange={(event) => setValues((old) => ({ ...old, arrivalInstructions: event.target.value }))}
                />
              </label>
            </div>
          </div>

          <div className="p-4 bg-slate-50/50 flex flex-col">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-1.5">
              <Link2 className="h-3.5 w-3.5" />
              Candidate Portal Link
            </h3>

            <div className="flex-1 space-y-4">
              {activeLink ? (
                <div className="rounded-md border border-slate-200 bg-white p-3 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                        <span className="flex h-1.5 w-1.5 rounded-full bg-green-500"></span>
                        Active Link
                      </p>
                      <p className="text-[11px] text-slate-500 mt-1">Expires {new Date(activeLink.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
                    </div>
                    <Button type="button" variant="ghost" className="h-6 px-2 text-[11px] text-slate-500 hover:text-red-600 hover:bg-red-50 -mr-1 -mt-1" disabled={busy} onClick={revoke}>
                      <Unlink className="h-3 w-3 mr-1" /> Revoke
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-slate-300 bg-slate-50/80 p-4 text-center">
                  <p className="text-xs text-slate-500">No active portal link.</p>
                </div>
              )}

              <div className="space-y-3 pt-2">
                <label className="flex items-start gap-2.5 text-[11px] text-slate-700 bg-white p-2.5 rounded-md border border-slate-200 shadow-sm cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/30 transition-colors">
                  <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600 focus:ring-offset-0" checked={sendEmail} onChange={(event) => setSendEmail(event.target.checked)} />
                  <span className="leading-tight font-medium text-slate-600">Send link & logistics via email</span>
                </label>

                <div className="flex gap-2">
                  <Button type="button" variant="outline" className="flex-1 h-8 text-xs gap-1.5 border-slate-200 hover:bg-slate-50 hover:border-slate-300" disabled={busy} onClick={issue}>
                    {sendEmail ? <Mail className="h-3.5 w-3.5 text-slate-500" /> : <Link2 className="h-3.5 w-3.5 text-slate-500" />}
                    Issue 7-Day Link
                  </Button>
                </div>

                {issuedUrl && (
                  <Button type="button" className="w-full h-8 text-xs gap-1.5 bg-slate-900 text-white hover:bg-slate-800" onClick={() => navigator.clipboard.writeText(issuedUrl)}>
                    <Copy className="h-3.5 w-3.5" /> Copy New Link
                  </Button>
                )}
              </div>

              {message && (
                <div className={`rounded-md p-2.5 text-[11px] font-medium border ${message.includes('failed') ? 'bg-red-50 text-red-800 border-red-100' : 'bg-green-50 text-green-800 border-green-100'}`}>
                  {message}
                </div>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
