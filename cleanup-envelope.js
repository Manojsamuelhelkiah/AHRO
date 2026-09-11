const fs = require('fs');

let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

// NeedsAttentionTab
content = content.replace(
  '<NotificationCard key={n.id} notification={n} envelopePaused={data.pausedOffline} envelopeCanAct={data.capabilities.canAct} />',
  '<NotificationCard key={n.id} notification={n} />'
);
content = content.replace(
  '<DocumentFollowupCard key={d.documentId} doc={d} envelopePaused={data.pausedOffline} envelopeCanRemind={data.capabilities.canSendReminder} />',
  '<DocumentFollowupCard key={d.documentId} doc={d} />'
);
content = content.replace(
  '<WorkItemCard key={w.id} item={w} envelopePaused={data.pausedOffline} envelopeCanAssign={data.capabilities.canAssign} envelopeCanEscalate={data.capabilities.canEscalate} />',
  '<WorkItemCard key={w.id} item={w} />'
);
content = content.replace(
  '<OpportunityCard key={o.id} opp={o} envelopePaused={data.pausedOffline} envelopeCanAct={data.capabilities.canAct} />',
  '<OpportunityCard key={o.id} opp={o} />'
);

// Update signatures
content = content.replace(
  'function NotificationCard({ notification, envelopePaused, envelopeCanAct }: { notification: OnbActionCenter[\'notifications\'][0], envelopePaused: boolean, envelopeCanAct: boolean }) {',
  'function NotificationCard({ notification }: { notification: OnbActionCenter[\'notifications\'][0] }) {'
);
content = content.replace(
  'function DocumentFollowupCard({ doc, envelopePaused, envelopeCanRemind }: { doc: OnbActionCenter[\'documentFollowups\'][0], envelopePaused: boolean, envelopeCanRemind: boolean }) {',
  'function DocumentFollowupCard({ doc }: { doc: OnbActionCenter[\'documentFollowups\'][0] }) {'
);
content = content.replace(
  'function WorkItemCard({ item, envelopePaused, envelopeCanAssign, envelopeCanEscalate }: { item: OnbActionCenter[\'workItems\'][0], envelopePaused: boolean, envelopeCanAssign: boolean, envelopeCanEscalate: boolean }) {',
  'function WorkItemCard({ item }: { item: OnbActionCenter[\'workItems\'][0] }) {'
);
content = content.replace(
  'function OpportunityCard({ opp, envelopePaused, envelopeCanAct }: { opp: OnbActionCenter[\'opportunities\'][0], envelopePaused: boolean, envelopeCanAct: boolean }) {',
  'function OpportunityCard({ opp }: { opp: OnbActionCenter[\'opportunities\'][0] }) {'
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', content);
