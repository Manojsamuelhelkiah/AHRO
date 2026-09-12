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
import { useListLifecycleHolds } from '../../hooks/use-privacy-api';
import { Link } from 'wouter';
import { Presentation, AlertTriangle } from 'lucide-react';

import { useUser } from '@clerk/react';
import { CaseHeader, CaseHealthStrip, CaseTabs } from './detail/components';
import { GatewaysStrip } from './detail/gateways-strip';
import { OverviewTab } from './detail/overview';
import { TasksTab, ActivityTab, CommunicationsTab, AuditTab } from './detail/tabs-content';
import { DocumentsTab } from './detail/documents-tab';
import { ExplainabilityTab } from './detail/explainability-tab';
import { PortalControls } from './detail/portal-controls';
import { getApprovalRefetchInterval } from '../../lib/approval-actions';

export function CaseDetailPage() {
  const { id } = useParams();
  const caseId = Number(id);
  const { user } = useUser();
  const [activeTab, setActiveTab] = useState(() => {
    const requested = typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("tab")?.toLowerCase();
    return requested === "communications" ? "Communications" : "Overview";
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

  const { data: events } = useListOnboardingCaseEvents(caseId, {
    query: {
      enabled: !!caseId,
      queryKey: getListOnboardingCaseEventsQueryKey(caseId),
      refetchInterval: () => {
        return (c?.orchestrationStatus === 'running' || c?.orchestrationStatus === 'waiting-approval' || c?.orchestrationStatus === 'blocked' || c?.orchestrationStatus === 'checklist-blocked' || c?.orchestrationStatus === 'idle') ? 2500 : false;
      }
    }
  });

  const { data: docs } = useListOnboardingCaseDocuments(caseId, {
    query: {
      enabled: !!caseId,
      queryKey: getListOnboardingCaseDocumentsQueryKey(caseId),
    }
  });

  const { data: comms } = useListOnboardingCaseCommunications(caseId, {
    query: {
      enabled: !!caseId,
      queryKey: getListOnboardingCaseCommunicationsQueryKey(caseId),
      refetchInterval: () => {
        return (c?.orchestrationStatus === 'running' || c?.orchestrationStatus === 'waiting-approval' || c?.orchestrationStatus === 'blocked' || c?.orchestrationStatus === 'checklist-blocked' || c?.orchestrationStatus === 'idle') ? 2500 : false;
      }
    }
  });

  const { data: channels } = useGetOnboardingChannels({
    query: { enabled: !!caseId, queryKey: getGetOnboardingChannelsQueryKey(), staleTime: 60_000 }
  });

  const { data: approvalsRaw } = useListOnboardingApprovals({ status: 'all' }, {
    query: {
      queryKey: getListOnboardingApprovalsQueryKey({ status: 'all' }),
      // Email decisions can resolve a review in another session. Poll only
      // while this finite queue contains pending approvals.
      refetchInterval: (query) => getApprovalRefetchInterval(query.state.data),
    }
  });

  const approvals = approvalsRaw?.filter((a: any) => a.caseId === caseId) || [];
  const pendingApprovals = approvals.filter((a: any) => a.status === 'pending');

  const { data: records } = useListOnboardingCaseRecords(caseId, {
    query: { enabled: !!caseId && c?.hireType === 'rehire', queryKey: getListOnboardingCaseRecordsQueryKey(caseId) }
  });

  const { data: requestsEnv, isError: requestsLoadError } = useGetOnboardingOperationalRequests(caseId, {
    query: {
      enabled: !!caseId,
      queryKey: getGetOnboardingOperationalRequestsQueryKey(caseId),
      refetchInterval: () => {
        return (c?.orchestrationStatus === 'running' || c?.orchestrationStatus === 'waiting-approval' || c?.orchestrationStatus === 'blocked' || c?.orchestrationStatus === 'checklist-blocked' || c?.orchestrationStatus === 'idle') ? 2500 : false;
      }
    }
  });

  const { data: caps } = useGetOnboardingDemoController({
    query: {
      enabled: !!caseId,
      queryKey: getGetOnboardingDemoControllerQueryKey(),
      retry: false
    }
  });

  const { error: privacyError } = useListLifecycleHolds();

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

  const restrictedFields: string[] = [];
  if (c.workerName === "Restricted candidate") {
    restrictedFields.push("Identity (Name, Email, Phone, Manager, Recruiter)");
  }

  return (
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

      <GatewaysStrip
        c={c}
        gateApproval={pendingApprovals.find((approval: any) =>
          approval.ruleRef === 'Gate A — offer-acceptance package',
        )}
      />
      <CaseHealthStrip c={c} pendingApprovals={pendingApprovals} />
      <PortalControls caseId={caseId} joiningDate={c.joiningDate} />

      <CaseTabs activeTab={activeTab} setTab={setActiveTab} />

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

        {activeTab === 'Tasks' && <TasksTab c={c} />}
        {activeTab === 'Documents' && <DocumentsTab caseId={caseId} docs={docs || []} />}
        {activeTab === 'Activity' && <ActivityTab events={events || []} />}
        {activeTab === 'Communications' && <CommunicationsTab caseId={caseId} c={c} comms={comms || []} channels={channels} requestsEnv={requestsEnv} requestsLoadError={requestsLoadError} />}
        {activeTab === 'Audit' && <AuditTab events={events || []} approvals={approvals} records={records || []} />}
        {activeTab === 'Ask AI' && <ExplainabilityTab key={`${getPinnedOrganizationIdForPage() || 'anon'}-${user?.id || 'anon'}-${caseId}`} caseId={caseId} userId={user?.id} />}
      </div>
    </div>
  );
}
