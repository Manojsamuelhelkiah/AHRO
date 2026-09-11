const fs = require('fs');

let settingsContent = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-settings.tsx', 'utf8');

settingsContent = settingsContent.replace(
  "identities: identities",
  "identities: identities as any"
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-settings.tsx', settingsContent);
