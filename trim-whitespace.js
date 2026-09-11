const fs = require('fs');

const files = [
  'artifacts/onboarding-agent/src/pages/action-center-tabs.tsx',
  'artifacts/onboarding-agent/src/pages/action-center-settings.tsx',
  'artifacts/onboarding-agent/src/pages/approvals.tsx'
];

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/[ \t]+$/gm, '');
  fs.writeFileSync(file, content);
}
