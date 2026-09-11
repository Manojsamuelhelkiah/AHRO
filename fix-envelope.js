const fs = require('fs');

let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

// NeedsAttentionTab
content = content.replace(
  '<NotificationCard key={n.id} notification={n} />',
  '<NotificationCard key={n.id} notification={n} envelopePaused={data.pausedOffline} envelopeCanAct={data.capabilities.canAct} />'
);
content = content.replace(
  '<DocumentFollowupCard key={d.documentId} doc={d} />',
  '<DocumentFollowupCard key={d.documentId} doc={d} envelopePaused={data.pausedOffline} envelopeCanRemind={data.capabilities.canSendReminder} />'
);
content = content.replace(
  '<WorkItemCard key={w.id} item={w} />',
  '<WorkItemCard key={w.id} item={w} envelopePaused={data.pausedOffline} envelopeCanAssign={data.capabilities.canAssign} envelopeCanEscalate={data.capabilities.canEscalate} />'
);
content = content.replace(
  '<OpportunityCard key={o.id} opp={o} />',
  '<OpportunityCard key={o.id} opp={o} envelopePaused={data.pausedOffline} envelopeCanAct={data.capabilities.canAct} />'
);

// CommunicationsTab
content = content.replace(
  '<ManualCallDialog caseId={item.caseId} defaultNotes={`Regarding: ${(item as any).title || (item as any).summary}`} personaEnabled={false} disabled={!((item as any).capabilities?.canAct ?? false)} />',
  '<ManualCallDialog caseId={item.caseId} defaultNotes={`Regarding: ${(item as any).title || (item as any).summary}`} personaEnabled={false} disabled={!((item as any).capabilities?.canAct ?? (!data.pausedOffline && data.capabilities.canAct))} />'
);

// Update signatures
content = content.replace(
  'function NotificationCard({ notification }: { notification: OnbActionCenter[\'notifications\'][0] }) {',
  'function NotificationCard({ notification, envelopePaused, envelopeCanAct }: { notification: OnbActionCenter[\'notifications\'][0], envelopePaused: boolean, envelopeCanAct: boolean }) {'
);
content = content.replace(
  'function DocumentFollowupCard({ doc }: { doc: OnbActionCenter[\'documentFollowups\'][0] }) {',
  'function DocumentFollowupCard({ doc, envelopePaused, envelopeCanRemind }: { doc: OnbActionCenter[\'documentFollowups\'][0], envelopePaused: boolean, envelopeCanRemind: boolean }) {'
);
content = content.replace(
  'function WorkItemCard({ item }: { item: OnbActionCenter[\'workItems\'][0] }) {',
  'function WorkItemCard({ item, envelopePaused, envelopeCanAssign, envelopeCanEscalate }: { item: OnbActionCenter[\'workItems\'][0], envelopePaused: boolean, envelopeCanAssign: boolean, envelopeCanEscalate: boolean }) {'
);
content = content.replace(
  'function OpportunityCard({ opp }: { opp: OnbActionCenter[\'opportunities\'][0] }) {',
  'function OpportunityCard({ opp, envelopePaused, envelopeCanAct }: { opp: OnbActionCenter[\'opportunities\'][0], envelopePaused: boolean, envelopeCanAct: boolean }) {'
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', content);

