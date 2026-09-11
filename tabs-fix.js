const fs = require('fs');
let code = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

// The AI active case link and actual communications feed requires fixing manual call visibility in Demo, and using actual generated schema labels
code = code.replace(
  'const aiCallHref = hrefTemplate.replace(\'{caseId}\', item.caseId.toString());',
  'const aiCallHref = hrefTemplate.replace(\'{caseId}\', item.caseId.toString()) + "&tab=Communications";'
);

code = code.replace(
  '<ManualCallDialog caseId={item.caseId} defaultNotes={`Regarding: ${item.title || item.summary}`} />',
  '<ManualCallDialog caseId={item.caseId} defaultNotes={`Regarding: ${item.title || item.summary}`} personaEnabled={false} />'
);

code = code.replace(
  'export function ManualCallDialog({ caseId, defaultNotes = \'\' }: { caseId: number, defaultNotes?: string }) {',
  'export function ManualCallDialog({ caseId, defaultNotes = \'\', personaEnabled = false }: { caseId: number, defaultNotes?: string, personaEnabled?: boolean }) {'
);

code = code.replace(
  '<div className="space-y-2">\n             <Label>Demo Persona (Optional)</Label>\n             <Input value={persona} onChange={e => setPersona(e.target.value)} placeholder="e.g. VIP Demo" />\n             <p className="text-[10px] text-[var(--text-muted)]">Allowed only in Demo Organization. Records as demo metadata.</p>\n           </div>',
  `{isDemo && (
           <div className="space-y-2">
             <Label>Demo Persona (Optional)</Label>
             <Input value={persona} onChange={e => setPersona(e.target.value)} placeholder="e.g. VIP Demo" />
             <p className="text-[10px] text-[var(--text-muted)]">Allowed only in Demo Organization. Records as demo metadata.</p>
           </div>
           )}`
);

// We need to inject isDemo inside ManualCallDialog.
code = code.replace(
  'export function ManualCallDialog({ caseId, defaultNotes = \'\', personaEnabled = false }: { caseId: number, defaultNotes?: string, personaEnabled?: boolean }) {',
  `export function ManualCallDialog({ caseId, defaultNotes = '', personaEnabled = false }: { caseId: number, defaultNotes?: string, personaEnabled?: boolean }) {
  const { organizationId } = useOrganizationRole();
  const isDemo = organizationId === 'DEMO';`
);


// Replace expectedVersion: (item as any).version || 0 with actionVersion
code = code.replace(
  'expectedVersion: (item as any).version || 0 // Use item version if it exists',
  'expectedVersion: item.actionVersion || 0'
);

code = code.replace(
  'const [reason, setReason] = useState(item.reason || \'\');',
  'const [reason, setReason] = useState(item.reason || \'\');\n  const { organizationId } = useOrganizationRole();\n  const isDemo = organizationId === \'DEMO\';'
);

// Make sure handleAssign doesn't have duplicate expectedVersion line
code = code.replace(
  'expectedVersion: (item as any).actionVersion || 0',
  'expectedVersion: item.actionVersion || 0'
);

code = code.replace(
  'expectedVersion: (item as any).actionVersion || 0',
  'expectedVersion: item.actionVersion || 0'
);

// Ensure reason is sent on assignment/escalation
// This is already using `reason: reason || undefined` in the previous iteration.

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', code);
