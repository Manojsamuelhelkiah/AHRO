const fs = require('fs');
let code = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

// There's a trailing } that shouldn't be there, or CommunicationsTab has two implementations? Let's check.
const count = (code.match(/export function CommunicationsTab/g) || []).length;
console.log("CommunicationsTab count:", count);
