import { expect, test } from "@playwright/test";

test("current action stays compact and analytics reconciles at desktop, tablet and phone widths", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo Reviewer/ }).click();
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByTestId("active-client-name")).toHaveText("Demo Organization");
  const fixture = {
    id: 358, workerName: "Example Worker", originalIntent: "Certification / course assignment",
    joiningDate: "2031-01-01", geography: "CA", hireType: "external-fte", lifecycleStage: "preboarding",
    orchestrationStatus: "running", createdAt: new Date().toISOString(), reportingCaseEligible: true,
    workingListHidden: false, workingListVersion: 0, canManageWorkingList: false,
    currentAction: { key: "course", label: "Check certification prerequisites and obtain the recorded manager approval",
      source: "workstream", status: "pending", additionalCount: 2 },
    gateways: { a: { status: "complete", label: "Accepted" }, b: { status: "pending", label: "Evidence needed" } },
  };
  const cases = [fixture, { ...fixture, id: 359, currentAction: null },
    { ...fixture, id: 360, offlineSample: true }];
  await page.route("**/api/onboarding/cases", route => route.fulfill({ json: cases }));
  await page.route("**/api/onboarding/workforce-transfers/programs", route => route.fulfill({ json: [] }));
  await page.route("**/api/onboarding/analytics", route => route.fulfill({ json: { narrative: "Layout fixture only.", bottlenecks: [] } }));
  await page.route("**/api/onboarding/approvals?*", route => route.fulfill({ json: [] }));
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/cases");
    const action = page.getByTestId("current-action").filter({ visible: true }).first();
    await expect(action).toContainText(fixture.currentAction.label);
    await expect(action).toContainText("+2 more");
    await expect(page.getByText(fixture.originalIntent, { exact: width >= 1024 }).filter({ visible: true }).first()).toBeVisible();
    if (width >= 1024) {
      expect((await page.locator("tbody tr").first().boundingBox())!.height).toBeLessThanOrEqual(54);
      expect(await page.locator("thead th").count()).toBe(8);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `generated-artifacts/current-action-cases-${width}.png` });
    await page.goto("/analytics");
    const workload = page.getByTestId("current-action-workload");
    await expect(workload).toBeVisible();
    await expect(page.getByTestId("current-action-reconcile")).toHaveText(
      /1 recorded \+ 1 not recorded = 2 measured cases; 1 offline example case excluded; 3 cases/);
    await workload.scrollIntoViewIfNeeded();
    expect(await workload.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `generated-artifacts/current-action-analytics-${width}.png` });
  }
});
