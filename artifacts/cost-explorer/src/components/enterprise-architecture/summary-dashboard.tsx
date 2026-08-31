import { useState, useEffect } from "react";
import { EaAssessment, EaPhaseProgress, EaPhaseProgressStatus } from "@workspace/api-client-react";
import { useAssessmentUpdater } from "./utils";
import { CheckCircle2, Circle, Clock, Check, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { useLocation } from "wouter";

export function SummaryDashboard({ assessment, isReadOnly }: { assessment: EaAssessment, isReadOnly: boolean }) {
  const [, setLocation] = useLocation();
  const [progress, setProgress] = useState<EaPhaseProgress[]>([]);
  
  useEffect(() => {
    setProgress(assessment.content.phaseProgress || []);
  }, [assessment]);

  const saveProgress = useAssessmentUpdater<EaPhaseProgress[]>(assessment, "phaseProgress");
  
  const updateProgress = (phaseId: string, field: keyof EaPhaseProgress, value: any) => {
    const transform = (current: EaPhaseProgress[]) => current.map(p => p.phase === phaseId ? { ...p, [field]: value } : p);
    setProgress(transform);
    saveProgress(transform);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'complete': return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
      case 'in-progress': return <Clock className="w-4 h-4 text-blue-500" />;
      default: return <Circle className="w-4 h-4 text-muted-foreground opacity-50" />;
    }
  };

  const currentPhaseIndex = progress.findIndex(p => p.phase === assessment.currentPhase);
  const overallProgress = progress.length > 0 
    ? progress.reduce((acc, p) => acc + p.completionPercent, 0) / progress.length 
    : 0;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold">Assessment Summary & Progress</h2>
        <p className="text-muted-foreground mt-1">Track architecture development lifecycle progress and key metrics.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl border bg-card shadow-sm">
          <div className="text-xs font-semibold uppercase text-muted-foreground mb-1">Overall Completion</div>
          <div className="text-3xl font-mono font-bold">{Math.round(overallProgress)}%</div>
          <Progress value={overallProgress} className="h-2 mt-3" />
        </div>
        <div className="p-4 rounded-xl border bg-card shadow-sm">
          <div className="text-xs font-semibold uppercase text-muted-foreground mb-1">Identified Gaps</div>
          <div className="text-3xl font-mono font-bold">{assessment.content.gaps.length}</div>
          <div className="text-xs text-muted-foreground mt-1">{assessment.content.gaps.filter(g => g.disposition === 'open').length} open</div>
        </div>
        <div className="p-4 rounded-xl border bg-card shadow-sm">
          <div className="text-xs font-semibold uppercase text-muted-foreground mb-1">Target Components</div>
          <div className="text-3xl font-mono font-bold">{assessment.content.targetArchitecture.components.length}</div>
          <div className="text-xs text-muted-foreground mt-1">planned future state</div>
        </div>
        <div className="p-4 rounded-xl border bg-card shadow-sm">
          <div className="text-xs font-semibold uppercase text-muted-foreground mb-1">Work Packages</div>
          <div className="text-3xl font-mono font-bold">{assessment.content.roadmap.workPackages.length}</div>
          <div className="text-xs text-muted-foreground mt-1">in migration roadmap</div>
        </div>
      </div>

      {assessment.content.costLinks && assessment.content.costLinks.length > 0 && (
        <div className="p-4 rounded-xl border border-blue-500/30 bg-blue-500/5 shadow-sm space-y-3">
          <h3 className="font-semibold flex items-center gap-2 text-blue-700 dark:text-blue-300">
            <Check className="w-4 h-4" /> Commercial Handoffs Generated
          </h3>
          <div className="grid gap-2">
            {assessment.content.costLinks.map(link => (
              <div key={link.id} className="flex items-center justify-between p-2 rounded bg-background border text-sm">
                <div>
                  <span className="font-medium capitalize">{link.linkType}</span>
                  <span className="text-muted-foreground ml-2">ID: {link.linkedRecordId}</span>
                </div>
                <Button variant="ghost" size="sm" onClick={() => {
                  if (link.linkType === 'scenario') setLocation(`/scenario?id=${link.linkedRecordId}`);
                  if (link.linkType === 'pricing-sheet') setLocation(`/product-pricing`);
                }} data-testid={`btn-view-link-${link.id}`}>
                  View <ExternalLink className="w-3 h-3 ml-2" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border rounded-xl bg-card overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="w-[40px]"></TableHead>
              <TableHead className="w-[200px]">Phase</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Completion %</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {progress.map((p, index) => (
              <TableRow key={p.phase} className={`${index === currentPhaseIndex ? 'bg-primary/5' : ''}`}>
                <TableCell>{getStatusIcon(p.status)}</TableCell>
                <TableCell className="font-medium capitalize text-xs">
                  {p.phase.replace(/-/g, ' ')}
                  {index === currentPhaseIndex && (
                     <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] bg-primary text-primary-foreground uppercase tracking-wider">Current</span>
                  )}
                </TableCell>
                <TableCell>
                  <Select value={p.status} onValueChange={(v) => updateProgress(p.phase, 'status', v)} disabled={isReadOnly}>
                    <SelectTrigger className="h-8 w-[130px] text-xs" data-testid={`select-phase-status-${p.phase}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.values(EaPhaseProgressStatus).map(v => (
                        <SelectItem key={v} value={v} className="text-xs capitalize">{v.replace('-', ' ')}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Input 
                      type="number" min={0} max={100}
                      value={p.completionPercent} 
                      onChange={(e) => updateProgress(p.phase, 'completionPercent', Number(e.target.value))}
                      className="h-8 w-16 text-xs bg-transparent border-transparent hover:border-input px-2 -ml-2"
                      disabled={isReadOnly}
                      data-testid={`input-phase-pct-${p.phase}`}
                    />
                    <Progress value={p.completionPercent} className="w-24 h-1.5" />
                  </div>
                </TableCell>
                <TableCell>
                  <Input 
                    value={p.notes || ""} 
                    onChange={(e) => updateProgress(p.phase, 'notes', e.target.value)}
                    className="text-xs bg-transparent border-transparent hover:border-input px-2 -ml-2 h-8 w-full"
                    placeholder="Phase notes..."
                    disabled={isReadOnly}
                    data-testid={`input-phase-notes-${p.phase}`}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
