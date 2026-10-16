import { expect, test } from "@playwright/test";

test("reviewed email intake: real isolated router, held conversion and responsive confidential screens", async ({ page }) => {
  const session = await page.request.post("/api/test/offboarding-session", { data: { profile: "offboarding-operator" } });
  expect(session.ok()).toBeTruthy();
  const fixture = await session.json();
  const headers = { "x-organization-id": fixture.organizationId, Origin: "http://127.0.0.1:4177" };
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
    const added = await page.request.post("/api/test/email-intake-message", {
      data: { templateId: "onboarding-external-fte", table: true, legacyEmpty: true },
    });
    expect(added.ok(), await added.text()).toBeTruthy();
    const request = await added.json();
    const endpoint = `/api/onboarding/email-intake/requests/${request.id}`;
    await page.reload();
    await page.getByTestId(`${label === "phone" ? "link-request-mobile" : "link-request"}-${request.id}`).click();
    await expect(page.getByRole("heading", { name: "Review email request", exact: true })).toBeVisible();
    await expect(page.getByTestId("button-convert")).toBeDisabled();
    await page.getByTestId("button-preview-extraction").click();
    await expect(page.getByTestId("extraction-preview")).toBeVisible();
    const afterResponse = await page.request.get(endpoint, { headers });
    expect(afterResponse.ok()).toBeTruthy();
    const after = await afterResponse.json();
    expect(after.templateId).toBeNull();
    expect(after.fields).toEqual({});
    await page.getByTestId("button-adopt-extraction").click();
    await expect(page.locator("#f-work_country")).toHaveValue("US");
    await expect(page.locator("#f-worker_category")).toHaveValue("");
    await page.locator("#f-worker_category").selectOption("employee");
    await page.locator("#f-site_exposure").selectOption("no");
    await page.getByTestId("button-save-review").click();
    const duplicates = page.getByTestId("checkbox-ack-duplicate");
    if (await duplicates.isVisible()) await duplicates.check();
    await expect(page.getByTestId("button-convert")).toBeEnabled();
    await page.getByTestId("button-convert").click();
    await expect(page.getByRole("link", { name: "Open case", exact: true })).toBeVisible();
    const result = await page.request.get(endpoint, { headers });
    expect(result.ok()).toBeTruthy();
    const converted = await result.json();
    expect(converted.status).toBe("converted");
    expect(converted.caseKind).toBe("onboarding");
    const source = await page.request.get(`${endpoint}/source`, { headers });
    expect(source.ok()).toBeTruthy();
    expect(await source.json()).toMatchObject({ state: "unavailable", subject: null, body: null });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.goto("/cases");
    // Desktop rows include the case number; mobile cards retain the shorter label.
    const sourceHistory = page.getByRole("link", { name: /^Email source history(?: for .+)?$/ })
      .and(page.locator(`a[href="/email-intake/${encodeURIComponent(request.id)}"]`));
    await expect(sourceHistory).toBeVisible();
    const stale = await page.request.post(`${endpoint}/extraction`, {
      headers, data: { expectedVersion: 1, action: "preview" },
    });
    expect(stale.status()).toBe(409);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  }
});

test("legacy table source extraction previews without saving and adoption still requires review", async ({ page }) => {
  const session = await page.request.post("/api/test/offboarding-session", { data: { profile: "offboarding-operator" } });
  expect(session.ok()).toBeTruthy();
  const fixture = await session.json();
  const headers = { "x-organization-id": fixture.organizationId, Origin: "http://127.0.0.1:4177" };
  await page.addInitScript(org => {
    localStorage.setItem("onboarding-e2e-demo-profile", "offboarding-operator");
    localStorage.setItem("activeOrganizationId", org);
  }, fixture.organizationId);
  const readiness = await page.request.get("/api/onboarding/email-intake", { headers });
  expect(readiness.ok()).toBeTruthy();
  if (!(await readiness.json()).routes.some((route: { enabled: boolean }) => route.enabled)) {
    const configured = await page.request.post("/api/onboarding/email-intake", { headers, data: { reference: "controlled-table-route-review", backfillHours: 1 } });
    expect(configured.ok(), await configured.text()).toBeTruthy();
  }
  const added = await page.request.post("/api/test/email-intake-message", {
    data: { templateId: "onboarding-external-fte", table: true, legacyEmpty: true },
  });
  expect(added.ok(), await added.text()).toBeTruthy();
  const request = await added.json();
  const endpoint = `/api/onboarding/email-intake/requests/${request.id}`;
  const beforeResponse = await page.request.get(endpoint, { headers });
  expect(beforeResponse.ok()).toBeTruthy();
  const before = await beforeResponse.json();
  expect(before.fields).toEqual({});
  expect(before.templateId).toBeNull();

  await page.goto(`/email-intake/${request.id}`);
  await expect(page.getByRole("heading", { name: "Review email request", exact: true })).toBeVisible();
  await expect(page.getByTestId("button-convert")).toBeDisabled();
  await page.getByTestId("button-preview-extraction").click();
  await expect(page.getByTestId("extraction-preview")).toContainText("Example Carter");
  await expect(page.getByTestId("extraction-preview")).toContainText("html-table-1");
  const afterResponse = await page.request.get(endpoint, { headers });
  expect(afterResponse.ok()).toBeTruthy();
  const after = await afterResponse.json();
  expect(after.fields).toEqual({});
  expect(after.version).toBe(before.version);

  await page.getByTestId("button-adopt-extraction").click();
  await expect(page.getByTestId("extraction-preview")).toHaveCount(0);
  await expect(page.getByTestId("select-template")).toHaveValue("onboarding-external-fte");
  await expect(page.getByTestId("button-convert")).toBeDisabled();
  const adoptedResponse = await page.request.get(endpoint, { headers });
  expect(adoptedResponse.ok()).toBeTruthy();
  const adopted = await adoptedResponse.json();
  expect(adopted.fields).toMatchObject({ worker_name: "Example Carter", work_country: "US", joining_date: "2026-10-20" });
  expect(adopted.reviewed).toBe(false);
  expect(adopted.caseId).toBeNull();
  expect(adopted.version).toBe(before.version + 1);
  const stale = await page.request.post(`${endpoint}/extraction`, {
    headers, data: { expectedVersion: before.version, action: "preview" },
  });
  expect(stale.status()).toBe(409);
});
