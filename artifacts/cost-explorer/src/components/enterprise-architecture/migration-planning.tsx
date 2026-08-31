import { useState, useEffect } from "react";
import { EaAssessment, EaWorkPackage, EaWorkPackageStatus, EaPhase, EaRoadmapWave, EaRoadmapDependency, EaPrioritization, EaRoadmapDependencyDependencyType } from "@workspace/api-client-react";
import { useAssessmentUpdater } from "./utils";
import { Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

function MultiSelect({ options, selected, onChange, placeholder, disabled }: { 
  options: {id: string, label: string}[], 
  selected: string[], 
  onChange: (selected: string[]) => void, 
  placeholder: string,
  disabled?: boolean 
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-start text-left font-normal truncate h-8 text-xs bg-transparent hover:bg-muted" disabled={disabled}>
           {selected.length > 0 ? `${selected.length} selected` : (placeholder || "Select...")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56 max-h-[300px] overflow-y-auto">
        {options.length === 0 && <div className="p-2 text-xs text-muted-foreground">No options available</div>}
        {options.map(opt => (
          <DropdownMenuCheckboxItem
            key={opt.id}
            checked={selected.includes(opt.id)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(c) => {
              if (c) onChange([...selected, opt.id]);
              else onChange(selected.filter(id => id !== opt.id));
            }}
            className="text-xs"
          >
            {opt.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StringListInput({ value, onChange, disabled, placeholder }: { value: string[], onChange: (val: string[]) => void, disabled?: boolean, placeholder?: string }) {
  const [localValue, setLocalValue] = useState(value.join("\n"));
  
  useEffect(() => {
    setLocalValue(value.join("\n"));
  }, [value]);

  return (
    <Textarea
      value={localValue}
      onChange={(e) => setLocalValue(e.target.value)}
      onBlur={() => {
        const arr = localValue.split("\n").map(s => s.trim()).filter(Boolean);
        onChange(arr);
      }}
      disabled={disabled}
      className="min-h-[60px] text-xs resize-none bg-transparent border-transparent hover:border-input focus:border-input"
      placeholder={placeholder}
    />
  )
}

function TextInput({ value, onChange, disabled, className, type = "text", "data-testid": testId, min, max }: any) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <Input 
      type={type}
      min={min}
      max={max}
      value={local} 
      onChange={(e) => setLocal(e.target.value)} 
      onBlur={() => onChange(type === "number" ? Number(local) : local)} 
      disabled={disabled} 
      className={className} 
      data-testid={testId}
    />
  );
}

function TextAreaInput({ value, onChange, disabled, className, "data-testid": testId }: any) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <Textarea 
      value={local} 
      onChange={(e) => setLocal(e.target.value)} 
      onBlur={() => onChange(local)} 
      disabled={disabled} 
      className={className} 
      data-testid={testId}
    />
  );
}

export function MigrationPlanningManager({ assessment, isReadOnly }: { assessment: EaAssessment, isReadOnly: boolean }) {
  const [workPackages, setWorkPackages] = useState<EaWorkPackage[]>([]);
  const [waves, setWaves] = useState<EaRoadmapWave[]>([]);
  const [dependencies, setDependencies] = useState<EaRoadmapDependency[]>([]);
  const [prioritization, setPrioritization] = useState<EaPrioritization[]>([]);
  
  useEffect(() => {
    setWorkPackages(assessment.content.roadmap.workPackages || []);
    setWaves(assessment.content.roadmap.waves || []);
    setDependencies(assessment.content.roadmap.dependencies || []);
    setPrioritization(assessment.content.roadmap.prioritization || []);
  }, [assessment]);

  const saveWorkPackages = useAssessmentUpdater<EaWorkPackage[]>(assessment, "roadmap", "workPackages");
  const saveWaves = useAssessmentUpdater<EaRoadmapWave[]>(assessment, "roadmap", "waves");
  const saveDependencies = useAssessmentUpdater<EaRoadmapDependency[]>(assessment, "roadmap", "dependencies");
  const savePrioritization = useAssessmentUpdater<EaPrioritization[]>(assessment, "roadmap", "prioritization");

  const componentList = (assessment.content.targetArchitecture?.components || []).map(c => ({ id: c.id, label: c.name }));
  const transitionArchList = (assessment.content.opportunities?.transitionArchitectures || []).map(ta => ({ id: ta.id, label: ta.name }));
  const wpList = workPackages.map(wp => ({ id: wp.id, label: wp.name || 'Unnamed WP' }));

  // Work Packages
  const handleAddWP = () => {
    const newWP: EaWorkPackage = {
      id: crypto.randomUUID(),
      name: "New Work Package",
      phase: "migration-planning",
      description: "",
      owner: "",
      outcomes: [],
      targetComponentIds: [],
      status: "planned",
      sequence: workPackages.length + 1,
      estimatedCost: 0
    };
    const transform = (current: EaWorkPackage[]) => [newWP, ...current];
    setWorkPackages(transform); saveWorkPackages(transform);
  };
  const updateWP = (id: string, field: keyof EaWorkPackage, value: any) => {
    const transform = (current: EaWorkPackage[]) => current.map(wp => wp.id === id ? { ...wp, [field]: value } : wp);
    setWorkPackages(transform); saveWorkPackages(transform);
  };
  const removeWP = (id: string) => {
    const transform = (current: EaWorkPackage[]) => current.filter(wp => wp.id !== id);
    setWorkPackages(transform); saveWorkPackages(transform);
  };

  // Waves
  const handleAddWave = () => {
    const transitionArchitecture = transitionArchList[0];
    if (!transitionArchitecture) return;
    const newWave: EaRoadmapWave = {
      id: crypto.randomUUID(),
      name: "New Wave",
      sequence: waves.length + 1,
      transitionArchitectureId: transitionArchitecture.id,
      workPackageIds: [],
      startDate: new Date().toISOString().split('T')[0],
      endDate: new Date().toISOString().split('T')[0]
    };
    const transform = (current: EaRoadmapWave[]) => [newWave, ...current];
    setWaves(transform); saveWaves(transform);
  };
  const updateWave = (id: string, field: keyof EaRoadmapWave, value: any) => {
    const transform = (current: EaRoadmapWave[]) => current.map(w => w.id === id ? { ...w, [field]: value } : w);
    setWaves(transform); saveWaves(transform);
  };
  const removeWave = (id: string) => {
    const transform = (current: EaRoadmapWave[]) => current.filter(w => w.id !== id);
    setWaves(transform); saveWaves(transform);
  };

  // Dependencies
  const handleAddDependency = () => {
    if (workPackages.length < 2) return;
    const newDep: EaRoadmapDependency = {
      id: crypto.randomUUID(),
      predecessorWorkPackageId: workPackages[0].id,
      successorWorkPackageId: workPackages[1].id,
      dependencyType: "finish-start",
      notes: ""
    };
    const transform = (current: EaRoadmapDependency[]) => [newDep, ...current];
    setDependencies(transform); saveDependencies(transform);
  };
  const updateDependency = (id: string, field: keyof EaRoadmapDependency, value: any) => {
    const transform = (current: EaRoadmapDependency[]) => current.map(d => d.id === id ? { ...d, [field]: value } : d);
    setDependencies(transform); saveDependencies(transform);
  };
  const removeDependency = (id: string) => {
    const transform = (current: EaRoadmapDependency[]) => current.filter(d => d.id !== id);
    setDependencies(transform); saveDependencies(transform);
  };

  // Prioritization
  const handleAddPrioritization = () => {
    // find a WP that is not prioritized yet
    const unassignedWp = workPackages.find(wp => !prioritization.some(p => p.workPackageId === wp.id));
    
    if (!unassignedWp) return;
    const newPrio: EaPrioritization = {
      workPackageId: unassignedWp.id,
      value: 0,
      risk: 0,
      urgency: 0,
      dependency: 0,
      readiness: 0,
      cost: 0,
      totalScore: 0,
      rationale: ""
    };
    const transform = (current: EaPrioritization[]) => [newPrio, ...current];
    setPrioritization(transform); savePrioritization(transform);
  };
  const updatePrioritization = (workPackageId: string, field: keyof EaPrioritization, value: any) => {
    const transform = (current: EaPrioritization[]) => current.map(p => {
      if (p.workPackageId !== workPackageId) return p;
      const updated = { ...p, [field]: value };
      return ["value", "risk", "urgency", "dependency", "readiness", "cost"].includes(field)
        ? { ...updated, totalScore: updated.value + updated.urgency + updated.dependency + updated.readiness - updated.risk - updated.cost }
        : updated;
    });
    setPrioritization(transform); savePrioritization(transform);
  };
  const removePrioritization = (workPackageId: string) => {
    const transform = (current: EaPrioritization[]) => current.filter(p => p.workPackageId !== workPackageId);
    setPrioritization(transform); savePrioritization(transform);
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold">Migration Planning</h2>
        <p className="text-muted-foreground">Define and sequence work packages for target implementation.</p>
      </div>

      <Tabs defaultValue="work-packages" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="work-packages">Work Packages</TabsTrigger>
          <TabsTrigger value="waves">Waves</TabsTrigger>
          <TabsTrigger value="dependencies">Dependencies</TabsTrigger>
          <TabsTrigger value="prioritization">Prioritization</TabsTrigger>
        </TabsList>

        <TabsContent value="work-packages" className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={handleAddWP} size="sm" disabled={isReadOnly} data-testid="btn-add-wp">
              <Plus className="w-4 h-4 mr-2" /> Add Work Package
            </Button>
          </div>
          
          <div className="border rounded-xl bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <Table className="min-w-[1000px]">
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="w-[250px]">Seq, Name & Description</TableHead>
                    <TableHead className="w-[200px]">Phase, Status & Owner</TableHead>
                    <TableHead className="w-[200px]">Outcomes</TableHead>
                    <TableHead className="w-[200px]">Target Components</TableHead>
                    <TableHead className="w-[120px]">Est. Cost ($)</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workPackages.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                        <Search className="w-8 h-8 opacity-20 mb-3 mx-auto" />
                        <p>No work packages planned.</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    workPackages.map(wp => (
                      <TableRow key={wp.id} className="group hover:bg-muted/20 align-top">
                        <TableCell className="space-y-2">
                          <div className="flex gap-2">
                            <TextInput 
                              type="number"
                              value={wp.sequence} 
                              onChange={(v: number) => updateWP(wp.id, 'sequence', v)}
                              className="w-16 h-8 text-xs bg-transparent border-transparent hover:border-input focus:border-input px-2"
                              disabled={isReadOnly}
                              data-testid={`input-wp-seq-${wp.id}`}
                            />
                            <TextInput 
                              value={wp.name} 
                              onChange={(v: string) => updateWP(wp.id, 'name', v)}
                              className="font-medium bg-transparent border-transparent hover:border-input focus:border-input px-2 h-8 flex-1"
                              placeholder="Work package name"
                              disabled={isReadOnly}
                              data-testid={`input-wp-name-${wp.id}`}
                            />
                          </div>
                          <TextAreaInput 
                            value={wp.description} 
                            onChange={(v: string) => updateWP(wp.id, 'description', v)}
                            className="text-xs bg-transparent border-transparent hover:border-input focus:border-input px-2 min-h-[60px] resize-none"
                            placeholder="Description"
                            disabled={isReadOnly}
                          />
                        </TableCell>
                        <TableCell className="space-y-2">
                          <Select value={wp.phase} onValueChange={(v) => updateWP(wp.id, 'phase', v)} disabled={isReadOnly}>
                            <SelectTrigger className="h-8 text-xs bg-transparent hover:bg-muted" data-testid={`select-wp-phase-${wp.id}`}>
                              <SelectValue placeholder="Phase" />
                            </SelectTrigger>
                            <SelectContent>
                              {Object.values(EaPhase).map(v => (
                                <SelectItem key={v} value={v} className="text-xs capitalize">{v.replace(/-/g, ' ')}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select value={wp.status} onValueChange={(v) => updateWP(wp.id, 'status', v)} disabled={isReadOnly}>
                            <SelectTrigger className="h-8 text-xs bg-transparent hover:bg-muted" data-testid={`select-wp-status-${wp.id}`}>
                              <SelectValue placeholder="Status" />
                            </SelectTrigger>
                            <SelectContent>
                              {Object.values(EaWorkPackageStatus).map(v => (
                                <SelectItem key={v} value={v} className="text-xs capitalize">{v}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <TextInput 
                            value={wp.owner} 
                            onChange={(v: string) => updateWP(wp.id, 'owner', v)}
                            className="text-xs bg-transparent border-transparent hover:border-input focus:border-input px-2 h-8"
                            placeholder="Owner"
                            disabled={isReadOnly}
                          />
                        </TableCell>
                        <TableCell>
                          <StringListInput 
                            value={wp.outcomes} 
                            onChange={(v) => updateWP(wp.id, 'outcomes', v)} 
                            placeholder="Outcomes"
                            disabled={isReadOnly} 
                          />
                        </TableCell>
                        <TableCell>
                          <MultiSelect 
                            options={componentList} 
                            selected={wp.targetComponentIds} 
                            onChange={(v) => updateWP(wp.id, 'targetComponentIds', v)} 
                            placeholder="Target Components"
                            disabled={isReadOnly}
                          />
                        </TableCell>
                        <TableCell>
                          <TextInput 
                            type="number"
                            value={wp.estimatedCost} 
                            onChange={(v: number) => updateWP(wp.id, 'estimatedCost', v)}
                            className="text-xs bg-transparent border-transparent hover:border-input focus:border-input px-2 h-8 w-28"
                            disabled={isReadOnly}
                            data-testid={`input-wp-cost-${wp.id}`}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => removeWP(wp.id)} disabled={isReadOnly} data-testid={`btn-remove-wp-${wp.id}`}>
                              <Trash2 className="w-4 h-4" />
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
        </TabsContent>

        <TabsContent value="waves" className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={handleAddWave} size="sm" disabled={isReadOnly || transitionArchList.length === 0} data-testid="btn-add-wave">
              <Plus className="w-4 h-4 mr-2" /> Add Wave
            </Button>
          </div>
          
          <div className="border rounded-xl bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <Table className="min-w-[800px]">
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="w-[200px]">Seq & Name</TableHead>
                    <TableHead className="w-[200px]">Transition Architecture</TableHead>
                    <TableHead className="w-[200px]">Work Packages</TableHead>
                    <TableHead className="w-[150px]">Dates</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {waves.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                        <Search className="w-8 h-8 opacity-20 mb-3 mx-auto" />
                        <p>No waves defined.</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    waves.map(wave => (
                      <TableRow key={wave.id} className="group hover:bg-muted/20 align-top">
                        <TableCell className="space-y-2">
                          <div className="flex gap-2">
                            <TextInput 
                              type="number"
                              value={wave.sequence} 
                              onChange={(v: number) => updateWave(wave.id, 'sequence', v)}
                              className="w-16 h-8 text-xs bg-transparent border-transparent hover:border-input focus:border-input px-2"
                              disabled={isReadOnly}
                            />
                            <TextInput 
                              value={wave.name} 
                              onChange={(v: string) => updateWave(wave.id, 'name', v)}
                              className="font-medium bg-transparent border-transparent hover:border-input focus:border-input px-2 h-8 flex-1"
                              placeholder="Wave name"
                              disabled={isReadOnly}
                            />
                          </div>
                        </TableCell>
                        <TableCell>
                          <Select value={wave.transitionArchitectureId} onValueChange={(v) => updateWave(wave.id, 'transitionArchitectureId', v)} disabled={isReadOnly}>
                            <SelectTrigger className="h-8 text-xs bg-transparent hover:bg-muted w-full">
                              <SelectValue placeholder="Select Arch" />
                            </SelectTrigger>
                            <SelectContent>
                              {transitionArchList.map(ta => <SelectItem key={ta.id} value={ta.id}>{ta.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <MultiSelect 
                            options={wpList} 
                            selected={wave.workPackageIds} 
                            onChange={(v) => updateWave(wave.id, 'workPackageIds', v)} 
                            placeholder="Work Packages"
                            disabled={isReadOnly}
                          />
                        </TableCell>
                        <TableCell className="space-y-2">
                          <TextInput 
                            type="date"
                            value={wave.startDate} 
                            onChange={(v: string) => updateWave(wave.id, 'startDate', v)}
                            className="h-8 text-xs bg-transparent border-transparent hover:border-input focus:border-input px-2 w-full"
                            disabled={isReadOnly}
                          />
                          <TextInput 
                            type="date"
                            value={wave.endDate} 
                            onChange={(v: string) => updateWave(wave.id, 'endDate', v)}
                            className="h-8 text-xs bg-transparent border-transparent hover:border-input focus:border-input px-2 w-full"
                            disabled={isReadOnly}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => removeWave(wave.id)} disabled={isReadOnly}>
                              <Trash2 className="w-4 h-4" />
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
        </TabsContent>

        <TabsContent value="dependencies" className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={handleAddDependency} size="sm" disabled={isReadOnly || workPackages.length < 2} data-testid="btn-add-dependency">
              <Plus className="w-4 h-4 mr-2" /> Add Dependency
            </Button>
          </div>
          
          <div className="border rounded-xl bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <Table className="min-w-[800px]">
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="w-[200px]">Predecessor WP</TableHead>
                    <TableHead className="w-[200px]">Successor WP</TableHead>
                    <TableHead className="w-[150px]">Dependency Type</TableHead>
                    <TableHead className="w-[200px]">Notes</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dependencies.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                        <Search className="w-8 h-8 opacity-20 mb-3 mx-auto" />
                        <p>No dependencies mapped.</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    dependencies.map(dep => (
                      <TableRow key={dep.id} className="group hover:bg-muted/20 align-top">
                        <TableCell>
                          <Select value={dep.predecessorWorkPackageId} onValueChange={(v) => updateDependency(dep.id, 'predecessorWorkPackageId', v)} disabled={isReadOnly}>
                            <SelectTrigger className="h-8 text-xs bg-transparent hover:bg-muted w-full">
                              <SelectValue placeholder="Predecessor WP" />
                            </SelectTrigger>
                            <SelectContent>
                              {wpList.map(wp => <SelectItem key={wp.id} value={wp.id}>{wp.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Select value={dep.successorWorkPackageId} onValueChange={(v) => updateDependency(dep.id, 'successorWorkPackageId', v)} disabled={isReadOnly}>
                            <SelectTrigger className="h-8 text-xs bg-transparent hover:bg-muted w-full">
                              <SelectValue placeholder="Successor WP" />
                            </SelectTrigger>
                            <SelectContent>
                              {wpList.map(wp => <SelectItem key={wp.id} value={wp.id}>{wp.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Select value={dep.dependencyType} onValueChange={(v) => updateDependency(dep.id, 'dependencyType', v)} disabled={isReadOnly}>
                            <SelectTrigger className="h-8 text-xs bg-transparent hover:bg-muted w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Object.values(EaRoadmapDependencyDependencyType).map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <TextAreaInput 
                            value={dep.notes} 
                            onChange={(v: string) => updateDependency(dep.id, 'notes', v)}
                            className="text-xs bg-transparent border-transparent hover:border-input focus:border-input px-2 min-h-[40px] resize-none"
                            placeholder="Notes"
                            disabled={isReadOnly}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => removeDependency(dep.id)} disabled={isReadOnly}>
                              <Trash2 className="w-4 h-4" />
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
        </TabsContent>

        <TabsContent value="prioritization" className="space-y-4">
          <div className="flex justify-end">
            <Button
              onClick={handleAddPrioritization}
              size="sm"
              disabled={isReadOnly || workPackages.every((wp) => prioritization.some((item) => item.workPackageId === wp.id))}
              data-testid="btn-add-prio"
            >
              <Plus className="w-4 h-4 mr-2" /> Add Prioritization
            </Button>
          </div>
          
          <div className="border rounded-xl bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <Table className="min-w-[1000px]">
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="w-[200px]">Work Package</TableHead>
                    <TableHead className="w-[80px]" title="0-5">Value</TableHead>
                    <TableHead className="w-[80px]" title="0-5">Risk</TableHead>
                    <TableHead className="w-[80px]" title="0-5">Urgency</TableHead>
                    <TableHead className="w-[80px]" title="0-5">Dependency</TableHead>
                    <TableHead className="w-[80px]" title="0-5">Readiness</TableHead>
                    <TableHead className="w-[80px]" title="0-5">Cost (-)</TableHead>
                    <TableHead className="w-[80px]">Score</TableHead>
                    <TableHead className="w-[200px]">Rationale</TableHead>
                    <TableHead className="w-[60px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {prioritization.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center py-12 text-muted-foreground">
                        <Search className="w-8 h-8 opacity-20 mb-3 mx-auto" />
                        <p>No prioritization criteria set.</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    prioritization.map((p) => (
                       <TableRow key={p.workPackageId} className="group hover:bg-muted/20 align-middle">
                        <TableCell>
                           <Select value={p.workPackageId} onValueChange={(v) => updatePrioritization(p.workPackageId, 'workPackageId', v)} disabled={isReadOnly}>
                            <SelectTrigger className="h-8 text-xs bg-transparent hover:bg-muted w-full">
                              <SelectValue placeholder="Select WP" />
                            </SelectTrigger>
                            <SelectContent>
                              {wpList.map(wp => <SelectItem key={wp.id} value={wp.id}>{wp.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell><TextInput type="number" min={0} max={5} value={p.value} onChange={(v: number) => updatePrioritization(p.workPackageId, 'value', v)} className="h-8 w-14 px-1 text-xs bg-transparent border-transparent hover:border-input focus:border-input" disabled={isReadOnly} /></TableCell>
                        <TableCell><TextInput type="number" min={0} max={5} value={p.risk} onChange={(v: number) => updatePrioritization(p.workPackageId, 'risk', v)} className="h-8 w-14 px-1 text-xs bg-transparent border-transparent hover:border-input focus:border-input" disabled={isReadOnly} /></TableCell>
                        <TableCell><TextInput type="number" min={0} max={5} value={p.urgency} onChange={(v: number) => updatePrioritization(p.workPackageId, 'urgency', v)} className="h-8 w-14 px-1 text-xs bg-transparent border-transparent hover:border-input focus:border-input" disabled={isReadOnly} /></TableCell>
                        <TableCell><TextInput type="number" min={0} max={5} value={p.dependency} onChange={(v: number) => updatePrioritization(p.workPackageId, 'dependency', v)} className="h-8 w-14 px-1 text-xs bg-transparent border-transparent hover:border-input focus:border-input" disabled={isReadOnly} /></TableCell>
                        <TableCell><TextInput type="number" min={0} max={5} value={p.readiness} onChange={(v: number) => updatePrioritization(p.workPackageId, 'readiness', v)} className="h-8 w-14 px-1 text-xs bg-transparent border-transparent hover:border-input focus:border-input" disabled={isReadOnly} /></TableCell>
                        <TableCell><TextInput type="number" min={0} max={5} value={p.cost} onChange={(v: number) => updatePrioritization(p.workPackageId, 'cost', v)} className="h-8 w-14 px-1 text-xs bg-transparent border-transparent hover:border-input focus:border-input" disabled={isReadOnly} /></TableCell>
                        <TableCell className="text-center font-bold text-xs">{p.totalScore}</TableCell>
                        <TableCell>
                          <TextInput 
                            value={p.rationale} 
                             onChange={(v: string) => updatePrioritization(p.workPackageId, 'rationale', v)}
                            className="text-xs bg-transparent border-transparent hover:border-input focus:border-input px-2 h-8 w-full"
                            placeholder="Rationale"
                            disabled={isReadOnly}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => removePrioritization(p.workPackageId)} disabled={isReadOnly}>
                              <Trash2 className="w-4 h-4" />
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
        </TabsContent>
      </Tabs>
    </div>
  );
}
