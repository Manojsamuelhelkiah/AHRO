import { expect, test } from "@playwright/test";

test("reviewed email intake: real isolated router, held conversion and responsive confidential screens", async ({ page }) => {
  const session = await page.request.post("/api/test/offboarding-session", { data: { profile: "offboarding-operator" } });
  expect(session.ok()).toBeTruthy();
  const fixture = await session.json();
  await page.addInitScript(org => {
    localStorage.setItem("onboarding-e2e-demo-profile", "offboarding-operator");
    localStorage.setItem("activeOrganizationId", org);
  }, fixture.organizationId);
  for (const [label, width, height] of [["phone", 390, 844], ["tablet", 768, 1024], ["desktop", 1440, 1000]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/email-intake");
    await expect(page.getByRole("heading", { name: "Email intake", exact: true })).toBeVisible();
    await expect(page.getByTestId("input-email-reference")).toBeVisible();
    if (label === "phone") {
      await page.getByTestId("input-email-reference").fill("controlled-independent-routing-review");
      await page.getByTestId("button-save-email-config").click();
      await expect(page.getByText("Route saved.", { exact: false })).toBeVisible();
    }
    await expect(page.getByTestId("section-email-pending-summary")).toContainText(/pending requests?/);
    await expect(page.getByTestId("section-review-turnaround")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Compare receipt cohorts" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    if (label === "phone") {
      await page.getByRole("link", { name: "View human review turnaround in Analytics" }).click();
      await expect(page).toHaveURL(/\/analytics#human-review-turnaround$/);
      const report = page.getByTestId("section-review-turnaround");
      await expect(report).toBeVisible();
      await expect(report).toContainText("Analytics case, domain, agent, region and period filters do not apply");
      const cohorts = page.getByRole("combobox", { name: "Compare receipt cohorts" });
      await cohorts.selectOption("weekly");
      await cohorts.selectOption("monthly");
      await page.locator('select:has(option[value="7"])').selectOption("7");
      await expect(cohorts).toHaveValue("monthly");
      const refresh = page.waitForRequest(request => request.method() === "GET" && new URL(request.url()).pathname === "/api/onboarding/email-intake");
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await refresh;
      await expect(cohorts).toHaveValue("monthly");
      await cohorts.selectOption("all");
      await expect(report.getByTestId("turnaround-mobile")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      await page.goto("/email-intake");
    }
    const added = await page.request.post("/api/test/email-intake-message", { data: { templateId: "leave-request" } });
    expect(added.ok(), await added.text()).toBeTruthy();
    const request = await added.json();
    await page.reload();
    await page.getByTestId(`${label === "phone" ? "link-request-mobile" : "link-request"}-${request.id}`).click();
    await expect(page.getByRole("heading", { name: "Review email request", exact: true })).toBeVisible();
    await expect(page.getByTestId("button-convert")).toBeDisabled();
    await page.getByTestId("button-save-review").click();
    const duplicates = page.getByTestId("checkbox-ack-duplicate");
    if (await duplicates.isVisible()) await duplicates.check();
    await expect(page.getByTestId("button-convert")).toBeEnabled();
    await page.getByTestId("button-convert").click();
    await expect(page.getByRole("link", { name: "Open case", exact: true })).toBeVisible();
    const result = await page.request.get(`/api/onboarding/email-intake/requests/${request.id}`, { headers: { "x-organization-id": fixture.organizationId } });
    expect(result.ok()).toBeTruthy();
    const converted = await result.json();
    expect(converted.status).toBe("converted");
    expect(converted.caseKind).toBe("service-request");
    const source = await page.request.get(`/api/onboarding/email-intake/requests/${request.id}/source`, { headers: { "x-organization-id": fixture.organizationId } });
    expect(await source.json()).toMatchObject({ state: "unavailable", subject: null, body: null });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.goto("/cases");
    // Compact desktop rows include the case number in the accessible name;
    // mobile cards retain the shorter label. Check this request's visible link.
    const sourceHistory = page.getByRole("link", { name: /^Email source history(?: for .+)?$/ })
      .and(page.locator(`a[href="/email-intake/${encodeURIComponent(request.id)}"]`));
    await expect(sourceHistory).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  }
});
