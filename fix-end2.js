const fs = require('fs');
let code = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');
const lastBraceIndex = code.lastIndexOf('}');
code = code.substring(0, lastBraceIndex) + code.substring(lastBraceIndex + 1);
fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', code);
