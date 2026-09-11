const fs = require('fs');
let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

content = content.replace(
  '{open && c && !isDemo && c.workerPhone && (',
  '{open && c && !isDemo && isAuthorized && c.workerPhone && ('
);

// We should also probably hide "Phone number unavailable" if they are not authorized, since they aren't allowed to call anyway.
content = content.replace(
  '{open && c && !isDemo && !c.workerPhone && (',
  '{open && c && !isDemo && isAuthorized && !c.workerPhone && ('
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', content);

