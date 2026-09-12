import React, { useState } from "react";
import { useStandardProvidersStatus, useUpdateStandardProviderConfiguration, useRefreshStandardProviderSourceConfirmation, StandardProviderStatus } from "@/hooks/use-standard-providers";
import { Button, Badge, Label, cn, IconTile, LoadingBlock, Input } from "@/components/ui-shared";
import { Database, ShieldCheck, AlertTriangle, ShieldAlert, History, RefreshCcw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export function StandardProvidersPanel() {
  const { data, isLoading, error } = useStandardProvidersStatus();

  if (isLoading) return <LoadingBlock>Loading standard providers...</LoadingBlock>;
  if (error || !data) return (
    <div className="p-4 text-[var(--status-red-fg)] bg-[var(--status-red-bg)] rounded-[var(--radius-lg)] font-medium text-sm border border-[var(--status-red-fg)]/20">
      {error instanceof Error ? error.message : "Failed to load standard providers. Organization owner or admin role required."}
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[var(--text-lg)] font-semibold text-[var(--text-primary)] flex items-center gap-2 m-0">
          <Database className="w-4 h-4 text-[var(--primary)]" /> Source of Truth Providers
        </h2>
        <p className="text-[var(--text-sm)] text-[var(--text-muted)] mt-1 mb-0">
          Standard configurations for authoritative system records. Remote writes are disabled pending dispatcher implementation.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6">
        {data.providers.map((provider) => (
          <ProviderCard key={provider.key} provider={provider} />
        ))}
      </div>
    </div>
  );
}

function ProviderCard({ provider }: { provider: StandardProviderStatus }) {
  const isApi = provider.key === "oracle-hcm" || provider.key === "servicenow";
  
  return (
    <div className={cn(
      "bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-sm overflow-hidden",
      provider.configurationState === 'operator-approved' ? "border-l-4 border-l-[var(--status-green-fg)]" : ""
    )}>
      <div className="p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <IconTile icon={Database} className={cn("border-none shadow-sm", provider.configurationState === 'operator-approved' ? "bg-[var(--status-green-bg)] text-[var(--status-green-fg)]" : "bg-[var(--surface-alt)] text-[var(--text-muted)]")} />
            <div>
              <h3 className="font-semibold text-[var(--text-base)] text-[var(--text-primary)] flex items-center gap-2">
                {provider.label}
                {provider.configurationState === 'operator-approved' && (
                  <Badge className="bg-[var(--status-green-bg)] text-[var(--status-green-fg)] border-none shadow-none text-[10px] uppercase">Approved</Badge>
                )}
              </h3>
              <p className="text-[var(--text-sm)] text-[var(--text-muted)] mt-1 font-medium">{provider.sourceOfTruth}</p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Badge className={cn("text-[var(--text-xs)] shadow-none border-none font-semibold", 
              provider.configurationState === 'not-configured' ? 'bg-[var(--surface-alt)] text-[var(--text-muted)]' :
              provider.configurationState === 'operator-approved' ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]' :
              'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]'
            )}>
              {provider.configurationState.replace(/-/g, ' ').toUpperCase()}
            </Badge>
            {provider.fulfillmentState !== 'not-submitted' && (
               <Badge className="text-[var(--text-xs)] shadow-none border-none font-semibold bg-[var(--surface-alt)] text-[var(--text-muted)]">
                 FULFILLMENT: {provider.fulfillmentState.replace(/-/g, ' ').toUpperCase()}
               </Badge>
            )}
            {!provider.liveReadinessEligible && provider.configurationState !== 'not-configured' && provider.sourceObservationState !== 'awaiting-source-confirmation' && (
               <Badge className="text-[var(--text-xs)] shadow-none border-none font-semibold bg-[var(--status-info-bg)] text-[var(--status-info-fg)]">
                 {provider.sourceObservationState.replace(/-/g, ' ').toUpperCase()}
               </Badge>
            )}
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <h4 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider mb-2 flex items-center gap-1.5"><ShieldAlert className="w-3.5 h-3.5" /> Setup Requirements</h4>
              <ul className="space-y-1">
                {provider.setupBlockers.map((req, i) => (
                  <li key={i} className="text-sm text-[var(--text-primary)] flex items-start gap-2">
                    <span className="text-[var(--primary)] mt-0.5">•</span> {req}
                  </li>
                ))}
              </ul>
            </div>
            
            {provider.launchBlockers.length > 0 && (
              <div className="p-3 bg-[var(--status-amber-bg)] rounded-md border border-[var(--status-amber-fg)]/20">
                <h4 className="text-xs font-bold text-[var(--status-amber-fg)] uppercase tracking-wider mb-2 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Launch Blockers</h4>
                <ul className="space-y-1">
                  {provider.launchBlockers.map((req, i) => (
                    <li key={i} className="text-sm text-[var(--status-amber-fg)] flex items-start gap-2">
                      <span className="opacity-70 mt-0.5">•</span> {req}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!isApi && provider.manualFulfillment && (
              <div className="mt-4 p-4 bg-[var(--surface-alt)] rounded-lg border border-[var(--border)]">
                <h4 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider mb-3">Manual Ownership</h4>
                <div className="space-y-2">
                  <div className="flex justify-between items-center text-sm border-b border-[var(--border)] pb-2">
                    <span className="text-[var(--text-muted)]">Owner Role</span>
                    <span className="font-medium text-[var(--text-primary)]">{provider.manualOwner}</span>
                  </div>
                  <div className="text-sm border-b border-[var(--border)] pb-2">
                    <span className="text-[var(--text-muted)] block mb-1">Evidence Required</span>
                    <span className="font-medium text-[var(--text-primary)]">{provider.manualFulfillment.evidence}</span>
                  </div>
                  <div className="text-sm">
                    <span className="text-[var(--text-muted)] block mb-1">Reconciliation</span>
                    <span className="font-medium text-[var(--text-primary)]">{provider.manualFulfillment.reconciliation}</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-4">
            {isApi ? (
              <ApiConfigurationForms provider={provider} />
            ) : (
              <div className="flex flex-col items-center justify-center h-full min-h-[200px] border-2 border-dashed border-[var(--border)] rounded-lg p-6 text-center text-[var(--text-muted)]">
                <ShieldCheck className="w-8 h-8 mb-3 opacity-50" />
                <h4 className="font-medium text-[var(--text-primary)]">Manual Provider</h4>
                <p className="text-sm mt-1 max-w-[250px]">This provider requires human coordination and manual record keeping. No API integration is available.</p>
              </div>
            )}
          </div>
        </div>
        
        {provider.sourceRecords && provider.sourceRecords.length > 0 && (
          <div className="mt-6 pt-6 border-t border-[var(--border)]">
            <h4 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider mb-4 flex items-center gap-1.5"><History className="w-3.5 h-3.5" /> Source Observations</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
                    <th className="pb-2 font-semibold">Date</th>
                    <th className="pb-2 font-semibold">Type</th>
                    <th className="pb-2 font-semibold">Record ID</th>
                    <th className="pb-2 font-semibold">State</th>
                    <th className="pb-2 font-semibold">Evidence</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {provider.sourceRecords.map((rec, idx) => (
                    <tr key={idx} className="text-[var(--text-primary)]">
                      <td className="py-2">{new Date(rec.sourceObservedAt).toLocaleDateString()}</td>
                      <td className="py-2 capitalize">{rec.recordType.replace(/-/g, ' ')}</td>
                      <td className="py-2 font-mono text-xs">{rec.sourceRecordId}</td>
                      <td className="py-2">
                        <Badge className="bg-[var(--surface-alt)] text-[var(--text-primary)] font-medium border-none shadow-none text-xs">{rec.normalizedState}</Badge>
                      </td>
                      <td className="py-2 text-xs text-[var(--text-muted)] max-w-[200px] truncate" title={rec.evidenceReference || "No reference provided"}>{rec.evidenceReference || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-[var(--text-muted)] mt-2 italic">Note: Source observations represent non-live, unverified evidence recorded for readiness planning.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ApiConfigurationForms({ provider }: { provider: StandardProviderStatus }) {
  const [activeTab, setActiveTab] = useState<'config' | 'refresh'>('config');
  
  return (
    <div className="flex flex-col h-full border border-[var(--border)] rounded-lg overflow-hidden bg-[var(--surface)]">
      <div className="flex border-b border-[var(--border)] bg-[var(--surface-alt)]">
        <button 
          onClick={() => setActiveTab('config')}
          className={cn("flex-1 py-2 text-sm font-medium border-b-2 transition-colors", activeTab === 'config' ? "border-[var(--primary)] text-[var(--primary)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]")}
        >
          Mapping & Config
        </button>
        <button 
          onClick={() => setActiveTab('refresh')}
          className={cn("flex-1 py-2 text-sm font-medium border-b-2 transition-colors", activeTab === 'refresh' ? "border-[var(--primary)] text-[var(--primary)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]")}
        >
          Read Live Source
        </button>
      </div>
      <div className="p-4 flex-1">
        {activeTab === 'config' ? (
          <ConfigForm provider={provider} />
        ) : (
          <SourceRefreshForm provider={provider} />
        )}
      </div>
    </div>
  );
}

function ConfigForm({ provider }: { provider: StandardProviderStatus }) {
  const updateConfig = useUpdateStandardProviderConfiguration();
  const { toast } = useToast();
  
  const [mappings, setMappings] = useState<Record<string, string>>(
    Object.keys(provider.fieldMappings).length > 0 ? provider.fieldMappings : provider.defaultMappings
  );
  
  // Initialize evidence refs as empty string since they are not returned in the API model for cleanliness
  const [sandboxRef, setSandboxRef] = useState("");
  const [operatorRef, setOperatorRef] = useState("");
  const [targetState, setTargetState] = useState<string>(provider.configurationState === 'not-configured' ? 'mapping-configured' : provider.configurationState);

  const handleSave = () => {
    updateConfig.mutate({
      providerKey: provider.key,
      data: {
        configurationState: targetState,
        fieldMappings: mappings,
        expectedVersion: provider.version || 0,
        sandboxEvidenceReference: sandboxRef,
        operatorApprovalReference: operatorRef
      }
    }, {
      onSuccess: () => toast({ title: "Configuration saved successfully" }),
      onError: (err: any) => toast({ title: "Error saving configuration", description: err.message, variant: "destructive" })
    });
  };

  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-2">
        <Label className="text-xs">Target State</Label>
        <select 
          className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-[var(--primary)]"
          value={targetState}
          onChange={e => setTargetState(e.target.value)}
        >
          <option value="mapping-configured">Mapping Configured</option>
          <option value="sandbox-validated">Sandbox Validated</option>
          <option value="operator-approved">Operator Approved</option>
        </select>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">Field Mappings</Label>
        <div className="space-y-2 max-h-[150px] overflow-y-auto pr-1">
          {Object.keys(provider.defaultMappings).map(key => (
            <div key={key} className="flex items-center gap-2">
              <span className="w-1/3 text-xs text-[var(--text-muted)] truncate" title={key}>{key}</span>
              <Input 
                className="w-2/3 h-7 text-xs" 
                value={mappings[key] || ""} 
                onChange={e => setMappings({...mappings, [key]: e.target.value})}
                placeholder={provider.defaultMappings[key]}
              />
            </div>
          ))}
          {provider.key === "oracle-hcm" && (
             <div className="flex items-center gap-2">
                <span className="w-1/3 text-xs text-[var(--text-muted)]">activeStatusValues</span>
                <Input 
                  className="w-2/3 h-7 text-xs" 
                  value={mappings["activeStatusValues"] || ""} 
                  onChange={e => setMappings({...mappings, ["activeStatusValues"]: e.target.value})}
                  placeholder="ACTIVE, SUSPENDED"
                />
             </div>
          )}
          {provider.key === "servicenow" && (
            <>
             <div className="flex items-center gap-2"><span className="w-1/3 text-xs text-[var(--text-muted)]">submittedStates</span><Input className="w-2/3 h-7 text-xs" value={mappings["submittedStates"] || ""} onChange={e => setMappings({...mappings, ["submittedStates"]: e.target.value})} placeholder="submitted, new" /></div>
             <div className="flex items-center gap-2"><span className="w-1/3 text-xs text-[var(--text-muted)]">inProgressStates</span><Input className="w-2/3 h-7 text-xs" value={mappings["inProgressStates"] || ""} onChange={e => setMappings({...mappings, ["inProgressStates"]: e.target.value})} placeholder="in_progress, working" /></div>
             <div className="flex items-center gap-2"><span className="w-1/3 text-xs text-[var(--text-muted)]">fulfilledStates</span><Input className="w-2/3 h-7 text-xs" value={mappings["fulfilledStates"] || ""} onChange={e => setMappings({...mappings, ["fulfilledStates"]: e.target.value})} placeholder="closed_complete" /></div>
             <div className="flex items-center gap-2"><span className="w-1/3 text-xs text-[var(--text-muted)]">failedStates</span><Input className="w-2/3 h-7 text-xs" value={mappings["failedStates"] || ""} onChange={e => setMappings({...mappings, ["failedStates"]: e.target.value})} placeholder="closed_incomplete" /></div>
            </>
          )}
        </div>
      </div>

      {(targetState === 'sandbox-validated' || targetState === 'operator-approved') && (
        <div className="space-y-1">
          <Label className="text-xs">Sandbox Evidence Reference</Label>
          <Input className="h-8 text-xs" value={sandboxRef} onChange={e => setSandboxRef(e.target.value)} placeholder="URL or document reference" />
        </div>
      )}

      {targetState === 'operator-approved' && (
        <div className="space-y-1">
          <Label className="text-xs">Operator Approval Reference</Label>
          <Input className="h-8 text-xs" value={operatorRef} onChange={e => setOperatorRef(e.target.value)} placeholder="Ticket or approval record" />
        </div>
      )}

      <Button onClick={handleSave} disabled={updateConfig.isPending} className="w-full h-8 text-xs bg-[var(--primary)] text-primary-foreground">
        {updateConfig.isPending ? "Saving..." : "Save Configuration"}
      </Button>
    </div>
  );
}

function SourceRefreshForm({ provider }: { provider: StandardProviderStatus }) {
  const refreshSource = useRefreshStandardProviderSourceConfirmation();
  const { toast } = useToast();
  
  const [caseId, setCaseId] = useState("");
  const [workersUniqId, setWorkersUniqId] = useState("");
  const [periodOfServiceId, setPeriodOfServiceId] = useState("");
  const [requestSysId, setRequestSysId] = useState("");
  
  const handleRefresh = () => {
    const caseIdNum = Number(caseId);
    if (!Number.isSafeInteger(caseIdNum) || caseIdNum <= 0) {
      toast({ title: "Invalid Case ID", description: "Case ID must be a positive whole number.", variant: "destructive" });
      return;
    }

    refreshSource.mutate({
      providerKey: provider.key,
      data: provider.key === "oracle-hcm" 
        ? { caseId: caseIdNum, workersUniqId, periodOfServiceId }
        : { caseId: caseIdNum, requestSysId }
    }, {
      onSuccess: () => {
        toast({ title: "Source confirmation read successfully" });
        setWorkersUniqId("");
        setPeriodOfServiceId("");
        setRequestSysId("");
      },
      onError: (err: any) => toast({ title: "Error reading source confirmation", description: err.message, variant: "destructive" })
    });
  };

  const isConfigured = provider.configurationState !== 'not-configured';
  const hasError = refreshSource.isError;
  const isPending = refreshSource.isPending;

  if (!isConfigured) {
    return (
      <div className="text-center py-6 text-[var(--text-muted)]">
        <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-50 text-[var(--status-amber-fg)]" />
        <p className="text-sm">Configure and validate mappings before reading from the live source.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 text-sm flex flex-col h-full justify-between">
      <div className="space-y-3">
        <div className="space-y-1">
          <Label className="text-xs">Case ID</Label>
          <Input 
            className="h-8 text-xs" 
            type="number"
            value={caseId} 
            onChange={e => setCaseId(e.target.value)} 
            placeholder="e.g. 123" 
          />
        </div>
        
        {provider.key === "oracle-hcm" && (
          <>
            <div className="space-y-1">
              <Label className="text-xs">Workers Unique ID</Label>
              <Input 
                className="h-8 text-xs" 
                value={workersUniqId} 
                onChange={e => setWorkersUniqId(e.target.value)} 
                placeholder="Unique person identifier" 
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Period of Service ID</Label>
              <Input 
                className="h-8 text-xs" 
                value={periodOfServiceId} 
                onChange={e => setPeriodOfServiceId(e.target.value)} 
                placeholder="Work relationship identifier" 
              />
            </div>
          </>
        )}

        {provider.key === "servicenow" && (
          <div className="space-y-1">
            <Label className="text-xs">Request sys_id</Label>
            <Input 
              className="h-8 text-xs" 
              value={requestSysId} 
              onChange={e => setRequestSysId(e.target.value)} 
              placeholder="e.g. 9b1c87... (internal sys_id)" 
            />
          </div>
        )}
      </div>
      
      {hasError && (
        <div className="p-3 text-xs bg-[var(--status-red-bg)] text-[var(--status-red-fg)] rounded border border-[var(--status-red-fg)]/20">
          Failed to authenticate or read from provider. Check that mapping is correct, the record exists, and current user has sensitive-record authority.
        </div>
      )}

      <Button 
        onClick={handleRefresh} 
        disabled={
          isPending || 
          !caseId || 
          (provider.key === 'oracle-hcm' ? (!workersUniqId || !periodOfServiceId) : !requestSysId)
        } 
        className="w-full h-8 text-xs bg-[var(--status-info-bg)] text-[var(--status-info-fg)] hover:opacity-90 border-none shadow-none font-medium flex items-center justify-center gap-2"
      >
        {isPending ? "Reading..." : <><RefreshCcw className="w-3.5 h-3.5" /> Read Live Source</>}
      </Button>
    </div>
  );
}
