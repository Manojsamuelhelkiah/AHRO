import React, { useState, useRef, useEffect, useCallback } from "react";
import { 
  EaAssessment, 
  EaRequirement,
  EaRequirementPriority,
  EaRequirementStatus
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetEaAssessmentQueryKey } from "@workspace/api-client-react";
import { Plus, Search, HelpCircle, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { useAssessmentUpdater } from "./utils";

export function RequirementsManager({ assessment, isReadOnly }: { assessment: EaAssessment, isReadOnly: boolean }) {
  const [requirements, setRequirements] = useState<EaRequirement[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const initializedId = useRef<number | null>(null);

  const updateRequirements = useAssessmentUpdater<EaRequirement[]>(assessment, 'requirements', undefined, setRequirements);

  useEffect(() => {
    if (assessment && initializedId.current !== assessment.id) {
      initializedId.current = assessment.id;
      setRequirements(assessment.content.requirements || []);
    }
  }, [assessment]);

  const saveRequirements = useCallback((transform: (current: EaRequirement[]) => EaRequirement[]) => {
    setRequirements(transform);
    updateRequirements(transform);
  }, [updateRequirements]);

  const handleLocalUpdate = (id: string, field: keyof EaRequirement, value: any) => {
    setRequirements(current => current.map(req => req.id === id ? { ...req, [field]: value } : req));
  };

  const handleBlur = (id: string) => {
    const localRequirement = requirements.find((requirement) => requirement.id === id);
    if (localRequirement) {
      updateRequirements(current => current.map(requirement => requirement.id === id ? { ...requirement, ...localRequirement } : requirement));
    }
  };

  const handleUpdateRequirement = (id: string, field: keyof EaRequirement, value: any) => {
    const transform = (current: EaRequirement[]) => current.map(req => req.id === id ? { ...req, [field]: value } : req);
    setRequirements(transform);
    updateRequirements(transform);
  };

  const handleTraceabilityToggle = (
    requirementId: string,
    field: "requirementIds" | "gapIds" | "targetComponentIds" | "workPackageIds" | "governanceReviewIds",
    linkedId: string,
    checked: boolean,
  ) => {
    const transform = (current: EaRequirement[]) => current.map((requirement) => {
      if (requirement.id !== requirementId) return requirement;
      const existing = requirement.traceability[field] ?? [];
      return {
        ...requirement,
        traceability: {
          ...requirement.traceability,
          [field]: checked
            ? Array.from(new Set([...existing, linkedId]))
            : existing.filter((id) => id !== linkedId),
        },
      };
    });
    setRequirements(transform);
    updateRequirements(transform);
  };

  const governanceRecords = Object.values(assessment.content.governance).flat();

  const handleAddRequirement = () => {
    const newReq: EaRequirement = {
      id: crypto.randomUUID(),
      title: "New Requirement",
      description: "",
      stakeholder: "",
      concern: "",
      priority: "medium",
      status: "proposed",
      acceptanceCriteria: [],
      traceability: {
        requirementIds: [],
        gapIds: [],
        targetComponentIds: [],
        workPackageIds: [],
        governanceReviewIds: []
      }
    };
    saveRequirements((current) => [newReq, ...current]);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Requirements Management</h2>
          <p className="text-muted-foreground mt-1">Cross-phase tracking of architecture requirements.</p>
        </div>
        <Button onClick={handleAddRequirement} size="sm" disabled={isReadOnly} data-testid="btn-add-req">
          <Plus className="w-4 h-4 mr-2" /> Add Requirement
        </Button>
      </div>

      <div className="border rounded-xl bg-card overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="w-[300px]">Title & Description</TableHead>
              <TableHead>Stakeholder</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[100px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requirements.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                  <div className="flex flex-col items-center justify-center">
                    <Search className="w-8 h-8 opacity-20 mb-3" />
                    <p>No requirements captured yet.</p>
                    <Button variant="link" onClick={handleAddRequirement} className="mt-2">Add the first requirement</Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              requirements.map(req => (
                <React.Fragment key={req.id}>
                  <TableRow className="group hover:bg-muted/20 align-top cursor-pointer" onClick={() => setExpandedId(expandedId === req.id ? null : req.id)}>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="space-y-2">
                        <Input 
                          value={req.title} 
                          onChange={(e) => handleLocalUpdate(req.id, 'title', e.target.value)}
                          onBlur={() => handleBlur(req.id)}
                          className="font-medium bg-transparent border-transparent group-hover:border-input px-2 -ml-2 h-8"
                          placeholder="Requirement title"
                          disabled={isReadOnly}
                          data-testid={`input-req-title-${req.id}`}
                        />
                        <Textarea 
                          value={req.description} 
                          onChange={(e) => handleLocalUpdate(req.id, 'description', e.target.value)}
                          onBlur={() => handleBlur(req.id)}
                          className="text-xs bg-transparent border-transparent group-hover:border-input px-2 -ml-2 min-h-[60px] resize-none text-muted-foreground leading-relaxed"
                          placeholder="Detailed description..."
                          disabled={isReadOnly}
                          data-testid={`input-req-desc-${req.id}`}
                        />
                      </div>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Input 
                        value={req.stakeholder} 
                        onChange={(e) => handleLocalUpdate(req.id, 'stakeholder', e.target.value)}
                          onBlur={() => handleBlur(req.id)}
                        className="text-xs bg-transparent border-transparent group-hover:border-input px-2 -ml-2 h-8"
                        placeholder="e.g. CISO, VP HR"
                        disabled={isReadOnly}
                        data-testid={`input-req-stakeholder-${req.id}`}
                      />
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Select value={req.priority} onValueChange={(v) => handleUpdateRequirement(req.id, 'priority', v)} disabled={isReadOnly}>
                        <SelectTrigger className="h-8 w-28 text-xs" data-testid={`select-req-priority-${req.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.values(EaRequirementPriority).map(v => (
                            <SelectItem key={v} value={v} className="text-xs capitalize">{v}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Select value={req.status} onValueChange={(v) => handleUpdateRequirement(req.id, 'status', v)} disabled={isReadOnly}>
                        <SelectTrigger className="h-8 w-32 text-xs" data-testid={`select-req-status-${req.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.values(EaRequirementStatus).map(v => (
                            <SelectItem key={v} value={v} className="text-xs capitalize">{v}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => setExpandedId(expandedId === req.id ? null : req.id)}>
                          {expandedId === req.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => saveRequirements(current => current.filter(r => r.id !== req.id))} disabled={isReadOnly} data-testid={`btn-remove-req-${req.id}`}>
                          <HelpCircle className="w-4 h-4 hidden" />
                          <span className="text-xs">Remove</span>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  {expandedId === req.id && (
                    <TableRow className="bg-muted/10">
                      <TableCell colSpan={5} className="p-4 border-b">
                        <div className="grid grid-cols-2 gap-6">
                          <div className="space-y-4">
                            <div className="space-y-2">
                              <label className="text-xs font-semibold text-muted-foreground uppercase">Concern</label>
                              <Input 
                                value={req.concern} 
                                onChange={(e) => handleLocalUpdate(req.id, 'concern', e.target.value)}
                                onBlur={() => handleBlur(req.id)}
                                placeholder="Core architectural concern (e.g., Security, Availability)..."
                                className="h-8 text-sm bg-transparent border-dashed"
                                disabled={isReadOnly}
                              />
                            </div>
                            <div className="space-y-2">
                              <div className="flex items-center justify-between">
                                <label className="text-xs font-semibold text-muted-foreground uppercase">Acceptance Criteria</label>
                                <Button 
                                  variant="ghost" size="sm" className="h-6 text-xs"
                                  disabled={isReadOnly}
                                  onClick={() => handleUpdateRequirement(req.id, 'acceptanceCriteria', [...(req.acceptanceCriteria || []), ""])}
                                >
                                  <Plus className="w-3 h-3 mr-1" /> Add
                                </Button>
                              </div>
                              <div className="space-y-2">
                                {(req.acceptanceCriteria || []).map((criteria, i) => (
                                  <div key={i} className="flex items-center gap-2">
                                    <Input 
                                      value={criteria} 
                                      onChange={(e) => handleLocalUpdate(req.id, 'acceptanceCriteria', req.acceptanceCriteria.map((c, j) => i === j ? e.target.value : c))}
                                      onBlur={() => handleBlur(req.id)}
                                      placeholder="Acceptance criteria..."
                                      className="h-8 text-sm bg-transparent border-dashed flex-1"
                                      disabled={isReadOnly}
                                    />
                                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" disabled={isReadOnly} onClick={() => handleUpdateRequirement(req.id, 'acceptanceCriteria', req.acceptanceCriteria.filter((_, j) => i !== j))}>
                                      <span className="sr-only">Remove</span>
                                      &times;
                                    </Button>
                                  </div>
                                ))}
                                {(!req.acceptanceCriteria || req.acceptanceCriteria.length === 0) && (
                                  <div className="text-xs text-muted-foreground italic">No acceptance criteria defined.</div>
                                )}
                              </div>
                            </div>
                          </div>
                           <div className="space-y-4">
                             <label className="text-xs font-semibold text-muted-foreground uppercase">Traceability Links</label>
                             <div className="max-h-64 space-y-4 overflow-y-auto rounded border bg-card p-3">
                               {([
                                 ["Related requirements", "requirementIds", requirements.filter((item) => item.id !== req.id).map((item) => ({ id: item.id, label: item.title }))],
                                 ["Gaps", "gapIds", assessment.content.gaps.map((item) => ({ id: item.id, label: item.title }))],
                                 ["Target components", "targetComponentIds", assessment.content.targetArchitecture.components.map((item) => ({ id: item.id, label: item.name }))],
                                 ["Work packages", "workPackageIds", assessment.content.roadmap.workPackages.map((item) => ({ id: item.id, label: item.name }))],
                                 ["Governance records", "governanceReviewIds", governanceRecords.map((item) => ({ id: item.id, label: item.title }))],
                               ] as const).map(([label, field, options]) => (
                                 <div key={field} className="space-y-2">
                                   <div className="text-[11px] font-semibold text-muted-foreground">{label}</div>
                                   {options.length === 0 ? (
                                     <div className="text-xs text-muted-foreground">No records available.</div>
                                   ) : (
                                     <div className="grid gap-2 sm:grid-cols-2">
                                       {options.map((option) => (
                                         <label key={option.id} className="flex min-w-0 items-center gap-2 text-xs">
                                           <Checkbox
                                             checked={(req.traceability[field] ?? []).includes(option.id)}
                                             onCheckedChange={(checked) => handleTraceabilityToggle(req.id, field, option.id, checked === true)}
                                             disabled={isReadOnly}
                                             data-testid={`checkbox-req-trace-${field}-${req.id}-${option.id}`}
                                           />
                                           <span className="truncate" title={option.label}>{option.label}</span>
                                         </label>
                                       ))}
                                     </div>
                                   )}
                                 </div>
                               ))}
                             </div>
                           </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
