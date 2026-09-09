export function canNavigateOrCommit(fileOperationPending: boolean): boolean {
  return !fileOperationPending;
}

export type ScenarioHydrationPlan<TFile> = {
  shouldHydrateSetup: boolean;
  processFiles: TFile[];
};

export function planScenarioHydration<TFile>(
  activeScenarioId: number | null,
  currentProcessFiles: TFile[],
): ScenarioHydrationPlan<TFile> {
  if (activeScenarioId !== null) {
    return {
      shouldHydrateSetup: false,
      processFiles: currentProcessFiles,
    };
  }

  return {
    shouldHydrateSetup: true,
    processFiles: [],
  };
}