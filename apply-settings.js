const fs = require('fs');

const file = 'artifacts/onboarding-agent/src/pages/settings.tsx';
let content = fs.readFileSync(file, 'utf8');

// add import
if (!content.includes('ActionCenterIdentitiesSettings')) {
  content = content.replace(
    "import { SyntheticResetCard } from './settings-synthetic-reset';",
    "import { SyntheticResetCard } from './settings-synthetic-reset';\nimport { ActionCenterIdentitiesSettings } from './action-center-settings';"
  );
}

// insert component in the layout before ChecklistSettingsCard or at the end
if (!content.includes('<ActionCenterIdentitiesSettings />')) {
  content = content.replace(
    "<ChecklistSettingsCard />",
    "<ActionCenterIdentitiesSettings />\n      <ChecklistSettingsCard />"
  );
}

fs.writeFileSync(file, content);
