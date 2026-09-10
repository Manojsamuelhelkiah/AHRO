import React, { useEffect, useRef, useState } from 'react';
import {
  customFetch,
  getGetOnboardingAnalyticsQueryKey,
  getGetOnboardingDashboardQueryKey,
  getGetOnboardingOutcomeKpisQueryKey,
  getListOnboardingApprovalsQueryKey,
  getListOnboardingCasesQueryKey,
  getPinnedOrganizationIdForPage,
} from '@workspace/api-client-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarDays,
  Check,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Users,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  IconTile,
  Label,
  LoadingBlock,
  cn,
} from '@/components/ui-shared';
import { useOrganizationRole } from '@/hooks/use-organization-role';
import { useToast } from '@/hooks/use-toast';

export const SYNTHETIC_RESET_CONFIRMATION = 'REPLACE SYNTHETIC CASES';
export const SYNTHETIC_RESET_PATH = '/api/onboarding/synthetic-reset';

export type SyntheticResetStatus =
  | 'ready'
  | 'blocked'
  | 'completed'
  | 'unavailable';

export type SyntheticResetCandidate = {
  id: number;
  workerName: string;
  scenarioKey: string | null;
};

export type SyntheticResetReceipt = {
  deletedCaseIds: number[];
  createdCaseIds: number[];
  completedAt: string;
  retainedUploadCount?: number;
};

export type SyntheticResetResponse = {
  organizationId: string;
  status: SyntheticResetStatus;
  revision: string;
  candidates: SyntheticResetCandidate[];
  preservedCount: number;
  replacementCount: number;
  blockers: string[];
  warnings?: string[];
  receipt: SyntheticResetReceipt | null;
};

export const syntheticResetQueryKey = (organizationId: string) =>
  ['onboarding', 'synthetic-reset', organizationId] as const;

type RequestOptions = {
  organizationId: string;
  signal?: AbortSignal;
};

function assertPinnedOrganization(organizationId: string): void {
  if (getPinnedOrganizationIdForPage() !== organizationId) {
    throw new Error('The workspace changed while this card was open. Refresh the page before continuing.');
  }
}

export async function getSyntheticResetStatus(
  options: RequestOptions,
): Promise<SyntheticResetResponse> {
  assertPinnedOrganization(options.organizationId);
  return customFetch<SyntheticResetResponse>(SYNTHETIC_RESET_PATH, {
    method: 'GET',
    credentials: 'include',
    signal: options.signal,
    responseType: 'json',
    headers: { 'x-organization-id': options.organizationId },
  });
}

export async function postSyntheticReset(
  options: RequestOptions & { expectedRevision: string },
): Promise<SyntheticResetResponse> {
  assertPinnedOrganization(options.organizationId);
  const response = await customFetch<SyntheticResetResponse>(SYNTHETIC_RESET_PATH, {
    method: 'POST',
    credentials: 'include',
    signal: options.signal,
    responseType: 'json',
    headers: {
      'content-type': 'application/json',
      'x-organization-id': options.organizationId,
    },
    body: JSON.stringify({
      expectedRevision: options.expectedRevision,
      confirmation: SYNTHETIC_RESET_CONFIRMATION,
    }),
  });
  assertPinnedOrganization(options.organizationId);
  return response;
}

export function canSubmitSyntheticReset({
  data,
  organizationId,
  isFetching,
  confirmation,
  isFetched = true,
  statusNeedsRefresh = false,
}: {
  data: SyntheticResetResponse | undefined;
  organizationId: string | null;
  isFetching: boolean;
  confirmation: string;
  isFetched?: boolean;
  statusNeedsRefresh?: boolean;
}): boolean {
  return Boolean(
    data &&
      organizationId &&
      data.organizationId === organizationId &&
      data.status === 'ready' &&
      data.revision &&
      isFetched &&
      !statusNeedsRefresh &&
      !isFetching &&
      confirmation === SYNTHETIC_RESET_CONFIRMATION,
  );
}

export function syntheticResetErrorMessage(error: unknown): string {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined;

  if (status === 403) {
    return 'Only organization owners and admins can refresh synthetic cases.';
  }
  if (status === 409) {
    return 'This reset is stale or no longer safe. Refresh the status before confirming again; nothing was submitted automatically.';
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Synthetic case status is unavailable. Refresh to try again.';
}

function currentDateLabel(): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date());
}

function formatReceiptDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export const FRESH_EXAMPLES = [
  'Standard external hire',
  'Contractor/client project',
  'Rehire',
  'Internal transfer',
  'Background-check exception',
  'Critical-skill hire',
];

function StatusBadge({ status }: { status: SyntheticResetStatus }) {
  const tone =
    status === 'completed'
      ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]'
      : status === 'blocked'
        ? 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]'
        : status === 'unavailable'
          ? 'bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)]'
          : 'bg-[var(--primary-light)] text-[var(--primary)]';

  return <Badge className={cn('shrink-0 uppercase shadow-none', tone)}>{status}</Badge>;
}

function WarningPanel() {
  return (
    <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--status-amber)]/40 bg-[var(--status-amber-bg)] p-3 text-[var(--text-xs)] text-[var(--status-amber-fg)]">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="space-y-1.5">
          <p className="font-semibold">This is irreversible.</p>
          <p>
            Linked approvals and case history for the eligible synthetic cases will be deleted.
            Other cases are preserved.
          </p>
          <p>
            Private uploaded-file bytes and external-delivery audit evidence are retained. No App
            Storage file bytes are physically destroyed, including in shared development or
            production storage.
          </p>
          <p>
            New cases are paused, offline examples only: they cannot send email, WhatsApp, or
            calls, and cannot execute live changes.
          </p>
        </div>
      </div>
    </div>
  );
}

function ServerWarnings({ warnings }: { warnings?: string[] }) {
  if (!warnings || warnings.length === 0) return null;

  return (
    <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--status-amber)]/40 bg-[var(--status-amber-bg)] p-3 text-[var(--text-xs)] text-[var(--status-amber-fg)]">
      <p className="font-semibold">Before you continue</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {warnings.map((warning, index) => (
          <li key={`${warning}-${index}`}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}

function CandidateList({ candidates }: { candidates: SyntheticResetCandidate[] }) {
  if (candidates.length === 0) return null;

  return (
    <div className="mt-4">
      <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        Eligible synthetic cases ({candidates.length})
      </p>
      <div className="mt-2 divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
        {candidates.map((candidate) => (
          <div
            key={candidate.id}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 bg-[var(--surface)] px-3 py-2 text-[var(--text-sm)]"
          >
            <Users className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
            <span className="font-medium text-[var(--text-primary)]">{candidate.workerName}</span>
            <span className="font-mono text-[var(--text-xs)] text-[var(--text-muted)]">
              Case #{candidate.id}
            </span>
            {candidate.scenarioKey && (
              <span className="text-[var(--text-xs)] text-[var(--text-muted)]">
                · {candidate.scenarioKey}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function FreshExamples() {
  const date = currentDateLabel();
  return (
    <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-alt)] p-3">
      <div className="flex items-start gap-2">
        <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]" />
        <div>
          <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">
            Six fresh examples use current dates
          </p>
          <p className="mt-0.5 text-[var(--text-xs)] text-[var(--text-muted)]">
            New synthetic cases will be dated {date}. They remain offline and cannot contact anyone
            or make live changes.
          </p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {FRESH_EXAMPLES.map((example) => (
          <div
            key={example}
            className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-[var(--text-xs)] text-[var(--text-secondary)]"
          >
            <span className="font-medium text-[var(--text-primary)]">{example}</span>
            <span className="mt-0.5 block text-[var(--text-muted)]">{date}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Receipt({ receipt }: { receipt: SyntheticResetReceipt }) {
  return (
    <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--status-green)]/30 bg-[var(--status-green-bg)] p-3 text-[var(--status-green-fg)]">
      <div className="flex items-start gap-2">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <p className="font-semibold">Synthetic cases refreshed</p>
          <p className="mt-1 text-[var(--text-xs)]">
            Completed {formatReceiptDate(receipt.completedAt)}. Old count:{' '}
            {receipt.deletedCaseIds.length}; new count: {receipt.createdCaseIds.length}.
          </p>
        </div>
      </div>
      <div className="mt-3 border-t border-[var(--status-green)]/20 pt-3">
        <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider">Created case IDs</p>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[var(--text-xs)]">
          {receipt.createdCaseIds.map((caseId) => (
            <a
              key={caseId}
              href={`/cases/${caseId}`}
              className="inline-flex items-center gap-1 font-medium underline decoration-current/40 underline-offset-2 hover:decoration-current"
            >
              Case #{caseId}
              <ExternalLink className="h-3 w-3" />
            </a>
          ))}
        </div>
      </div>
      <p className="mt-2 text-[var(--text-xs)]">
        Deleted case IDs: {receipt.deletedCaseIds.length > 0 ? receipt.deletedCaseIds.join(', ') : 'None'}
      </p>
      {typeof receipt.retainedUploadCount === 'number' && (
        <p className="mt-1 text-[var(--text-xs)]">
          Private uploaded files retained: {receipt.retainedUploadCount}
        </p>
      )}
    </div>
  );
}

export function SyntheticResetCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { isHR, loading: roleLoading, role } = useOrganizationRole();
  const organizationId = getPinnedOrganizationIdForPage();
  const [confirmation, setConfirmation] = useState('');
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [statusNeedsRefresh, setStatusNeedsRefresh] = useState(false);
  const mountedOrganizationId = useRef(organizationId);

  const statusQuery = useQuery({
    queryKey: organizationId ? syntheticResetQueryKey(organizationId) : ['onboarding', 'synthetic-reset', 'no-org'],
    queryFn: ({ signal }) =>
      getSyntheticResetStatus({
        organizationId: organizationId as string,
        signal,
      }),
    enabled: Boolean(organizationId && isHR && !roleLoading),
    retry: false,
    staleTime: 0,
    refetchOnMount: true,
  });

  const resetMutation = useMutation({
    mutationFn: ({ expectedRevision }: { expectedRevision: string }) =>
      postSyntheticReset({
        organizationId: mountedOrganizationId.current as string,
        expectedRevision,
      }),
    onSuccess: (response) => {
      if (
        !mountedOrganizationId.current ||
        getPinnedOrganizationIdForPage() !== mountedOrganizationId.current ||
        response.organizationId !== mountedOrganizationId.current
      ) {
        return;
      }

      queryClient.setQueryData(
        syntheticResetQueryKey(mountedOrganizationId.current),
        response,
      );
      setConfirmation('');
      setNotice(null);
      setStatusNeedsRefresh(false);
      queryClient.invalidateQueries({ queryKey: getListOnboardingCasesQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetOnboardingDashboardQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListOnboardingApprovalsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetOnboardingAnalyticsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetOnboardingOutcomeKpisQueryKey() });
      toast({
        title: 'Synthetic cases refreshed',
        description: `Created ${response.receipt?.createdCaseIds.length ?? response.replacementCount} fresh offline examples.`,
      });
    },
    onError: (error) => {
      if (getPinnedOrganizationIdForPage() !== mountedOrganizationId.current) return;
      setConfirmation('');
      if (
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        (error as { status?: unknown }).status === 409
      ) {
        setStatusNeedsRefresh(true);
      }
      setNotice({ ok: false, message: syntheticResetErrorMessage(error) });
    },
  });

  useEffect(() => {
    if (mountedOrganizationId.current === organizationId) return;
    mountedOrganizationId.current = organizationId;
    setConfirmation('');
    setNotice(null);
    setStatusNeedsRefresh(false);
    resetMutation.reset();
  }, [organizationId, resetMutation.reset]);

  const data =
    !statusQuery.isError && statusQuery.data?.organizationId === organizationId
      ? statusQuery.data
      : undefined;
  const canSubmit = canSubmitSyntheticReset({
    data,
    organizationId,
    isFetching: statusQuery.isFetching || resetMutation.isPending,
    confirmation,
    isFetched: statusQuery.isFetchedAfterMount,
    statusNeedsRefresh,
  });

  const refreshStatus = () => {
    setConfirmation('');
    setNotice(null);
    setStatusNeedsRefresh(false);
    resetMutation.reset();
    void statusQuery.refetch();
  };

  const submit = () => {
    if (!canSubmit || !data || !mountedOrganizationId.current) return;
    setNotice(null);
    resetMutation.mutate({ expectedRevision: data.revision });
  };

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] bg-[var(--surface-alt)] p-[var(--space-lg)]">
          <div className="flex min-w-0 items-start gap-3">
            <IconTile
              icon={RefreshCw}
              className="bg-[var(--surface-soft)] text-[var(--text-secondary)] border-transparent"
            />
            <div className="min-w-0">
              <h3 className="text-[var(--text-xs)] font-semibold uppercase tracking-[0.05em] text-[var(--text-primary)]">
                Refresh synthetic cases
              </h3>
              <p className="mt-0.5 text-[var(--text-xs)] text-[var(--text-muted)]">
                One-off reset for the current workspace&apos;s offline demo cases.
              </p>
            </div>
          </div>
          {data && <StatusBadge status={data.status} />}
        </div>

        <div className="p-[var(--space-lg)]">
          {roleLoading ? (
            <LoadingBlock>Checking workspace permissions...</LoadingBlock>
          ) : !role ? (
            <div className="flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-3 text-[var(--text-sm)] text-[var(--text-muted)]">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <p>Workspace permissions are unavailable. Refresh the page to continue.</p>
            </div>
          ) : !isHR ? (
            <div className="space-y-3">
              <p className="text-[var(--text-sm)] text-[var(--text-secondary)]">
                Refreshing synthetic cases is restricted to organization owners and admins.
                Members can see why this control exists, but cannot inspect or change protected
                reset data.
              </p>
              <WarningPanel />
            </div>
          ) : !organizationId ? (
            <div className="flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-3 text-[var(--text-sm)] text-[var(--text-muted)]">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <p>Select a workspace before refreshing synthetic cases.</p>
            </div>
          ) : statusQuery.isPending && !data ? (
            <LoadingBlock>Loading synthetic case status...</LoadingBlock>
          ) : statusQuery.isError && !data ? (
            <div className="space-y-3">
              <p className="rounded-[var(--radius-md)] bg-[var(--status-red-bg)] p-3 text-[var(--text-sm)] text-[var(--status-red-fg)]">
                {syntheticResetErrorMessage(statusQuery.error)}
              </p>
              <Button variant="outline" className="gap-2" onClick={refreshStatus} disabled={statusQuery.isFetching}>
                <RefreshCw className={cn('h-3.5 w-3.5', statusQuery.isFetching && 'animate-spin')} />
                Refresh status
              </Button>
            </div>
          ) : statusQuery.data && !data ? (
            <div className="space-y-3">
              <p className="rounded-[var(--radius-md)] bg-[var(--status-amber-bg)] p-3 text-[var(--text-sm)] text-[var(--status-amber-fg)]">
                Workspace status changed while this card was open. Refresh the status before continuing.
              </p>
              <Button variant="outline" className="gap-2" onClick={refreshStatus} disabled={statusQuery.isFetching}>
                <RefreshCw className={cn('h-3.5 w-3.5', statusQuery.isFetching && 'animate-spin')} />
                Refresh status
              </Button>
            </div>
          ) : data ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-alt)] p-3">
                  <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    Cases eligible for reset
                  </p>
                  <p className="mt-1 text-[var(--text-lg)] font-semibold text-[var(--text-primary)]">
                    {data.candidates.length}
                  </p>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
                    {data.preservedCount} other case{data.preservedCount === 1 ? '' : 's'} preserved
                  </p>
                </div>
                <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-alt)] p-3">
                  <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    Fresh replacements
                  </p>
                  <p className="mt-1 text-[var(--text-lg)] font-semibold text-[var(--text-primary)]">
                    {data.replacementCount}
                  </p>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
                    Created as six offline synthetic examples
                  </p>
                </div>
              </div>

              <CandidateList candidates={data.candidates} />
              <ServerWarnings warnings={data.warnings} />

              {statusQuery.isFetching && (
                <p className="mt-3 text-[var(--text-xs)] text-[var(--text-muted)]">Refreshing status...</p>
              )}

              {data.status === 'blocked' && (
                <div className="mt-4 space-y-3">
                  <div className="rounded-[var(--radius-md)] bg-[var(--status-amber-bg)] p-3 text-[var(--text-sm)] text-[var(--status-amber-fg)]">
                    <p className="font-semibold">Reset is blocked</p>
                    {data.blockers.length > 0 && (
                      <ul className="mt-1 list-disc space-y-1 pl-5">
                        {data.blockers.map((blocker, index) => <li key={`${blocker}-${index}`}>{blocker}</li>)}
                      </ul>
                    )}
                  </div>
                  <Button variant="outline" className="gap-2" onClick={refreshStatus} disabled={statusQuery.isFetching}>
                    <RefreshCw className={cn('h-3.5 w-3.5', statusQuery.isFetching && 'animate-spin')} />
                    Refresh status
                  </Button>
                </div>
              )}

              {data.status === 'unavailable' && (
                <div className="mt-4 space-y-3">
                  <p className="rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-3 text-[var(--text-sm)] text-[var(--text-muted)]">
                    No eligible synthetic cases are available in this workspace.
                  </p>
                  <Button variant="outline" className="gap-2" onClick={refreshStatus} disabled={statusQuery.isFetching}>
                    <RefreshCw className={cn('h-3.5 w-3.5', statusQuery.isFetching && 'animate-spin')} />
                    Refresh status
                  </Button>
                </div>
              )}

              {data.status === 'ready' && (
                <>
                  <FreshExamples />
                  <WarningPanel />
                  <div className="mt-4 space-y-2">
                    <Label htmlFor="synthetic-reset-confirmation">Type to confirm</Label>
                    <input
                      id="synthetic-reset-confirmation"
                      aria-label="Type REPLACE SYNTHETIC CASES to confirm"
                      value={confirmation}
                      onChange={(event) => {
                        setConfirmation(event.target.value);
                        setNotice(null);
                      }}
                      disabled={
                        (!canSubmit &&
                          (statusQuery.isFetching ||
                            !statusQuery.isFetchedAfterMount ||
                            statusNeedsRefresh ||
                            !data.revision ||
                            data.status !== 'ready')) ||
                        resetMutation.isPending
                      }
                      placeholder={SYNTHETIC_RESET_CONFIRMATION}
                      className="mt-1 block h-9 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text-sm)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
                      Confirmation is case-sensitive and must match exactly.
                    </p>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      variant="destructive"
                      className="gap-2"
                      onClick={submit}
                      disabled={!canSubmit}
                    >
                      <Trash2 className="h-4 w-4" />
                      {resetMutation.isPending ? 'Refreshing...' : 'Refresh synthetic cases'}
                    </Button>
                    <Button variant="ghost" className="gap-2" onClick={refreshStatus} disabled={statusQuery.isFetching || resetMutation.isPending}>
                      <RefreshCw className="h-3.5 w-3.5" />
                      Reload status
                    </Button>
                  </div>
                </>
              )}

              {data.status === 'completed' && data.receipt && <Receipt receipt={data.receipt} />}

              {notice && (
                <div
                  className={cn(
                    'mt-4 flex items-start gap-2 rounded-[var(--radius-md)] p-3 text-[var(--text-sm)]',
                    notice.ok
                      ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]'
                      : 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)]',
                  )}
                  role="alert"
                >
                  {notice.ok ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
                  <p>{notice.message}</p>
                </div>
              )}
            </>
          ) : (
            <LoadingBlock>Loading synthetic case status...</LoadingBlock>
          )}
        </div>
      </CardContent>
    </Card>
  );
}