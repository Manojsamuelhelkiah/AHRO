const fs = require('fs');

let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

// For DocumentFollowupCard
content = content.replace(
  'const handleRemind = () => {',
  `const { role, organizationId, loading: roleLoading } = useOrganizationRole();
  const isDemo = organizationId === 'DEMO';
  const isAuthorized = role === 'admin' || role === 'owner';
  const canRemind = !roleLoading && (isAuthorized || isDemo) && (doc.capabilities?.canRemind ?? false);
  
  const handleRemind = () => {`
);

content = content.replace(
  '<Button size="sm" variant="outline" disabled={!doc.eligibleForReminder} className="gap-2">',
  '<Button size="sm" variant="outline" disabled={!doc.eligibleForReminder || !canRemind} className="gap-2">'
);

// For WorkItemCard
content = content.replace(
  'const { organizationId } = useOrganizationRole();\n  const isDemo = organizationId === \'DEMO\';',
  `const { role, organizationId, loading: roleLoading } = useOrganizationRole();
  const isDemo = organizationId === 'DEMO';
  const isAuthorized = role === 'admin' || role === 'owner';
  const canResolve = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canResolve ?? false);
  const canReassign = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canReassign ?? false);
  const canAct = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canAct ?? false);`
);

content = content.replace(
  '<Button size="sm" variant="ghost" onClick={handleResolve} disabled={resolveMutation.isPending} className="text-[var(--status-green)] hover:text-[var(--status-green)] hover:bg-[var(--status-green-bg)] mr-2">',
  '<Button size="sm" variant="ghost" onClick={handleResolve} disabled={resolveMutation.isPending || !canResolve} className="text-[var(--status-green)] hover:text-[var(--status-green)] hover:bg-[var(--status-green-bg)] mr-2">'
);

content = content.replace(
  '<DialogTrigger asChild>\n             <Button size="sm" variant="outline" className="gap-2">\n               Assign\n             </Button>\n           </DialogTrigger>',
  `<DialogTrigger asChild>
             <Button size="sm" variant="outline" className="gap-2" disabled={!canReassign}>
               Assign
             </Button>
           </DialogTrigger>`
);

content = content.replace(
  '<DialogTrigger asChild>\n             <Button size="sm" variant="outline" className="gap-2 text-[var(--status-red)] border-[var(--status-red)] hover:bg-[var(--status-red-bg)]">\n               Escalate\n             </Button>\n           </DialogTrigger>',
  `<DialogTrigger asChild>
             <Button size="sm" variant="outline" className="gap-2 text-[var(--status-red)] border-[var(--status-red)] hover:bg-[var(--status-red-bg)]" disabled={!canAct}>
               Escalate
             </Button>
           </DialogTrigger>`
);

// For OpportunityCard
content = content.replace(
  'function OpportunityCard({ opp }: { opp: OnbActionCenter[\'opportunities\'][0] }) {',
  `function OpportunityCard({ opp }: { opp: OnbActionCenter['opportunities'][0] }) {
  const { role, organizationId, loading: roleLoading } = useOrganizationRole();
  const isDemo = organizationId === 'DEMO';
  const isAuthorized = role === 'admin' || role === 'owner';
  const canAct = !roleLoading && (isAuthorized || isDemo) && (opp.capabilities?.canAct ?? false);`
);

content = content.replace(
  '<ManualCallDialog caseId={opp.caseId} defaultNotes={`Regarding opportunity: ${opp.title}`} />',
  '<ManualCallDialog caseId={opp.caseId} defaultNotes={`Regarding opportunity: ${opp.title}`} disabled={!canAct} />'
);

// For ManualCallDialog
content = content.replace(
  'export function ManualCallDialog({ caseId, defaultNotes = \'\', personaEnabled = false }: { caseId: number, defaultNotes?: string, personaEnabled?: boolean }) {',
  `export function ManualCallDialog({ caseId, defaultNotes = '', personaEnabled = false, disabled = false }: { caseId: number, defaultNotes?: string, personaEnabled?: boolean, disabled?: boolean }) {`
);

content = content.replace(
  'const { organizationId } = useOrganizationRole();\n  const isDemo = organizationId === \'DEMO\';',
  `const { role, organizationId, loading: roleLoading } = useOrganizationRole();
  const isDemo = organizationId === 'DEMO';
  const isAuthorized = role === 'admin' || role === 'owner';
  const canLog = !roleLoading && (isAuthorized || isDemo) && !disabled;`
);

content = content.replace(
  '<Button size="sm" variant="outline" className="gap-2">',
  '<Button size="sm" variant="outline" className="gap-2" disabled={!canLog}>'
);

// CommunicationsTab AI Call
content = content.replace(
  'const aiCallAvailable = data.capabilities.aiCall.available;',
  `const { role, organizationId, loading: roleLoading } = useOrganizationRole();
  const isDemo = organizationId === 'DEMO';
  const isAuthorized = role === 'admin' || role === 'owner';
  const canCall = !roleLoading && (isAuthorized || isDemo) && data.capabilities.aiCall.available;`
);

content = content.replace(
  '{aiCallAvailable && (',
  '{canCall && ('
);

content = content.replace(
  '<ManualCallDialog caseId={item.caseId} defaultNotes={`Regarding: ${(item as any).title || (item as any).summary}`} personaEnabled={false} />',
  '<ManualCallDialog caseId={item.caseId} defaultNotes={`Regarding: ${(item as any).title || (item as any).summary}`} personaEnabled={false} disabled={!((item as any).capabilities?.canAct ?? true)} />'
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', content);

