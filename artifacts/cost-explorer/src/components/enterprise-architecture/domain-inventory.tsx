import React, { useState, useRef, useEffect, useCallback } from "react";
import { 
  EaAssessment, 
  EaDomain, 
  EaInventoryItem, 
  EaInventoryItemCriticality, 
  EaInventoryItemLifecycle,
  EaInventoryItemConfidence
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetEaAssessmentQueryKey } from "@workspace/api-client-react";
import { Plus, Search, HelpCircle, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useAssessmentUpdater } from "./utils";

export function DomainInventory({ 
  assessment, 
  domain,
  isReadOnly
}: { 
  assessment: EaAssessment; 
  domain: EaDomain; 
  isReadOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const [items, setItems] = useState<EaInventoryItem[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const initializedId = useRef<number | null>(null);
  
  const domainKey = domain === 'operating-model' ? 'operatingModel' : domain;
  const updateDomain = useAssessmentUpdater<EaInventoryItem[]>(assessment, 'currentState', domainKey, setItems);

  useEffect(() => {
    if (assessment && initializedId.current !== assessment.id) {
      initializedId.current = assessment.id;
      const currentItems = (assessment.content.currentState as any)[domainKey] || [];
      setItems(currentItems);
    }
  }, [assessment, domainKey]);

  const saveItems = useCallback((transform: (current: EaInventoryItem[]) => EaInventoryItem[]) => {
    setItems(transform);
    updateDomain(transform);
  }, [updateDomain]);

  const handleAddItem = () => {
    const newItem: EaInventoryItem = {
      id: crypto.randomUUID(),
      name: "New Item",
      kind: "system",
      description: "",
      maturity: 0,
      criticality: "unknown",
      lifecycle: "unknown",
      owner: "unknown",
      confidence: "unknown",
      notes: "",
      evidence: []
    };
    saveItems((current) => [...current, newItem]);
  };

  const handleLocalUpdate = (id: string, field: keyof EaInventoryItem, value: any) => {
    setItems(current => current.map(item => item.id === id ? { ...item, [field]: value } : item));
  };

  const handleBlur = (id: string) => {
    const localItem = items.find((item) => item.id === id);
    if (localItem) {
      updateDomain((current) => current.map((item) => item.id === id ? { ...item, ...localItem } : item));
    }
  };

  const handleUpdateItem = (id: string, field: keyof EaInventoryItem, value: any) => {
    const transform = (current: EaInventoryItem[]) => current.map(item => item.id === id ? { ...item, [field]: value } : item);
    setItems(transform);
    updateDomain(transform);
  };

  const domainColors: Record<string, string> = {
    business: "bg-blue-500/10 text-blue-700 border-blue-500/20 dark:bg-blue-500/20 dark:text-blue-300",
    data: "bg-teal-500/10 text-teal-700 border-teal-500/20 dark:bg-teal-500/20 dark:text-teal-300",
    application: "bg-purple-500/10 text-purple-700 border-purple-500/20 dark:bg-purple-500/20 dark:text-purple-300",
    technology: "bg-slate-500/10 text-slate-700 border-slate-500/20 dark:bg-slate-500/20 dark:text-slate-300",
    integration: "bg-orange-500/10 text-orange-700 border-orange-500/20 dark:bg-orange-500/20 dark:text-orange-300",
    ai: "bg-rose-500/10 text-rose-700 border-rose-500/20 dark:bg-rose-500/20 dark:text-rose-300",
    security: "bg-red-500/10 text-red-700 border-red-500/20 dark:bg-red-500/20 dark:text-red-300",
    "operating-model": "bg-emerald-500/10 text-emerald-700 border-emerald-500/20 dark:bg-emerald-500/20 dark:text-emerald-300",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-3">
            <span className="capitalize">{domain.replace('-', ' ')}</span> Inventory
            <Badge variant="outline" className={domainColors[domain] || ""}>Current State</Badge>
          </h2>
          <p className="text-muted-foreground mt-1">Capture building blocks and assess their lifecycle, criticality, and confidence.</p>
        </div>
        <Button onClick={handleAddItem} size="sm" disabled={isReadOnly} data-testid="btn-add-item">
          <Plus className="w-4 h-4 mr-2" /> Add Item
        </Button>
      </div>

      <div className="border rounded-xl bg-card overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="w-[250px]">Name & Kind</TableHead>
              <TableHead>Lifecycle</TableHead>
              <TableHead>Criticality</TableHead>
              <TableHead>Confidence</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead className="w-[100px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                  <div className="flex flex-col items-center justify-center">
                    <Search className="w-8 h-8 opacity-20 mb-3" />
                    <p>No inventory items captured for this domain.</p>
                    <Button variant="link" onClick={handleAddItem} className="mt-2">Add the first item</Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              items.map(item => (
                <React.Fragment key={item.id}>
                  <TableRow className="group hover:bg-muted/20 cursor-pointer" onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="space-y-2">
                        <Input 
                          value={item.name} 
                          onChange={(e) => handleLocalUpdate(item.id, 'name', e.target.value)}
                          onBlur={() => handleBlur(item.id)}
                          className="h-8 font-medium bg-transparent border-transparent group-hover:border-input px-2 -ml-2 transition-colors"
                          placeholder="Item name"
                          disabled={isReadOnly}
                          data-testid={`input-item-name-${item.id}`}
                        />
                        <Input 
                          value={item.kind} 
                          onChange={(e) => handleLocalUpdate(item.id, 'kind', e.target.value)}
                          onBlur={() => handleBlur(item.id)}
                          className="h-6 text-xs bg-transparent border-transparent group-hover:border-input px-2 -ml-2 text-muted-foreground transition-colors"
                          placeholder="Kind (e.g. system, capability)"
                          disabled={isReadOnly}
                          data-testid={`input-item-kind-${item.id}`}
                        />
                      </div>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Select value={item.lifecycle} onValueChange={(v) => handleUpdateItem(item.id, 'lifecycle', v)} disabled={isReadOnly}>
                        <SelectTrigger className={`h-8 w-32 text-xs ${item.lifecycle === 'unknown' ? 'text-muted-foreground border-dashed' : ''}`} data-testid={`select-item-lifecycle-${item.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.values(EaInventoryItemLifecycle).map(v => (
                            <SelectItem key={v} value={v} className="text-xs">{v}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Select value={item.criticality} onValueChange={(v) => handleUpdateItem(item.id, 'criticality', v)} disabled={isReadOnly}>
                        <SelectTrigger className={`h-8 w-28 text-xs ${item.criticality === 'unknown' ? 'text-muted-foreground border-dashed' : ''}`} data-testid={`select-item-criticality-${item.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.values(EaInventoryItemCriticality).map(v => (
                            <SelectItem key={v} value={v} className="text-xs">{v}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Select value={item.confidence} onValueChange={(v) => handleUpdateItem(item.id, 'confidence', v)} disabled={isReadOnly}>
                        <SelectTrigger className={`h-8 w-28 text-xs ${item.confidence === 'unknown' ? 'text-muted-foreground border-dashed' : ''}`} data-testid={`select-item-confidence-${item.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.values(EaInventoryItemConfidence).map(v => (
                            <SelectItem key={v} value={v} className="text-xs">{v}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Input 
                        value={item.owner} 
                        onChange={(e) => handleLocalUpdate(item.id, 'owner', e.target.value)}
                        onBlur={() => handleBlur(item.id)}
                        className={`h-8 w-32 text-xs bg-transparent border-transparent group-hover:border-input transition-colors ${item.owner === 'unknown' ? 'text-muted-foreground italic' : ''}`}
                        placeholder="Owner"
                        disabled={isReadOnly}
                        data-testid={`input-item-owner-${item.id}`}
                      />
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}>
                          {expandedId === item.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => saveItems(current => current.filter(i => i.id !== item.id))} disabled={isReadOnly} data-testid={`btn-remove-item-${item.id}`}>
                          <HelpCircle className="w-4 h-4 hidden" />
                          <span className="text-xs">Remove</span>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  {expandedId === item.id && (
                    <TableRow className="bg-muted/10">
                      <TableCell colSpan={6} className="p-4 border-b">
                        <div className="grid grid-cols-2 gap-6">
                          <div className="space-y-4">
                            <div className="space-y-2">
                              <label className="text-xs font-semibold text-muted-foreground uppercase">Description</label>
                              <Textarea 
                                value={item.description}
                                onChange={(e) => handleLocalUpdate(item.id, 'description', e.target.value)}
                                onBlur={() => handleBlur(item.id)}
                                placeholder="Describe the building block..."
                                className="h-20 text-sm bg-transparent border-dashed"
                                disabled={isReadOnly}
                              />
                            </div>
                            <div className="space-y-2">
                              <label className="text-xs font-semibold text-muted-foreground uppercase">Notes</label>
                              <Textarea 
                                value={item.notes}
                                onChange={(e) => handleLocalUpdate(item.id, 'notes', e.target.value)}
                                onBlur={() => handleBlur(item.id)}
                                placeholder="Additional context..."
                                className="h-20 text-sm bg-transparent border-dashed"
                                disabled={isReadOnly}
                              />
                            </div>
                          </div>
                          <div className="space-y-4">
                            <div className="space-y-2">
                              <label className="text-xs font-semibold text-muted-foreground uppercase">Maturity (0-5)</label>
                              <Input 
                                type="number"
                                min="0" max="5" step="1"
                                value={item.maturity}
                                 onChange={(e) => handleUpdateItem(item.id, 'maturity', Number.parseInt(e.target.value, 10) || 0)}
                                className="h-8 w-24 bg-transparent border-dashed"
                                disabled={isReadOnly}
                              />
                            </div>
                            <div className="space-y-2">
                              <div className="flex items-center justify-between">
                                <label className="text-xs font-semibold text-muted-foreground uppercase">Evidence</label>
                                <Button 
                                  variant="ghost" size="sm" className="h-6 text-xs"
                                  disabled={isReadOnly}
                                  onClick={() => handleUpdateItem(item.id, 'evidence', [...(item.evidence || []), { id: crypto.randomUUID(), title: "New Evidence", source: "", capturedAt: new Date().toISOString().split('T')[0] }])}
                                >
                                  <Plus className="w-3 h-3 mr-1" /> Add
                                </Button>
                              </div>
                              <div className="space-y-2">
                                {(item.evidence || []).map((ev, i) => (
                                  <div key={ev.id} className="p-2 border rounded text-xs space-y-2 bg-card">
                                    <div className="flex gap-2">
                                      <Input 
                                        value={ev.title} 
                                        onChange={(e) => handleLocalUpdate(item.id, 'evidence', item.evidence.map(e2 => e2.id === ev.id ? { ...e2, title: e.target.value } : e2))}
                                        onBlur={() => handleBlur(item.id)}
                                        placeholder="Title" className="h-7 text-xs flex-1" disabled={isReadOnly}
                                      />
                                      <Input 
                                        value={ev.source} 
                                        onChange={(e) => handleLocalUpdate(item.id, 'evidence', item.evidence.map(e2 => e2.id === ev.id ? { ...e2, source: e.target.value } : e2))}
                                        onBlur={() => handleBlur(item.id)}
                                        placeholder="Source" className="h-7 text-xs flex-1" disabled={isReadOnly}
                                      />
                                      <Input 
                                        type="date"
                                        value={ev.capturedAt || ''} 
                                        onChange={(e) => handleLocalUpdate(item.id, 'evidence', item.evidence.map(e2 => e2.id === ev.id ? { ...e2, capturedAt: e.target.value } : e2))}
                                        onBlur={() => handleBlur(item.id)}
                                        className="h-7 text-xs w-32" disabled={isReadOnly}
                                      />
                                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" disabled={isReadOnly} onClick={() => handleUpdateItem(item.id, 'evidence', item.evidence.filter(e2 => e2.id !== ev.id))}>
                                        <span className="sr-only">Remove</span>
                                        &times;
                                      </Button>
                                    </div>
                                    <Input 
                                      value={ev.notes || ''} 
                                      onChange={(e) => handleLocalUpdate(item.id, 'evidence', item.evidence.map(e2 => e2.id === ev.id ? { ...e2, notes: e.target.value } : e2))}
                                      onBlur={() => handleBlur(item.id)}
                                      placeholder="Evidence notes..." className="h-7 text-xs" disabled={isReadOnly}
                                    />
                                  </div>
                                ))}
                                {(!item.evidence || item.evidence.length === 0) && (
                                  <div className="text-xs text-muted-foreground italic py-2">No evidence linked.</div>
                                )}
                              </div>
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
