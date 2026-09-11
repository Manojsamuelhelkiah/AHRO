const fs = require('fs');

let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

// The CommunicationsTab maps over filtered items (notifications and completed).
// Notification has capabilities.canAct.
// If it's completed, it probably doesn't have capabilities, so canAct is false.
content = content.replace(
  'disabled={!((item as any).capabilities?.canAct ?? true)}',
  'disabled={!((item as any).capabilities?.canAct ?? false)}'
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', content);

