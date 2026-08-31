import { useState } from "react";
import { useLocation } from "wouter";
import { 
  useGetEaAssessment, 
  getGetEaAssessmentQueryKey,
  EaPhase,
  EaAssessment
} from "@workspace/api-client-react";
import { 
  ArrowLeft,
  LayoutDashboard,
  Target,
  Briefcase,
  Database,
  AppWindow,
  Server,
  Lightbulb,
  Route as RouteIcon,
  ShieldCheck,
  RefreshCcw,
  ListTodo,
  AlertTriangle,
  Scale,
  LogOut
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { GapRegister } from "@/components/enterprise-architecture/gap-register";
import { DomainInventory } from "@/components/enterprise-architecture/domain-inventory";
import { SolutionBaseline } from "@/components/enterprise-architecture/solution-baseline";

import { RequirementsManager } from "@/components/enterprise-architecture/requirements-manager";
import { HandoffDialog } from "@/components/enterprise-architecture/handoff-dialog";
import { PrintableReport } from "@/components/enterprise-architecture/printable-report";

import { TargetArchitectureManager } from "@/components/enterprise-architecture/target-architecture";
import { OpportunitiesSolutionsManager } from "@/components/enterprise-architecture/opportunities-solutions";
import { MigrationPlanningManager } from "@/components/enterprise-architecture/migration-planning";
import { ImplementationGovernanceManager } from "@/components/enterprise-architecture/implementation-governance";
import { ChangeManagementManager } from "@/components/enterprise-architecture/change-management";
import { PhaseCharter } from "@/components/enterprise-architecture/phase-charter";
import { DecisionsManager, RisksManager } from "@/components/enterprise-architecture/decisions-risks";
import { SummaryDashboard } from "@/components/enterprise-architecture/summary-dashboard";
import { useAssessmentUpdater } from "@/components/enterprise-architecture/utils";

const PHASES: { id: EaPhase | "baseline" | "requirements" | "gaps" | "decisions" | "risks" | "summary" | "integration" | "ai" | "security" | "operating-model" | "target", label: string, icon: any }[] = [
  { id: "summary", label: "Overview & Summary", icon: LayoutDashboard },
  { id: "preliminary", label: "Preliminary", icon: LayoutDashboard },
  { id: "architecture-vision", label: "A. Architecture Vision", icon: Target },
  { id: "business", label: "B. Business Architecture", icon: Briefcase },
  { id: "data", label: "C. Data Architecture", icon: Database },
  { id: "application", label: "C. Application Architecture", icon: AppWindow },
  { id: "technology", label: "D. Technology Architecture", icon: Server },
  { id: "integration", label: "Integration Architecture", icon: Server },
  { id: "ai", label: "AI Architecture", icon: Server },
  { id: "security", label: "Security Architecture", icon: Server },
  { id: "operating-model", label: "Operating Model", icon: Server },
  { id: "target", label: "Target Architecture", icon: Target },
  { id: "opportunities-solutions", label: "E. Opportunities & Solutions", icon: Lightbulb },
  { id: "migration-planning", label: "F. Migration Planning", icon: RouteIcon },
  { id: "implementation-governance", label: "G. Implementation Governance", icon: ShieldCheck },
  { id: "architecture-change-management", label: "H. Architecture Change Mgmt", icon: RefreshCcw },
];

const LIFECYCLE_PHASES: { id: EaPhase; label: string }[] = [
  { id: "preliminary", label: "Preliminary" },
  { id: "architecture-vision", label: "Architecture Vision" },
  { id: "business", label: "Business Architecture" },
  { id: "data", label: "Data Architecture" },
  { id: "application", label: "Application Architecture" },
  { id: "technology", label: "Technology Architecture" },
  { id: "opportunities-solutions", label: "Opportunities & Solutions" },
  { id: "migration-planning", label: "Migration Planning" },
  { id: "implementation-governance", label: "Implementation Governance" },
  { id: "architecture-change-management", label: "Architecture Change Management" },
];

export function Workspace({ id }: { id: number }) {
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState<string>("preliminary");
  
  const { data: assessment, isLoading } = useGetEaAssessment(id, {
    query: { enabled: !!id, queryKey: getGetEaAssessmentQueryKey(id) }
  });
  const updateCurrentPhase = useAssessmentUpdater<EaPhase>(
    assessment as EaAssessment,
    "currentPhase",
  );

  if (isLoading) {
    return (
      <div className="space-y-6 animate-in fade-in">
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 w-10 rounded-md" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <div className="flex gap-6 h-[calc(100vh-12rem)]">
          <Skeleton className="w-64 h-full rounded-xl" />
          <Skeleton className="flex-1 h-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (!assessment) {
    return (
      <div className="text-center py-20">
        <h2 className="text-xl font-semibold mb-2">Assessment not found</h2>
        <Button onClick={() => setLocation("/enterprise-architecture")} variant="outline">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Portfolio
        </Button>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Printable Report (hidden on screen, shown on print) */}
      <PrintableReport assessment={assessment} />

      {/* Screen Content */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 sm:p-6 rounded-2xl bg-slate-900 text-slate-50 shadow-sm border border-slate-800 gap-4 print:hidden">
        <div className="flex items-start sm:items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/enterprise-architecture")} className="text-slate-300 hover:text-white hover:bg-slate-800 shrink-0 mt-1 sm:mt-0">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight truncate">{assessment.name}</h1>
              <Badge variant="outline" className="text-[10px] sm:text-xs uppercase bg-teal-500/20 text-teal-300 border-teal-500/30 whitespace-nowrap">
                {assessment.clientName}
              </Badge>
              {assessment.status === 'archived' && (
                <Badge variant="secondary" className="bg-slate-800 text-slate-300 hover:bg-slate-700 whitespace-nowrap">Archived</Badge>
              )}
            </div>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              Enterprise Architecture Workspace
            </p>
          </div>
        </div>
        
        <div className="flex flex-wrap items-center gap-3 print:hidden self-start sm:self-auto">
          <div className="space-y-1">
            <label htmlFor="current-phase" className="block text-xs font-medium text-slate-300">
              Current phase
            </label>
            <Select
              value={assessment.currentPhase}
              onValueChange={(phase) => updateCurrentPhase(phase as EaPhase)}
              disabled={assessment.status === "archived"}
            >
              <SelectTrigger id="current-phase" className="h-9 w-56 border-slate-700 bg-slate-800 text-slate-100">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIFECYCLE_PHASES.map((phase) => (
                  <SelectItem key={phase.id} value={phase.id}>{phase.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <HandoffDialog assessment={assessment} />
          <Button variant="outline" size="sm" className="border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white" onClick={() => window.print()}>
            <LogOut className="w-4 h-4 mr-2" /> Export Report
          </Button>
        </div>
      </div>

      <div className="flex flex-col md:flex-row flex-1 overflow-hidden mt-6 gap-6 print:hidden">
        {/* Navigation Sidebar */}
        <div className="md:w-64 flex-shrink-0 flex flex-col gap-6 overflow-y-auto pr-2 pb-8 print:hidden">
          <div className="md:hidden">
            <Select value={activeTab} onValueChange={setActiveTab}>
              <SelectTrigger data-testid="mobile-tab-select" className="bg-slate-900 text-white border-slate-700 font-semibold">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="baseline">Solution Baseline</SelectItem>
                {PHASES.map((phase) => (
                  <SelectItem key={phase.id} value={phase.id}>{phase.label}</SelectItem>
                ))}
                <SelectItem value="requirements">Requirements</SelectItem>
                <SelectItem value="gaps">Gap Register</SelectItem>
                <SelectItem value="decisions">Decisions</SelectItem>
                <SelectItem value="risks">Risks</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="hidden md:block space-y-1">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-3">
              Baseline
            </div>
            <button
              onClick={() => setActiveTab("baseline")}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors ${
                activeTab === "baseline" ? "bg-teal-500 text-white font-medium shadow-sm" : "text-foreground hover:bg-muted"
              }`}
            >
              <Database className="w-4 h-4" />
              Solution Baseline
            </button>
          </div>

          <div className="hidden md:block space-y-1">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-3">
              Architecture Development
            </div>
            {PHASES.map((phase) => {
              const Icon = phase.icon;
              return (
                <button
                  key={phase.id}
                  onClick={() => setActiveTab(phase.id as string)}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors ${
                    activeTab === phase.id
                      ? "bg-slate-800 text-white font-medium shadow-sm"
                      : "text-foreground hover:bg-muted"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span className="truncate">{phase.label}</span>
                </button>
              );
            })}
          </div>

          <div className="hidden md:block space-y-1">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-3">
              Cross-Phase Management
            </div>
            <button
              onClick={() => setActiveTab("requirements")}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors ${
                activeTab === "requirements" ? "bg-slate-800 text-white font-medium shadow-sm" : "text-foreground hover:bg-muted"
              }`}
            >
              <ListTodo className="w-4 h-4" />
              Requirements
            </button>
            <button
              onClick={() => setActiveTab("gaps")}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors ${
                activeTab === "gaps" ? "bg-slate-800 text-white font-medium shadow-sm" : "text-foreground hover:bg-muted"
              }`}
            >
              <AlertTriangle className="w-4 h-4" />
              Gap Register
            </button>
            <button
              onClick={() => setActiveTab("decisions")}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors ${
                activeTab === "decisions" ? "bg-slate-800 text-white font-medium shadow-sm" : "text-foreground hover:bg-muted"
              }`}
            >
              <Scale className="w-4 h-4" />
              Decisions
            </button>
            <button
              onClick={() => setActiveTab("risks")}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors ${
                activeTab === "risks" ? "bg-slate-800 text-white font-medium shadow-sm" : "text-foreground hover:bg-muted"
              }`}
            >
              <AlertTriangle className="w-4 h-4 opacity-50" />
              Risks
            </button>
          </div>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 bg-card rounded-xl border shadow-sm overflow-hidden flex flex-col print:border-none print:shadow-none print:overflow-visible">
          <div className="flex-1 overflow-y-auto p-4 md:p-6 print:p-0 print:overflow-visible">
            {activeTab === "summary" && <SummaryDashboard assessment={assessment} isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "baseline" && <SolutionBaseline />}
            {activeTab === "preliminary" && <PhaseCharter assessment={assessment} phase="preliminary" isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "architecture-vision" && <PhaseCharter assessment={assessment} phase="architecture-vision" isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "business" && <DomainInventory assessment={assessment} domain="business" isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "data" && <DomainInventory assessment={assessment} domain="data" isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "application" && <DomainInventory assessment={assessment} domain="application" isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "technology" && <DomainInventory assessment={assessment} domain="technology" isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "integration" && <DomainInventory assessment={assessment} domain="integration" isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "ai" && <DomainInventory assessment={assessment} domain="ai" isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "security" && <DomainInventory assessment={assessment} domain="security" isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "operating-model" && <DomainInventory assessment={assessment} domain="operating-model" isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "target" && <TargetArchitectureManager assessment={assessment} isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "opportunities-solutions" && <OpportunitiesSolutionsManager assessment={assessment} isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "migration-planning" && <MigrationPlanningManager assessment={assessment} isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "implementation-governance" && <ImplementationGovernanceManager assessment={assessment} isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "architecture-change-management" && <ChangeManagementManager assessment={assessment} isReadOnly={assessment.status === 'archived'} />}
            
            {activeTab === "requirements" && <RequirementsManager assessment={assessment} isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "gaps" && <GapRegister assessment={assessment} isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "decisions" && <DecisionsManager assessment={assessment} isReadOnly={assessment.status === 'archived'} />}
            {activeTab === "risks" && <RisksManager assessment={assessment} isReadOnly={assessment.status === 'archived'} />}
          </div>
        </div>
      </div>
    </div>
  );
}


