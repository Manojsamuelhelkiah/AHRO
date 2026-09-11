const fs = require('fs');

const tabContent = `
export function CommunicationsTab() {
  const { data, isLoading } = useGetOnboardingActionCenter({ scope: 'all' });
  const [searchTerm, setSearchTerm] = useState('');

  if (isLoading) return <div className="py-12 text-center text-sm text-[var(--text-muted)]">Loading communications...</div>;
  if (!data) return <div className="py-12 text-center text-sm text-[var(--status-red)]">Failed to load action center.</div>;

  const aiCallAvailable = data.capabilities.aiCall.available;
  const hrefTemplate = data.capabilities.aiCall.hrefTemplate || '/cases/{caseId}?tab=Communications';
  
  const commsAndNotifications = [
    ...data.notifications.map(n => ({...n, _type: 'notification'})),
    ...data.completed.filter(c => c.kind.includes('call') || c.kind.includes('comm')).map(c => ({...c, _type: 'completed'}))
  ];

  const filtered = commsAndNotifications.filter(item => {
    if (!searchTerm) return true;
    const text = (item.title || item.summary || item.detail || item.deliveryLabel || '').toLowerCase();
    return text.includes(searchTerm.toLowerCase());
  }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex-1 w-full max-w-md relative">
          <Input 
            type="text" 
            placeholder="Search communications, recipients..." 
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full bg-[var(--surface)]"
          />
        </div>
      </div>

      <div className="space-y-3">
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-[var(--text-muted)] border rounded-md border-dashed">
            No communications found.
          </div>
        ) : (
          filtered.map(item => {
            const isCompleted = item._type === 'completed';
            const caseHref = item.caseHref || \`/cases/\${item.caseId}\`;
            const aiCallHref = hrefTemplate.replace('{caseId}', item.caseId.toString());

            return (
              <Card key={item.id} className="p-4 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between bg-[var(--surface)] hover:border-[var(--primary)] transition-colors">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className={cn("uppercase text-[10px]", isCompleted ? "bg-[var(--status-green-bg)] text-[var(--status-green)] border-[var(--status-green)]" : "bg-[var(--primary-light)] text-[var(--primary)] border-[var(--primary)]")}>
                      {isCompleted ? 'Completed' : (item as any).kind}
                    </Badge>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] bg-[var(--surface-alt)] px-1.5 py-0.5 rounded">
                      Case #{item.caseId}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">{format(new Date(item.createdAt), 'MMM d, HH:mm')}</span>
                  </div>
                  
                  <h4 className="text-sm font-semibold text-[var(--text-primary)] mt-1">
                    {item.title || item.summary}
                  </h4>
                  
                  {!isCompleted && (
                    <div className="mt-2 space-y-1">
                      {(item as any).detail && <p className="text-sm text-[var(--text-secondary)]">{(item as any).detail}</p>}
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-[var(--text-secondary)]">
                        {(item as any).deliveryLabel && <span>Delivery: <strong>{(item as any).deliveryLabel}</strong></span>}
                        {(item as any).provenance && <span>Provenance: <strong>{(item as any).provenance}</strong></span>}
                        {(item as any).recipient && <span>Recipient: <strong>{(item as any).recipient}</strong></span>}
                        {(item as any).initiator && <span>Initiator: <strong>{(item as any).initiator}</strong></span>}
                        {(item as any).source && <span>Source: <strong>{(item as any).source}</strong></span>}
                      </div>
                    </div>
                  )}
                </div>
                
                <div className="flex flex-wrap items-center justify-end gap-2 shrink-0 w-full md:w-auto mt-3 md:mt-0">
                  <ManualCallDialog caseId={item.caseId} defaultNotes={\`Regarding: \${item.title || item.summary}\`} />
                  
                  {aiCallAvailable && (
                    <Link href={aiCallHref} className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3 gap-2">
                      <Phone className="h-3 w-3" /> AI Call
                    </Link>
                  )}
                  
                  <Link href={caseHref} className="text-xs font-medium text-[var(--primary)] hover:underline flex items-center ml-2">
                    Case Context <ChevronRight className="h-3 w-3 ml-1" />
                  </Link>
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
`;

let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

const regex = /export function CommunicationsTab\(\) \{[\s\S]*?(?=\n\nexport function |\nEOF|\n$|$)/m;
content = content.replace(regex, tabContent.trim());

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', content);

