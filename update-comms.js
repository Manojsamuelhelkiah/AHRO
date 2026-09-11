const fs = require('fs');

let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

const targetHref = "data.capabilities.aiCall.hrefTemplate";

content = content.replace(
  "Navigate to a case's communications tab to use <strong>{data.capabilities.aiCall.label}</strong>.",
  "Use <strong>{data.capabilities.aiCall.label}</strong> on individual case communications tabs."
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', content);
