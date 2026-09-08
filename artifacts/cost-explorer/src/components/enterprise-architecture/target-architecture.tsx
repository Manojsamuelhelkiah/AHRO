import React, { useState } from "react";
import { EaAssessment, EaTargetComponent, EaTargetRelationship, EaTargetComponentStatus, EaDomain } from "@workspace/api-client-react";
import { useAssessmentUpdater } from "./utils";
import { Plus, Search, HelpCircle, ChevronDown, ChevronUp, Link as LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDraftProtection, useMergeSavedDraft, resolveSubmittedDraft } from "./edit-recovery";

export function TargetArchitectureManager({ assessment, isReadOnly }: { assessment: EaAssessment, isReadOnly: boolean }) {
  const savedComponents = assessment.content.targetArchitecture.components || [];
  const savedRelationships = assessment.content.targetArchitecture.relationships || [];
  const [components, setComponents] = useState<EaTargetComponent[]>(savedComponents);
  const [relationships, setRelationships] = useState<EaTargetRelationship[]>(savedRelationships);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useDraftProtection(components, savedComponents, () => setComponents(savedComponents), 'Target architecture components');
  useDraftProtection(relationships, savedRelationships, () => setRelationships(savedRelationships), 'Target architecture relationships');
  
  useMergeSavedDraft(savedComponents, setComponents, "targetArchitecture.components");
  useMergeSavedDraft(savedRelationships, setRelationships, "targetArchitecture.relationships");

  const saveComponents = useAssessmentUpdater<EaTargetComponent[]>(assessment, "targetArchitecture", "components", resolveSubmittedDraft(setComponents));
  const saveRelationships = useAssessmentUpdater<EaTargetRelationship[]>(assessment, "targetArchitecture", "relationships", resolveSubmittedDraft(setRelationships));

  // Component Handlers
  const handleAddComponent = () => {
    const newComponent: EaTargetComponent = {
      id: crypto.randomUUID(),
      name: "New Component",
      domain: "application",
      componentType: "system",
      description: "",
      status: "proposed",
      owner: "",
      addressesGapIds: [],
      deliveredByWorkPackageIds: []
    };
    const transform = (current: EaTargetComponent[]) => [newComponent, ...current];
    setComponents(transform); saveComponents(transform);
  };

  const updateComponentLocal = (id: string, field: keyof EaTargetComponent, value: any) => {
    setComponents(current => current.map(c => c.id === id ? { ...c, [field]: value } : c));
  };

  const handleBlur = (id: string) => {
    const local = components.find(c => c.id === id);
    if (local) saveComponents(current => current.map(c => c.id === id ? { ...c, ...local } : c));
  };

  const updateComponent = (id: string, field: keyof EaTargetComponent, value: any) => {
    const transform = (current: EaTargetComponent[]) => current.map(c => c.id === id ? { ...c, [field]: value } : c);
    setComponents(transform); saveComponents(transform);
  };

  const removeComponent = (id: string) => {
    const transform = (current: EaTargetComponent[]) => current.filter(c => c.id !== id);
    setComponents(transform); saveComponents(transform);
    // Remove cascading relationships
    const relationshipTransform = (current: EaTargetRelationship[]) => current.filter(r => r.sourceComponentId !== id && r.targetComponentId !== id);
    setRelationships(relationshipTransform); saveRelationships(relationshipTransform);
  };

  // Relationship Handlers
  const handleAddRelationship = () => {
    if (components.length < 2) return;
    const newRelationship: EaTargetRelationship = {
      id: crypto.randomUUID(),
      sourceComponentId: components[0].id,
      targetComponentId: components[1]?.id || components[0].id,
      relationshipType: "integrates-with",
      description: ""
    };
    const transform = (current: EaTargetRelationship[]) => [newRelationship, ...current];
    setRelationships(transform); saveRelationships(transform);
  };

  const updateRelationshipLocal = (id: string, field: keyof EaTargetRelationship, value: any) => {
    setRelationships(current => current.map(r => r.id === id ? { ...r, [field]: value } : r));
  };

  const handleRelationshipBlur = (id: string) => {
    const local = relationships.find(r => r.id === id);
    if (local) saveRelationships(current => current.map(r => r.id === id ? { ...r, ...local } : r));
  };

  const updateRelationship = (id: string, field: keyof EaTargetRelationship, value: any) => {
    const transform = (current: EaTargetRelationship[]) => current.map(r => r.id === id ? { ...r, [field]: value } : r);
    setRelationships(transform); saveRelationships(transform);
  };

  const removeRelationship = (id: string) => {
    const transform = (current: EaTargetRelationship[]) => current.filter(r => r.id !== id);
    setRelationships(transform); saveRelationships(transform);
  };

  return (
    <div className="space-y-8">
      {/* Components Section */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Target Architecture Components</h2>
            <p className="text-muted-foreground mt-1">Define the future-state building blocks of the architecture.</p>
          </div>
          <Button onClick={handleAddComponent} size="sm" disabled={isReadOnly} data-testid="btn-add-target-component">
            <Plus className="w-4 h-4 mr-2" /> Add Component
          </Button>
        </div>

        <div className="border rounded-xl bg-card overflow-hidden overflow-x-auto min-w-full">
          <Table className="min-w-[800px]">
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-[300px]">Name & Type</TableHead>
                <TableHead>Domain</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {components.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                    <Search className="w-8 h-8 opacity-20 mb-3 mx-auto" />
                    <p>No target components defined.</p>
                  </TableCell>
                </TableRow>
              ) : (
                components.map(comp => (
                  <React.Fragment key={comp.id}>
                    <TableRow className="group hover:bg-muted/20 align-top cursor-pointer" onClick={() => setExpandedId(expandedId === comp.id ? null : comp.id)}>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="space-y-2">
                          <Input 
                            value={comp.name} 
                            onChange={(e) => updateComponentLocal(comp.id, 'name', e.target.value)}
                            onBlur={() => handleBlur(comp.id)}
                            className="font-medium bg-transparent border-transparent group-hover:border-input px-2 -ml-2 h-8"
                            placeholder="Component name"
                            disabled={isReadOnly}
                            data-testid={`input-target-name-${comp.id}`}
                          />
                          <Input 
                            value={comp.componentType} 
                            onChange={(e) => updateComponentLocal(comp.id, 'componentType', e.target.value)}
                            onBlur={() => handleBlur(comp.id)}
                            className="text-xs bg-transparent border-transparent group-hover:border-input px-2 -ml-2 h-6 text-muted-foreground"
                            placeholder="Type (e.g. Service, Capability)"
                            disabled={isReadOnly}
                            data-testid={`input-target-type-${comp.id}`}
                          />
                        </div>
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Select value={comp.domain} onValueChange={(v) => updateComponent(comp.id, 'domain', v)} disabled={isReadOnly}>
                          <SelectTrigger className="h-8 w-32 text-xs" data-testid={`select-target-domain-${comp.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Object.values(EaDomain).map(v => (
                              <SelectItem key={v} value={v} className="text-xs capitalize">{v.replace('-', ' ')}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Select value={comp.status} onValueChange={(v) => updateComponent(comp.id, 'status', v)} disabled={isReadOnly}>
                          <SelectTrigger className="h-8 w-32 text-xs" data-testid={`select-target-status-${comp.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Object.values(EaTargetComponentStatus).map(v => (
                              <SelectItem key={v} value={v} className="text-xs capitalize">{v}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Input 
                          value={comp.owner} 
                          onChange={(e) => updateComponentLocal(comp.id, 'owner', e.target.value)}
                          onBlur={() => handleBlur(comp.id)}
                          className="text-xs bg-transparent border-transparent group-hover:border-input px-2 -ml-2 h-8 w-full"
                          placeholder="Owner..."
                          disabled={isReadOnly}
                          data-testid={`input-target-owner-${comp.id}`}
                        />
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => setExpandedId(expandedId === comp.id ? null : comp.id)}>
                            {expandedId === comp.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => removeComponent(comp.id)} disabled={isReadOnly} data-testid={`btn-remove-target-${comp.id}`}>
                            <HelpCircle className="w-4 h-4 hidden" />
                            <span className="text-xs">Remove</span>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                    {expandedId === comp.id && (
                      <TableRow className="bg-muted/10">
                        <TableCell colSpan={5} className="p-4 border-b">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-4">
                              <div className="space-y-2">
                                <label className="text-xs font-semibold text-muted-foreground uppercase">Description</label>
                                <Textarea 
                                  value={comp.description || ''} 
                                  onChange={(e) => updateComponentLocal(comp.id, 'description', e.target.value)}
                                  onBlur={() => handleBlur(comp.id)}
                                  placeholder="Component description..."
                                  className="h-20 text-sm bg-transparent border-dashed resize-none"
                                  disabled={isReadOnly}
                                />
                              </div>
                            </div>
                            <div className="space-y-4">
                              <div className="space-y-2">
                                <label className="text-xs font-semibold text-muted-foreground uppercase">Addresses Gap IDs</label>
                                <Input 
                                  value={(comp.addressesGapIds || []).join(", ")} 
                                  onChange={(e) => updateComponentLocal(comp.id, 'addressesGapIds', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                                  onBlur={() => handleBlur(comp.id)}
                                  placeholder="Comma-separated Gap IDs..."
                                  className="h-8 text-sm bg-muted/20"
                                  disabled={isReadOnly}
                                />
                              </div>
                              <div className="space-y-2">
                                <label className="text-xs font-semibold text-muted-foreground uppercase">Delivered By Work Package IDs</label>
                                <Input 
                                  value={(comp.deliveredByWorkPackageIds || []).join(", ")} 
                                  onChange={(e) => updateComponentLocal(comp.id, 'deliveredByWorkPackageIds', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                                  onBlur={() => handleBlur(comp.id)}
                                  placeholder="Comma-separated Work Package IDs..."
                                  className="h-8 text-sm bg-muted/20"
                                  disabled={isReadOnly}
                                />
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

      {/* Relationships Section */}
      <div className="space-y-6 pt-6 border-t border-border">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Component Relationships</h2>
            <p className="text-muted-foreground mt-1">Define how architecture components interact with each other.</p>
          </div>
          <Button onClick={handleAddRelationship} size="sm" disabled={isReadOnly || components.length < 2} data-testid="btn-add-relationship">
            <LinkIcon className="w-4 h-4 mr-2" /> Add Relationship
          </Button>
        </div>

        <div className="border rounded-xl bg-card overflow-hidden overflow-x-auto min-w-full">
          <Table className="min-w-[800px]">
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-[200px]">Source Component</TableHead>
                <TableHead className="w-[150px]">Relationship Type</TableHead>
                <TableHead className="w-[200px]">Target Component</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {relationships.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                    <LinkIcon className="w-8 h-8 opacity-20 mb-3 mx-auto" />
                    {components.length < 2 ? (
                      <p>Create at least two components to define relationships.</p>
                    ) : (
                      <p>No relationships defined.</p>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                relationships.map(rel => (
                  <TableRow key={rel.id} className="group hover:bg-muted/20">
                    <TableCell>
                      <Select value={rel.sourceComponentId} onValueChange={(v) => updateRelationship(rel.id, 'sourceComponentId', v)} disabled={isReadOnly}>
                        <SelectTrigger className="h-8 w-full text-xs bg-transparent group-hover:border-input border-transparent" data-testid={`select-source-${rel.id}`}>
                          <SelectValue placeholder="Select component" />
                        </SelectTrigger>
                        <SelectContent>
                          {components.map(c => (
                            <SelectItem key={c.id} value={c.id} className="text-xs">{c.name || 'Unnamed Component'}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input 
                        value={rel.relationshipType} 
                        onChange={(e) => updateRelationshipLocal(rel.id, 'relationshipType', e.target.value)}
                        onBlur={() => handleRelationshipBlur(rel.id)}
                        className="text-xs bg-transparent border-transparent group-hover:border-input px-2 -ml-2 h-8 font-medium italic text-teal-400 w-full"
                        placeholder="e.g. consumes, sends data to"
                        disabled={isReadOnly}
                        data-testid={`input-rel-type-${rel.id}`}
                      />
                    </TableCell>
                    <TableCell>
                      <Select value={rel.targetComponentId} onValueChange={(v) => updateRelationship(rel.id, 'targetComponentId', v)} disabled={isReadOnly}>
                        <SelectTrigger className="h-8 w-full text-xs bg-transparent group-hover:border-input border-transparent" data-testid={`select-target-${rel.id}`}>
                          <SelectValue placeholder="Select component" />
                        </SelectTrigger>
                        <SelectContent>
                          {components.map(c => (
                            <SelectItem key={c.id} value={c.id} className="text-xs">{c.name || 'Unnamed Component'}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input 
                        value={rel.description} 
                        onChange={(e) => updateRelationshipLocal(rel.id, 'description', e.target.value)}
                        onBlur={() => handleRelationshipBlur(rel.id)}
                        className="text-xs bg-transparent border-transparent group-hover:border-input px-2 -ml-2 h-8 w-full"
                        placeholder="Description of relationship..."
                        disabled={isReadOnly}
                        data-testid={`input-rel-desc-${rel.id}`}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => removeRelationship(rel.id)} disabled={isReadOnly} data-testid={`btn-remove-rel-${rel.id}`}>
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
    </div>
  );
}
