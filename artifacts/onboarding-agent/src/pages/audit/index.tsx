import React, { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { endOfDay, format, parseISO, startOfDay } from 'date-fns';
import { Shield, ShieldAlert, Download, Lock, Filter, History, Database, CheckCircle2, XCircle, FileText, Anchor, RefreshCcw, ChevronLeft, ChevronRight, AlertTriangle } from 'lucide-react';

import { PageHeader, Card, CardHeader, CardTitle, CardContent, Button } from '@/components/ui-shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useOrganizationRole } from '@/hooks/use-organization-role';
import { ScrollArea } from '@/components/ui/scroll-area';

import {
  useListOnboardingProtectedAudit,
  getListOnboardingProtectedAuditQueryKey,
  useGetOnboardingProtectedAuditIntegrity,
  getGetOnboardingProtectedAuditIntegrityQueryKey,
  useGetOnboardingProtectedAuditLifecycle,
  getGetOnboardingProtectedAuditLifecycleQueryKey,
  exportOnboardingProtectedAudit,
  useSetOnboardingProtectedAuditLegalHold,
  useReviewOnboardingProtectedAuditRetention,
  useCreateOnboardingProtectedAuditCorrection,
  useGetOnboardingProtectedAuditApprovalHistory,
  getGetOnboardingProtectedAuditApprovalHistoryQueryKey,
  ListOnboardingProtectedAuditParams,
} from '@workspace/api-client-react';
import {
  AuditExportFormatError,
  collectProtectedAuditCsv,
} from './export-parser';

function ApprovalHistoryDialog({
  approvalId,
  organizationId,
  enabled,
  open,
  onOpenChange,
}: {
  approvalId: number | null;
  organizationId: string | null;
  enabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: historyData, isLoading, isError } = useGetOnboardingProtectedAuditApprovalHistory(
    approvalId ?? 0,
    {
      query: {
        enabled: enabled && approvalId !== null && open,
        queryKey: approvalId
          ? [...getGetOnboardingProtectedAuditApprovalHistoryQueryKey(approvalId), organizationId]
          : ['onboarding', 'audit', 'retained-approval-history', organizationId],
      },
    },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Retained Approval History (ID: {approvalId})</DialogTitle>
        </DialogHeader>
        <div className="pt-4">
          {isLoading ? (
            <div className="py-8 text-center text-muted-foreground">Loading approval history...</div>
          ) : isError ? (
            <div className="py-8 text-center text-red-500">Failed to load historical data.</div>
          ) : !historyData || historyData.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">No historical records found.</div>
          ) : (
            <ScrollArea className="h-[400px] rounded-md border p-4">
              <div className="space-y-6">
                {historyData.map((record) => (
                  <div key={record.id} className="border-b pb-4 last:border-0 last:pb-0">
                    <div className="flex items-center justify-between mb-2">
                      <Badge variant="outline">v{record.version}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {format(new Date(record.createdAt), 'PPpp')}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-sm mb-3">
                      <div>
                        <span className="text-muted-foreground text-xs block">Event Type</span>
                        <span className="font-medium">{record.eventType}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground text-xs block">Status</span>
                        <Badge variant={record.status === 'approved' ? 'default' : record.status === 'rejected' ? 'destructive' : 'secondary'} className="capitalize mt-0.5">
                          {record.status}
                        </Badge>
                      </div>
                      {record.validationState && (
                        <div>
                          <span className="text-muted-foreground text-xs block">Validation</span>
                          <span className="font-medium">{record.validationState}</span>
                        </div>
                      )}
                    </div>

                    <div className="bg-surface-alt rounded p-2 text-xs mb-3 flex flex-wrap justify-between gap-x-4 gap-y-1">
                      <span>
                        Recorded {format(new Date(record.createdAt), 'PPpp')}
                      </span>
                      {record.decidedAt && (
                        <span className="text-muted-foreground">
                          Decided {format(new Date(record.decidedAt), 'PPpp')}
                        </span>
                      )}
                    </div>

                    <div className="mt-3 text-xs text-muted-foreground">
                      <p><em>Only retained status and timing metadata is shown. Findings, comments, and snapshot contents are withheld.</em></p>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function auditDateFilter(value: string, endOfDayInclusive = false): string | undefined {
  if (!value) return undefined;
  const parsed = parseISO(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return (endOfDayInclusive ? endOfDay(parsed) : startOfDay(parsed)).toISOString();
}

function AuditPageContent({
  organizationId,
  canReview,
  mode = 'organization',
}: {
  organizationId: string | null;
  canReview: boolean;
  mode?: 'organization' | 'demo';
}) {
  const demoMode = mode === 'demo';
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [isHoldDialogOpen, setIsHoldDialogOpen] = useState(false);
  const [holdReason, setHoldReason] = useState('');
  
  const [isCorrectionDialogOpen, setIsCorrectionDialogOpen] = useState(false);
  const [correctionEntryId, setCorrectionEntryId] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  
  const [isReviewDialogOpen, setIsReviewDialogOpen] = useState(false);
  const [retentionStatement, setRetentionStatement] = useState('');

  const [selectedApprovalId, setSelectedApprovalId] = useState<number | null>(null);
  const [isApprovalDialogOpen, setIsApprovalDialogOpen] = useState(false);
  const [approvalLookupId, setApprovalLookupId] = useState('');
  const [approvalLookupError, setApprovalLookupError] = useState('');

  const [isExporting, setIsExporting] = useState(false);

  const [filters, setFilters] = useState({
    action: '',
    actorId: '',
    objectType: '',
    objectId: '',
    outcome: 'all',
    from: '',
    to: ''
  });

  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const currentCursor = cursorStack[cursorStack.length - 1] || undefined;
  
  const listParams: ListOnboardingProtectedAuditParams = {
    scope: demoMode ? 'demo' : 'organization',
    action: appliedFilters.action || undefined,
    actorId: appliedFilters.actorId || undefined,
    objectType: appliedFilters.objectType || undefined,
    objectId: appliedFilters.objectId || undefined,
    outcome: appliedFilters.outcome !== 'all' ? (appliedFilters.outcome as any) : undefined,
    from: auditDateFilter(appliedFilters.from),
    to: auditDateFilter(appliedFilters.to, true),
    cursor: currentCursor ? Number(currentCursor) : undefined,
  };

  const listQueryKey = [...getListOnboardingProtectedAuditQueryKey(listParams), organizationId];
  const integrityQueryKey = [...getGetOnboardingProtectedAuditIntegrityQueryKey(), organizationId];
  const lifecycleQueryKey = [...getGetOnboardingProtectedAuditLifecycleQueryKey(), organizationId];

  const { data: pageData, isLoading: isLoadingList, isError: isErrorList, refetch: refetchList, isFetching: isFetchingList } = useListOnboardingProtectedAudit(
    listParams,
    { query: { queryKey: listQueryKey, placeholderData: keepPreviousData, enabled: (canReview || demoMode) && Boolean(organizationId) } }
  );

  const { data: integrityData, isLoading: isLoadingIntegrity, isError: isErrorIntegrity, refetch: refetchIntegrity } = useGetOnboardingProtectedAuditIntegrity(
    { query: { queryKey: integrityQueryKey, enabled: canReview && Boolean(organizationId) } }
  );

  const { data: lifecycleData, isLoading: isLoadingLifecycle, isError: isErrorLifecycle, refetch: refetchLifecycle } = useGetOnboardingProtectedAuditLifecycle(
    { query: { queryKey: lifecycleQueryKey, enabled: canReview && Boolean(organizationId) } }
  );

  const setHoldMutation = useSetOnboardingProtectedAuditLegalHold();
  const createCorrectionMutation = useCreateOnboardingProtectedAuditCorrection();
  const reviewRetentionMutation = useReviewOnboardingProtectedAuditRetention();

  const handleRefresh = () => {
    refetchList();
    if (!demoMode) {
      refetchIntegrity();
      refetchLifecycle();
    }
  };

  const handleApplyFilters = (e: React.FormEvent) => {
    e.preventDefault();
    setCursorStack([]);
    setAppliedFilters(filters);
  };

  const handleExport = async () => {
    try {
      setIsExporting(true);
      toast({ title: 'Export started', description: 'Fetching audit records...' });

      const allCsvContent = await collectProtectedAuditCsv(async (cursor) => {
        const exportParams: import('@workspace/api-client-react').ExportOnboardingProtectedAuditParams = {
          action: appliedFilters.action || undefined,
          actorId: appliedFilters.actorId || undefined,
          objectType: appliedFilters.objectType || undefined,
          objectId: appliedFilters.objectId || undefined,
          outcome: appliedFilters.outcome !== 'all' ? (appliedFilters.outcome as any) : undefined,
          from: auditDateFilter(appliedFilters.from),
          to: auditDateFilter(appliedFilters.to, true),
          cursor,
        };

        const response = await exportOnboardingProtectedAudit(exportParams);
        // The generated type is Blob for the binary OpenAPI schema, while
        // customFetch correctly treats text/csv as text in the browser.
        const responseBody: unknown = response;
        if (typeof responseBody === 'string') return responseBody;
        if (
          responseBody &&
          typeof responseBody === 'object' &&
          'text' in responseBody &&
          typeof responseBody.text === 'function'
        ) {
          return responseBody.text();
        }
        throw new AuditExportFormatError('server did not return CSV text.');
      });

      const finalBlob = new Blob([allCsvContent], { type: 'text/csv' });
      const url = URL.createObjectURL(finalBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-export-${format(new Date(), 'yyyy-MM-dd')}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      toast({ title: 'Export successful', description: 'Your audit report has been fully downloaded.' });
    } catch (err) {
      console.error("Export Error:", err);
      toast({ title: 'Export failed', description: err instanceof Error ? err.message : 'The audit export format was invalid.', variant: 'destructive' });
    } finally {
      setIsExporting(false);
    }
  };

  const handleToggleHold = (e: React.FormEvent) => {
    e.preventDefault();
    if (!holdReason) return;
    
    const action = lifecycleData?.legalHold?.active ? 'release' : 'set';
    
    setHoldMutation.mutate(
      { data: { action, reason: holdReason } },
      {
        onSuccess: () => {
          toast({ title: `Legal hold ${action} complete.` });
          setIsHoldDialogOpen(false);
          setHoldReason('');
          queryClient.invalidateQueries({ queryKey: lifecycleQueryKey });
          queryClient.invalidateQueries({ queryKey: integrityQueryKey });
          queryClient.invalidateQueries({ queryKey: listQueryKey });
        },
        onError: () => {
          toast({ title: 'Operation failed', variant: 'destructive' });
        }
      }
    );
  };

  const handleCreateCorrection = (e: React.FormEvent) => {
    e.preventDefault();
    if (!correctionEntryId || !correctionReason) return;
    
    createCorrectionMutation.mutate(
      { data: { entryId: parseInt(correctionEntryId, 10), reason: correctionReason } },
      {
        onSuccess: () => {
          toast({ title: 'Correction recorded.' });
          setIsCorrectionDialogOpen(false);
          setCorrectionEntryId('');
          setCorrectionReason('');
          queryClient.invalidateQueries({ queryKey: integrityQueryKey });
          queryClient.invalidateQueries({ queryKey: listQueryKey });
        },
        onError: (error) => {
          toast({ title: 'Correction failed', description: String(error), variant: 'destructive' });
        }
      }
    );
  };

  const handleReviewRetention = (e: React.FormEvent) => {
    e.preventDefault();
    if (!retentionStatement) return;
    
    reviewRetentionMutation.mutate(
      { data: { retentionStatement } },
      {
        onSuccess: () => {
          toast({ title: 'Retention policy reviewed and updated.' });
          setIsReviewDialogOpen(false);
          setRetentionStatement('');
           queryClient.invalidateQueries({ queryKey: lifecycleQueryKey });
           queryClient.invalidateQueries({ queryKey: integrityQueryKey });
        },
        onError: (error) => {
          toast({ title: 'Update failed', description: String(error), variant: 'destructive' });
        }
      }
    );
  };

  const isHoldActive = !isLoadingLifecycle && !isErrorLifecycle && (lifecycleData?.legalHold?.active ?? false);
  const entries = pageData?.entries || [];
  const nextCursor = pageData?.nextCursor;
  const isDataAvailable = !isErrorList && !isLoadingList;

  const viewApprovalById = (event: React.FormEvent) => {
    event.preventDefault();
    if (!/^[1-9]\d*$/.test(approvalLookupId)) {
      setApprovalLookupError('Enter a positive numeric approval ID.');
      return;
    }
    const approvalId = Number(approvalLookupId);
    if (!Number.isSafeInteger(approvalId)) {
      setApprovalLookupError('Approval ID is outside the supported range.');
      return;
    }
    setApprovalLookupError('');
    setSelectedApprovalId(approvalId);
    setIsApprovalDialogOpen(true);
  };

  return (
    <div className="max-w-[1200px] mx-auto w-full pb-12">
      {!demoMode && (
        <ApprovalHistoryDialog
          approvalId={selectedApprovalId}
          organizationId={organizationId}
          enabled={canReview}
          open={isApprovalDialogOpen}
          onOpenChange={setIsApprovalDialogOpen}
        />
      )}
      
      <PageHeader 
        title={demoMode ? "Demo Audit Trail" : "Audit Review & Integrity"}
        subtitle={demoMode
          ? "Read-only history for your authorized non-operational test records."
          : "Accountable, restricted review of system activity."}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="gap-2" onClick={handleRefresh}>
            <RefreshCcw className={`w-4 h-4 ${(isFetchingList || isLoadingIntegrity || isLoadingLifecycle) ? 'animate-spin' : ''}`} /> Refresh
          </Button>
          {!demoMode && (
            <Button variant="outline" size="sm" className="gap-2" onClick={handleExport} disabled={isExporting}>
              {isExporting ? <RefreshCcw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {isExporting ? 'Exporting...' : 'Export Report'}
            </Button>
          )}
          
          {!demoMode && <Dialog open={isHoldDialogOpen} onOpenChange={setIsHoldDialogOpen}>
            <DialogTrigger asChild>
              <Button 
                variant={isHoldActive ? "destructive" : "default"} 
                size="sm"
                className="gap-2"
                disabled={isLoadingLifecycle || isErrorLifecycle}
              >
                <Lock className="w-4 h-4" /> 
                {isHoldActive ? 'Release Hold' : 'Set Retention Hold'}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{isHoldActive ? 'Release Legal Hold' : 'Set Legal Hold'}</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleToggleHold} className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label>Reason for {isHoldActive ? 'Release' : 'Hold'}</Label>
                  <Textarea 
                    value={holdReason} 
                    onChange={(e) => setHoldReason(e.target.value)} 
                    placeholder="Required reasoning for audit log." 
                    required 
                  />
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsHoldDialogOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={setHoldMutation.isPending || !holdReason} variant={isHoldActive ? "destructive" : "default"}>
                    {setHoldMutation.isPending ? 'Processing...' : 'Confirm'}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>}
        </div>
      </PageHeader>

      {demoMode && (
        <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/20 dark:text-blue-200">
          This view includes restricted historical events for test records assigned to your Demo Administrator profile, plus your own unscoped demo actions. These records are non-operational.
          Organization-wide integrity, export, retention, legal-hold, approval-history, and correction controls remain restricted.
        </div>
      )}
      
      <div className={demoMode ? "mb-6" : "grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6"}>
        <div className={demoMode ? "space-y-6" : "lg:col-span-2 space-y-6"}>
          <Card>
            <CardHeader className="border-b bg-surface-alt/50" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center justify-between mb-4">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <History className="w-5 h-5 text-primary" />
                  Activity Timeline
                </CardTitle>
                {isDataAvailable && (
                  <Badge variant="secondary">{entries.length} Events</Badge>
                )}
              </div>
              <form onSubmit={handleApplyFilters} className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Action</Label>
                  <Input 
                    placeholder="e.g. create_case" 
                    value={filters.action} 
                    onChange={e => setFilters({...filters, action: e.target.value})}
                    className="h-8 text-sm bg-surface"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Actor ID (backend value)</Label>
                  <Input 
                    placeholder="e.g. user_123" 
                    value={filters.actorId} 
                    onChange={e => setFilters({...filters, actorId: e.target.value})}
                    className="h-8 text-sm bg-surface"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Object Type</Label>
                  <Input 
                    placeholder="e.g. case" 
                    value={filters.objectType} 
                    onChange={e => setFilters({...filters, objectType: e.target.value})}
                    className="h-8 text-sm bg-surface"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Object ID (pseudonymous)</Label>
                  <Input 
                    placeholder="e.g. ref:abc123..." 
                    value={filters.objectId} 
                    onChange={e => setFilters({...filters, objectId: e.target.value})}
                    className="h-8 text-sm bg-surface"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">From Date</Label>
                  <Input 
                    type="date"
                    value={filters.from} 
                    onChange={e => setFilters({...filters, from: e.target.value})}
                    className="h-8 text-sm bg-surface"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">To Date</Label>
                  <Input 
                    type="date"
                    value={filters.to} 
                    onChange={e => setFilters({...filters, to: e.target.value})}
                    className="h-8 text-sm bg-surface"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Outcome</Label>
                  <Select value={filters.outcome} onValueChange={(v) => setFilters({...filters, outcome: v})}>
                    <SelectTrigger className="h-8 text-sm bg-surface">
                      <SelectValue placeholder="Any" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Any</SelectItem>
                      <SelectItem value="success">Success</SelectItem>
                      <SelectItem value="failure">Failure</SelectItem>
                      <SelectItem value="denied">Denied</SelectItem>
                      <SelectItem value="attempted">Attempted</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 flex items-end">
                  <Button type="submit" size="sm" className="w-full h-8 bg-primary hover:bg-primary/90 text-primary-foreground">
                    <Filter className="w-3.5 h-3.5 mr-2" /> Apply Filters
                  </Button>
                </div>
              </form>
              {!demoMode && <form onSubmit={viewApprovalById} className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Retained approval lookup (numeric ID)</Label>
                  <Input
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder="e.g. 142"
                    value={approvalLookupId}
                    onChange={e => {
                      setApprovalLookupId(e.target.value);
                      if (approvalLookupError) setApprovalLookupError('');
                    }}
                    className="h-8 w-[180px] text-sm bg-surface"
                    aria-invalid={Boolean(approvalLookupError)}
                  />
                </div>
                <Button type="submit" size="sm" className="h-8">
                  View retained history
                </Button>
                <p className="basis-full text-xs text-muted-foreground">
                  Audit object references are pseudonymous and cannot be converted into approval IDs. This lookup remains available after the live approval is deleted.
                </p>
                {approvalLookupError && (
                  <p className="basis-full text-xs text-red-600" role="alert">{approvalLookupError}</p>
                )}
              </form>}
            </CardHeader>
            <CardContent className="p-0">
              {isErrorList ? (
                <div className="p-8 flex flex-col items-center justify-center text-center">
                  <AlertTriangle className="w-8 h-8 text-red-500 mb-3" />
                  <h3 className="text-md font-medium text-foreground mb-1">Failed to load audit events</h3>
                  <p className="text-sm text-muted-foreground mb-4">There was a problem communicating with the audit service.</p>
                  <Button variant="outline" onClick={() => refetchList()}>Retry Connection</Button>
                </div>
              ) : isLoadingList && !isFetchingList ? (
                <div className="p-12 flex justify-center text-muted-foreground">Loading audit trail...</div>
              ) : entries.length === 0 ? (
                <div className="p-12 text-center flex flex-col items-center">
                  <Database className="w-12 h-12 mb-4 text-muted-foreground opacity-20" />
                  <h3 className="text-lg font-medium text-foreground">No Activity Found</h3>
                  <p className="max-w-md mx-auto mt-2 text-sm text-muted-foreground">
                    No matching audit events were found for this tenant.
                  </p>
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[80px]">ID / Seq</TableHead>
                          <TableHead>Timestamp</TableHead>
                          <TableHead>Action</TableHead>
                          <TableHead>Actor</TableHead>
                          <TableHead>Outcome</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {entries.map((entry) => (
                          <TableRow key={entry.id}>
                            <TableCell className="font-mono text-xs text-muted-foreground">
                              #{entry.id}
                              <br/>
                              <span className="opacity-50">S:{entry.sequence}</span>
                            </TableCell>
                            <TableCell className="text-sm whitespace-nowrap">
                              {format(new Date(entry.occurredAt), 'MMM d, yyyy')}
                              <br/>
                              <span className="text-muted-foreground text-xs">{format(new Date(entry.occurredAt), 'HH:mm:ss')}</span>
                            </TableCell>
                            <TableCell className="text-sm font-medium">
                              {entry.action}
                              {entry.objectType && (
                                <div className="text-xs text-muted-foreground mt-0.5 font-normal flex items-center gap-1">
                                   {entry.objectType}: {entry.objectId || '—'}
                                </div>
                              )}
                               {entry.caseReference && (
                                 <div className="text-[10px] text-muted-foreground/80 font-normal">
                                   case ref: {entry.caseReference}
                                 </div>
                               )}
                            </TableCell>
                            <TableCell className="text-sm">
                              <Badge variant="outline" className="capitalize text-[10px] h-5 px-1.5 mb-1">
                                {entry.actorKind}
                              </Badge>
                              {entry.actorId && (
                                <div className="text-xs font-mono text-foreground mb-0.5 truncate max-w-[150px]" title={entry.actorId}>
                                  {entry.actorId}
                                </div>
                              )}
                              <div className="text-xs text-muted-foreground truncate max-w-[150px]" title={entry.actorAuthority}>
                                {entry.actorAuthority}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge 
                                variant={entry.outcome === 'success' ? 'default' : entry.outcome === 'failure' ? 'destructive' : 'secondary'}
                                className="capitalize"
                              >
                                {entry.outcome}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <div className="flex items-center justify-between p-4 border-t border-border bg-surface-alt/30">
                    <Button 
                      variant="outline" 
                      size="sm" 
                      disabled={cursorStack.length === 0 || isFetchingList}
                      onClick={() => {
                        const newStack = [...cursorStack];
                        newStack.pop();
                        setCursorStack(newStack);
                      }}
                    >
                      <ChevronLeft className="w-4 h-4 mr-1" /> Previous
                    </Button>
                    <div className="text-xs text-muted-foreground font-medium">
                      Page {cursorStack.length + 1}
                    </div>
                    <Button 
                      variant="outline" 
                      size="sm"
                      disabled={!nextCursor || isFetchingList}
                      onClick={() => {
                        if (nextCursor) {
                          setCursorStack([...cursorStack, nextCursor]);
                        }
                      }}
                    >
                      Next <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {!demoMode && <Card>
            <CardContent className="p-6">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <h4 className="text-sm font-semibold flex items-center gap-2">
                    <FileText className="w-4 h-4 text-primary" />
                    Linked Correction Workflow
                  </h4>
                  <p className="text-xs text-muted-foreground mt-1 max-w-lg">
                    Corrections are tracked as distinct appending events, preserving original entry hashes in the chain. Normal application paths cannot edit entries; a privileged database administrator could still rewrite history, so independent anchoring is required for stronger guarantees.
                  </p>
                </div>
                <Dialog open={isCorrectionDialogOpen} onOpenChange={setIsCorrectionDialogOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm" className="shrink-0" disabled={isLoadingIntegrity || isErrorIntegrity}>
                      Initiate Correction
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Append Linked Correction</DialogTitle>
                    </DialogHeader>
                    <form onSubmit={handleCreateCorrection} className="space-y-4 pt-4">
                      <div className="space-y-2">
                        <Label>Target Entry ID</Label>
                        <Input 
                          type="number"
                          value={correctionEntryId}
                          onChange={(e) => setCorrectionEntryId(e.target.value)}
                          placeholder="e.g. 142"
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Correction Details</Label>
                        <Textarea 
                          value={correctionReason}
                          onChange={(e) => setCorrectionReason(e.target.value)}
                          placeholder="Describe the discrepancy and the correct information."
                          required
                        />
                      </div>
                      <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setIsCorrectionDialogOpen(false)}>Cancel</Button>
                        <Button type="submit" disabled={createCorrectionMutation.isPending || !correctionEntryId || !correctionReason}>
                          {createCorrectionMutation.isPending ? 'Submitting...' : 'Submit Correction'}
                        </Button>
                      </DialogFooter>
                    </form>
                  </DialogContent>
                </Dialog>
              </div>
            </CardContent>
          </Card>}
        </div>
        
        {!demoMode && <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-lg">
                <span className="flex items-center gap-2">
                  <Shield className="w-5 h-5 text-emerald-600" />
                  Integrity Status
                </span>
                {isErrorIntegrity && (
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500" onClick={() => refetchIntegrity()}>
                    <RefreshCcw className="w-4 h-4" />
                  </Button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isErrorIntegrity ? (
                <div className="p-4 rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 text-red-800 dark:text-red-300 text-sm flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <div>
                    <p className="font-semibold mb-1">Integrity Check Failed</p>
                    <p className="text-xs">Unable to cryptographically verify the event chain. The connection to the audit service may be degraded.</p>
                  </div>
                </div>
              ) : isLoadingIntegrity ? (
                <div className="text-sm text-muted-foreground p-4 bg-surface-alt rounded-lg text-center">Checking cryptographic integrity...</div>
              ) : (
                <>
                  <div className="p-4 rounded-lg flex gap-3 bg-surface-alt border">
                    {integrityData?.status === 'verified' ? (
                      <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                    ) : integrityData?.status === 'broken' ? (
                      <XCircle className="w-5 h-5 text-red-600 shrink-0" />
                    ) : (
                      <Database className="w-5 h-5 text-muted-foreground shrink-0" />
                    )}
                    <div>
                      <h4 className="text-sm font-semibold flex items-center gap-2">
                        Local Hash Chain
                        <Badge variant={integrityData?.status === 'verified' ? 'outline' : integrityData?.status === 'empty' ? 'secondary' : 'destructive'} className="text-[10px] h-5 uppercase tracking-wide">
                          {integrityData?.status || 'Unknown'}
                        </Badge>
                      </h4>
                      <p className="text-xs text-muted-foreground mt-1">
                        Checked {integrityData?.checkedEntries ?? 0} entries.
                        {integrityData?.firstBrokenSequence !== null && integrityData?.firstBrokenSequence !== undefined && ` Broken at sequence ${integrityData?.firstBrokenSequence}.`}
                      </p>
                    </div>
                  </div>
                  
                  <div className="p-4 rounded-lg flex gap-3 border border-orange-200 bg-orange-50 dark:bg-orange-950/20 dark:border-orange-900/50">
                    <ShieldAlert className="w-5 h-5 text-orange-600 shrink-0 mt-0.5" />
                    <div>
                      <h4 className="text-sm font-semibold text-orange-900 dark:text-orange-300">DBA Resistance Limitations</h4>
                      <p className="text-xs mt-1 text-orange-800 dark:text-orange-400">
                        While local hashes provide tamper evidence against application-level manipulation, they do not prevent a database administrator from rewriting history.
                      </p>
                    </div>
                  </div>

                  <div className="p-4 rounded-lg flex gap-3 bg-surface-alt border">
                    <Anchor className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
                    <div>
                      <h4 className="text-sm font-semibold">External Anchoring</h4>
                      <p className="text-xs text-muted-foreground mt-1">
                        {integrityData?.externalAnchoring?.configured 
                          ? 'Configured and actively publishing roots.'
                          : (integrityData?.externalAnchoring?.limitation || 'Not configured. Required for true DBA resistance.')}
                      </p>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg flex items-center gap-2">
                  Data Retention
                  {isErrorLifecycle && (
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-red-500" onClick={() => refetchLifecycle()}>
                      <RefreshCcw className="w-3 h-3" />
                    </Button>
                  )}
                </CardTitle>
                <Dialog open={isReviewDialogOpen} onOpenChange={setIsReviewDialogOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm" disabled={isLoadingLifecycle || isErrorLifecycle}>Review Policy</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Review Retention Policy</DialogTitle>
                    </DialogHeader>
                    <form onSubmit={handleReviewRetention} className="space-y-4 pt-4">
                      <div className="space-y-2">
                        <Label>Retention Statement</Label>
                        <Textarea 
                          value={retentionStatement}
                          onChange={(e) => setRetentionStatement(e.target.value)}
                          placeholder="State the retention period (e.g. 7 Years for compliance)"
                          required
                        />
                      </div>
                      <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setIsReviewDialogOpen(false)}>Cancel</Button>
                        <Button type="submit" disabled={reviewRetentionMutation.isPending || !retentionStatement}>
                          {reviewRetentionMutation.isPending ? 'Saving...' : 'Confirm Review'}
                        </Button>
                      </DialogFooter>
                    </form>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              {isErrorLifecycle ? (
                <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-md text-xs flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  Could not load retention policies.
                </div>
              ) : isLoadingLifecycle ? (
                <div className="p-4 text-center bg-surface-alt rounded-lg">Loading lifecycle data...</div>
              ) : (
                <>
                  <div className="flex justify-between py-2 border-b border-border">
                    <span>Policy</span>
                    <span className="font-medium text-foreground">
                      {lifecycleData?.retentionStatement || 'Unknown (Not approved)'}
                    </span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-border">
                    <span>Last Reviewed</span>
                    <span className="font-medium text-foreground">
                      {lifecycleData?.reviewedAt ? `${format(new Date(lifecycleData.reviewedAt), 'PP')} by ${lifecycleData.reviewedBy || 'System'}` : 'Never'}
                    </span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-border">
                    <span>Legal Hold</span>
                    {isHoldActive ? (
                      <span className="font-medium text-red-600 flex items-center gap-1">
                        <Lock className="w-3 h-3" /> Active
                      </span>
                    ) : (
                      <span className="font-medium text-muted-foreground">
                        None
                      </span>
                    )}
                  </div>
                  <div className="flex justify-between py-2 border-b border-border">
                    <span>Auto Purge</span>
                    <span className="font-medium text-foreground">
                      {lifecycleData?.automaticPurge ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-border">
                    <span>Deadline</span>
                    <span className="font-medium text-foreground">
                      {lifecycleData?.retentionDeadline ? format(new Date(lifecycleData.retentionDeadline), 'PP') : 'None'}
                    </span>
                  </div>
                  <div className="flex flex-col py-2 gap-1">
                    <span className="font-medium">Historical Coverage</span>
                    <span className="text-xs text-muted-foreground whitespace-pre-wrap">
                      {lifecycleData?.historicalCoverage || 'Unknown'}
                    </span>
                  </div>
                  {isHoldActive && lifecycleData?.legalHold?.reason && (
                    <div className="mt-2 p-3 bg-red-50 dark:bg-red-950/20 text-red-800 dark:text-red-300 text-xs rounded-md border border-red-200 dark:border-red-900/50">
                      <strong>Hold Reason:</strong> {lifecycleData.legalHold.reason}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>}
      </div>
    </div>
  );
}

export function AuditPage() {
  const { isHR, loading, organizationId, demoProfile } = useOrganizationRole();

  if (loading) {
    return <div className="p-8 text-center text-muted-foreground">Checking authorization...</div>;
  }
  
  if (!isHR && demoProfile !== 'administrator') {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader
          title="Audit Trail"
          subtitle="Protected organization-wide audit evidence"
        />
        <Card className="border-[var(--status-amber)] bg-[var(--status-amber-bg)]">
          <CardContent className="flex flex-col items-start gap-4 p-6">
            <div className="flex items-start gap-3">
              <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-[var(--status-amber-fg)]" />
              <div>
                <h2 className="font-semibold text-[var(--status-amber-fg)]">Owner or administrator access required</h2>
                <p className="mt-1 text-sm leading-relaxed text-[var(--status-amber-fg)]">
                  The organization-wide protected audit contains evidence across cases and is limited to organization owners and administrators.
                  Demo membership does not grant that broader authority.
                </p>
              </div>
            </div>
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--text-secondary)]">
              Review case-linked historical evidence in Cases using your current case permissions.
            </div>
            <Link
              href="/cases"
              className="inline-flex h-10 items-center justify-center rounded-md bg-[var(--primary)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[var(--primary-dark)]"
            >
              Open Cases
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <AuditPageContent
      organizationId={organizationId}
      canReview={isHR && Boolean(organizationId)}
      mode={isHR ? 'organization' : 'demo'}
    />
  );
}
