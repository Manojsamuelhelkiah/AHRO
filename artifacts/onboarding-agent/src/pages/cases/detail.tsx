import React, { useState, useEffect } from 'react';
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
} from '@workspace/api-client-react';
import { useQuery } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';
import { useListLifecycleHolds } from '../../hooks/use-privacy-api';
import { Link, Redirect } from 'wouter';
import { Presentation, AlertTriangle } from 'lucide-react';

import { useUser } from '@clerk/react';
import { CaseHeader, OriginalIntent, CaseHealthStrip, CaseTabs, isOfflineDemoSample } from './detail/components';
import { OperationalPreparationPanel } from './detail/operational-preparation-panel';
import { GatewaysStrip } from './detail/gateways-strip';
import { EmployeeVaultPanel } from './detail/employee-vault-panel';
import { OverviewTab } from './detail/overview';
import { TasksTab, ActivityTab, CommunicationsTab, AuditTab } from './detail/tabs-content';
import { SyntheticJourneySummary, SyntheticJourneyStages, SyntheticJourneyCommunications } from './detail/synthetic-journey';
import { FrontlineTab } from './detail/frontline-tab';
import { DocumentsTab } from './detail/documents-tab';
import { ExplainabilityTab, clearCaseAnalysisMemory } from './detail/explainability-tab';
import { PortalControls } from './detail/portal-controls';
import { EarlyTenurePanel } from './detail/early-tenure-panel';
import { getApprovalRefetchInterval } from '../../lib/approval-actions';
import { SimulationPanel } from './detail/simulation-panel';
import { caseTitleOf, caseTypeOf, isDemoCoverageCase, isFictionalOfflineExample, sampleCaseReference, caseSummary } from './case-presentation';
import { HroIntakeRequestPanel } from '../../components/hro-intake-request-panel';
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
    data: rawPermissions,
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
  const permissions = rawPermissions && c?.controllerRetired ? {
    ...rawPermissions,
    access: { ...rawPermissions.access, flowEdit: false, profileEdit: false, notesEdit: false },
    sensitive: Object.fromEntries(Object.entries(rawPermissions.sensitive).map(
      ([key, value]) => [key, { ...value, edit: false }],
    )) as typeof rawPermissions.sensitive,
  } : rawPermissions;
  const canAnalyze = Boolean(permissions?.access.profileRead && permissions.access.notesRead &&
    Object.values(permissions.sensitive).every(permission => permission.read) && !permissionsError && !caseError);
  useEffect(() => {
    if (!canAnalyze) clearCaseAnalysisMemory(caseId, user?.id);
  }, [canAnalyze, caseId, user?.id]);
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

  const offlineSample = c ? c.controllerRetired || isOfflineDemoSample(c) : false;
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

  if (c.hireType === 'separation') return <Redirect to={`/cases/separations/${caseId}`} />;

  const uatCoverageSample = isDemoCoverageCase(c);

  const restrictedFields: string[] = [];
  const canViewIdentity = permissions.access.profileRead &&
    (permissions.sensitive.identity.read || c.fictionalOfflineIdentity === true);
  if (!canViewIdentity || c.workerName === "Restricted candidate") {
    restrictedFields.push("Identity (Name, Email, Phone, Manager, Recruiter)");
  }
  if (c.hireType === 'service-request' || c.orchestrationStatus === 'hro-request-pending-review') {
    return <CaseAccessProvider value={permissions}>
      <div className="mx-auto max-w-5xl space-y-5 px-4 md:px-8">
        <Link href="/cases" className="inline-flex min-h-10 items-center text-sm text-[var(--primary)]">Back to cases</Link>
        <div><p className="text-sm font-semibold">{sampleCaseReference(c) ?? `Case #${caseId}`}</p>
          <OriginalIntent c={c} />
          <h1 className="break-words text-2xl font-semibold text-[var(--text-primary)]">{permissions.access.profileRead ? caseTitleOf(c) : 'Case details restricted'}</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">{permissions.access.profileRead ? caseTypeOf(c) : 'Case details restricted'} · Held for specialist review · No external action authorized</p>
          {isFictionalOfflineExample(c) && <p className="mt-2 text-xs">Offline — read-only; no outreach or business completion.</p>}</div>
        {c.batchIntake ? <HroIntakeRequestPanel request={c.batchIntake} sampleContext={c} /> :
          <RestrictedActionNotice>Submitted fields require current profile, notes and sensitive-record read authority. They have not been removed from the case.</RestrictedActionNotice>}
        {permissions.access.notesRead && <ActivityTab events={events || []} />}
      </div>
    </CaseAccessProvider>;
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
      {hasRestrictedCaseActions && !c.controllerRetired && (
        <div role="status" className="mb-5 rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-sm text-[var(--status-amber-fg)]">
          Some case actions are restricted by your current permissions. Edit, profile, and notes controls are shown only when their corresponding access is available.
        </div>
      )}

      <CaseHeader c={c} caseId={caseId} setTab={setActiveTab} />
      {c.controllerRetired && !c.fictionalOfflineIdentity && <div role="status" className="mb-6 rounded-md border p-4 text-sm">
        This case is retained historical evidence. Operations and outreach are retired; delivery outcomes and private records remain subject to current access and retention rules.
      </div>}
      {!offlineSample && <EmployeeVaultPanel caseId={caseId} />}

      {c.batchIntake && <HroIntakeRequestPanel request={c.batchIntake} sampleContext={c} />}
      {c.syntheticJourney && <SyntheticJourneySummary journey={c.syntheticJourney} />}
      {!c.syntheticJourney && c.fictionalOfflineIdentity && permissions.access.notesRead && c.planSummary && (
        <section aria-label="Example request and pending review" className="my-4 rounded-lg border p-4 text-sm">
          <h3 className="mb-2 font-semibold">Request and unresolved review needs</h3>
          <p className="break-words">{caseSummary(c)}</p>
        </section>
      )}
      {offlineSample ? (
        !isFictionalOfflineExample(c) && <div role="status" className="mb-6 rounded-lg border p-4 text-sm">
          Historical test record — read-only and permanently non-operational.
          Retained events and private evidence are not business activity, approval authority, or proof of readiness.
        </div>
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
      {!c.syntheticJourney && (offlineSample || c.operationalActivated) && <OperationalPreparationPanel caseId={caseId} canRead={permissions.access.flowRead && permissions.access.profileRead} />}
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
        {activeTab === 'Frontline' && <FrontlineTab key={caseId} caseId={caseId} />}
        {activeTab === 'Documents' && <DocumentsTab caseId={caseId} docs={docs || []} />}
        {activeTab === 'Activity' && (permissions.access.notesRead
          ? <>{c.syntheticJourney && <div className="mb-6"><SyntheticJourneyStages journey={c.syntheticJourney} timeline /></div>}
            {c.syntheticJourney && <h2 className="mb-4 font-semibold">Recorded activity</h2>}
            <ActivityTab events={events || []} /></>
          : <RestrictedActionNotice>Activity notes are restricted by your current permissions.</RestrictedActionNotice>)}
        {activeTab === 'Communications' && <>{c.syntheticJourney && <><SyntheticJourneyCommunications journey={c.syntheticJourney} />
          <h2 className="mb-4 font-semibold">Recorded communications · original delivery status and provenance</h2></>}
          <CommunicationsTab caseId={caseId} c={c} comms={comms || []} channels={channels} requestsEnv={requestsEnv} requestsLoadError={requestsLoadError} enforceCasePermissions /></>}
        {activeTab === 'Audit' && (permissions.access.notesRead
          ? <AuditTab events={events || []} approvals={approvals} records={records || []} />
          : <RestrictedActionNotice>Audit notes are restricted by your current permissions.</RestrictedActionNotice>)}
        {activeTab === 'Ask AI' && (canAnalyze
          ? <ExplainabilityTab key={`${getPinnedOrganizationIdForPage() || 'anon'}-${user?.id || 'anon'}-${caseId}`} caseId={caseId} userId={user?.id} />
          : <RestrictedActionNotice>Ask AI requires current case and sensitive-field read permissions. Review only the case records available to your account.</RestrictedActionNotice>)}
      </div>
    </div>
    </CaseAccessProvider>
  );
}
