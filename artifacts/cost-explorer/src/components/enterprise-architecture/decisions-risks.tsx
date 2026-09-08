import { useState } from "react";
import { EaAssessment, EaDecision, EaDecisionStatus, EaRisk, EaRiskStatus } from "@workspace/api-client-react";
import { useAssessmentUpdater } from "./utils";
import { Plus, Search, HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { resolveSubmittedDraft, useMergeSavedDraft } from "./edit-recovery";

export function DecisionsManager({ assessment, isReadOnly }: { assessment: EaAssessment, isReadOnly: boolean }) {
  const savedItems = assessment.content.decisions || [];
  const [items, setItems] = useState<EaDecision[]>(savedItems);
  useMergeSavedDraft(savedItems, setItems, "decisions");
  
  const saveItems = useAssessmentUpdater<EaDecision[]>(assessment, "decisions", undefined, resolveSubmittedDraft(setItems));

  const handleAddItem = () => {
    const newItem: EaDecision = {
      id: crypto.randomUUID(),
      title: "New Decision",
      decision: "",
      rationale: "",
      status: "proposed",
      owner: "",
      decidedAt: new Date().toISOString().split('T')[0],
      traceability: {
        requirementIds: [], gapIds: [], targetComponentIds: [], workPackageIds: [], governanceReviewIds: []
      }
    };
    const transform = (current: EaDecision[]) => [newItem, ...current];
    setItems(transform);
    saveItems(transform);
  };

  const updateItem = (id: string, field: keyof EaDecision, value: any) => {
    const transform = (current: EaDecision[]) => current.map(i => i.id === id ? { ...i, [field]: value } : i);
    setItems(transform);
    saveItems(transform);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Architecture Decisions</h2>
          <p className="text-muted-foreground mt-1">Record key architecture decisions and their rationale.</p>
        </div>
        <Button onClick={handleAddItem} size="sm" disabled={isReadOnly} data-testid="btn-add-decision">
          <Plus className="w-4 h-4 mr-2" /> Add Decision
        </Button>
      </div>

      <div className="space-y-4">
        {items.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground border rounded-xl bg-muted/5 border-dashed">
            <Search className="w-8 h-8 opacity-20 mb-3 mx-auto" />
            <p>No decisions recorded.</p>
          </div>
        ) : (
          items.map(item => (
            <div key={item.id} className="p-4 border rounded-xl bg-card shadow-sm space-y-4">
               <div className="flex gap-4 items-start">
                 <div className="flex-1">
                   <Input 
                     value={item.title}
                     onChange={(e) => updateItem(item.id, 'title', e.target.value)}
                     className="font-semibold text-base h-9 border-transparent hover:border-input bg-transparent -ml-3 px-3 w-full"
                     disabled={isReadOnly}
                     data-testid={`input-dec-title-${item.id}`}
                   />
                 </div>
                 <div className="flex items-center gap-2">
                   <Input 
                      type="date"
                      value={item.decidedAt}
                      onChange={(e) => updateItem(item.id, 'decidedAt', e.target.value)}
                      className="h-8 w-36 text-xs"
                      disabled={isReadOnly}
                      data-testid={`input-dec-date-${item.id}`}
                   />
                   <Select value={item.status} onValueChange={(v) => updateItem(item.id, 'status', v)} disabled={isReadOnly}>
                     <SelectTrigger className="h-8 w-[130px] text-xs" data-testid={`select-dec-status-${item.id}`}>
                       <SelectValue />
                     </SelectTrigger>
                     <SelectContent>
                       {Object.values(EaDecisionStatus).map(v => (
                         <SelectItem key={v} value={v} className="text-xs capitalize">{v}</SelectItem>
                       ))}
                     </SelectContent>
                   </Select>
                   <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => {
                      const transform = (current: EaDecision[]) => current.filter(i => i.id !== item.id);
                      setItems(transform);
                      saveItems(transform);
                   }} disabled={isReadOnly} data-testid={`btn-remove-dec-${item.id}`}>
                     <HelpCircle className="w-4 h-4 hidden" />
                     <span className="text-xs sr-only">Remove</span>
                     <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.5 1C5.22386 1 5 1.22386 5 1.5C5 1.77614 5.22386 2 5.5 2H9.5C9.77614 2 10 1.77614 10 1.5C10 1.22386 9.77614 1 9.5 1H5.5ZM3 3.5C2.72386 3.5 2.5 3.72386 2.5 4C2.5 4.27614 2.72386 4.5 3 4.5H12C12.2761 4.5 12.5 4.27614 12.5 4C12.5 3.72386 12.2761 3.5 12 3.5H3ZM4.5 5.5C4.5 5.22386 4.72386 5 5 5C5.27614 5 5.5 5.22386 5.5 5.5V11.5C5.5 11.7761 5.27614 12 5 12C4.72386 12 4.5 11.7761 4.5 11.5V5.5ZM10.5 5.5C10.5 5.22386 10.2761 5 10 5C9.72386 5 9.5 5.22386 9.5 5.5V11.5C9.5 11.7761 9.72386 12 10 12C10.2761 12 10.5 11.7761 10.5 11.5V5.5Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd"></path></svg>
                   </Button>
                 </div>
               </div>
               
               <div className="grid grid-cols-2 gap-4">
                 <div className="space-y-1.5">
                   <label className="text-xs font-semibold text-muted-foreground uppercase">Decision</label>
                   <Textarea 
                     value={item.decision}
                     onChange={(e) => updateItem(item.id, 'decision', e.target.value)}
                     placeholder="State the decision..."
                     className="resize-none h-20 text-sm bg-muted/20"
                     disabled={isReadOnly}
                     data-testid={`input-dec-decision-${item.id}`}
                   />
                 </div>
                 <div className="space-y-1.5">
                   <label className="text-xs font-semibold text-muted-foreground uppercase">Rationale</label>
                   <Textarea 
                     value={item.rationale}
                     onChange={(e) => updateItem(item.id, 'rationale', e.target.value)}
                     placeholder="Why was this decided?"
                     className="resize-none h-20 text-sm bg-muted/20"
                     disabled={isReadOnly}
                     data-testid={`input-dec-rationale-${item.id}`}
                   />
                 </div>
               </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function RisksManager({ assessment, isReadOnly }: { assessment: EaAssessment, isReadOnly: boolean }) {
  const savedItems = assessment.content.risks || [];
  const [items, setItems] = useState<EaRisk[]>(savedItems);
  useMergeSavedDraft(savedItems, setItems, "risks");
  
  const saveItems = useAssessmentUpdater<EaRisk[]>(assessment, "risks", undefined, resolveSubmittedDraft(setItems));

  const handleAddItem = () => {
    const newItem: EaRisk = {
      id: crypto.randomUUID(),
      title: "New Risk",
      description: "",
      likelihood: 3,
      impact: 3,
      mitigation: "",
      owner: "",
      status: "open"
    };
    const transform = (current: EaRisk[]) => [newItem, ...current];
    setItems(transform);
    saveItems(transform);
  };

  const updateItem = (id: string, field: keyof EaRisk, value: any) => {
    const transform = (current: EaRisk[]) => current.map(i => i.id === id ? { ...i, [field]: value } : i);
    setItems(transform);
    saveItems(transform);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Architecture Risks</h2>
          <p className="text-muted-foreground mt-1">Track risks and mitigation strategies.</p>
        </div>
        <Button onClick={handleAddItem} size="sm" disabled={isReadOnly} data-testid="btn-add-risk">
          <Plus className="w-4 h-4 mr-2" /> Add Risk
        </Button>
      </div>

      <div className="border rounded-xl bg-card overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="w-[300px]">Risk Title & Description</TableHead>
              <TableHead>Likelihood</TableHead>
              <TableHead>Impact</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[100px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                  <Search className="w-8 h-8 opacity-20 mb-3 mx-auto" />
                  <p>No risks identified.</p>
                </TableCell>
              </TableRow>
            ) : (
              items.map(item => (
                <TableRow key={item.id} className="group hover:bg-muted/20 align-top">
                  <TableCell>
                    <div className="space-y-2">
                      <Input 
                        value={item.title} 
                        onChange={(e) => updateItem(item.id, 'title', e.target.value)}
                        className="font-medium bg-transparent border-transparent group-hover:border-input px-2 -ml-2 h-8"
                        placeholder="Risk title"
                        disabled={isReadOnly}
                        data-testid={`input-risk-title-${item.id}`}
                      />
                      <Textarea 
                        value={item.description} 
                        onChange={(e) => updateItem(item.id, 'description', e.target.value)}
                        className="text-xs bg-transparent border-transparent group-hover:border-input px-2 -ml-2 min-h-[40px] resize-none text-muted-foreground"
                        placeholder="Detailed description..."
                        disabled={isReadOnly}
                        data-testid={`input-risk-desc-${item.id}`}
                      />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Input 
                      type="number" min={1} max={5}
                      value={item.likelihood} 
                      onChange={(e) => updateItem(item.id, 'likelihood', Number(e.target.value))}
                      className="h-8 w-16 bg-transparent border-transparent group-hover:border-input px-2 text-xs"
                      disabled={isReadOnly}
                      data-testid={`input-risk-like-${item.id}`}
                    />
                  </TableCell>
                  <TableCell>
                    <Input 
                      type="number" min={1} max={5}
                      value={item.impact} 
                      onChange={(e) => updateItem(item.id, 'impact', Number(e.target.value))}
                      className="h-8 w-16 bg-transparent border-transparent group-hover:border-input px-2 text-xs"
                      disabled={isReadOnly}
                      data-testid={`input-risk-impact-${item.id}`}
                    />
                  </TableCell>
                  <TableCell>
                    <Select value={item.status} onValueChange={(v) => updateItem(item.id, 'status', v)} disabled={isReadOnly}>
                      <SelectTrigger className="h-8 w-32 text-xs" data-testid={`select-risk-status-${item.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.values(EaRiskStatus).map(v => (
                          <SelectItem key={v} value={v} className="text-xs capitalize">{v}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => {
                        const transform = (current: EaRisk[]) => current.filter(i => i.id !== item.id);
                        setItems(transform);
                        saveItems(transform);
                      }} disabled={isReadOnly} data-testid={`btn-remove-risk-${item.id}`}>
                        <HelpCircle className="w-4 h-4 hidden" />
                        <span className="text-xs">Remove</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
