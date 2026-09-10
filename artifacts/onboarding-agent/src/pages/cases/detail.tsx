import React, { useState } from 'react';
import { useParams } from 'wouter';
import { 
  useGetOnboardingCase, 
  useListOnboardingCaseEvents, 
  useListOnboardingCaseCommunications,
  useListOnboardingCaseDocuments,
  useListOnboardingApprovals,
  useListOnboardingCaseRecords,
  getGetOnboardingCaseQueryKey,
  getListOnboardingCaseEventsQueryKey,
  getListOnboardingCaseCommunicationsQueryKey,
  getListOnboardingCaseDocumentsQueryKey,
  getListOnboardingApprovalsQueryKey,
  getListOnboardingCaseRecordsQueryKey,
  useGetOnboardingChannels,
  getGetOnboardingChannelsQueryKey,
  getPinnedOrganizationIdForPage
} from '@workspace/api-client-react';

import { useUser } from '@clerk/react';
import { CaseHeader, CaseHealthStrip, CaseTabs } from './detail/components';
import { GatewaysStrip } from './detail/gateways-strip';
import { useOrganizationRole } from '../../hooks/use-organization-role';
import { OverviewTab } from './detail/overview';
import { TasksTab, ActivityTab, CommunicationsTab, AuditTab } from './detail/tabs-content';
import { DocumentsTab } from './detail/documents-tab';
import { ExplainabilityTab } from './detail/explainability-tab';
import { PortalControls } from './detail/portal-controls';

export function CaseDetailPage() {
  const { id } = useParams();
  const caseId = Number(id);
  const { user } = useUser();
  const { isHR, loading: isHRLoading } = useOrganizationRole();
  
  const [activeTab, setActiveTab] = useState('Overview');

  const { data: c, isLoading } = useGetOnboardingCase(caseId, {
    query: {
      enabled: !!caseId,
      queryKey: getGetOnboardingCaseQueryKey(caseId),
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
    query: { queryKey: getListOnboardingApprovalsQueryKey({ status: 'all' }) }
  });
  
  const approvals = approvalsRaw?.filter((a: any) => a.caseId === caseId) || [];
  const pendingApprovals = approvals.filter((a: any) => a.status === 'pending');

  const { data: records } = useListOnboardingCaseRecords(caseId, {
    query: { enabled: !!caseId && c?.hireType === 'rehire', queryKey: getListOnboardingCaseRecordsQueryKey(caseId) }
  });

  if (isLoading || isHRLoading) return <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>Loading case workspace...</div>;
  if (!c) return <div className="p-8 text-center text-[var(--status-red)] font-bold">Case not found.</div>;

  return (
    <div className="max-w-7xl mx-auto px-6 md:px-8">
      <CaseHeader c={c} caseId={caseId} setTab={setActiveTab} />
      
      <GatewaysStrip c={c} isHR={isHR} />
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
        {activeTab === 'Communications' && <CommunicationsTab caseId={caseId} c={c} comms={comms || []} channels={channels} />}
        {activeTab === 'Audit' && <AuditTab events={events || []} approvals={approvals} records={records || []} />}
        {activeTab === 'Ask AI' && <ExplainabilityTab key={`${getPinnedOrganizationIdForPage() || 'anon'}-${user?.id || 'anon'}-${caseId}`} caseId={caseId} userId={user?.id} />}
      </div>
    </div>
  );
}
