import { useState } from "react";
import { EaAssessment, EaSolutionOption, EaTransitionArchitecture, EaSolutionOptionApproach } from "@workspace/api-client-react";
import { useAssessmentUpdater } from "./utils";
import { Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { resolveSubmittedDraft, useDraftProtection, useMergeSavedDraft } from "./edit-recovery";

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
  useDraftProtection(localValue, value.join("\n"), () => setLocalValue(value.join("\n")), "List field");
  useMergeSavedDraft(value.join("\n"), setLocalValue);

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

function TextInput({ value, onChange, disabled, className, type = "text", "data-testid": testId }: any) {
  const [local, setLocal] = useState(value);
  useDraftProtection(type === "number" ? Number(local) : local, value, () => setLocal(value), "Text field");
  useMergeSavedDraft(value, setLocal);
  return (
    <Input 
      type={type}
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
  useDraftProtection(local, value, () => setLocal(value), "Text area");
  useMergeSavedDraft(value, setLocal);
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

export function OpportunitiesSolutionsManager({ assessment, isReadOnly }: { assessment: EaAssessment, isReadOnly: boolean }) {
  const savedOptions = assessment.content.opportunities.solutionOptions || [];
  const savedArchitectures = assessment.content.opportunities.transitionArchitectures || [];
  const [options, setOptions] = useState<EaSolutionOption[]>(savedOptions);
  const [architectures, setArchitectures] = useState<EaTransitionArchitecture[]>(savedArchitectures);
  useMergeSavedDraft(savedOptions, setOptions, "opportunities.solutionOptions");
  useMergeSavedDraft(savedArchitectures, setArchitectures, "opportunities.transitionArchitectures");

  const saveOptions = useAssessmentUpdater<EaSolutionOption[]>(assessment, "opportunities", "solutionOptions", resolveSubmittedDraft(setOptions));
  const saveArchitectures = useAssessmentUpdater<EaTransitionArchitecture[]>(assessment, "opportunities", "transitionArchitectures", resolveSubmittedDraft(setArchitectures));

  const gapList = (assessment.content.gaps || []).map(g => ({ id: g.id, label: g.title }));
  const componentList = (assessment.content.targetArchitecture?.components || []).map(c => ({ id: c.id, label: c.name }));
  const workPackageList = (assessment.content.roadmap?.workPackages || []).map(w => ({ id: w.id, label: w.name }));

  const handleAddOption = () => {
    const newOption: EaSolutionOption = {
      id: crypto.randomUUID(),
      name: "New Solution Option",
      approach: "build",
      gapIds: [],
      targetComponentIds: [],
      benefits: [],
      constraints: [],
      score: 0,
      selected: false
    };
    const transform = (current: EaSolutionOption[]) => [newOption, ...current];
    setOptions(transform); saveOptions(transform);
  };

  const updateOption = (id: string, field: keyof EaSolutionOption, value: any) => {
    const transform = (current: EaSolutionOption[]) => current.map(o => o.id === id ? { ...o, [field]: value } : o);
    setOptions(transform); saveOptions(transform);
  };

  const removeOption = (id: string) => {
    const transform = (current: EaSolutionOption[]) => current.filter(o => o.id !== id);
    setOptions(transform); saveOptions(transform);
  };
  
  const handleAddArchitecture = () => {
    const newArch: EaTransitionArchitecture = {
      id: crypto.randomUUID(),
      name: "New Transition Architecture",
      description: "",
      targetComponentIds: [],
      workPackageIds: [],
      entryCriteria: [],
      exitCriteria: []
    };
    const transform = (current: EaTransitionArchitecture[]) => [newArch, ...current];
    setArchitectures(transform); saveArchitectures(transform);
  };

  const updateArchitecture = (id: string, field: keyof EaTransitionArchitecture, value: any) => {
    const transform = (current: EaTransitionArchitecture[]) => current.map(a => a.id === id ? { ...a, [field]: value } : a);
    setArchitectures(transform); saveArchitectures(transform);
  };

  const removeArchitecture = (id: string) => {
    const transform = (current: EaTransitionArchitecture[]) => current.filter(a => a.id !== id);
    setArchitectures(transform); saveArchitectures(transform);
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold">Opportunities & Solutions</h2>
        <p className="text-muted-foreground">Evaluate solution options and define transition architectures.</p>
      </div>

      <Tabs defaultValue="options" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="options">Solution Options</TabsTrigger>
          <TabsTrigger value="architectures">Transition Architectures</TabsTrigger>
        </TabsList>
        
        <TabsContent value="options" className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={handleAddOption} size="sm" disabled={isReadOnly} data-testid="btn-add-solution-option">
              <Plus className="w-4 h-4 mr-2" /> Add Option
            </Button>
          </div>
          
          <div className="border rounded-xl bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <Table className="min-w-[1000px]">
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="w-[200px]">Name & Approach</TableHead>
                    <TableHead className="w-[200px]">Targets & Gaps</TableHead>
                    <TableHead className="w-[200px]">Benefits</TableHead>
                    <TableHead className="w-[200px]">Constraints</TableHead>
                    <TableHead className="w-[120px]">Score & Status</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {options.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                        <Search className="w-8 h-8 opacity-20 mb-3 mx-auto" />
                        <p>No solution options proposed.</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    options.map(opt => (
                      <TableRow key={opt.id} className="group hover:bg-muted/20 align-top">
                        <TableCell className="space-y-2">
                          <TextInput 
                            value={opt.name} 
                            onChange={(v: string) => updateOption(opt.id, 'name', v)}
                            className="font-medium bg-transparent border-transparent hover:border-input focus:border-input px-2 h-8"
                            disabled={isReadOnly}
                            data-testid={`input-option-name-${opt.id}`}
                          />
                          <Select value={opt.approach} onValueChange={(v) => updateOption(opt.id, 'approach', v)} disabled={isReadOnly}>
                            <SelectTrigger className="h-8 text-xs bg-transparent hover:bg-muted">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Object.values(EaSolutionOptionApproach).map(v => (
                                <SelectItem key={v} value={v} className="text-xs capitalize">{v}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="space-y-2">
                          <MultiSelect 
                            options={componentList} 
                            selected={opt.targetComponentIds} 
                            onChange={(v) => updateOption(opt.id, 'targetComponentIds', v)} 
                            placeholder="Target Components"
                            disabled={isReadOnly}
                          />
                          <MultiSelect 
                            options={gapList} 
                            selected={opt.gapIds} 
                            onChange={(v) => updateOption(opt.id, 'gapIds', v)} 
                            placeholder="Gaps Addressed"
                            disabled={isReadOnly}
                          />
                        </TableCell>
                        <TableCell>
                          <StringListInput 
                            value={opt.benefits} 
                            onChange={(v) => updateOption(opt.id, 'benefits', v)} 
                            disabled={isReadOnly} 
                          />
                        </TableCell>
                        <TableCell>
                          <StringListInput 
                            value={opt.constraints} 
                            onChange={(v) => updateOption(opt.id, 'constraints', v)} 
                            disabled={isReadOnly} 
                          />
                        </TableCell>
                        <TableCell className="space-y-2">
                          <div className="flex items-center gap-2 px-2">
                            <span className="text-xs text-muted-foreground w-10">Score:</span>
                            <TextInput 
                              type="number"
                              value={opt.score} 
                              onChange={(v: number) => updateOption(opt.id, 'score', v)}
                              className="text-xs bg-transparent border-transparent hover:border-input focus:border-input h-8 w-16 px-1"
                              disabled={isReadOnly}
                            />
                          </div>
                          <Button 
                            variant={opt.selected ? "default" : "outline"} 
                            size="sm" 
                            onClick={() => updateOption(opt.id, 'selected', !opt.selected)}
                            disabled={isReadOnly}
                            className={`w-full h-8 ${opt.selected ? "bg-emerald-600 hover:bg-emerald-700" : ""}`}
                            data-testid={`btn-option-select-${opt.id}`}
                          >
                            {opt.selected ? "Selected" : "Alternative"}
                          </Button>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => removeOption(opt.id)} disabled={isReadOnly} data-testid={`btn-remove-option-${opt.id}`}>
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

        <TabsContent value="architectures" className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={handleAddArchitecture} size="sm" disabled={isReadOnly} data-testid="btn-add-architecture">
              <Plus className="w-4 h-4 mr-2" /> Add Architecture
            </Button>
          </div>
          
          <div className="border rounded-xl bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <Table className="min-w-[1000px]">
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="w-[200px]">Name & Description</TableHead>
                    <TableHead className="w-[200px]">Components & Work Packages</TableHead>
                    <TableHead className="w-[200px]">Entry Criteria</TableHead>
                    <TableHead className="w-[200px]">Exit Criteria</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {architectures.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                        <Search className="w-8 h-8 opacity-20 mb-3 mx-auto" />
                        <p>No transition architectures defined.</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    architectures.map(arch => (
                      <TableRow key={arch.id} className="group hover:bg-muted/20 align-top">
                        <TableCell className="space-y-2">
                          <TextInput 
                            value={arch.name} 
                            onChange={(v: string) => updateArchitecture(arch.id, 'name', v)}
                            className="font-medium bg-transparent border-transparent hover:border-input focus:border-input px-2 h-8"
                            disabled={isReadOnly}
                            data-testid={`input-arch-name-${arch.id}`}
                          />
                          <TextAreaInput 
                            value={arch.description} 
                            onChange={(v: string) => updateArchitecture(arch.id, 'description', v)}
                            className="text-xs bg-transparent border-transparent hover:border-input focus:border-input px-2 min-h-[60px] resize-none"
                            disabled={isReadOnly}
                          />
                        </TableCell>
                        <TableCell className="space-y-2">
                          <MultiSelect 
                            options={componentList} 
                            selected={arch.targetComponentIds} 
                            onChange={(v) => updateArchitecture(arch.id, 'targetComponentIds', v)} 
                            placeholder="Target Components"
                            disabled={isReadOnly}
                          />
                          <MultiSelect 
                            options={workPackageList} 
                            selected={arch.workPackageIds} 
                            onChange={(v) => updateArchitecture(arch.id, 'workPackageIds', v)} 
                            placeholder="Work Packages"
                            disabled={isReadOnly}
                          />
                        </TableCell>
                        <TableCell>
                          <StringListInput 
                            value={arch.entryCriteria} 
                            onChange={(v) => updateArchitecture(arch.id, 'entryCriteria', v)} 
                            disabled={isReadOnly} 
                          />
                        </TableCell>
                        <TableCell>
                          <StringListInput 
                            value={arch.exitCriteria} 
                            onChange={(v) => updateArchitecture(arch.id, 'exitCriteria', v)} 
                            disabled={isReadOnly} 
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => removeArchitecture(arch.id)} disabled={isReadOnly} data-testid={`btn-remove-arch-${arch.id}`}>
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
