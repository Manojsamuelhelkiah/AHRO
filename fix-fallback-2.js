const fs = require('fs');
let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

content = content.replace(
  'const canRemind = !roleLoading && (isAuthorized || isDemo) && (doc.capabilities?.canRemind ?? (!envelopePaused && envelopeCanRemind));',
  'const canRemind = !roleLoading && (isAuthorized || isDemo) && (doc.capabilities?.canRemind ?? false);'
);

content = content.replace(
  'const canResolve = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canResolve ?? (!envelopePaused && envelopeCanAssign));',
  'const canResolve = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canResolve ?? false);'
);

content = content.replace(
  'const canReassign = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canReassign ?? (!envelopePaused && envelopeCanAssign));',
  'const canReassign = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canReassign ?? false);'
);

content = content.replace(
  'const canAct = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canAct ?? (!envelopePaused && envelopeCanEscalate));',
  'const canAct = !roleLoading && (isAuthorized || isDemo) && (item.capabilities?.canAct ?? false);'
);

content = content.replace(
  'const canAct = !roleLoading && (isAuthorized || isDemo) && (opp.capabilities?.canAct ?? (!envelopePaused && envelopeCanAct));',
  'const canAct = !roleLoading && (isAuthorized || isDemo) && (opp.capabilities?.canAct ?? false);'
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', content);

