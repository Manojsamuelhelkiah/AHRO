const fs = require('fs');
let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

content = content.replace(
  'const canRemind = !roleLoading && (isAuthorized || isDemo) && (doc.capabilities?.canRemind ?? false);',
  `const canRemind = !roleLoading && (isAuthorized || isDemo) && (doc.capabilities?.canRemind ?? (!envelopePaused && envelopeCanRemind));`
);

content = content.replace(
  'const canResolve = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canResolve ?? false);\n  const canReassign = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canReassign ?? false);\n  const canAct = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canAct ?? false);',
  `const canResolve = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canResolve ?? (!envelopePaused && envelopeCanAssign));
  const canReassign = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canReassign ?? (!envelopePaused && envelopeCanAssign));
  const canAct = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canAct ?? (!envelopePaused && envelopeCanEscalate));`
);

content = content.replace(
  'const canAct = !roleLoading && (isAuthorized || isDemo) && (opp.capabilities?.canAct ?? false);',
  `const canAct = !roleLoading && (isAuthorized || isDemo) && (opp.capabilities?.canAct ?? (!envelopePaused && envelopeCanAct));`
);

// ManualCallDialog guard
content = content.replace(
  'const canLog = !roleLoading && (isAuthorized || isDemo) && !disabled;',
  `const canLog = !roleLoading && (isAuthorized || isDemo) && !disabled;
  const isGenuinePaused = false; // The caller should pass disabled if it's paused. We rely on the disabled prop.`
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', content);
