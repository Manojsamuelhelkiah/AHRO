import { expect, test, type Locator, type Page } from "@playwright/test";

const recordedAt = "2026-10-01T12:00:00.000Z";
const longLabel = "Cross-regional onboarding with a deliberately long recorded review description";
const caseRows = Array.from({ length: 6 }, (_, index) => ({
  id: 95500 + index, workerName: `${longLabel} ${index + 1}`,
  joiningDate: "2031-01-01", geography: "CA", hireType: "external-fte",
  lifecycleStage: "preboarding", orchestrationStatus: "waiting-approval",
  createdAt: recordedAt, reportingCaseEligible: true,
}));
const events = Array.from({ length: 9 }, (_, index) => ({
  id: 95600 + index, caseId: index === 1 ? null : caseRows[index % 6].id,
  agent: index === 1 ? "system" : "documentation", engine: "rules",
  title: `Recorded event ${index + 1} — ${longLabel}`,
  detail: `Browser-only recorded evidence ${index + 1}. ${longLabel}. No message or decision is authorized.`,
  createdAt: new Date(Date.parse(recordedAt) - index * 60_000).toISOString(),
}));
const approvals = caseRows.map((c, index) => ({
  id: 95700 + index, caseId: c.id, status: "pending",
  hitlPattern: index === 1 ? "hard-block" : "approve-before-act",
  agent: "documentation", ruleRef: null,
  recommendation: `Review recorded evidence ${index + 1}. ${longLabel}. ${longLabel}.`,
  rationale: "Browser-only layout response; does not authorize work.", createdAt: recordedAt,
  case: { workerName: c.workerName, caseType: "Onboarding", pausedOffline: false },
  actions: { canAct: false },
}));

// Match the authorized Action Center contract, not the retired approvals-only
// dashboard source. IDs in route overrides never create server-side records.
function actionCenter(items = approvals) {
  return {
    version: 1, generatedAt: recordedAt, pausedOffline: false, offboardingSource: "available",
    counts: { pendingApprovals: items.length, notifications: 0, missingDocuments: 0,
      openWorkItems: 0, completed: 0, opportunities: 0 },
    approvals: items, notifications: [], documentFollowups: [], workItems: [],
    completed: [], opportunities: [], domainRecords: [], caseSummaries: [],
  };
}
const endpoints = {
  activity: "/api/onboarding/dashboard",
  cases: "/api/onboarding/cases",
  actions: "/api/onboarding/action-center",
} as const;

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo Reviewer/ }).click();
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByTestId("active-client-name")).toHaveText("Demo Organization");
  await expect(page.getByRole("heading", { name: "HRO Control Tower", exact: true })).toBeVisible();
}
function panel(page: Page, heading: string) {
  return page.getByRole("heading", { name: heading, exact: true }).locator("../..");
}
async function reviews(page: Page) {
  await page.route(url => url.pathname === "/api/workforce-insights", route => route.fulfill({ json: {
    organizationId: "demo", version: 1, reviews: [], owners: [], subjects: [], canManage: false,
  } }));
}
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

for (const { read, retryFrom } of [
  { read: "activity", retryFrom: "Activity coverage incomplete" },
  { read: "cases", retryFrom: "Case workload unavailable" },
  { read: "cases", retryFrom: "Family workload unavailable" },
  { read: "cases", retryFrom: "Execution data unavailable" },
  { read: "actions", retryFrom: "Outstanding work unavailable" },
  { read: "actions", retryFrom: "Reliability sources unavailable" },
] as const) {
  test(`Control Tower recovers ${read} using ${retryFrom} Retry without hiding other panels`, async ({ page }) => {
    let failing = true, failedReads = 0, restoredReads = 0;
    const responses = {
      activity: { recentEvents: [events[0]] }, cases: [caseRows[0]],
      actions: actionCenter([approvals[0]]),
    };
    await reviews(page);
    for (const key of ["activity", "cases", "actions"] as const) {
      await page.route(url => url.pathname === endpoints[key], async route => {
        if (route.request().method() !== "GET") return route.continue();
        if (key === "actions") {
          expect(new URL(route.request().url()).searchParams.get("limit")).toBe("200");
        }
        if (key === read && failing) {
          failedReads++;
          await route.fulfill({ status: 503, json: { message: "Isolated dashboard read unavailable" } });
        } else {
          if (key === read) restoredReads++;
          await route.fulfill({ json: responses[key] });
        }
      });
    }
    await signIn(page);
    const activity = panel(page, "Agent Activity");
    const attention = panel(page, "Human Attention Required");
    const domains = panel(page, "Cases by HRO Domain");
    const execution = panel(page, "Execution Model");
    const errors = read === "activity" ? ["Activity coverage incomplete"]
      : read === "cases" ? ["Case workload unavailable", "Family workload unavailable", "Execution data unavailable"]
      : ["Outstanding work unavailable", "Reliability sources unavailable"];
    for (const label of errors) {
      const error = page.getByText(label, { exact: true });
      await expect(error).toBeVisible();
      await expect(error.locator("..").getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
    }
    expect(failedReads).toBeGreaterThan(0);
    expect(restoredReads).toBe(0);
    for (const section of [activity, attention, domains, execution]) await expect(section).toBeVisible();
    await expect(attention.getByRole("link", { name: "View Action Center →" })).toBeVisible();
    if (read !== "activity") await expect(activity.getByText(events[0].title, { exact: true })).toBeVisible();
    if (read !== "actions") await expect(attention.getByText(approvals[0].recommendation, { exact: true })).toBeVisible();
    if (read !== "cases") {
      await expect(page.getByTestId("family-active-Onboarding")).toHaveText("1 active");
      await expect(execution).toContainText("Unknown:");
    }
    // A failed case count must not discard independently authorized human work.
    if (read === "cases") await expect(page.getByText("Operations status unavailable", { exact: true })).toBeVisible();
    failing = false;
    const recovered = page.waitForResponse(r => new URL(r.url()).pathname === endpoints[read] && r.status() === 200);
    await page.getByText(retryFrom, { exact: true }).locator("..").getByRole("button", { name: "Retry", exact: true }).click();
    await recovered;
    await expect.poll(() => restoredReads).toBeGreaterThan(0);
    for (const label of errors) await expect(page.getByText(label, { exact: true })).toHaveCount(0);
    await expect(activity.getByText(events[0].title, { exact: true })).toBeVisible();
    await expect(attention.getByText(approvals[0].recommendation, { exact: true })).toBeVisible();
    await expect(page.getByTestId("family-active-Onboarding")).toHaveText("1 active");
    await expect(execution).toContainText("Unknown:");
    await expect(page.getByText("Operations status unavailable", { exact: true })).toHaveCount(0);
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
    await signIn(page);
    const summary = page.locator('[aria-label="Dashboard summary"]');
    for (const title of ["Active Cases", "Autonomously Resolved", "Human Attention Required", "SLA At Risk",
      "Blocked Cases", "Offer-Acceptance Package", "Background Checks", "Day-1 Readiness"]) {
      await expect(summary.getByText(title, { exact: true })).toBeVisible();
    }
    for (const title of ["Agent Activity", "Human Attention Required", "Cases by HRO Domain",
      "Execution Model", "Operational Reliability & AI Quality"]) {
      const heading = page.getByRole("heading", { name: title, exact: true });
      await heading.scrollIntoViewIfNeeded(); await expect(heading).toBeVisible();
    }
    await expect(page.locator('[data-testid="family-list"] > li')).toHaveCount(12);
    await expect(page.getByText("Not assessed", { exact: true }).first()).toBeVisible();
    await expect(page.locator("#agent-ops-heading")).toHaveCount(0);
    await expect(page.getByText("Agent Operations", { exact: true })).toHaveCount(0);
    for (const name of ["AI Agents", "Action Center", "Execution History"]) {
      await expect(page.getByRole("link", { name, exact: true }).filter({ visible: true })).toHaveCount(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
    await page.screenshot({ path: testInfo.outputPath(`dashboard-${viewport.label}.png`), fullPage: true });
  });

  test(`Populated dashboard activity and interventions remain reachable on ${viewport.label}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await reviews(page);
    await page.route(url => url.pathname === endpoints.activity, route => route.fulfill({ json: { recentEvents: events } }));
    await page.route(url => url.pathname === endpoints.cases, route => route.fulfill({ json: caseRows }));
    await page.route(url => url.pathname === endpoints.actions, route => route.fulfill({ json: actionCenter() }));
    await signIn(page);
    const activity = panel(page, "Agent Activity"), attention = panel(page, "Human Attention Required");
    const eventRows = activity.locator("li"), workRows = attention.locator("li");
    await expect(eventRows).toHaveCount(8); await expect(workRows).toHaveCount(5);
    for (const [index, event] of events.slice(0, 8).entries()) {
      const row = eventRows.nth(index);
      await expect(row.getByText(event.title, { exact: true })).toBeVisible();
      await expect(row.getByText(event.detail, { exact: true })).toBeVisible();
      await expectReachable(row, viewport.width);
      if (event.caseId === null) await expect(row.getByRole("link")).toHaveCount(0);
      else {
        const link = row.getByRole("link");
        await expect(link).toHaveAttribute("href", `/cases/${event.caseId}?tab=progress&section=history`);
        await expectReachable(link, viewport.width); await link.click({ trial: true });
      }
    }
    // Prioritize the policy block; unsupported priorities remain not recorded.
    const visible = [approvals[1], approvals[0], approvals[2], approvals[3], approvals[4]];
    for (const [index, item] of visible.entries()) {
      const row = workRows.nth(index), link = row.getByRole("link");
      await expect(row).toContainText(item.recommendation);
      await expect(row).toContainText(`priority ${index === 0 ? "high" : "not recorded"}`);
      await expect(link).toHaveAttribute("href", `/approvals?tab=approvals&approvalId=${item.id}&caseId=${item.caseId}`);
      await expectReachable(link, viewport.width); await link.click({ trial: true });
    }
    await expect(attention).toContainText("6 total");
    await expect(attention.getByText(approvals[5].recommendation, { exact: true })).toHaveCount(0);
    const viewAll = attention.getByRole("link", { name: "View Action Center →", exact: true });
    await expectReachable(viewAll, viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
    await page.screenshot({ path: testInfo.outputPath(`dashboard-populated-${viewport.label}.png`), fullPage: true });
    await page.route("**/api/onboarding/cases/*", route => route.fulfill({ status: 404, json: { message: "Browser-only case" } }));
    for (const [link, destination] of [
      [eventRows.first().getByRole("link"), `/cases/${events[0].caseId}?tab=progress&section=history`],
      [workRows.first().getByRole("link"), `/approvals?tab=approvals&approvalId=${visible[0].id}&caseId=${visible[0].caseId}`],
      [viewAll, "/approvals"],
    ] as const) {
      await link.click();
      await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe(destination);
      await page.goBack();
      await expect(eventRows).toHaveCount(8); await expect(workRows).toHaveCount(5);
    }
  });
}

test("authored quality inventory opens the same persisted case records without execution", async ({ page }) => {
  await signIn(page);
  const examples = await page.evaluate(async () => {
    const response = await fetch("/api/onboarding/control-tower/examples", { headers: { "x-organization-id": "demo" } });
    if (!response.ok) throw new Error(`Example inventory unavailable: ${response.status}`);
    return response.json();
  });
  expect(examples.source).toBe("authored-examples");
  expect(examples.inventorySize).toBe(7); expect(examples.available).toBe(7);
  expect(examples.answerSamples).toBe(2); expect(examples.answerMatches).toBe(1);
  for (const example of examples.items) {
    expect(example.caseHref).toBe(`/cases/${example.caseId}#operational-reliability`);
    await page.goto("/");
    const link = page.locator(`a[href="${example.caseHref}"]`).first();
    await link.scrollIntoViewIfNeeded(); await link.click();
    await expect(page).toHaveURL(new RegExp(`/cases/${example.caseId}#operational-reliability$`));
    const detail = page.getByTestId("case-example-detail");
    await expect(detail).toContainText(example.title);
    await expect(detail).toContainText(example.observed ?? example.impact);
    await expect(detail).toContainText("No execution or recovery is authorized");
    if (example.corrected) await expect(detail).toContainText(example.corrected);
    await expect(detail.getByRole("button")).toHaveCount(0);
  }
});
