import { expect, test, type Locator, type Page } from "@playwright/test";
import type { OnbApproval, OnbEvent } from "@workspace/api-client-react";

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

// Browser-only responses: these identifiers never create cases, approvals or
// recorded activity in either the isolated server or the everyday tenant.
const recordedAt = "2026-10-01T12:00:00.000Z";
const longLabel = "Fictional cross-regional employee onboarding with a deliberately long review label";
const cases = Array.from({ length: 8 }, (_, index) => ({
  id: 95500 + index,
  workerName: `${longLabel} ${index + 1}`,
  workerEmail: `dashboard-${index + 1}@example.test`,
  joiningDate: "2031-01-01",
  geography: "CA",
  lifecycleStage: "intake",
  orchestrationStatus: "waiting-approval",
  createdAt: recordedAt,
  // Last two rows exercise the existing retained/offline population fences.
  controllerRetired: index === 6,
  offlineSample: index === 7,
  fictionalOfflineIdentity: index === 7,
}));
const events: OnbEvent[] = Array.from({ length: 9 }, (_, index) => ({
  id: 95600 + index,
  caseId: index === 1 ? null : cases[index % 6].id,
  agent: index === 1 ? "system" : "documentation",
  engine: index === 1 ? "system" : "rules",
  hitlPattern: null,
  ruleRef: null,
  title: `Recorded event ${index + 1} — ${longLabel}`,
  detail: `Fictional recorded evidence ${index + 1}. ${longLabel}. No message was sent and no decision is authorized.`,
  createdAt: new Date(Date.parse(recordedAt) - index * 60_000).toISOString(),
}));
function approval(index: number, overrides: Partial<OnbApproval> = {}): OnbApproval {
  return {
    id: 95700 + index, version: 1, caseId: cases[index].id,
    caseWorkerName: cases[index].workerName,
    agent: "documentation", ruleRef: null, hitlPattern: "approve-before-act",
    recommendation: `Review fictional evidence ${index + 1}. ${longLabel}. ${longLabel}.`,
    rationale: "Recorded for layout testing only; does not authorize any action.",
    recordsEvidence: null, authorityScope: null, authorityReviewStatus: "unresolved",
    decidedAuthorityId: null, status: "pending", decidedBy: null,
    comment: null, createdAt: recordedAt, decidedAt: null, ...overrides,
  };
}
const pending = [
  approval(0),
  approval(1, { hitlPattern: "hard-block" }),
  approval(2, { agent: "readiness-watcher", ruleRef: "readiness" }),
  approval(3, { agent: "system-watcher", ruleRef: "sla", rationale: "Fictional SLA breach for review." }),
  approval(4),
  approval(5), // Eligible but beyond the five-row dashboard limit.
];
const approvals = [
  approval(6), // Retired case, not a current intervention.
  approval(7), // Offline sample history, not a current intervention.
  approval(0, { id: 95800, caseId: 99999, caseWorkerName: "Unlisted fictional case" }),
  approval(0, { id: 95801, status: "approved", decidedAt: recordedAt }),
  ...pending,
];

// toBeVisible alone permits links clipped by overflow-hidden ancestors. Check
// the whole control's horizontal bounds plus a real hit target after scrolling.
// Labels may retain the product's deliberate ellipsis/line-clamp behavior.
async function expectReachable(control: Locator, width: number) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  const bounds = await control.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeGreaterThan(0);
  expect(bounds!.height).toBeGreaterThan(0);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
  expect(await control.evaluate(element => {
    const rect = element.getBoundingClientRect();
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (["hidden", "clip", "auto", "scroll"].includes(getComputedStyle(parent).overflowX)) {
        const clip = parent.getBoundingClientRect();
        if (rect.left < clip.left - 1 || rect.right > clip.right + 1) return false;
      }
    }
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return target !== null && element.contains(target);
  })).toBe(true);
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

  test(`Populated dashboard activity and interventions remain reachable on ${viewport.label}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    // Install before login so the first dashboard query cannot cache empty data.
    await page.route("**/api/onboarding/dashboard", route => route.fulfill({ json: {
      totalCases: 7, byStage: [], pendingApprovals: 6, hardBlocked: 1,
      day1AtRisk: 0, readyCases: 0, recentEvents: events,
    } }));
    await page.route("**/api/onboarding/cases", route => route.fulfill({ json: cases }));
    await page.route("**/api/onboarding/approvals?status=all", route => route.fulfill({ json: approvals }));
    await page.goto("/");
    await page.getByRole("button", { name: /Demo Reviewer/ }).click();
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(page.getByTestId("active-client-name")).toHaveText("Demo Organization");
    await expect(page.getByRole("heading", { name: "HRO Control Tower", exact: true })).toBeVisible();

    const activity = page.getByRole("heading", { name: "Agent Activity", exact: true }).locator("../..");
    const attention = page.getByRole("heading", { name: "Human Attention Required", exact: true }).locator("../..");
    const eventRows = activity.locator("li");
    const interventionRows = attention.locator("li");
    await expect(eventRows).toHaveCount(8);
    await expect(interventionRows).toHaveCount(5);
    await expect(activity.getByText("No recent agent activity", { exact: true })).toHaveCount(0);
    await expect(attention.getByText("No interventions required", { exact: true })).toHaveCount(0);

    for (const [index, event] of events.slice(0, 8).entries()) {
      const row = eventRows.nth(index);
      await expect(row.locator("p").nth(0)).toHaveText(event.title);
      await expect(row.locator("p").nth(1)).toHaveText(event.detail);
      await expectReachable(row, viewport.width);
      if (event.caseId === null) {
        await expect(row.getByRole("link")).toHaveCount(0);
        await expect(row.getByText("View details", { exact: true })).toHaveCount(0);
      } else {
        const link = row.getByRole("link", { name: `Open case ${event.caseId}: ${event.title}`, exact: true });
        await expect(link).toHaveAttribute("href", `/cases/${event.caseId}`);
        await expectReachable(link, viewport.width);
        await expectReachable(link.getByText("View details", { exact: true }), viewport.width);
        await link.click({ trial: true });
      }
    }
    await expect(activity.getByText(events[8].title, { exact: true })).toHaveCount(0);

    const labels = ["Approval required", "Decision required", "SLA Action Due", "SLA Breached", "Approval required"];
    for (const [index, item] of pending.slice(0, 5).entries()) {
      const row = interventionRows.nth(index);
      await expect(row.locator("p").nth(0)).toHaveText(`${labels[index]} — ${item.caseWorkerName}`);
      await expect(row.locator("p").nth(1)).toHaveText(item.recommendation);
      await expect(row).toContainText(index === 1 || index === 3 ? "High priority" : "Medium priority");
      const link = row.getByRole("link", { name: `Open intervention for ${item.caseWorkerName}`, exact: true });
      await expect(link).toHaveAttribute("href", index === 2 || index === 3 ? `/cases/${item.caseId}` : "/approvals");
      await expectReachable(link, viewport.width);
      if (index === 2 || index === 3) await expectReachable(row.getByText("SLA Alert", { exact: true }), viewport.width);
      await link.click({ trial: true });
    }
    for (const name of [pending[5].caseWorkerName, cases[6].workerName, cases[7].workerName, "Unlisted fictional case"]) {
      await expect(attention.getByRole("link", { name: `Open intervention for ${name}`, exact: true })).toHaveCount(0);
    }
    const viewAll = attention.getByRole("link", { name: "View all interventions →", exact: true });
    await expect(viewAll).toHaveAttribute("href", "/approvals");
    await expectReachable(viewAll, viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
    await page.screenshot({ path: testInfo.outputPath(`dashboard-populated-${viewport.label}.png`), fullPage: true });

    // Exercise the real SPA link clicks and resulting URLs. A fictional case
    // detail read returns 404; intervention-page reads stay on the disposable
    // harness. Never decide an approval or dispatch work at the destination.
    await page.route("**/api/onboarding/cases/*", route => route.fulfill({ status: 404, json: { message: "Fictional layout-only case" } }));
    for (const [link, destination] of [
      [eventRows.first().getByRole("link"), `/cases/${events[0].caseId}`],
      [interventionRows.nth(2).getByRole("link"), `/cases/${pending[2].caseId}`],
      [interventionRows.first().getByRole("link"), "/approvals"],
      [viewAll, "/approvals"],
    ] as const) {
      await link.click();
      await expect(page).toHaveURL(new RegExp(`${destination}$`));
      await page.goBack();
      await expect(eventRows).toHaveCount(8);
      await expect(interventionRows).toHaveCount(5);
    }
  });
}
