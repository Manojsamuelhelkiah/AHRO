const fs = require('fs');
let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

content = content.replace(
  'disabled={!((item as any).capabilities?.canAct ?? (!data.pausedOffline && data.capabilities.canRecordCallOutcome))}',
  'disabled={!((item as any).capabilities?.canAct ?? false)}'
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', content);
