export type ChecklistProfileUsageCase = {
  checklistProfileId: string;
  createdAt: Date;
};

export type ChecklistProfileUsage = {
  profileId: string;
  recentMatchedCaseCount: number;
  lastUsedAt: string | null;
};

export function summarizeChecklistProfileUsage(
  cases: readonly ChecklistProfileUsageCase[],
  asOf: Date,
  windowDays: number,
) {
  const windowStartedAt = new Date(asOf.getTime() - windowDays * 86_400_000);
  const byProfile = new Map<string, { recentMatchedCaseCount: number; lastUsedAt: Date }>();

  for (const row of cases) {
    const current = byProfile.get(row.checklistProfileId);
    const recentMatchedCaseCount =
      (current?.recentMatchedCaseCount ?? 0) +
      (row.createdAt >= windowStartedAt && row.createdAt <= asOf ? 1 : 0);
    const lastUsedAt = !current || row.createdAt > current.lastUsedAt
      ? row.createdAt
      : current.lastUsedAt;
    byProfile.set(row.checklistProfileId, { recentMatchedCaseCount, lastUsedAt });
  }

  const usage: ChecklistProfileUsage[] = [...byProfile.entries()].map(([profileId, value]) => ({
    profileId,
    recentMatchedCaseCount: value.recentMatchedCaseCount,
    lastUsedAt: value.lastUsedAt.toISOString(),
  }));
  const recentCaseCount = usage.reduce((sum, row) => sum + row.recentMatchedCaseCount, 0);
  const defaultUsage = usage.find((row) => row.profileId === "default");

  return {
    windowDays,
    windowStartedAt: windowStartedAt.toISOString(),
    recentCaseCount,
    defaultFallbackCount: defaultUsage?.recentMatchedCaseCount ?? 0,
    defaultFallbackRate: recentCaseCount === 0
      ? 0
      : (defaultUsage?.recentMatchedCaseCount ?? 0) / recentCaseCount,
    profiles: usage.filter((row) => row.profileId !== "default"),
  };
}