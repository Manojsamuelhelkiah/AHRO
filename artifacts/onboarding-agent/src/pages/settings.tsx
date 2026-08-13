import React, { useEffect, useState } from 'react';
import {
  useGetOnboardingSettings,
  useUpdateOnboardingSettings,
  useGetDemoVolunteers,
  useUpdateDemoVolunteers,
  useSeedDemoVolunteers,
  useListOnboardingScenarios,
  useRunOnboardingScenario,
  getListOnboardingCasesQueryKey,
  getGetDemoVolunteersQueryKey,
  getGetOnboardingSettingsQueryKey,
  getGetOnboardingDashboardQueryKey,
  type DemoVolunteer,
  type DemoPersona,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, Button, Badge, Label, cn, PageHeader, IconTile, LoadingBlock } from '@/components/ui-shared';
import { Mail, Check, X, AlertTriangle, Trash2, Users, Plus, Rocket, Phone, PhoneCall, Play } from 'lucide-react';
import { useLocation } from 'wouter';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+\d{8,15}$/;

const GEOGRAPHIES = ['India', 'United States', 'UK', 'Europe', 'Singapore'];

function blankVolunteer(): DemoVolunteer {
  const inAWeek = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  return {
    name: '', email: '', phone: '', channelPreference: 'email', persona: 'custom',
    role: 'Software Engineer', department: 'Engineering', geography: 'India',
    hireType: 'external', workerCategory: 'full-time',
    managerName: 'Demo Manager', recruiterName: 'Demo Recruiter',
    joiningDate: inAWeek, notes: 'Demo volunteer',
  };
}

function volunteerProblem(v: DemoVolunteer): string | null {
  if (!v.name.trim()) return 'Name is required';
  if (!EMAIL_RE.test(v.email.trim())) return 'Valid email required';
  const phone = v.phone.replace(/[\s-]/g, '');
  if (phone && !PHONE_RE.test(phone)) return 'Phone must look like +919876543210';
  if ((v.channelPreference === 'whatsapp' || v.channelPreference === 'both') && !phone) return 'WhatsApp needs a phone';
  return null;
}

const inputCls = 'block w-full text-[var(--text-sm)] rounded-[var(--radius-md)] h-[32px] px-[10px] py-[6px] border border-input outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)] bg-background shadow-sm';

function PersonaBrief({ persona, volunteerName }: { persona: DemoPersona | undefined; volunteerName: string }) {
  const [copied, setCopied] = useState(false);
  if (!persona) return null;
  const briefText = `Hi${volunteerName ? ` ${volunteerName.split(' ')[0]}` : ''}! You're playing: ${persona.title}.\n\n${persona.description}\n\nYour part: ${persona.volunteerBrief}`;
  return (
    <div className="mt-2.5 p-2.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-alt)] text-[var(--text-xs)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-[var(--text-primary)] text-[var(--text-sm)]">{persona.title}</p>
          <p className="text-[var(--text-muted)] mt-1"><span className="font-medium text-[var(--text-secondary)]">Their part:</span> {persona.volunteerBrief}</p>
          <p className="text-[var(--text-muted)] mt-1"><span className="font-medium text-[var(--text-secondary)]">What the agent should do:</span> {persona.expectedBehaviour}</p>
        </div>
        <Button
          variant="secondary" size="sm" className="shrink-0 gap-1.5 text-[var(--text-xs)]"
          onClick={() => { navigator.clipboard.writeText(briefText).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}
        >
          <Check className={cn('w-3.5 h-3.5', copied ? 'text-[var(--status-green)]' : 'opacity-0 w-0')} />
          {copied ? 'Copied' : 'Copy briefing'}
        </Button>
      </div>
    </div>
  );
}

const HR_BRIEF_TEXT = `You're playing: HR / Human-in-the-loop (the escalation chair).

Your part: keep the control tower open. The AI hands over to you whenever it reaches a limit it was designed to respect — watch the Approvals queue. Expect handovers when: a background check has an exception (BGV persona), a hire reports a blocker on a call, the AI can't answer a question confidently, or a promised email couldn't be delivered. Open each approval, read the AI's recommendation and rationale, then approve or reject — the agent resumes automatically. If the AI stumbles during a phone call it promises the hire "a human will call you back": that promise lands in your queue, and honoring it is your showcase moment. You're also the outage contact — the HR Alert Email above is where the system emails you if its own machinery breaks.`;

function HrOperatorBrief() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4 p-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-alt)] text-[var(--text-xs)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-[var(--text-primary)] text-[var(--text-sm)]">The seventh chair: HR / Human-in-the-loop (not a volunteer row)</p>
          <p className="text-[var(--text-muted)] mt-1">
            Every demo needs one person working the <span className="font-medium text-[var(--text-secondary)]">Approvals queue</span> — the escalation
            human the AI defers to for background-check exceptions, call blockers, unanswerable questions, and broken
            promises. Approving or rejecting there is what makes the human-in-the-loop story land.
          </p>
        </div>
        <Button
          variant="secondary" size="sm" className="shrink-0 gap-1.5 text-[var(--text-xs)]"
          onClick={() => { navigator.clipboard.writeText(HR_BRIEF_TEXT).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}
        >
          <Check className={cn('w-3.5 h-3.5', copied ? 'text-[var(--status-green)]' : 'opacity-0 w-0')} />
          {copied ? 'Copied' : 'Copy briefing'}
        </Button>
      </div>
    </div>
  );
}

function RemoteApproverSettings() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useGetOnboardingSettings();
  const update = useUpdateOnboardingSettings();

  const [draft, setDraft] = useState('');
  const [touched, setTouched] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (settings && !touched) setDraft(settings.hrApproverEmail ?? '');
  }, [settings, touched]);

  const trimmed = draft.trim();
  const invalid = touched && trimmed.length > 0 && !EMAIL_RE.test(trimmed);
  const dirty = settings ? trimmed !== (settings.hrApproverEmail ?? '') : false;

  const save = (value: string | null) => {
    setResult(null);
    update.mutate(
      { data: { hrApproverEmail: value } },
      {
        onSuccess: (updated) => {
          setTouched(false);
          setDraft(updated.hrApproverEmail ?? '');
          setResult({
            ok: true,
            message: updated.hrApproverEmail
              ? `New pending approvals will be emailed to ${updated.hrApproverEmail}. A reply containing "approve" or "reject" from that exact address decides them.`
              : 'Cleared — approvals are decided only from the in-app Approvals queue.',
          });
          queryClient.invalidateQueries({ queryKey: getGetOnboardingSettingsQueryKey() });
        },
        onError: (err: any) => setResult({ ok: false, message: err?.error ?? err?.message ?? 'Saving failed — please try again.' }),
      },
    );
  };

  if (isLoading) return null;
  return (
    <div className="mt-4 p-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-alt)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-[var(--text-sm)] text-[var(--text-primary)]">Remote HR approver (optional)</p>
          <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1">
            When the AI escalates, this address gets an email with the recommendation and decides it by replying{' '}
            <span className="font-medium text-[var(--text-secondary)]">approve</span> or <span className="font-medium text-[var(--text-secondary)]">reject</span>. Only replies
            from this exact address are honored; each decision is recorded in the audit trail.
          </p>
        </div>
        <Badge
          className={cn(
            'uppercase tracking-wider text-[10px] shadow-none shrink-0',
            settings?.hrApproverEmail
              ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]'
              : 'bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)]',
          )}
        >
          {settings?.hrApproverEmail ? 'ACTIVE' : 'NOT SET'}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        <input
          type="email"
          placeholder="approver@example.com"
          value={draft}
          onChange={(e) => { setTouched(true); setDraft(e.target.value); setResult(null); }}
          className={cn(inputCls, 'max-w-sm', invalid && 'border-[var(--status-red)] focus:border-[var(--status-red)] focus:ring-[var(--status-red)]')}
          aria-label="HR approver email"
        />
        <Button onClick={() => save(trimmed.length > 0 ? trimmed : null)} disabled={update.isPending || invalid || !dirty} className="gap-2 bg-[var(--surface-alt)] text-[var(--text-primary)] border-[var(--border)] hover:bg-[var(--surface-soft)]">
          <Check className="w-4 h-4" /> Save
        </Button>
        {settings?.hrApproverEmail && (
          <Button variant="ghost" onClick={() => save(null)} disabled={update.isPending} className="gap-2 text-[var(--status-red)] hover:text-[var(--status-red)] hover:bg-[var(--status-red-bg)]">
            <Trash2 className="w-4 h-4" /> Clear
          </Button>
        )}
      </div>
      {invalid && (
        <p className="text-[var(--text-xs)] text-[var(--status-red)] flex items-center gap-1 mt-2">
          <AlertTriangle className="w-3 h-3" /> Enter a valid email address.
        </p>
      )}
      {result && (
        <div className={cn('p-3 mt-3 text-[var(--text-sm)] rounded-[var(--radius-md)] border flex items-start gap-3',
          result.ok ? 'bg-[var(--status-green-bg)] border-transparent text-[var(--status-green-fg)]' : 'bg-[var(--status-red-bg)] border-transparent text-[var(--status-red-fg)]')}>
          {result.ok ? <Check className="w-5 h-5 shrink-0 mt-0.5" /> : <X className="w-5 h-5 shrink-0 mt-0.5" />}
          <p className="mt-0.5">{result.message}</p>
        </div>
      )}
    </div>
  );
}

function DemoVolunteersCard() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetDemoVolunteers();
  const update = useUpdateDemoVolunteers();
  const seed = useSeedDemoVolunteers();

  const [rows, setRows] = useState<DemoVolunteer[]>([]);
  const [touched, setTouched] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [seedResults, setSeedResults] = useState<{ name: string; status: string; note: string; caseId: number | null }[] | null>(null);

  useEffect(() => {
    if (data && !touched) setRows(data.volunteers);
  }, [data, touched]);

  const edit = (i: number, patch: Partial<DemoVolunteer>) => {
    setTouched(true);
    setNotice(null);
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const problems = rows.map(volunteerProblem);
  const anyInvalid = rows.some((r, i) => problems[i] !== null && (r.name || r.email));

  const save = () => {
    setNotice(null);
    setSeedResults(null);
    update.mutate(
      { data: { volunteers: rows } },
      {
        onSuccess: (saved) => {
          setTouched(false);
          setRows(saved.volunteers);
          const live = saved.volunteers.filter((v) => !volunteerProblem(v));
          setNotice({
            ok: true,
            message: live.length > 0
              ? `Saved. Live emails, WhatsApp and calls are now enabled for ${live.length} volunteer${live.length === 1 ? '' : 's'} — and nobody else.`
              : 'Saved. No valid volunteers yet, so live delivery stays off.',
          });
          queryClient.invalidateQueries({ queryKey: getGetDemoVolunteersQueryKey() });
        },
        onError: (err: any) => setNotice({ ok: false, message: err?.message ?? 'Saving failed — please try again.' }),
      },
    );
  };

  const runSeed = () => {
    setNotice(null);
    seed.mutate(undefined, {
      onSuccess: (res) => setSeedResults(res.results),
      onError: (err: any) => setNotice({ ok: false, message: err?.message ?? 'Seeding failed — please try again.' }),
    });
  };

  return (
    <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ backgroundColor: 'var(--surface-alt)', borderBottom: '1px solid var(--border)', padding: 'var(--space-md) var(--space-lg)' }}>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <IconTile icon={Users} className="bg-[var(--surface-soft)] text-[var(--text-secondary)] border-transparent" />
            <div>
              <h3 style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>Demo Volunteers</h3>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px', marginBottom: 0 }}>
                Real people for live demos. Saving authorizes their email/phone for real messages and calls — no one else
                can be contacted. "Create demo cases" runs each volunteer through the full agent pipeline.
              </p>
            </div>
          </div>
        </div>
      </div>
      <div className="p-[var(--space-lg)] bg-[var(--surface)]">
        {isLoading ? (
          <LoadingBlock>Loading volunteers...</LoadingBlock>
        ) : (
          <>
            <div className="space-y-3">
              {rows.map((v, i) => {
                const problem = problems[i];
                return (
                  <div key={i} className={cn('border rounded-[var(--radius-md)] p-3 transition-colors', problem && (v.name || v.email) ? 'border-[var(--status-amber)] bg-[var(--status-amber-bg)]/30' : 'border-[var(--border)] bg-[var(--surface)]')}>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      <input placeholder="Full name" value={v.name} onChange={(e) => edit(i, { name: e.target.value })} className={inputCls} />
                      <input placeholder="email@example.com" type="email" value={v.email} onChange={(e) => edit(i, { email: e.target.value })} className={inputCls} />
                      <input placeholder="+919876543210 (optional)" value={v.phone} onChange={(e) => edit(i, { phone: e.target.value })} className={inputCls} />
                      <select value={v.persona} onChange={(e) => edit(i, { persona: e.target.value })} className={cn(inputCls, 'font-medium')} title="Persona this volunteer plays">
                        {(data?.personas ?? []).map((p) => <option key={p.key} value={p.key}>{p.title}</option>)}
                      </select>
                      <select value={v.channelPreference} onChange={(e) => edit(i, { channelPreference: e.target.value })} className={inputCls}>
                        <option value="email">Email only</option>
                        <option value="whatsapp">WhatsApp</option>
                        <option value="both">Email + WhatsApp</option>
                      </select>
                      <select value={v.geography} onChange={(e) => edit(i, { geography: e.target.value })} className={inputCls}>
                        {GEOGRAPHIES.map((g) => <option key={g} value={g}>{g}</option>)}
                      </select>
                      <div className="flex gap-2">
                        <input type="date" value={v.joiningDate} onChange={(e) => edit(i, { joiningDate: e.target.value })} className={inputCls} title="Joining date" />
                        <select value={v.workerCategory} onChange={(e) => edit(i, { workerCategory: e.target.value })} className={cn(inputCls, 'w-36')}>
                          <option value="full-time">Full-time</option>
                          <option value="contractor">Contractor</option>
                        </select>
                        <Button variant="ghost" size="icon" className="shrink-0 text-[var(--text-muted)] hover:text-[var(--status-red)] hover:bg-[var(--status-red-bg)]" title="Remove volunteer"
                          onClick={() => { setTouched(true); setNotice(null); setRows((prev) => prev.filter((_, idx) => idx !== i)); }}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                    {problem && (v.name || v.email) && (
                      <p className="text-[var(--text-xs)] text-[var(--status-amber-fg)] flex items-center gap-1 mt-2">
                        <AlertTriangle className="w-3 h-3" /> {problem}
                      </p>
                    )}
                    <PersonaBrief persona={(data?.personas ?? []).find((p) => p.key === v.persona)} volunteerName={v.name} />
                  
                  </div>
                );
              })}
              {rows.length === 0 && (
                <LoadingBlock>No volunteers yet. Add one to enable live demo delivery.</LoadingBlock>
              )}
            </div>

            <div className="flex flex-wrap gap-2 mt-4 pt-2 border-t border-[var(--border)]">
              <Button variant="secondary" className="gap-2" onClick={() => { setTouched(true); setRows((prev) => [...prev, blankVolunteer()]); }}>
                <Plus className="w-4 h-4" /> Add volunteer
              </Button>
              <Button onClick={save} disabled={update.isPending || !touched || anyInvalid} className="gap-2">
                <Check className="w-4 h-4" /> Save & authorize
              </Button>
              <Button variant="outline" onClick={runSeed} disabled={seed.isPending || touched || (data?.volunteers.length ?? 0) === 0}
                className="gap-2 ml-auto" title={touched ? 'Save first, then create cases' : undefined}>
                <Rocket className="w-4 h-4" /> {seed.isPending ? 'Creating cases…' : 'Create demo cases'}
              </Button>
            </div>
            {touched && <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-2">Unsaved changes — save before creating demo cases.</p>}

            {notice && (
              <div className={cn('p-3 mt-4 text-[var(--text-sm)] rounded-[var(--radius-md)] border flex items-start gap-3',
                notice.ok ? 'bg-[var(--status-green-bg)] border-transparent text-[var(--status-green-fg)]' : 'bg-[var(--status-red-bg)] border-transparent text-[var(--status-red-fg)]')}>
                {notice.ok ? <Check className="w-5 h-5 shrink-0 mt-0.5" /> : <X className="w-5 h-5 shrink-0 mt-0.5" />}
                <p className="mt-0.5">{notice.message}</p>
              </div>
            )}

            {seedResults && (
              <div className="mt-4 border border-[var(--border)] rounded-[var(--radius-md)] divide-y divide-[var(--border)] overflow-hidden">
                {seedResults.map((r, i) => (
                  <div key={i} className="p-2.5 bg-[var(--surface)] text-[var(--text-sm)] flex items-center gap-3">
                    <Badge className={cn('uppercase tracking-wider text-[10px] shadow-none shrink-0',
                      r.status === 'seeded' ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]'
                        : r.status === 'skipped' ? 'bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)]'
                          : 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]')}>
                      {r.status}
                    </Badge>
                    <span className="font-medium text-[var(--text-primary)]">{r.name}</span>
                    <span className="text-[var(--text-muted)]">{r.note}</span>
                    {r.caseId !== null && (
                      <a href={`cases/${r.caseId}`} className="ml-auto text-[var(--primary)] font-medium hover:underline shrink-0">Open case #{r.caseId}</a>
                    )}
                  </div>
                ))}
              </div>
            )}

            <HrOperatorBrief />

            <RemoteApproverSettings />

            <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-4 flex items-start gap-1.5">
              <Phone className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              Twilio trial note: phone numbers must also be added as Verified Caller IDs in the Twilio console before live
              calls or WhatsApp will connect. WhatsApp volunteers must send the sandbox join message once.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useGetOnboardingSettings();
  const update = useUpdateOnboardingSettings();

  const [draft, setDraft] = useState('');
  const [touched, setTouched] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const toggleCalls = useUpdateOnboardingSettings();
  const [callsResult, setCallsResult] = useState<{ ok: boolean; message: string } | null>(null);

  const saveAutoCalls = (enabled: boolean) => {
    setCallsResult(null);
    toggleCalls.mutate(
      { data: { autoEscalationCalls: enabled } },
      {
        onSuccess: (updated) => {
          setCallsResult({
            ok: true,
            message: updated.autoEscalationCalls
              ? 'Automatic escalation calls are ON. Calls still respect the allowlist and hourly limit.'
              : 'Automatic escalation calls are OFF. Escalation calls must be placed manually from the case page.',
          });
          queryClient.invalidateQueries({ queryKey: getGetOnboardingSettingsQueryKey() });
        },
        onError: (err: any) => {
          setCallsResult({
            ok: false,
            message: err?.error ?? err?.message ?? 'Saving failed — please try again.',
          });
        },
      },
    );
  };

  // Seed the input from the stored value once it loads.
  useEffect(() => {
    if (settings && !touched) setDraft(settings.hrAlertEmail ?? '');
  }, [settings, touched]);

  const trimmed = draft.trim();
  const invalid = touched && trimmed.length > 0 && !EMAIL_RE.test(trimmed);
  const dirty = settings ? trimmed !== (settings.hrAlertEmail ?? '') : false;

  const save = (value: string | null) => {
    setResult(null);
    update.mutate(
      { data: { hrAlertEmail: value } },
      {
        onSuccess: (updated) => {
          setTouched(false);
          setDraft(updated.hrAlertEmail ?? '');
          setResult({
            ok: true,
            message: updated.hrAlertEmail
              ? `Alert emails will be sent to ${updated.hrAlertEmail}.`
              : updated.envFallback
                ? `Cleared — alerts fall back to the server-configured address (${updated.envFallback}).`
                : 'Cleared — no alert email is configured, so outage emails are disabled.',
          });
          queryClient.invalidateQueries({ queryKey: getGetOnboardingSettingsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetOnboardingDashboardQueryKey() });
        },
        onError: (err: any) => {
          setResult({
            ok: false,
            message: err?.error ?? err?.message ?? 'Saving failed — please try again.',
          });
        },
      },
    );
  };

  const sourceLabel =
    settings?.source === 'settings'
      ? 'Set from this screen'
      : settings?.source === 'environment'
        ? 'Server default (environment variable)'
        : 'Not configured';

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      <PageHeader 
        title="Settings" 
        subtitle="Application-level configuration for the control tower." 
      />

      <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)' }} className="mt-2">
        <div style={{ backgroundColor: 'var(--surface-alt)', borderBottom: '1px solid var(--border)', padding: 'var(--space-md) var(--space-lg)' }}>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <IconTile icon={Mail} className="bg-[var(--surface-soft)] text-[var(--text-secondary)] border-transparent" />
              <div>
                <h3 style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>HR Alert Email</h3>
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px', marginBottom: 0 }}>
                  Where outage alerts go when the Gmail reply monitor breaks (and recovery notices when it resumes).
                </p>
              </div>
            </div>
            {!isLoading && (
              <span style={{ 
                backgroundColor: settings?.effective ? 'var(--status-green-bg)' : 'var(--status-gray-bg)', 
                color: settings?.effective ? 'var(--status-green-fg)' : 'var(--status-gray-fg)', 
                fontSize: 'var(--text-xs)', fontWeight: 700, padding: '3px 8px', borderRadius: '20px', textTransform: 'uppercase', letterSpacing: '0.03em', display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap'
              }}>
                {settings?.effective ? 'ACTIVE' : 'NOT SET'}
              </span>
            )}
          </div>
        </div>
        <div className="p-[var(--space-lg)] bg-[var(--surface)]">

          {isLoading ? (
            <LoadingBlock>Loading settings...</LoadingBlock>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                <div className="border border-[var(--border)] rounded-[var(--radius-md)] p-2.5 bg-[var(--surface-alt)]">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Alerts currently go to</p>
                  <p className="text-[var(--text-xs)] font-mono mt-1 break-all text-[var(--text-primary)]">{settings?.effective ?? 'Nobody — alerts disabled'}</p>
                </div>
                <div className="border border-[var(--border)] rounded-[var(--radius-md)] p-2.5 bg-[var(--surface-alt)]">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Source</p>
                  <p className="text-[var(--text-xs)] mt-1 text-[var(--text-primary)]">{sourceLabel}</p>
                </div>
              </div>

              <div className="space-y-2 max-w-sm">
                <Label htmlFor="hr-alert-email" className="text-[var(--text-xs)] font-bold uppercase tracking-wider text-[var(--text-muted)]">
                  Alert email address
                </Label>
                <input
                  id="hr-alert-email"
                  type="email"
                  placeholder="hr@company.com"
                  value={draft}
                  onChange={(e) => {
                    setTouched(true);
                    setDraft(e.target.value);
                    setResult(null);
                  }}
                  className={cn(
                    'block w-full text-[var(--text-sm)] rounded-[var(--radius-md)] h-[32px] px-3 border outline-none transition-colors bg-[var(--surface)] shadow-sm text-[var(--text-primary)]',
                    invalid ? 'border-[var(--status-red)] focus:border-[var(--status-red)]' : 'border-[var(--border)] focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]',
                  )}
                />
                {invalid && (
                  <p className="text-[var(--text-xs)] text-[var(--status-red)] flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> Enter a valid email address (e.g. hr@company.com).
                  </p>
                )}
                {settings?.envFallback && (
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
                    Leaving this empty falls back to the server-configured address ({settings.envFallback}).
                  </p>
                )}
              </div>

              <div className="flex gap-2 mt-4 pt-2 border-t border-[var(--border)]">
                <Button
                  onClick={() => save(trimmed.length > 0 ? trimmed : null)}
                  disabled={update.isPending || invalid || !dirty || trimmed.length === 0 && !settings?.hrAlertEmail}
                  className="gap-2 font-bold"
                >
                  <Check className="w-4 h-4" /> Save
                </Button>
                {settings?.hrAlertEmail && (
                  <Button
                    variant="ghost"
                    onClick={() => save(null)}
                    disabled={update.isPending}
                    className="gap-2 text-[var(--status-red)] hover:text-[var(--status-red)] hover:bg-[var(--status-red-bg)]"
                  >
                    <Trash2 className="w-4 h-4" /> Clear stored address
                  </Button>
                )}
              </div>

              {result && (
                <div
                  className={cn(
                    'p-3 mt-4 text-[var(--text-sm)] rounded-[var(--radius-md)] border flex items-start gap-3',
                    result.ok ? 'bg-[var(--status-green-bg)] border-transparent text-[var(--status-green-fg)]' : 'bg-[var(--status-red-bg)] border-transparent text-[var(--status-red-fg)]',
                  )}
                >
                  {result.ok ? (
                    <Check className="w-5 h-5 shrink-0 mt-0.5" />
                  ) : (
                    <X className="w-5 h-5 shrink-0 mt-0.5" />
                  )}
                  <p className="mt-0.5">{result.message}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)' }}>
        <div style={{ backgroundColor: 'var(--surface-alt)', borderBottom: '1px solid var(--border)', padding: 'var(--space-md) var(--space-lg)' }}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <IconTile icon={PhoneCall} className="bg-[var(--surface-soft)] text-[var(--text-secondary)] border-transparent" />
              <div>
                <h3 style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>Automatic Escalation Calls</h3>
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px', marginBottom: 0 }}>
                  On SLA breach with no reply from the hire, the System Watcher places the escalation call itself —
                  allowlist and hourly limit still apply; each call is recorded on the case timeline.
                </p>
              </div>
            </div>
            {!isLoading && (
              <span style={{ 
                backgroundColor: settings?.autoEscalationCalls ? 'var(--status-green-bg)' : 'var(--status-gray-bg)', 
                color: settings?.autoEscalationCalls ? 'var(--status-green-fg)' : 'var(--status-gray-fg)', 
                fontSize: 'var(--text-xs)', fontWeight: 700, padding: '3px 8px', borderRadius: '20px', textTransform: 'uppercase', letterSpacing: '0.03em', display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap'
              }}>
                {settings?.autoEscalationCalls ? 'ON' : 'OFF'}
              </span>
            )}
          </div>
        </div>
        <div className="p-[var(--space-lg)] bg-[var(--surface)]">

          {!isLoading && (
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={!!settings?.autoEscalationCalls}
                aria-label="Automatic escalation calls"
                disabled={toggleCalls.isPending}
                onClick={() => saveAutoCalls(!settings?.autoEscalationCalls)}
                className={cn(
                  'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50 border-2 border-transparent',
                  settings?.autoEscalationCalls ? 'bg-[var(--status-green)]' : 'bg-[var(--border)]',
                )}
              >
                <span
                  className={cn(
                    'inline-block h-5 w-5 rounded-full bg-[var(--surface)] shadow-sm transition-transform',
                    settings?.autoEscalationCalls ? 'translate-x-5' : 'translate-x-0',
                  )}
                />
              </button>
              <span className="text-[var(--text-sm)] text-[var(--text-primary)]">
                {settings?.autoEscalationCalls
                  ? 'On — overdue, unresponsive hires get an automatic escalation call.'
                  : 'Off — escalation calls are only placed manually from the case page.'}
              </span>
            </div>
          )}

          {callsResult && (
            <div
              className={cn(
                'p-3 mt-4 text-[var(--text-sm)] rounded-[var(--radius-md)] border flex items-start gap-3',
                callsResult.ok ? 'bg-[var(--status-green-bg)] border-transparent text-[var(--status-green-fg)]' : 'bg-[var(--status-red-bg)] border-transparent text-[var(--status-red-fg)]',
              )}
            >
              {callsResult.ok ? (
                <Check className="w-5 h-5 shrink-0 mt-0.5" />
              ) : (
                <X className="w-5 h-5 shrink-0 mt-0.5" />
              )}
              <p className="mt-0.5">{callsResult.message}</p>
            </div>
          )}
        </div>
      </div>

      <DemoVolunteersCard />

      <ScenarioTestingCard />
    </div>
  );
}

/** Scenario testing moved here from the Control Tower — development/demo tooling
 *  does not belong on the production operations dashboard. */
function ScenarioTestingCard() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { data: scenarios, isLoading } = useListOnboardingScenarios();
  const runScenario = useRunOnboardingScenario();

  const handleRun = (key: string) => {
    runScenario.mutate({ key }, {
      onSuccess: (caseData) => {
        queryClient.invalidateQueries({ queryKey: getGetOnboardingDashboardQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCasesQueryKey() });
        setLocation(`/cases/${caseData.id}`);
      },
    });
  };

  return (
    <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ backgroundColor: 'var(--surface-alt)', borderBottom: '1px solid var(--border)', padding: 'var(--space-md) var(--space-lg)' }}>
        <div className="flex items-center gap-3">
          <IconTile icon={Play} className="bg-[var(--surface-soft)] text-[var(--text-secondary)] border-transparent" />
          <div>
            <h3 style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>Scenario Testing</h3>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px', marginBottom: 0 }}>
              Development tooling — launches a pre-configured case to exercise the autonomous agents end to end.
            </p>
          </div>
        </div>
      </div>
      <div className="p-[var(--space-lg)] bg-[var(--surface-soft)]/30">
        {isLoading ? (
          <LoadingBlock>Loading scenarios...</LoadingBlock>
        ) : !scenarios?.length ? (
          <p className="text-[var(--text-sm)] text-[var(--text-muted)]">No scenarios configured.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {scenarios.map((s) => (
              <div key={s.key} className="p-[var(--space-md)] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] shadow-sm flex flex-col gap-2 transition-shadow hover:shadow-[var(--shadow-sm)]">
                <div>
                  <h4 className="font-semibold text-[var(--text-sm)] text-[var(--text-primary)]">{s.title}</h4>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1 leading-relaxed">{s.description}</p>
                </div>
                <p className="text-[var(--text-xs)] text-[var(--text-muted)]"><span className="font-medium text-[var(--text-secondary)]">Expected behaviour:</span> {s.expectedBehaviour}</p>
                <div className="mt-auto pt-2">
                  <Button size="sm" variant="secondary" onClick={() => handleRun(s.key)} disabled={runScenario.isPending} className="gap-2 w-full sm:w-auto">
                    <Play className="h-3.5 w-3.5" /> {runScenario.isPending ? 'Running...' : 'Run scenario'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
