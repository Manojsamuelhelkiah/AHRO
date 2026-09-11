const fs = require('fs');

let settingsContent = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-settings.tsx', 'utf8');
if (!settingsContent.includes("const isDemo = organizationId === 'DEMO';")) {
    settingsContent = settingsContent.replace(
      "const isDemo = role === 'demo';", 
      "const isDemo = organizationId === 'DEMO';"
    );
    settingsContent = settingsContent.replace(
      "const { role, loading: roleLoading } = useOrganizationRole();",
      "const { role, organizationId, loading: roleLoading } = useOrganizationRole();"
    );
    fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-settings.tsx', settingsContent);
}

let tabsContent = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');
if (tabsContent.includes('const isDemo = role === \'demo\';')) {
    tabsContent = tabsContent.replace(/const isDemo = role === 'demo';/g, "const isDemo = organizationId === 'DEMO';");
    fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', tabsContent);
}
