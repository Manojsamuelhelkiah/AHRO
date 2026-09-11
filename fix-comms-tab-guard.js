const fs = require('fs');
let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

content = content.replace(
  'disabled={!((item as any).capabilities?.canAct ?? (!data.pausedOffline && data.capabilities.canAct))}',
  'disabled={!((item as any).capabilities?.canAct ?? (!data.pausedOffline && data.capabilities.canRecordCallOutcome))}'
);

content = content.replace(
  'const canCall = !roleLoading && (isAuthorized || isDemo) && data.capabilities.aiCall.available;',
  `const canCall = !roleLoading && (isAuthorized || isDemo) && data.capabilities.aiCall.available && (!data.pausedOffline || isDemo);`
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', content);
