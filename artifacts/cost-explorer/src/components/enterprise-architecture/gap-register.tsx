import { useState, useRef, useEffect, useCallback } from "react";
import { 
  EaAssessment, 
  EaGap,
  EaDomain,
  EaGapSeverity,
  EaGapDisposition
} from "@workspace/api-client-react";
import { Plus, Search, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAssessmentUpdater } from "./utils";

export function GapRegister({ assessment, isReadOnly }: { assessment: EaAssessment, isReadOnly: boolean }) {
  const [gaps, setGaps] = useState<EaGap[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const initializedId = useRef<number | null>(null);

  const updateGaps = useAssessmentUpdater<EaGap[]>(assessment, 'gaps', undefined, setGaps);

  useEffect(() => {
    if (assessment && initializedId.current !== assessment.id) {
      initializedId.current = assessment.id;
      setGaps(assessment.content.gaps || []);
    }
  }, [assessment]);

  const saveGaps = useCallback((transform: (current: EaGap[]) => EaGap[]) => {
    setGaps(transform);
    updateGaps(transform);
  }, [updateGaps]);

  const handleLocalUpdate = (id: string, field: keyof EaGap, value: any) => {
    setGaps(current => current.map(gap => gap.id === id ? { ...gap, [field]: value } : gap));
  };

  const handleBlur = (id: string) => {
    const localGap = gaps.find((gap) => gap.id === id);
    if (localGap) updateGaps(current => current.map(gap => gap.id === id ? { ...gap, ...localGap } : gap));
  };

  const handleUpdateGap = (id: string, field: keyof EaGap, value: any) => {
    const transform = (current: EaGap[]) => current.map(gap => gap.id === id ? { ...gap, [field]: value } : gap);
    setGaps(transform);
    updateGaps(transform);
  };

  const handleAddGap = () => {
    const newGap: EaGap = {
      id: crypto.randomUUID(),
      title: "New Architectural Gap",
      domain: "business",
      severity: "medium",
      impact: "",
      recommendation: "",
      targetBuildingBlockId: "",
      implementationDependencyIds: [],
      disposition: "open",
      traceability: {
        requirementIds: [],
        gapIds: [],
        targetComponentIds: [],
        workPackageIds: [],
        governanceReviewIds: []
      }
    };
    saveGaps((current) => [newGap, ...current]);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Gap Register</h2>
          <p className="text-muted-foreground mt-1">Identify and track architectural gaps between baseline and target.</p>
        </div>
        <Button onClick={handleAddGap} size="sm" disabled={isReadOnly} data-testid="btn-add-gap">
          <Plus className="w-4 h-4 mr-2" /> Log Gap
        </Button>
      </div>

      <div className="space-y-4">
        {gaps.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-12 border border-dashed rounded-xl bg-muted/5 text-center">
            <Search className="w-10 h-10 text-muted-foreground mb-4 opacity-20" />
            <h3 className="text-lg font-medium">No gaps identified</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">Log architectural omissions, technical debt, or functional shortfalls here.</p>
          </div>
        ) : (
          gaps.map(gap => (
            <div key={gap.id} className="p-4 border rounded-xl bg-card shadow-sm space-y-4">
                <div className="flex gap-4 items-start">
                  <div className="flex-1">
                    <Input 
                      value={gap.title}
                      onChange={(e) => handleLocalUpdate(gap.id, 'title', e.target.value)}
                      onBlur={() => handleBlur(gap.id)}
                      className="font-semibold text-base h-9 border-transparent hover:border-input bg-transparent -ml-3 px-3 w-full"
                      disabled={isReadOnly}
                      data-testid={`input-gap-title-${gap.id}`}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Select value={gap.domain} onValueChange={(v) => handleUpdateGap(gap.id, 'domain', v)} disabled={isReadOnly}>
                      <SelectTrigger className="h-8 w-[130px] text-xs" data-testid={`select-gap-domain-${gap.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.values(EaDomain).map(v => (
                          <SelectItem key={v} value={v} className="text-xs capitalize">{v.replace('-', ' ')}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    
                    <Select value={gap.severity} onValueChange={(v) => handleUpdateGap(gap.id, 'severity', v)} disabled={isReadOnly}>
                      <SelectTrigger className="h-8 w-[110px] text-xs" data-testid={`select-gap-severity-${gap.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.values(EaGapSeverity).map(v => (
                          <SelectItem key={v} value={v} className="text-xs capitalize">{v}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    
                    <Select value={gap.disposition} onValueChange={(v) => handleUpdateGap(gap.id, 'disposition', v)} disabled={isReadOnly}>
                      <SelectTrigger className="h-8 w-[110px] text-xs" data-testid={`select-gap-disposition-${gap.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.values(EaGapDisposition).map(v => (
                          <SelectItem key={v} value={v} className="text-xs capitalize">{v}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    
                    <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground" onClick={() => setExpandedId(expandedId === gap.id ? null : gap.id)}>
                      {expandedId === gap.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" onClick={() => saveGaps(current => current.filter(g => g.id !== gap.id))} disabled={isReadOnly} data-testid={`btn-remove-gap-${gap.id}`}>
                      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.5 1C5.22386 1 5 1.22386 5 1.5C5 1.77614 5.22386 2 5.5 2H9.5C9.77614 2 10 1.77614 10 1.5C10 1.22386 9.77614 1 9.5 1H5.5ZM3 3.5C2.72386 3.5 2.5 3.72386 2.5 4C2.5 4.27614 2.72386 4.5 3 4.5H12C12.2761 4.5 12.5 4.27614 12.5 4C12.5 3.72386 12.2761 3.5 12 3.5H3ZM4.5 5.5C4.5 5.22386 4.72386 5 5 5C5.27614 5 5.5 5.22386 5.5 5.5V11.5C5.5 11.7761 5.27614 12 5 12C4.72386 12 4.5 11.7761 4.5 11.5V5.5ZM10.5 5.5C10.5 5.22386 10.2761 5 10 5C9.72386 5 9.5 5.22386 9.5 5.5V11.5C9.5 11.7761 9.72386 12 10 12C10.2761 12 10.5 11.7761 10.5 11.5V5.5Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd"></path></svg>
                    </Button>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground uppercase">Impact</label>
                    <Textarea 
                      value={gap.impact}
                      onChange={(e) => handleLocalUpdate(gap.id, 'impact', e.target.value)}
                      onBlur={() => handleBlur(gap.id)}
                      placeholder="Describe the business or technical impact of this gap..."
                      className="resize-none h-20 text-sm bg-muted/20"
                      disabled={isReadOnly}
                      data-testid={`input-gap-impact-${gap.id}`}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground uppercase">Recommendation</label>
                    <Textarea 
                      value={gap.recommendation}
                      onChange={(e) => handleLocalUpdate(gap.id, 'recommendation', e.target.value)}
                      onBlur={() => handleBlur(gap.id)}
                      placeholder="Describe how to resolve or mitigate this gap..."
                      className="resize-none h-20 text-sm bg-muted/20"
                      disabled={isReadOnly}
                      data-testid={`input-gap-recommendation-${gap.id}`}
                    />
                  </div>
                </div>

                {expandedId === gap.id && (
                  <div className="pt-4 border-t mt-4 grid grid-cols-2 gap-6">
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <label className="text-xs font-semibold text-muted-foreground uppercase">Target Building Block</label>
                        <Input 
                          value={gap.targetBuildingBlockId} 
                          onChange={(e) => handleLocalUpdate(gap.id, 'targetBuildingBlockId', e.target.value)}
                          onBlur={() => handleBlur(gap.id)}
                          placeholder="Target Component ID..."
                          className="h-8 text-sm bg-muted/20"
                          disabled={isReadOnly}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-semibold text-muted-foreground uppercase">Dependencies</label>
                        <Input 
                          value={(gap.implementationDependencyIds || []).join(", ")} 
                          onChange={(e) => handleLocalUpdate(gap.id, 'implementationDependencyIds', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                          onBlur={() => handleBlur(gap.id)}
                          placeholder="Comma-separated Dependency IDs..."
                          className="h-8 text-sm bg-muted/20"
                          disabled={isReadOnly}
                        />
                      </div>
                    </div>
                    <div className="space-y-4">
                      <label className="text-xs font-semibold text-muted-foreground uppercase">Traceability Links</label>
                      <div className="text-xs text-muted-foreground italic bg-card p-3 rounded border">
                        Requirement IDs: {gap.traceability.requirementIds?.length || 0}
                        <br />
                        Work Package IDs: {gap.traceability.workPackageIds?.length || 0}
                      </div>
                    </div>
                  </div>
                )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
