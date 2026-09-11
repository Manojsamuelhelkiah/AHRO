const fs = require('fs');
let code = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

let open = 0;
let close = 0;
for(let i=0; i<code.length; i++) {
  if (code[i] === '{') open++;
  if (code[i] === '}') close++;
}
console.log("Braces:", open, close);
