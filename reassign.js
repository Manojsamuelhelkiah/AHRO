const fs = require('fs');
let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

if (!content.includes('useReassignOnboardingActionCenterWork')) {
  content = content.replace(
    'useAssignOnboardingActionCenterWork,',
    'useAssignOnboardingActionCenterWork,\n  useReassignOnboardingActionCenterWork,'
  );
}

if (!content.includes('const reassignMutation = useReassignOnboardingActionCenterWork();')) {
  content = content.replace(
    'const assignMutation = useAssignOnboardingActionCenterWork();',
    'const assignMutation = useAssignOnboardingActionCenterWork();\n  const reassignMutation = useReassignOnboardingActionCenterWork();'
  );

  const newHandleAssign = `
  const handleAssign = () => {
    reassignMutation.mutate({
      data: {
        requestId: uuidv4(),
        caseId: item.caseId,
        workItemId: item.id,
        owner: owner as any,
        assignee: assignee || undefined,
        reason: reason || undefined,
        expectedVersion: (item as any).actionVersion || 0
      }
    }, {
      onSuccess: () => {
        toast({ title: "Work item reassigned" });
        setAssignOpen(false);
        queryClient.invalidateQueries({ queryKey: getGetOnboardingActionCenterQueryKey({ scope: 'active' }) });
      },
      onError: (err: any) => {
        toast({ title: "Error assigning", description: err.message, variant: 'destructive' });
      }
    });
  };
  `;

  content = content.replace(
    /const handleAssign = \(\) => \{[\s\S]*?\}\);\n  \};/,
    newHandleAssign.trim()
  );
}

// Ensure expectedVersion correctly uses actionVersion
content = content.replace(/expectedVersion: 0/g, "expectedVersion: (item as any).actionVersion || 0");
content = content.replace(/expectedVersion: \(item as any\)\.version \|\| 0/g, "expectedVersion: (item as any).actionVersion || 0");

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', content);
