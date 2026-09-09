import { useEffect, useState } from 'react';
import { Copy, Link2, Save, Send, Unlink } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '@/components/ui-shared';
import { portalAdminRequest } from '@/lib/portal-admin-request';

const fields = [
  ['orientationDate', 'Orientation / joining date', 'date'],
  ['orientationTime', 'Time', 'time'],
  ['timezone', 'Timezone (for example, Asia/Kolkata)', 'text'],
  ['venueAddress', 'Venue / address', 'text'],
  ['googleMapsUrl', 'Google Maps URL', 'url'],
  ['meetingUrl', 'Meeting URL', 'url'],
  ['reportingContact', 'Reporting contact', 'text'],
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

  return <Card className="mb-6">
    <CardHeader className="border-b pb-3"><CardTitle className="flex items-center gap-2 text-[var(--text-base)]"><Link2 className="h-4 w-4 text-[var(--primary)]" /> Candidate portal and Day-1 logistics</CardTitle></CardHeader>
    <CardContent className="space-y-5 pt-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map(([key, label, type]) => <label key={key} className="space-y-1 text-xs font-semibold text-[var(--text-secondary)]"><span>{label}</span><Input type={type} value={values[key] ?? ''} onChange={(event) => setValues((old) => ({ ...old, [key]: event.target.value }))} /></label>)}
        <label className="space-y-1 text-xs font-semibold text-[var(--text-secondary)]"><span>Format</span><select className="h-9 w-full rounded-md border bg-white px-3 text-sm" value={values.format ?? ''} onChange={(event) => setValues((old) => ({ ...old, format: event.target.value }))}><option value="">Not set</option><option value="physical">Physical</option><option value="remote">Remote</option><option value="hybrid">Hybrid</option></select></label>
        <label className="space-y-1 text-xs font-semibold text-[var(--text-secondary)] sm:col-span-2"><span>Arrival instructions</span><textarea className="min-h-20 w-full rounded-md border bg-white p-3 text-sm" value={values.arrivalInstructions ?? ''} onChange={(event) => setValues((old) => ({ ...old, arrivalInstructions: event.target.value }))} /></label>
      </div>
      <Button type="button" variant="outline" disabled={busy} onClick={save}><Save className="mr-2 h-4 w-4" />Save logistics</Button>
      <div className="border-t pt-4">
        <p className="text-sm font-semibold">Private candidate link</p>
        {activeLink && <p className="mt-1 text-xs text-[var(--text-muted)]">Active until {new Date(activeLink.expiresAt).toLocaleString()}</p>}
        <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={sendEmail} onChange={(event) => setSendEmail(event.target.checked)} />Explicitly send the link and logistics by email</label>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" disabled={busy} onClick={issue}>{sendEmail ? <Send className="mr-2 h-4 w-4" /> : <Link2 className="mr-2 h-4 w-4" />}Issue new 7-day link</Button>
          {issuedUrl && <Button type="button" variant="outline" onClick={() => navigator.clipboard.writeText(issuedUrl)}><Copy className="mr-2 h-4 w-4" />Copy newly issued link</Button>}
          {activeLink && <Button type="button" variant="outline" disabled={busy} onClick={revoke}><Unlink className="mr-2 h-4 w-4" />Revoke</Button>}
        </div>
      </div>
      {message && <p role="status" className="text-sm text-[var(--text-secondary)]">{message}</p>}
    </CardContent>
  </Card>;
}