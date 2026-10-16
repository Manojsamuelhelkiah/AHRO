import { expect, test, type Page } from "@playwright/test";

function dashboardPanel(page: Page, heading: string) {
  return page.getByRole("heading", { name: heading, exact: true }).locator("../..");
}

const failureScenarios = [
  { read: "activity", retryFrom: "Agent activity unavailable" },
  { read: "cases", retryFrom: "Operational metrics unavailable" },
  { read: "cases", retryFrom: "Domain workload unavailable" },
  { read: "cases", retryFrom: "Execution data unavailable" },
  { read: "approvals", retryFrom: "Interventions unavailable" },
  { read: "approvals", retryFrom: "Execution data unavailable" },
] as const;

for (const { read, retryFrom } of failureScenarios) {
  test(`Control Tower recovers ${read} using ${retryFrom} Retry without hiding other panels`, async ({ page }) => {
    const createdAt = new Date().toISOString();
    const activeCase = {
      id: 55401, workerName: "Dashboard Recovery Worker", joiningDate: "2031-01-01",
      geography: "CA", hireType: "external-fte", lifecycleStage: "preboarding",
      orchestrationStatus: "running", createdAt, reportingCaseEligible: true,
    };
    const responses = {
      activity: {
        recentEvents: [{
          id: 55402, caseId: activeCase.id, title: "Dashboard recovery activity",
          detail: "Recorded activity remains available independently.",
          engine: "deterministic", agent: "onboarding-agent", createdAt,
        }],
      },
      cases: [activeCase],
      approvals: [{
        id: 55403, caseId: activeCase.id, caseWorkerName: activeCase.workerName,
        status: "pending", hitlPattern: "hard-block", agent: "onboarding-agent",
        recommendation: "Review dashboard recovery evidence", createdAt,
      }],
    };
    const endpoints = {
      activity: "/api/onboarding/dashboard",
      cases: "/api/onboarding/cases",
      approvals: "/api/onboarding/approvals",
    };
    let failing = true;
    let failedReads = 0;
    let restoredReads = 0;
    for (const key of ["activity", "cases", "approvals"] as const) {
      // Match just these GETs, including approvals' status=all query. Leave
      // authentication, tenant admission and every other API read untouched.
      await page.route(url => url.pathname === endpoints[key], async route => {
        if (route.request().method() !== "GET") return route.continue();
        if (key === "approvals") {
          expect(new URL(route.request().url()).searchParams.get("status")).toBe("all");
        }
        if (key === read && failing) {
          failedReads++;
          await route.fulfill({ status: 503, json: { error: "Isolated dashboard read unavailable" } });
        } else {
          if (key === read) restoredReads++;
          await route.fulfill({ json: responses[key] });
        }
      });
    }

    await page.goto("/");
    await page.getByRole("button", { name: /Demo Reviewer/ }).click();
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(page.getByTestId("active-client-name")).toHaveText("Demo Organization");
    await expect(page.getByRole("heading", { name: "HRO Control Tower", exact: true })).toBeVisible();

    const activity = dashboardPanel(page, "Agent Activity");
    const attention = dashboardPanel(page, "Human Attention Required");
    const domains = dashboardPanel(page, "Cases by HRO Domain");
    const execution = dashboardPanel(page, "Execution Model");
    const summary = page.locator('[aria-label="Dashboard summary"]');
    const errors = read === "activity" ? ["Agent activity unavailable"]
      : read === "cases" ? ["Operational metrics unavailable", "Domain workload unavailable", "Execution data unavailable"]
      : ["Interventions unavailable", "Execution data unavailable"];
    for (const label of errors) {
      const error = page.getByText(label, { exact: true });
      await expect(error).toBeVisible();
      await expect(error.locator("..").getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
    }
    expect(failedReads).toBeGreaterThan(0);
    expect(restoredReads).toBe(0);

    async function expectUnrelatedPanels() {
      for (const panel of [activity, attention, domains, execution]) await expect(panel).toBeVisible();
      await expect(attention.getByRole("link", { name: "View all interventions →" })).toBeVisible();
      if (read !== "activity") {
        await expect(activity.getByRole("link", { name: `Open case ${activeCase.id}: Dashboard recovery activity` })).toBeVisible();
      }
      if (read !== "cases") {
        await expect(summary).toBeVisible();
        await expect(summary.getByText("Active Cases", { exact: true })).toBeVisible();
        await expect(domains.getByRole("img", { name: "Active cases by domain: Onboarding 1", exact: true })).toBeVisible();
      }
      if (read === "activity") {
        await expect(attention.getByRole("link", { name: `Open intervention for ${activeCase.workerName}` })).toBeVisible();
        await expect(execution.getByText("Insufficient data", { exact: true })).toBeVisible();
      }
      // Case availability also governs which approvals enter reporting.
      // Do not replace that existing population rule with an independent count.
      if (read === "cases") await expect(attention.getByText("No interventions required", { exact: true })).toBeVisible();
      await expect(page.locator("#agent-ops-heading")).toHaveCount(0);
    }
    await expectUnrelatedPanels();
    if (read !== "activity") await expect(page.getByText("Operations status unavailable", { exact: true })).toBeVisible();

    // Restore only the failed read, then use the actual section-local control:
    // no reload, navigation, query-cache manipulation or automatic retry tweak.
    failing = false;
    const recoveredResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === endpoints[read] && response.status() === 200);
    await page.getByText(retryFrom, { exact: true }).locator("..").getByRole("button", { name: "Retry", exact: true }).click();
    await recoveredResponse;
    await expect.poll(() => restoredReads).toBeGreaterThan(0);
    for (const label of errors) await expect(page.getByText(label, { exact: true })).toHaveCount(0);
    await expect(summary).toBeVisible();
    await expect(activity.getByRole("link", { name: `Open case ${activeCase.id}: Dashboard recovery activity` })).toBeVisible();
    await expect(attention.getByRole("link", { name: `Open intervention for ${activeCase.workerName}` })).toBeVisible();
    await expect(domains.getByRole("img", { name: "Active cases by domain: Onboarding 1", exact: true })).toBeVisible();
    await expect(execution.getByText("Insufficient data", { exact: true })).toBeVisible();
    await expect(page.getByText("Operations status unavailable", { exact: true })).toHaveCount(0);
    for (const panel of [activity, attention, domains, execution]) await expect(panel).toBeVisible();
    await expect(attention.getByRole("link", { name: "View all interventions →" })).toBeVisible();
    await expect(page.locator("#agent-ops-heading")).toHaveCount(0);
  });
}

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
