import { useState, useEffect } from "react";
import { EaAssessment, EaGovernanceRecord, EaGovernanceRecordRecordType, EaGovernanceRecordStatus } from "@workspace/api-client-react";
import { useAssessmentUpdater } from "./utils";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

function BlurInput({ value, onSave, ...props }: any) {
  const [val, setVal] = useState(value || "");
  useEffect(() => setVal(value || ""), [value]);
  return <Input value={val} onChange={e => setVal(e.target.value)} onBlur={() => { if(val !== (value || "")) onSave(val); }} {...props} />;
}

function BlurTextarea({ value, onSave, ...props }: any) {
  const [val, setVal] = useState(value || "");
  useEffect(() => setVal(value || ""), [value]);
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

export function ImplementationGovernanceManager({ assessment, isReadOnly }: { assessment: EaAssessment, isReadOnly: boolean }) {
  const [records, setRecords] = useState<EaGovernanceRecord[]>([]);
  
  useEffect(() => {
    const gov = assessment.content.governance;
    if (gov) {
      setRecords([
        ...(gov.contracts || []),
        ...(gov.reviews || []),
        ...(gov.deviations || []),
        ...(gov.waivers || []),
        ...(gov.remediation || [])
      ]);
    }
  }, [assessment]);

  const updateGovernance = useAssessmentUpdater<any>(assessment, "governance");

  const saveRecords = (transform: (current: EaGovernanceRecord[]) => EaGovernanceRecord[]) => {
    setRecords(transform);
    updateGovernance((governance: any) => {
      const current = Object.values(governance).flat() as EaGovernanceRecord[];
      const updated = transform(current);
      return {
        ...governance,
        contracts: updated.filter(r => r.recordType === "contract"),
        reviews: updated.filter(r => r.recordType === "review"),
        deviations: updated.filter(r => r.recordType === "deviation"),
        waivers: updated.filter(r => r.recordType === "waiver"),
        remediation: updated.filter(r => r.recordType === "remediation"),
      };
    });
  };

  const handleAddRecord = () => {
    const newRecord: EaGovernanceRecord = {
      id: crypto.randomUUID(),
      title: "New Governance Record",
      recordType: "review",
      status: "scheduled",
      owner: "",
      description: "",
      dueDate: new Date().toISOString().split('T')[0],
      targetComponentIds: [],
      workPackageIds: [],
      decisionIds: []
    };
    saveRecords(current => [newRecord, ...current]);
  };

  const updateRecord = (id: string, field: keyof EaGovernanceRecord, value: any) => {
    saveRecords(current => current.map(r => r.id === id ? { ...r, [field]: value } : r));
  };

  const removeRecord = (id: string) => {
    saveRecords(current => current.filter(r => r.id !== id));
  };

  const targetComponentOptions = (assessment.content.targetArchitecture?.components || []).map(c => ({ id: c.id, label: c.name }));
  const workPackageOptions = (assessment.content.roadmap?.workPackages || []).map(w => ({ id: w.id, label: w.name }));
  const decisionOptions = (assessment.content.decisions || []).map(d => ({ id: d.id, label: d.title }));

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Implementation Governance</h2>
          <p className="text-muted-foreground mt-1 text-sm">Manage reviews, waivers, and implementation compliance.</p>
        </div>
        <Button onClick={handleAddRecord} size="sm" disabled={isReadOnly} data-testid="btn-add-gov-record">
          <Plus className="w-4 h-4 mr-2" /> Add Record
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-6">
        {records.length === 0 && (
          <div className="p-12 border border-dashed rounded-xl text-center">
            <p className="text-muted-foreground">No governance records found.</p>
          </div>
        )}
        {records.map(rec => (
          <div key={rec.id} className="p-5 border rounded-xl bg-card shadow-sm space-y-4">
            <div className="flex flex-col md:flex-row gap-4 justify-between items-start">
              <div className="flex-1 space-y-4 w-full">
                <div className="flex flex-col sm:flex-row gap-4 sm:items-center">
                  <BlurInput 
                    value={rec.title} 
                    onSave={(val: string) => updateRecord(rec.id, 'title', val)}
                    className="font-semibold text-base h-9 border-transparent hover:border-input bg-transparent px-2 -ml-2 w-full sm:max-w-md"
                    placeholder="Record title"
                    disabled={isReadOnly}
                    data-testid={`input-gov-title-${rec.id}`}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Select value={rec.recordType} onValueChange={(v) => updateRecord(rec.id, 'recordType', v)} disabled={isReadOnly}>
                      <SelectTrigger className="h-8 w-32 text-xs" data-testid={`select-gov-type-${rec.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.values(EaGovernanceRecordRecordType).map(v => (
                          <SelectItem key={v} value={v} className="text-xs capitalize">{v}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={rec.status} onValueChange={(v) => updateRecord(rec.id, 'status', v)} disabled={isReadOnly}>
                      <SelectTrigger className="h-8 w-32 text-xs" data-testid={`select-gov-status-${rec.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.values(EaGovernanceRecordStatus).map(v => (
                          <SelectItem key={v} value={v} className="text-xs capitalize">{v}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground uppercase">Owner</label>
                    <BlurInput 
                      value={rec.owner} 
                      onSave={(val: string) => updateRecord(rec.id, 'owner', val)}
                      className="h-8 text-sm bg-muted/20"
                      placeholder="Owner Name"
                      disabled={isReadOnly}
                      data-testid={`input-gov-owner-${rec.id}`}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground uppercase">Due Date</label>
                    <BlurInput 
                      type="date"
                      value={rec.dueDate} 
                      onSave={(val: string) => updateRecord(rec.id, 'dueDate', val)}
                      className="h-8 text-sm bg-muted/20"
                      disabled={isReadOnly}
                      data-testid={`input-gov-date-${rec.id}`}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground uppercase">Description</label>
                  <BlurTextarea 
                    value={rec.description} 
                    onSave={(val: string) => updateRecord(rec.id, 'description', val)}
                    className="text-sm min-h-[60px] resize-none bg-muted/20"
                    placeholder="Provide detailed description..."
                    disabled={isReadOnly}
                    data-testid={`input-gov-desc-${rec.id}`}
                  />
                </div>
              </div>

              {!isReadOnly && (
                <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive shrink-0" onClick={() => removeRecord(rec.id)} data-testid={`btn-remove-gov-${rec.id}`}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              )}
            </div>

            <div className="border-t pt-4 grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="space-y-2">
                <label className="text-xs font-semibold text-muted-foreground uppercase">Target Components</label>
                <CrossRecordSelector 
                  value={rec.targetComponentIds || []} 
                  onSave={(val) => updateRecord(rec.id, 'targetComponentIds', val)} 
                  options={targetComponentOptions} 
                  placeholder="Select Component..." 
                  disabled={isReadOnly}
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-semibold text-muted-foreground uppercase">Work Packages</label>
                <CrossRecordSelector 
                  value={rec.workPackageIds || []} 
                  onSave={(val) => updateRecord(rec.id, 'workPackageIds', val)} 
                  options={workPackageOptions} 
                  placeholder="Select Work Package..." 
                  disabled={isReadOnly}
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-semibold text-muted-foreground uppercase">Decisions</label>
                <CrossRecordSelector 
                  value={rec.decisionIds || []} 
                  onSave={(val) => updateRecord(rec.id, 'decisionIds', val)} 
                  options={decisionOptions} 
                  placeholder="Select Decision..." 
                  disabled={isReadOnly}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
