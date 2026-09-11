const fs = require('fs');

let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

// fix imports
content = content.replace(
  "getGetOnboardingActionCenterQueryKey",
  "getGetOnboardingActionCenterQueryKey,\n  useGetOnboardingCase,\n  getGetOnboardingCaseQueryKey"
);

// fix isDemo
content = content.replace(/organizationId === 'demo'/g, "organizationId === 'DEMO'");

// fix aiCallHref
content = content.replace(
  /const aiCallHref = hrefTemplate\.replace\('\{caseId\}', item\.caseId\.toString\(\)\) \+ "&tab=Communications";/g,
  "const aiCallHref = hrefTemplate.replace('{caseId}', item.caseId.toString());"
);

// update ManualCallDialog
const manualCallCode = `export function ManualCallDialog({ caseId, defaultNotes = '', personaEnabled = false }: { caseId: number, defaultNotes?: string, personaEnabled?: boolean }) {
  const { organizationId } = useOrganizationRole();
  const isDemo = organizationId === 'DEMO';
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const recordOutcome = useRecordOnboardingActionCenterCallOutcome();
  
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState('reached');
  const [notes, setNotes] = useState(defaultNotes);
  const [persona, setPersona] = useState('');

  const { data: c } = useGetOnboardingCase(caseId, {
    query: {
      enabled: open,
      queryKey: getGetOnboardingCaseQueryKey(caseId)
    }
  });
  
  const handleRecord = () => {`;

content = content.replace(
  /export function ManualCallDialog\(\{ caseId, defaultNotes = '', personaEnabled = false \}: \{ caseId: number, defaultNotes\?: string, personaEnabled\?: boolean \}\) \{[\s\S]*?const handleRecord = \(\) => \{/,
  manualCallCode
);

const dialogHeaderContent = `<DialogDescription>Record a manual call outcome for Case #{caseId}. This is self-reported and does not verify readiness.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
           {open && c && !isDemo && c.workerPhone && (
             <div className="mb-2">
               <a href={\`tel:\${c.workerPhone}\`} className="inline-flex items-center gap-2 text-sm font-medium text-[var(--primary)] hover:underline border border-[var(--border)] rounded-md px-3 py-1.5 bg-[var(--surface-alt)]">
                 <Phone className="h-4 w-4" /> Dial {c.workerPhone}
               </a>
             </div>
           )}
           {open && c && !isDemo && !c.workerPhone && (
             <div className="mb-2 text-sm text-[var(--text-muted)] italic">
               Phone number unavailable
             </div>
           )}
           {open && c && isDemo && (
             <div className="mb-2 text-sm text-[var(--status-amber)] italic bg-[var(--status-amber-bg)] px-3 py-1.5 rounded-md border border-[var(--status-amber)]">
               Simulation log only
             </div>
           )}
           <div className="space-y-2">`;

content = content.replace(
  /<DialogDescription>Record a manual call outcome for Case #\{caseId\}\. This is self-reported and does not verify readiness\.<\/DialogDescription>\s*<\/DialogHeader>\s*<div className="space-y-4 py-2">\s*<div className="space-y-2">/,
  dialogHeaderContent
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', content);

