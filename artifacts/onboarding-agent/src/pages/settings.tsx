import React, { useEffect, useState } from 'react';
import {
  useGetOnboardingSettings,
  useUpdateOnboardingSettings,
  useGetDemoVolunteers,
  useUpdateDemoVolunteers,
  useSeedDemoVolunteers,
  getGetDemoVolunteersQueryKey,
  getGetOnboardingSettingsQueryKey,
  getGetOnboardingDashboardQueryKey,
  type DemoVolunteer,
  type DemoPersona,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, Button, Badge, Label, cn } from '@/components/ui-shared';
import { Mail, Check, X, AlertTriangle, Trash2, Users, Plus, Rocket, Phone, PhoneCall } from 'lucide-react';

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

const inputCls = 'block w-full text-sm rounded-md h-9 px-2.5 border border-input outline-none focus:border-primary bg-background';

function PersonaBrief({ persona, volunteerName }: { persona: DemoPersona | undefined; volunteerName: string }) {
  const [copied, setCopied] = useState(false);
  if (!persona) return null;
  const briefText = `Hi${volunteerName ? ` ${volunteerName.split(' ')[0]}` : ''}! You're playing: ${persona.title}.\n\n${persona.description}\n\nYour part: ${persona.volunteerBrief}`;
  return (
    <div className="mt-3 p-3 rounded-md border border-violet-200 bg-violet-50/50 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-violet-900">{persona.title}</p>
          <p className="text-violet-900/80 mt-1"><span className="font-medium">Their part:</span> {persona.volunteerBrief}</p>
          <p className="text-violet-900/60 mt-1 text-xs"><span className="font-medium">What the agent should do:</span> {persona.expectedBehaviour}</p>
        </div>
        <Button
          variant="outline" size="sm" className="shrink-0 gap-1.5 text-xs"
          onClick={() => { navigator.clipboard.writeText(briefText).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}
        >
          <Check className={cn('w-3.5 h-3.5', copied ? 'text-emerald-600' : 'opacity-0 w-0')} />
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
    <div className="mt-5 p-4 rounded-lg border border-sky-200 bg-sky-50/50 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-sky-900">The seventh chair: HR / Human-in-the-loop (not a volunteer row)</p>
          <p className="text-sky-900/80 mt-1">
            Every demo needs one person on the HR side — the escalation human the AI is designed to defer to. They don't
            receive hire messages; they work the <span className="font-medium">Approvals queue</span>, where the agent
            hands over background-check exceptions, blockers reported on calls, questions it can't answer, and any
            promise it couldn't keep (like an undeliverable email or a "human will call you back" from a voice call).
            Approving or rejecting there is what makes the human-in-the-loop story land.
          </p>
        </div>
        <Button
          variant="outline" size="sm" className="shrink-0 gap-1.5 text-xs"
          onClick={() => { navigator.clipboard.writeText(HR_BRIEF_TEXT).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}
        >
          <Check className={cn('w-3.5 h-3.5', copied ? 'text-emerald-600' : 'opacity-0 w-0')} />
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
    <div className="mt-5 p-4 rounded-lg border border-sky-200 bg-sky-50/30">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-sm text-sky-900">Remote HR approver (optional)</p>
          <p className="text-sm text-sky-900/80 mt-1">
            Let a second volunteer play the HR approver from their own inbox: when the AI escalates, they get an email
            with the recommendation and can decide it by replying <span className="font-medium">approve</span> or{' '}
            <span className="font-medium">reject</span>. Only replies from this exact address are honored, and each
            decision is recorded in the audit trail under their name.
          </p>
        </div>
        <Badge
          className={cn(
            'uppercase tracking-wider text-[10px] shadow-none shrink-0',
            settings?.hrApproverEmail
              ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-emerald-200'
              : 'bg-muted text-muted-foreground hover:bg-muted',
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
          className={cn(inputCls, 'max-w-sm', invalid && 'border-red-400 focus:border-red-500')}
          aria-label="HR approver email"
        />
        <Button onClick={() => save(trimmed.length > 0 ? trimmed : null)} disabled={update.isPending || invalid || !dirty} className="gap-2 font-bold">
          <Check className="w-4 h-4" /> Save
        </Button>
        {settings?.hrApproverEmail && (
          <Button variant="outline" onClick={() => save(null)} disabled={update.isPending} className="gap-2">
            <Trash2 className="w-4 h-4" /> Clear
          </Button>
        )}
      </div>
      {invalid && (
        <p className="text-xs text-red-600 flex items-center gap-1 mt-2">
          <AlertTriangle className="w-3 h-3" /> Enter a valid email address.
        </p>
      )}
      {result && (
        <div className={cn('p-3 mt-3 text-sm rounded-md border flex items-start gap-3',
          result.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-red-50 border-red-200 text-red-900')}>
          {result.ok ? <Check className="w-5 h-5 shrink-0 mt-0.5 text-emerald-600" /> : <X className="w-5 h-5 shrink-0 mt-0.5 text-red-600" />}
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
    <Card className="shadow-sm">
      <CardContent className="p-6">
        <div className="flex items-start justify-between mb-5">
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-xl flex items-center justify-center shrink-0 border shadow-sm bg-violet-100 text-violet-700 border-violet-200">
              <Users className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-bold uppercase tracking-wider text-sm">Demo Volunteers</h3>
              <p className="text-sm text-muted-foreground mt-0.5">
                Real people for live demos. Saving authorizes their email/phone for real messages and calls — no one else
                can be contacted. "Create demo cases" runs each volunteer through the full agent pipeline.
              </p>
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="p-8 text-muted-foreground text-center border rounded-xl border-dashed">Loading volunteers...</div>
        ) : (
          <>
            <div className="space-y-4">
              {rows.map((v, i) => {
                const problem = problems[i];
                return (
                  <div key={i} className={cn('border rounded-lg p-4', problem && (v.name || v.email) ? 'border-amber-300 bg-amber-50/40' : 'bg-muted/10')}>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
                        <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground hover:text-red-600" title="Remove volunteer"
                          onClick={() => { setTouched(true); setNotice(null); setRows((prev) => prev.filter((_, idx) => idx !== i)); }}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                    {problem && (v.name || v.email) && (
                      <p className="text-xs text-amber-700 flex items-center gap-1 mt-2">
                        <AlertTriangle className="w-3 h-3" /> {problem}
                      </p>
                    )}
                    <PersonaBrief persona={(data?.personas ?? []).find((p) => p.key === v.persona)} volunteerName={v.name} />
                  
                  </div>
                );
              })}
              {rows.length === 0 && (
                <div className="p-6 text-sm text-muted-foreground text-center border rounded-xl border-dashed">
                  No volunteers yet. Add one to enable live demo delivery.
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2 mt-5">
              <Button variant="outline" className="gap-2" onClick={() => { setTouched(true); setRows((prev) => [...prev, blankVolunteer()]); }}>
                <Plus className="w-4 h-4" /> Add volunteer
              </Button>
              <Button onClick={save} disabled={update.isPending || !touched || anyInvalid} className="gap-2 font-bold">
                <Check className="w-4 h-4" /> Save & authorize
              </Button>
              <Button variant="secondary" onClick={runSeed} disabled={seed.isPending || touched || (data?.volunteers.length ?? 0) === 0}
                className="gap-2 font-bold" title={touched ? 'Save first, then create cases' : undefined}>
                <Rocket className="w-4 h-4" /> {seed.isPending ? 'Creating cases…' : 'Create demo cases'}
              </Button>
            </div>
            {touched && <p className="text-xs text-muted-foreground mt-2">Unsaved changes — save before creating demo cases.</p>}

            {notice && (
              <div className={cn('p-3 mt-4 text-sm rounded-md border flex items-start gap-3',
                notice.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-red-50 border-red-200 text-red-900')}>
                {notice.ok ? <Check className="w-5 h-5 shrink-0 mt-0.5 text-emerald-600" /> : <X className="w-5 h-5 shrink-0 mt-0.5 text-red-600" />}
                <p className="mt-0.5">{notice.message}</p>
              </div>
            )}

            {seedResults && (
              <div className="mt-4 border rounded-md divide-y">
                {seedResults.map((r, i) => (
                  <div key={i} className="p-3 text-sm flex items-center gap-3">
                    <Badge className={cn('uppercase tracking-wider text-[10px] shadow-none shrink-0',
                      r.status === 'seeded' ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-emerald-200'
                        : r.status === 'skipped' ? 'bg-slate-100 text-slate-700 hover:bg-slate-100 border-slate-200'
                          : 'bg-amber-100 text-amber-800 hover:bg-amber-100 border-amber-200')}>
                      {r.status}
                    </Badge>
                    <span className="font-medium">{r.name}</span>
                    <span className="text-muted-foreground">{r.note}</span>
                    {r.caseId !== null && (
                      <a href={`cases/${r.caseId}`} className="ml-auto text-primary font-medium hover:underline shrink-0">Open case #{r.caseId}</a>
                    )}
                  </div>
                ))}
              </div>
            )}

            <HrOperatorBrief />

            <RemoteApproverSettings />

            <p className="text-xs text-muted-foreground mt-4 flex items-start gap-1.5">
              <Phone className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              Twilio trial note: phone numbers must also be added as Verified Caller IDs in the Twilio console before live
              calls or WhatsApp will connect. WhatsApp volunteers must send the sandbox join message once.
            </p>
          </>
        )}
      </CardContent>
    </Card>
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
    <div className="space-y-8 max-w-3xl mx-auto pb-12">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1">Application-level configuration for the control tower.</p>
      </div>

      <Card className="shadow-sm">
        <CardContent className="p-6">
          <div className="flex items-start justify-between mb-5">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl flex items-center justify-center shrink-0 border shadow-sm bg-primary/10 text-primary border-primary/20">
                <Mail className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-bold uppercase tracking-wider text-sm">HR Alert Email</h3>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Where outage alerts go when the Gmail reply monitor breaks (and recovery notices when it resumes).
                </p>
              </div>
            </div>
            {!isLoading && (
              <Badge
                className={cn(
                  'uppercase tracking-wider text-[10px] shadow-none shrink-0',
                  settings?.effective
                    ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-emerald-200'
                    : 'bg-amber-100 text-amber-800 hover:bg-amber-100 border-amber-200',
                )}
              >
                {settings?.effective ? 'ACTIVE' : 'NOT SET'}
              </Badge>
            )}
          </div>

          {isLoading ? (
            <div className="p-8 text-muted-foreground text-center border rounded-xl border-dashed">Loading settings...</div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
                <div className="border rounded-md p-3 bg-muted/20">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Alerts currently go to</p>
                  <p className="text-sm font-mono mt-1 break-all">{settings?.effective ?? 'Nobody — alerts disabled'}</p>
                </div>
                <div className="border rounded-md p-3 bg-muted/20">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Source</p>
                  <p className="text-sm mt-1">{sourceLabel}</p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="hr-alert-email" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
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
                    'block w-full text-sm rounded-md h-10 px-3 border outline-none transition-colors bg-background shadow-sm',
                    invalid ? 'border-red-400 focus:border-red-500' : 'border-input focus:border-primary',
                  )}
                />
                {invalid && (
                  <p className="text-xs text-red-600 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> Enter a valid email address (e.g. hr@company.com).
                  </p>
                )}
                {settings?.envFallback && (
                  <p className="text-xs text-muted-foreground">
                    Leaving this empty falls back to the server-configured address ({settings.envFallback}).
                  </p>
                )}
              </div>

              <div className="flex gap-2 mt-5">
                <Button
                  onClick={() => save(trimmed.length > 0 ? trimmed : null)}
                  disabled={update.isPending || invalid || !dirty || trimmed.length === 0 && !settings?.hrAlertEmail}
                  className="gap-2 font-bold"
                >
                  <Check className="w-4 h-4" /> Save
                </Button>
                {settings?.hrAlertEmail && (
                  <Button
                    variant="outline"
                    onClick={() => save(null)}
                    disabled={update.isPending}
                    className="gap-2"
                  >
                    <Trash2 className="w-4 h-4" /> Clear stored address
                  </Button>
                )}
              </div>

              {result && (
                <div
                  className={cn(
                    'p-3 mt-4 text-sm rounded-md border flex items-start gap-3',
                    result.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-red-50 border-red-200 text-red-900',
                  )}
                >
                  {result.ok ? (
                    <Check className="w-5 h-5 shrink-0 mt-0.5 text-emerald-600" />
                  ) : (
                    <X className="w-5 h-5 shrink-0 mt-0.5 text-red-600" />
                  )}
                  <p className="mt-0.5">{result.message}</p>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardContent className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl flex items-center justify-center shrink-0 border shadow-sm bg-primary/10 text-primary border-primary/20">
                <PhoneCall className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-bold uppercase tracking-wider text-sm">Automatic Escalation Calls</h3>
                <p className="text-sm text-muted-foreground mt-0.5">
                  When an onboarding check breaches its SLA and the hire hasn't replied to any message, the System
                  Watcher places the escalation voice call itself. The recipient allowlist and hourly call limit
                  still apply, and the reason for each call is recorded on the case timeline.
                </p>
              </div>
            </div>
            {!isLoading && (
              <Badge
                className={cn(
                  'uppercase tracking-wider text-[10px] shadow-none shrink-0',
                  settings?.autoEscalationCalls
                    ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-emerald-200'
                    : 'bg-muted text-muted-foreground hover:bg-muted',
                )}
              >
                {settings?.autoEscalationCalls ? 'ON' : 'OFF'}
              </Badge>
            )}
          </div>

          {!isLoading && (
            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={!!settings?.autoEscalationCalls}
                aria-label="Automatic escalation calls"
                disabled={toggleCalls.isPending}
                onClick={() => saveAutoCalls(!settings?.autoEscalationCalls)}
                className={cn(
                  'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50',
                  settings?.autoEscalationCalls ? 'bg-primary border-primary' : 'bg-muted border-input',
                )}
              >
                <span
                  className={cn(
                    'inline-block h-5 w-5 rounded-full bg-background shadow transition-transform',
                    settings?.autoEscalationCalls ? 'translate-x-5' : 'translate-x-0.5',
                  )}
                />
              </button>
              <span className="text-sm">
                {settings?.autoEscalationCalls
                  ? 'On — overdue, unresponsive hires get an automatic escalation call.'
                  : 'Off — escalation calls are only placed manually from the case page.'}
              </span>
            </div>
          )}

          {callsResult && (
            <div
              className={cn(
                'p-3 mt-4 text-sm rounded-md border flex items-start gap-3',
                callsResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-red-50 border-red-200 text-red-900',
              )}
            >
              {callsResult.ok ? (
                <Check className="w-5 h-5 shrink-0 mt-0.5 text-emerald-600" />
              ) : (
                <X className="w-5 h-5 shrink-0 mt-0.5 text-red-600" />
              )}
              <p className="mt-0.5">{callsResult.message}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <DemoVolunteersCard />
    </div>
  );
}
