const fs = require('fs');
let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

content = content.replace(
  '<p>Action Center is paused for offline/simulated cases. Only Demo-authorized actions on allowed rows are available.</p>',
  '<p>Action Center is paused for offline/simulated cases (Global canSendReminder: {data.capabilities.canSendReminder ? \'Yes\' : \'No\'}). Only Demo-authorized actions on allowed rows are available.</p>'
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', content);
