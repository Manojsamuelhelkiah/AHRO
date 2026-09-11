const fs = require('fs');

let settingsContent = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-settings.tsx', 'utf8');
settingsContent = settingsContent.replace(
  "import { useToast } from '@/components/ui/toast';",
  "import { useToast } from '@/hooks/use-toast';"
);
settingsContent = settingsContent.replace(
  "const { isAuthorized, isDemo } = useOrganizationRole();",
  "const { role } = useOrganizationRole();\n  const isAuthorized = role === 'admin' || role === 'owner';\n  const isDemo = role === 'demo';"
);
settingsContent = settingsContent.replace(
  "const [identities, setIdentities] = useState<OnbActionCenterIdentityMap>({});",
  "const [identities, setIdentities] = useState<Record<string, any>>({});"
);
fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-settings.tsx', settingsContent);

let tabsContent = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');
tabsContent = tabsContent.replace(
  "import { useToast } from '@/components/ui/toast';",
  "import { useToast } from '@/hooks/use-toast';"
);
tabsContent = tabsContent.replace(
  "import { v4 as uuidv4 } from 'uuid';",
  "const uuidv4 = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);"
);
tabsContent = tabsContent.replace(
  "useGetOnboardingActionCenter({ query: { scope: 'active' } })",
  "useGetOnboardingActionCenter({ scope: 'active' })"
);
tabsContent = tabsContent.replace(
  "useGetOnboardingActionCenter({ query: { scope: 'completed' } })",
  "useGetOnboardingActionCenter({ scope: 'completed' })"
);
tabsContent = tabsContent.replace(
  "useGetOnboardingActionCenter({ query: { scope: 'active' } })",
  "useGetOnboardingActionCenter({ scope: 'active' })"
);
fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', tabsContent);

