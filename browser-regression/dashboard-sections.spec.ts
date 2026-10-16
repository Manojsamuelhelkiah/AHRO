import { expect, test } from "@playwright/test";

for (const viewport of [
  { width: 390, height: 844, label: "phone" },
  { width: 768, height: 1024, label: "tablet" },
  { width: 1280, height: 900, label: "desktop" },
]) {
  test(`Control Tower retains its dashboard without Agent Operations on ${viewport.label}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.getByRole("button", { name: /Demo Reviewer/ }).click();
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(page.getByTestId("active-client-name")).toHaveText("Demo Organization");
    await expect(page.getByRole("heading", { name: "HRO Control Tower", exact: true })).toBeVisible();

    const summary = page.locator('[aria-label="Dashboard summary"]');
    await expect(summary).toBeVisible();
    for (const title of [
      "Active Cases", "Autonomously Resolved", "Human Interventions", "SLA At Risk",
      "Blocked Cases", "Offer-Acceptance Package", "Background Checks", "Day-1 Readiness",
    ]) {
      await expect(summary.getByText(title, { exact: true })).toBeVisible();
    }

    for (const title of [
      "Agent Activity", "Human Attention Required", "Cases by HRO Domain", "Execution Model",
    ]) {
      const heading = page.getByRole("heading", { name: title, exact: true });
      await heading.scrollIntoViewIfNeeded();
      await expect(heading).toBeVisible();
    }
    await expect(page.getByRole("link", { name: "View all interventions →" })).toBeVisible();
    await expect(page.locator("#agent-ops-heading")).toHaveCount(0);
    for (const text of [
      "Agent Operations", "Operational status and workload across the autonomous HR workforce.",
      "Onboarding Agent", "Payroll Agent", "Compliance Agent", "Helpdesk Agent", "No active work",
    ]) {
      await expect(page.getByText(text, { exact: true })).toHaveCount(0);
    }
    // Keep navigation to the actual capabilities; only the dashboard cards are removed.
    for (const name of ["AI Agents", "Action Center", "Execution History"]) {
      await expect(page.getByRole("link", { name, exact: true }).filter({ visible: true })).toHaveCount(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
    const activityGrid = page.getByRole("heading", { name: "Agent Activity", exact: true }).locator("../../..");
    const gap = await activityGrid.evaluate((element) => {
      const previous = element.previousElementSibling!;
      return element.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
    });
    // The activity/attention row follows the preceding retained section with
    // the existing space-y-6 spacing, not an empty card grid or reserved height.
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(24);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`dashboard-${viewport.label}.png`), fullPage: true });
  });
}
