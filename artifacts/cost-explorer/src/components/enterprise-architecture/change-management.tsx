import { useState } from "react";
import { EaAssessment, EaChangeRequest, EaChangeRequestStatus, EaChangeRequestClassification, EaArchitectureVersion } from "@workspace/api-client-react";
import { useAssessmentUpdater } from "./utils";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { resolveSubmittedDraft, useDraftProtection, useMergeSavedDraft } from "./edit-recovery";

function BlurInput({ value, onSave, ...props }: any) {
  const [val, setVal] = useState(value || "");
  useDraftProtection(val, value || "", () => setVal(value || ""), "Text field");
  useMergeSavedDraft(value || "", setVal);
  return <Input value={val} onChange={e => setVal(e.target.value)} onBlur={() => { if(val !== (value || "")) onSave(val); }} {...props} />;
}

function BlurTextarea({ value, onSave, ...props }: any) {
  const [val, setVal] = useState(value || "");
  useDraftProtection(val, value || "", () => setVal(value || ""), "Text area");
  useMergeSavedDraft(value || "", setVal);
  return <Textarea value={val} onChange={e => setVal(e.target.value)} onBlur={() => { if(val !== (value || "")) onSave(val); }} {...props} />;
}

function CrossRecordSelector({ 
  value = [], 
  onSave, 
  options, 
  placeholder, 
  disabled 
}: { 
  value: string[], 
  onSave: (val: string[]) => void, 
  options: {id: string, label: string}[], 
  placeholder: string,
  disabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1 min-h-[24px]">
        {value.map(id => {
          const opt = options.find(o => o.id === id);
          return (
            <span key={id} className="inline-flex items-center gap-1 bg-secondary text-secondary-foreground text-xs px-2 py-1 rounded-md max-w-full">
              <span className="truncate min-w-0 max-w-[200px]">{opt ? opt.label : id}</span>
              {!disabled && (
                <button type="button" onClick={() => onSave(value.filter(v => v !== id))} className="hover:text-destructive ml-1 shrink-0">
                  &times;
                </button>
              )}
            </span>
          );
        })}
        {value.length === 0 && <span className="text-xs text-muted-foreground italic flex items-center">None selected</span>}
      </div>
      {!disabled && options.filter(o => !value.includes(o.id)).length > 0 && (
        <Select 
          value="" 
          onValueChange={(v) => {
            if (v && !value.includes(v)) {
              onSave([...value, v]);
            }
          }}
        >
          <SelectTrigger className="h-8 text-xs w-full sm:w-auto sm:min-w-[200px]">
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            {options.filter(o => !value.includes(o.id)).map(o => (
              <SelectItem key={o.id} value={o.id} className="text-xs">{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

export function ChangeManagementManager({ assessment, isReadOnly }: { assessment: EaAssessment, isReadOnly: boolean }) {
  const savedRequests = assessment.content.changeManagement?.requests || [];
  const savedVersions = assessment.content.changeManagement?.versionHistory || [];
  const [requests, setRequests] = useState<EaChangeRequest[]>(savedRequests);
  const [versions, setVersions] = useState<EaArchitectureVersion[]>(savedVersions);
  useMergeSavedDraft(savedRequests, setRequests, "changeManagement.requests");
  useMergeSavedDraft(savedVersions, setVersions, "changeManagement.versionHistory");

  const saveRequests = useAssessmentUpdater<EaChangeRequest[]>(assessment, "changeManagement", "requests", resolveSubmittedDraft(setRequests));
  const saveVersions = useAssessmentUpdater<EaArchitectureVersion[]>(assessment, "changeManagement", "versionHistory", resolveSubmittedDraft(setVersions));

  const handleAddRequest = () => {
    const newRequest: EaChangeRequest = {
      id: crypto.randomUUID(),
      title: "New Change Request",
      description: "",
      requestedBy: "",
      status: "submitted",
      classification: "minor",
      impact: {
        baseline: "",
        targetState: "",
        roadmap: "",
        cost: "",
        affectedIds: []
      }
    };
    const transform = (current: EaChangeRequest[]) => [newRequest, ...current];
    setRequests(transform); saveRequests(transform);
  };

  const updateRequest = (id: string, field: keyof EaChangeRequest, value: any) => {
    const transform = (current: EaChangeRequest[]) => current.map(req => req.id === id ? { ...req, [field]: value } : req);
    setRequests(transform); saveRequests(transform);
  };

  const updateImpact = (id: string, impactField: keyof EaChangeRequest['impact'], value: any) => {
    const transform = (current: EaChangeRequest[]) => current.map(req => 
      req.id === id 
        ? { ...req, impact: { ...req.impact, [impactField]: value } } 
        : req
    );
    setRequests(transform); saveRequests(transform);
  };

  const removeRequest = (id: string) => {
    const transform = (current: EaChangeRequest[]) => current.filter(req => req.id !== id);
    setRequests(transform); saveRequests(transform);
  };

  const handleAddVersion = () => {
    const newVer: EaArchitectureVersion = {
      id: crypto.randomUUID(),
      version: "1.0.0",
      description: "",
      approvedAt: new Date().toISOString().split('T')[0],
      approvedBy: "",
      changeRequestIds: []
    };
    const transform = (current: EaArchitectureVersion[]) => [newVer, ...current];
    setVersions(transform); saveVersions(transform);
  };

  const updateVersion = (id: string, field: keyof EaArchitectureVersion, value: any) => {
    const transform = (current: EaArchitectureVersion[]) => current.map(v => v.id === id ? { ...v, [field]: value } : v);
    setVersions(transform); saveVersions(transform);
  };

  const removeVersion = (id: string) => {
    const transform = (current: EaArchitectureVersion[]) => current.filter(v => v.id !== id);
    setVersions(transform); saveVersions(transform);
  };

  const affectedOptions = [
    ...(assessment.content.targetArchitecture?.components || []).map(c => ({ id: c.id, label: `Component: ${c.name}` })),
    ...(assessment.content.roadmap?.workPackages || []).map(w => ({ id: w.id, label: `WP: ${w.name}` }))
  ];

  const requestOptions = requests.map(r => ({ id: r.id, label: r.title }));

  return (
    <div className="space-y-12">
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Change Requests</h2>
            <p className="text-muted-foreground mt-1 text-sm">Manage and assess change requests against the baseline architecture.</p>
          </div>
          <Button onClick={handleAddRequest} size="sm" disabled={isReadOnly} data-testid="btn-add-cr">
            <Plus className="w-4 h-4 mr-2" /> Add Request
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-6">
          {requests.length === 0 && (
            <div className="p-12 border border-dashed rounded-xl text-center">
              <p className="text-muted-foreground">No change requests found.</p>
            </div>
          )}
          {requests.map(req => (
            <div key={req.id} className="p-5 border rounded-xl bg-card shadow-sm space-y-4">
              <div className="flex flex-col md:flex-row gap-4 justify-between items-start">
                <div className="flex-1 space-y-4 w-full">
                  <div className="flex flex-col sm:flex-row gap-4 sm:items-center">
                    <BlurInput 
                      value={req.title}
                      onSave={(val: string) => updateRequest(req.id, 'title', val)}
                      className="font-semibold text-base h-9 border-transparent hover:border-input bg-transparent px-2 -ml-2 w-full sm:max-w-md"
                      disabled={isReadOnly}
                      data-testid={`input-cr-title-${req.id}`}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Select value={req.classification} onValueChange={(v) => updateRequest(req.id, 'classification', v)} disabled={isReadOnly}>
                        <SelectTrigger className="h-8 w-32 text-xs" data-testid={`select-cr-class-${req.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.values(EaChangeRequestClassification).map(v => (
                            <SelectItem key={v} value={v} className="text-xs capitalize">{v.replace('-', ' ')}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select value={req.status} onValueChange={(v) => updateRequest(req.id, 'status', v)} disabled={isReadOnly}>
                        <SelectTrigger className="h-8 w-32 text-xs" data-testid={`select-cr-status-${req.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.values(EaChangeRequestStatus).map(v => (
                            <SelectItem key={v} value={v} className="text-xs capitalize">{v}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-muted-foreground uppercase">Requested By</label>
                      <BlurInput 
                        value={req.requestedBy}
                        onSave={(val: string) => updateRequest(req.id, 'requestedBy', val)}
                        className="h-8 text-sm bg-muted/20"
                        placeholder="Requester Name"
                        disabled={isReadOnly}
                        data-testid={`input-cr-requester-${req.id}`}
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground uppercase">Description</label>
                    <BlurTextarea 
                      value={req.description}
                      onSave={(val: string) => updateRequest(req.id, 'description', val)}
                      className="text-sm min-h-[60px] resize-none bg-muted/20"
                      placeholder="Describe the change request..."
                      disabled={isReadOnly}
                      data-testid={`input-cr-desc-${req.id}`}
                    />
                  </div>
                </div>

                {!isReadOnly && (
                  <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive shrink-0" onClick={() => removeRequest(req.id)} data-testid={`btn-remove-cr-${req.id}`}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>

              <div className="border-t pt-4">
                <h4 className="text-sm font-semibold mb-3">Impact Assessment</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Baseline Impact</label>
                      <BlurTextarea 
                        value={req.impact.baseline}
                        onSave={(val: string) => updateImpact(req.id, 'baseline', val)}
                        placeholder="Impact on baseline..."
                        className="resize-none h-16 text-sm bg-muted/20"
                        disabled={isReadOnly}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Target State Impact</label>
                      <BlurTextarea 
                        value={req.impact.targetState}
                        onSave={(val: string) => updateImpact(req.id, 'targetState', val)}
                        placeholder="Impact on target state..."
                        className="resize-none h-16 text-sm bg-muted/20"
                        disabled={isReadOnly}
                        data-testid={`input-cr-impact-${req.id}`}
                      />
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Roadmap Impact</label>
                      <BlurTextarea 
                        value={req.impact.roadmap}
                        onSave={(val: string) => updateImpact(req.id, 'roadmap', val)}
                        placeholder="Impact on roadmap schedule..."
                        className="resize-none h-16 text-sm bg-muted/20"
                        disabled={isReadOnly}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Cost Impact</label>
                      <BlurTextarea 
                        value={req.impact.cost}
                        onSave={(val: string) => updateImpact(req.id, 'cost', val)}
                        placeholder="Financial impact..."
                        className="resize-none h-16 text-sm bg-muted/20"
                        disabled={isReadOnly}
                      />
                    </div>
                  </div>
                </div>
                <div className="mt-5 space-y-2">
                  <label className="text-xs font-semibold text-muted-foreground uppercase">Affected Items</label>
                  <CrossRecordSelector 
                    value={req.impact.affectedIds || []} 
                    onSave={(val) => updateImpact(req.id, 'affectedIds', val)} 
                    options={affectedOptions} 
                    placeholder="Select Affected Component or WP..." 
                    disabled={isReadOnly}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-6 pt-6 border-t">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Architecture Version History</h2>
            <p className="text-muted-foreground mt-1 text-sm">Track approved versions of the enterprise architecture.</p>
          </div>
          <Button onClick={handleAddVersion} size="sm" disabled={isReadOnly} data-testid="btn-add-version">
            <Plus className="w-4 h-4 mr-2" /> Add Version
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-6">
          {versions.length === 0 && (
            <div className="p-12 border border-dashed rounded-xl text-center">
              <p className="text-muted-foreground">No versions recorded.</p>
            </div>
          )}
          {versions.map(ver => (
            <div key={ver.id} className="p-5 border rounded-xl bg-card shadow-sm space-y-4">
              <div className="flex flex-col md:flex-row gap-4 justify-between items-start">
                <div className="flex-1 space-y-4 w-full">
                  <div className="flex flex-col sm:flex-row gap-4 sm:items-center">
                    <div className="space-y-1.5 flex-1 max-w-[200px]">
                      <label className="text-xs font-semibold text-muted-foreground uppercase">Version</label>
                      <BlurInput 
                        value={ver.version}
                        onSave={(val: string) => updateVersion(ver.id, 'version', val)}
                        className="font-mono text-sm h-8 bg-muted/20"
                        disabled={isReadOnly}
                        data-testid={`input-ver-id-${ver.id}`}
                      />
                    </div>
                    <div className="space-y-1.5 flex-1 max-w-[200px]">
                      <label className="text-xs font-semibold text-muted-foreground uppercase">Approved At</label>
                      <BlurInput 
                        type="date"
                        value={ver.approvedAt}
                        onSave={(val: string) => updateVersion(ver.id, 'approvedAt', val)}
                        className="text-sm h-8 bg-muted/20"
                        disabled={isReadOnly}
                      />
                    </div>
                    <div className="space-y-1.5 flex-1 max-w-[200px]">
                      <label className="text-xs font-semibold text-muted-foreground uppercase">Approved By</label>
                      <BlurInput 
                        value={ver.approvedBy}
                        onSave={(val: string) => updateVersion(ver.id, 'approvedBy', val)}
                        className="text-sm h-8 bg-muted/20"
                        disabled={isReadOnly}
                      />
                    </div>
                  </div>
                  
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground uppercase">Description</label>
                    <BlurTextarea 
                      value={ver.description}
                      onSave={(val: string) => updateVersion(ver.id, 'description', val)}
                      className="text-sm min-h-[60px] resize-none bg-muted/20"
                      disabled={isReadOnly}
                    />
                  </div>

                  <div className="space-y-2 border-t pt-4">
                    <label className="text-xs font-semibold text-muted-foreground uppercase">Linked Change Requests</label>
                    <CrossRecordSelector 
                      value={ver.changeRequestIds || []} 
                      onSave={(val) => updateVersion(ver.id, 'changeRequestIds', val)} 
                      options={requestOptions} 
                      placeholder="Link Change Request..." 
                      disabled={isReadOnly}
                    />
                  </div>
                </div>

                {!isReadOnly && (
                  <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive shrink-0" onClick={() => removeVersion(ver.id)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
