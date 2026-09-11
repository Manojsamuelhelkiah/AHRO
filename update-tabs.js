const fs = require('fs');

let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

if (!content.includes('useResolveOnboardingActionCenterWork')) {
  content = content.replace(
    "useEscalateOnboardingActionCenterWork,",
    "useEscalateOnboardingActionCenterWork,\n  useResolveOnboardingActionCenterWork,"
  );
}

if (!content.includes('const resolveMutation = useResolveOnboardingActionCenterWork()')) {
  content = content.replace(
    "const assignMutation = useAssignOnboardingActionCenterWork();",
    "const assignMutation = useAssignOnboardingActionCenterWork();\n  const resolveMutation = useResolveOnboardingActionCenterWork();"
  );
  
  const handleResolveCode = `
  const handleResolve = () => {
    resolveMutation.mutate({
      data: {
        requestId: uuidv4(),
        caseId: item.caseId,
        workItemId: item.id,
        expectedVersion: (item as any).version || 0 // Use item version if it exists
      }
    }, {
      onSuccess: () => {
        toast({ title: "Work item resolved" });
        queryClient.invalidateQueries({ queryKey: getGetOnboardingActionCenterQueryKey({ scope: 'active' }) });
        queryClient.invalidateQueries({ queryKey: getGetOnboardingActionCenterQueryKey({ scope: 'completed' }) });
      },
      onError: (err: any) => {
        toast({ title: "Error resolving", description: err.message, variant: 'destructive' });
      }
    });
  };
  `;
  
  content = content.replace(
    "const handleEscalate = () => {",
    handleResolveCode + "\n  const handleEscalate = () => {"
  );
  
  content = content.replace(
    "<Dialog open={assignOpen} onOpenChange={setAssignOpen}>",
    `<Button size="sm" variant="ghost" onClick={handleResolve} disabled={resolveMutation.isPending} className="text-[var(--status-green)] hover:text-[var(--status-green)] hover:bg-[var(--status-green-bg)] mr-2">
             {resolveMutation.isPending ? 'Resolving...' : 'Resolve'}
           </Button>\n         <Dialog open={assignOpen} onOpenChange={setAssignOpen}>`
  );
}

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', content);
