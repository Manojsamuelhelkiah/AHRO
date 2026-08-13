import React, { useEffect, useState } from 'react';
import {
  useGetOnboardingSettings,
  useUpdateOnboardingSettings,
  getGetOnboardingSettingsQueryKey,
  getGetOnboardingDashboardQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, Button, Badge, Label, cn } from '@/components/ui-shared';
import { Mail, Check, X, AlertTriangle, Trash2 } from 'lucide-react';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useGetOnboardingSettings();
  const update = useUpdateOnboardingSettings();

  const [draft, setDraft] = useState('');
  const [touched, setTouched] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

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
    </div>
  );
}
