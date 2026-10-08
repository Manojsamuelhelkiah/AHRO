import React, { useState } from 'react';
import { useParams } from 'wouter';
import {
  useGetOnboardingCase,
  useListOnboardingCaseEvents,
  useListOnboardingCaseCommunications,
  useListOnboardingCaseDocuments,
  useListOnboardingApprovals,
  useListOnboardingCaseRecords,
  useGetOnboardingOperationalRequests,
  getGetOnboardingCaseQueryKey,
  getListOnboardingCaseEventsQueryKey,
  getListOnboardingCaseCommunicationsQueryKey,
  getListOnboardingCaseDocumentsQueryKey,
  getListOnboardingApprovalsQueryKey,
  getListOnboardingCaseRecordsQueryKey,
  getGetOnboardingOperationalRequestsQueryKey,
  useGetOnboardingChannels,
  getGetOnboardingChannelsQueryKey,
  getPinnedOrganizationIdForPage,
  useGetOnboardingDemoController,
  getGetOnboardingDemoControllerQueryKey
} from '@workspace/api-client-react';
import { useQuery } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';
import { useListLifecycleHolds } from '../../hooks/use-privacy-api';
import { Link } from 'wouter';
import { Presentation, AlertTriangle } from 'lucide-react';

import { useUser } from '@clerk/react';
import { CaseHeader, CaseHealthStrip, CaseTabs, isOfflineDemoSample } from './detail/components';
import { GatewaysStrip } from './detail/gateways-strip';
import { EmployeeVaultPanel } from './detail/employee-vault-panel';
import { OverviewTab } from './detail/overview';
import { TasksTab, ActivityTab, CommunicationsTab, AuditTab } from './detail/tabs-content';
import { FrontlineTab } from './detail/frontline-tab';
import { DocumentsTab } from './detail/documents-tab';
import { ExplainabilityTab } from './detail/explainability-tab';
import { PortalControls } from './detail/portal-controls';
import { EarlyTenurePanel } from './detail/early-tenure-panel';
import { getApprovalRefetchInterval } from '../../lib/approval-actions';
import { SimulationPanel } from './detail/simulation-panel';
import { isDemoCoverageCase } from './case-presentation';
import { CaseAccessProvider, RestrictedActionNotice, type CaseAccessPermissions } from './detail/case-access';

export function CaseDetailPage() {
  const { id } = useParams();
  const caseId = Number(id);
  const { user } = useUser();
  const [activeTab, setActiveTab] = useState(() => {
    const requested = typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("tab")?.toLowerCase();
    return requested === "communications" ? "Communications" : requested === "early-tenure" ? "Early tenure" : "Overview";
  });

  const { data: c, isLoading, error: caseError } = useGetOnboardingCase(caseId, {
    query: {
      enabled: !!caseId,
      queryKey: getGetOnboardingCaseQueryKey(caseId),
      retry: false,
      refetchInterval: (query: any) => {
        const status = query?.state?.data?.orchestrationStatus;
        return (status === 'running' || status === 'waiting-approval' || status === 'blocked' || status === 'checklist-blocked' || status === 'idle') ? 2500 : false;
      }
    }
  });
  const {
    data: permissions,
    isLoading: permissionsLoading,
    error: permissionsError,
  } = useQuery<CaseAccessPermissions>({
    queryKey: ['onboarding-case-access-permissions', getPinnedOrganizationIdForPage() || 'anon', user?.id || 'anon', caseId],
    queryFn: () => customFetch<CaseAccessPermissions>(
      `/api/onboarding/cases/${caseId}/access-permissions`,
      { responseType: 'json' },
    ),
    enabled: Number.isSafeInteger(caseId) && caseId > 0,
    retry: false,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
  const { data: standardIntakeEvidence } = useQuery({
    queryKey: ['standard-intake-evidence', caseId],
    queryFn: () => customFetch<{
      sourceIdentity: string;
      sourceEventId: string;
      eventType: 'accepted-offer' | 'scheduled-preboarding';
      acceptanceEvidenceReference: string;
      state: string;
      activationStatus: 'awaiting-review' | 'scheduled' | 'due-review' | 'released';
      activationDueAt: string | null;
    }>(`/api/onboarding/cases/${caseId}/standard-intake-evidence`, { responseType: 'json' }),
    // Most cases do not originate in standard intake. A 404 is deliberately
    // ignored and no request is made until a real case has loaded.
    enabled: Boolean(c?.id) && permissions?.access.flowRead === true && permissions?.sensitive.identity.read === true,
    retry: false,
  });

  const { data: events } = useListOnboardingCaseEvents(caseId, {
    query: {
      enabled: !!caseId && permissions?.access.flowRead === true && permissions?.access.notesRead === true,
      queryKey: getListOnboardingCaseEventsQueryKey(caseId),
      refetchInterval: () => {
        return (c?.orchestrationStatus === 'running' || c?.orchestrationStatus === 'waiting-approval' || c?.orchestrationStatus === 'blocked' || c?.orchestrationStatus === 'checklist-blocked' || c?.orchestrationStatus === 'idle') ? 2500 : false;
      }
    }
  });

  const { data: docs } = useListOnboardingCaseDocuments(caseId, {
    query: {
      enabled: !!caseId && permissions?.access.flowRead === true,
      queryKey: getListOnboardingCaseDocumentsQueryKey(caseId),
    }
  });

  const { data: comms } = useListOnboardingCaseCommunications(caseId, {
    query: {
      enabled: !!caseId && permissions?.access.flowRead === true
        && permissions?.access.notesRead === true
        && (c?.fictionalOfflineIdentity === true
          || Object.values(permissions?.sensitive ?? {}).every((permission) => permission.read)),
      queryKey: getListOnboardingCaseCommunicationsQueryKey(caseId),
      refetchInterval: () => {
        return (c?.orchestrationStatus === 'running' || c?.orchestrationStatus === 'waiting-approval' || c?.orchestrationStatus === 'blocked' || c?.orchestrationStatus === 'checklist-blocked' || c?.orchestrationStatus === 'idle') ? 2500 : false;
      }
    }
  });

  const { data: channels } = useGetOnboardingChannels({
    query: {
      enabled: !!caseId && permissions?.access.notesRead === true
        && Object.values(permissions?.sensitive ?? {}).every((permission) => permission.read),
      queryKey: getGetOnboardingChannelsQueryKey(),
      staleTime: 60_000,
    }
  });

  const { data: approvalsRaw } = useListOnboardingApprovals({ status: 'all' }, {
    query: {
      queryKey: getListOnboardingApprovalsQueryKey({ status: 'all' }),
      enabled: permissions?.access.flowRead === true && permissions?.access.notesRead === true,
      // Email decisions can resolve a review in another session. Poll only
      // while this finite queue contains pending approvals.
      refetchInterval: (query) => getApprovalRefetchInterval(query.state.data),
    }
  });

  const approvals = approvalsRaw?.filter((a: any) => a.caseId === caseId) || [];
  const pendingApprovals = approvals.filter((a: any) => a.status === 'pending');

  const { data: records } = useListOnboardingCaseRecords(caseId, {
    query: {
      enabled: !!caseId && permissions?.access.flowRead === true
        && permissions?.access.profileRead === true
        && permissions?.sensitive.identity.read === true
        && c?.hireType === 'rehire',
      queryKey: getListOnboardingCaseRecordsQueryKey(caseId),
    }
  });

  const { data: requestsEnv, isError: requestsLoadError } = useGetOnboardingOperationalRequests(caseId, {
    query: {
      enabled: !!caseId && permissions?.access.flowRead === true,
      queryKey: getGetOnboardingOperationalRequestsQueryKey(caseId),
      refetchInterval: () => {
        return (c?.orchestrationStatus === 'running' || c?.orchestrationStatus === 'waiting-approval' || c?.orchestrationStatus === 'blocked' || c?.orchestrationStatus === 'checklist-blocked' || c?.orchestrationStatus === 'idle') ? 2500 : false;
      }
    }
  });

  const { data: caps } = useGetOnboardingDemoController({
    query: {
      enabled: !!caseId && permissions?.access.flowRead === true && permissions?.sensitive.identity.read === true,
      queryKey: getGetOnboardingDemoControllerQueryKey(),
      retry: false
    }
  });

  const offlineSample = c ? isOfflineDemoSample(c) : false;
  const { error: privacyError } = useListLifecycleHolds({
    enabled: Boolean(c) && !offlineSample && permissions?.access.flowRead === true,
  });
  const hasRestrictedCaseActions = !permissions?.access.flowEdit
    || !permissions?.access.profileEdit
    || !permissions?.access.notesEdit
    || Object.values(permissions?.sensitive ?? {}).some((permission) => !permission.read || !permission.edit);

  if (permissionsLoading) return <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>Checking case permissions...</div>;

  if (permissionsError || !permissions) {
    return (
      <div role="alert" className="max-w-3xl mx-auto mt-12 p-8 bg-[var(--status-amber-bg)] border border-[var(--status-amber-fg)] rounded-lg text-center">
        <div className="flex justify-center mb-4"><AlertTriangle className="h-10 w-10 text-[var(--status-amber-fg)]" /></div>
        <h2 className="text-xl font-bold text-[var(--status-amber-fg)] mb-2">Case access could not be confirmed</h2>
        <p className="text-[var(--status-amber-fg)] opacity-90">The current permissions could not be loaded. Refresh the page before viewing or changing case information.</p>
      </div>
    );
  }

  if (!permissions.access.flowRead) {
    return (
      <div className="max-w-3xl mx-auto mt-12 p-8 bg-[var(--status-red-bg)] border border-[var(--status-red-fg)] rounded-lg text-center">
        <div className="flex justify-center mb-4"><AlertTriangle className="h-10 w-10 text-[var(--status-red-fg)]" /></div>
        <h2 className="text-xl font-bold text-[var(--status-red-fg)] mb-2">Case access restricted</h2>
        <p className="text-[var(--status-red-fg)] opacity-90">Your current case permissions do not allow you to view this case. Request the appropriate case-read access from your administrator.</p>
      </div>
    );
  }

  if (isLoading) return <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>Loading case workspace...</div>;

  if (caseError) {
    const status = (caseError as any)?.response?.status;
    if (status === 403) {
      return (
        <div className="max-w-3xl mx-auto mt-12 p-8 bg-[var(--status-red-bg)] border border-[var(--status-red-fg)] rounded-lg text-center">
          <div className="flex justify-center mb-4"><AlertTriangle className="h-10 w-10 text-[var(--status-red-fg)]" /></div>
          <h2 className="text-xl font-bold text-[var(--status-red-fg)] mb-2">Authority Restricted</h2>
          <p className="text-[var(--status-red-fg)] opacity-90">You do not have the required authority assignment to view this case.</p>
        </div>
      );
    }
    return <div className="p-8 text-center text-[var(--status-red)] font-bold">Error loading case: {(caseError as any)?.message}</div>;
  }

  if (privacyError && (privacyError as any)?.message?.includes('AUTHORITY_RESTRICTED')) {
    return (
      <div className="max-w-3xl mx-auto mt-12 p-8 bg-[var(--status-red-bg)] border border-[var(--status-red-fg)] rounded-lg text-center">
        <div className="flex justify-center mb-4"><AlertTriangle className="h-10 w-10 text-[var(--status-red-fg)]" /></div>
        <h2 className="text-xl font-bold text-[var(--status-red-fg)] mb-2">Authority Restricted</h2>
        <p className="text-[var(--status-red-fg)] opacity-90">You do not have the required authority assignment to view this case's privacy status.</p>
      </div>
    );
  }

  if (!c) return <div className="p-8 text-center text-[var(--status-red)] font-bold">Case not found.</div>;

  const demoSession = caps?.available ? caps.existingSessions.find((s: any) => s.caseId === caseId) : undefined;
  const uatCoverageSample = isDemoCoverageCase(c);

  const restrictedFields: string[] = [];
  const canViewIdentity = permissions.access.profileRead &&
    (permissions.sensitive.identity.read || c.fictionalOfflineIdentity === true);
  if (!canViewIdentity || c.workerName === "Restricted candidate") {
    restrictedFields.push("Identity (Name, Email, Phone, Manager, Recruiter)");
  }

  return (
    <CaseAccessProvider value={permissions}>
    <div className="max-w-7xl mx-auto px-6 md:px-8">
      {restrictedFields.length > 0 && (
        <div className="mb-6 p-3 bg-[var(--status-amber-bg)] border border-[var(--status-amber-fg)] rounded-md flex items-start gap-3 shadow-sm">
          <AlertTriangle className="h-5 w-5 text-[var(--status-amber-fg)] shrink-0 mt-0.5" />
          <div>
            <h4 className="font-semibold text-[var(--status-amber-fg)] text-sm">Operational View Restricted</h4>
            <p className="text-[var(--status-amber-fg)] text-sm mt-1">
              Some fields are restricted by your authority assignment and are intentionally omitted from this view (not absent from the record):
              <span className="font-mono block mt-1 text-xs opacity-90">{restrictedFields.join(', ')}</span>
            </p>
          </div>
        </div>
      )}
      {hasRestrictedCaseActions && (
        <div role="status" className="mb-5 rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-sm text-[var(--status-amber-fg)]">
          Some case actions are restricted by your current permissions. Edit, profile, and notes controls are shown only when their corresponding access is available.
        </div>
      )}

      {demoSession && (
        <div className="mb-4 p-3 bg-[var(--primary-light)] border border-[var(--primary)] border-opacity-30 rounded-md flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-2 text-[var(--primary-dark)] text-sm font-medium">
            <Presentation className="h-4 w-4" />
            This is a simulated demo case ({demoSession.scenario}).
          </div>
          <Link href={`/demo-controller/${demoSession.runId}`} className="text-xs font-semibold bg-[var(--surface)] text-[var(--primary-dark)] px-3 py-1.5 rounded shadow-sm border border-[var(--primary)] border-opacity-20 hover:bg-[var(--primary-light)] transition-colors">
            Open Control Tower
          </Link>
        </div>
      )}
      <CaseHeader c={c} caseId={caseId} setTab={setActiveTab} />
      {!offlineSample && <EmployeeVaultPanel caseId={caseId} />}

      {!offlineSample && c.hybridDemoSimulation === true && permissions.access.flowRead && (
        <SimulationPanel
          caseId={caseId}
          recipientEmail={null}
          emailPromptAvailable={c.candidateEmailAuthorized === true}
        />
      )}

      {offlineSample ? (
        <>
          <div className="mb-6 rounded-lg border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-4 shadow-sm">
            <h2 className="text-sm font-bold text-[var(--status-amber-fg)]">Service-case synopsis</h2>
            <p className="mt-1 text-sm leading-relaxed text-[var(--status-amber-fg)]">
              {c.planSummary || 'This offline Demo sample has no live service execution.'}
            </p>
            <p className="mt-2 text-xs font-medium text-[var(--status-amber-fg)]">
              Simulated/manual sample only. No onboarding gateway is completed, and no HRIS, payroll, benefits, IAM, LMS, mobility, document, or other provider connection is active.
            </p>
          </div>
          {uatCoverageSample ? (
            <div className="mb-6 rounded-lg border border-[var(--primary)] border-opacity-30 bg-[var(--primary-light)] p-4 shadow-sm">
              <h2 className="text-sm font-bold text-[var(--primary-dark)]">UAT coverage sample</h2>
              <p className="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">
                This sample is evaluated through the UAT Test Center. Per-case response simulation is intentionally unavailable for UAT-isolated cases.
              </p>
              <Link
                href="/uat-test-center"
                className="mt-3 inline-flex rounded-md border border-[var(--primary)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-dark)] transition-colors hover:bg-[var(--primary-light)]"
              >
                Open UAT Test Center
              </Link>
            </div>
          ) : (
            permissions.access.flowRead
              ? <SimulationPanel
                  caseId={caseId}
                  recipientEmail={demoSession?.selectedVolunteerId
                    ? (demoSession.selectedVolunteer?.email ?? null)
                    : null}
                  emailPromptAvailable={c.candidateEmailAuthorized === true}
                />
              : <RestrictedActionNotice>Simulation is restricted by your current case permissions.</RestrictedActionNotice>
          )}
        </>
      ) : (
        <>
          <GatewaysStrip
            c={c}
            standardIntakeEvidence={standardIntakeEvidence}
            gateApproval={pendingApprovals.find((approval: any) =>
              approval.ruleRef === 'Gate A — offer-acceptance package',
            )}
          />
          {permissions.access.flowEdit && permissions.access.profileEdit && permissions.sensitive.identity.edit
            ? <PortalControls caseId={caseId} joiningDate={c.joiningDate} />
            : <div className="mb-6"><div role="status" className="rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] px-3 py-2 text-xs text-[var(--status-amber-fg)]">Logistics and portal edits are restricted by your current case permissions.</div></div>}
        </>
      )}
      <CaseHealthStrip c={c} pendingApprovals={pendingApprovals} offlineSample={offlineSample} />

      <CaseTabs activeTab={activeTab} setTab={setActiveTab} offlineSample={offlineSample} />

      <div className="pt-2">
        {activeTab === 'Overview' && (
          <OverviewTab
            c={c}
            caseId={caseId}
            events={events || []}
            docs={docs || []}
            comms={comms || []}
            approvals={approvals}
            pendingApprovals={pendingApprovals}
            records={records || []}
            setTab={setActiveTab}
          />
        )}

        {activeTab === 'Early tenure' && !offlineSample && (permissions.access.flowEdit && permissions.access.profileEdit && permissions.sensitive.identity.edit
          ? <EarlyTenurePanel caseId={caseId} joiningDate={c.joiningDate} />
          : <RestrictedActionNotice>Early-tenure case actions are restricted by your current permissions.</RestrictedActionNotice>)}
        {activeTab === 'Tasks' && <TasksTab c={c} />}
        {activeTab === 'Frontline' && (permissions.access.flowEdit && permissions.access.notesEdit && Object.values(permissions.sensitive).every((permission) => permission.edit)
          ? <FrontlineTab caseId={caseId} />
          : <RestrictedActionNotice>Frontline case actions are restricted by your current permissions.</RestrictedActionNotice>)}
        {activeTab === 'Documents' && <DocumentsTab caseId={caseId} docs={docs || []} />}
        {activeTab === 'Activity' && (permissions.access.notesRead
          ? <ActivityTab events={events || []} />
          : <RestrictedActionNotice>Activity notes are restricted by your current permissions.</RestrictedActionNotice>)}
        {activeTab === 'Communications' && <CommunicationsTab caseId={caseId} c={c} comms={comms || []} channels={channels} requestsEnv={requestsEnv} requestsLoadError={requestsLoadError} enforceCasePermissions />}
        {activeTab === 'Audit' && (permissions.access.notesRead
          ? <AuditTab events={events || []} approvals={approvals} records={records || []} />
          : <RestrictedActionNotice>Audit notes are restricted by your current permissions.</RestrictedActionNotice>)}
        {activeTab === 'Ask AI' && permissions.access.profileRead && permissions.access.notesRead && Object.values(permissions.sensitive).every((permission) => permission.read)
          && <ExplainabilityTab key={`${getPinnedOrganizationIdForPage() || 'anon'}-${user?.id || 'anon'}-${caseId}`} caseId={caseId} userId={user?.id} />}
      </div>
    </div>
    </CaseAccessProvider>
  );
}
