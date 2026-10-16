import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";

test("email review reconciles saved revisions and converts once after a real routing blocker", async ({ page }) => {
  const session = await page.request.post("/api/test/offboarding-session", { data: { profile: "offboarding-operator" } });
  expect(session.ok()).toBeTruthy();
  const fixture = await session.json();
  const headers = { "x-organization-id": fixture.organizationId, Origin: "http://127.0.0.1:4177" };
  await page.addInitScript(org => {
    localStorage.setItem("onboarding-e2e-demo-profile", "offboarding-operator");
    localStorage.setItem("activeOrganizationId", org);
  }, fixture.organizationId);

  let readinessResponse = await page.request.get("/api/onboarding/email-intake", { headers });
  expect(readinessResponse.ok()).toBeTruthy();
  let readiness = await readinessResponse.json();
  if (!readiness.routes.some((route: { enabled: boolean }) => route.enabled)) {
    await page.goto("/email-intake");
    await page.getByTestId("input-email-reference").fill("focused-revision-reconciliation-review");
    await page.getByTestId("button-save-email-config").click();
    await expect(page.getByText("Route saved.", { exact: false })).toBeVisible();
    readinessResponse = await page.request.get("/api/onboarding/email-intake", { headers });
    expect(readinessResponse.ok()).toBeTruthy();
    readiness = await readinessResponse.json();
  }
  const route = readiness.routes.find((item: { enabled: boolean }) => item.enabled);
  expect(route, "isolated fixture must expose an enabled, reviewed route").toBeTruthy();

  const added = await page.request.post("/api/test/email-intake-message", {
    data: { templateId: "onboarding-external-fte" },
  });
  expect(added.ok(), await added.text()).toBeTruthy();
  const { id } = await added.json();
  const endpoint = `/api/onboarding/email-intake/requests/${id}`;
  await page.goto(`/email-intake/${id}`);
  await expect(page.getByRole("heading", { name: "Review email request", exact: true })).toBeVisible();
  await page.getByTestId("button-preview-extraction").click();
  await expect(page.getByTestId("extraction-preview")).toBeVisible();
  await page.getByTestId("button-adopt-extraction").click();
  await expect(page.locator("#f-work_country")).toHaveValue("US");
  await page.locator("#f-worker_category").selectOption("employee");
  await page.locator("#f-site_exposure").selectOption("no");
  const reviewSaved = page.waitForResponse(response =>
    response.request().method() === "PATCH" && new URL(response.url()).pathname === endpoint);
  await page.getByTestId("button-save-review").click();
  const reviewResponse = await reviewSaved;
  expect(reviewResponse.ok(), await reviewResponse.text()).toBeTruthy();
  let savedResponse = await page.request.get(endpoint, { headers });
  expect(savedResponse.ok()).toBeTruthy();
  let saved = await savedResponse.json();
  console.log("saved review", { status: saved.status, version: saved.version, reviewed: saved.reviewed, missingFields: saved.missingFields });
  expect(saved.reviewed).toBe(true);
  expect(saved.missingFields).toEqual([]);

  const externalEdit = async (expectedVersion: number, workerName: string) => {
    const response = await page.request.patch(endpoint, {
      headers,
      data: { expectedVersion, action: "save", templateId: "onboarding-external-fte",
        fields: { ...saved.fields, worker_name: workerName } },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };

  // The clean local editor adopts a newer server-owned saved revision.
  let newer = await externalEdit(saved.version, "Server Reviewed Revision One");
  await page.getByTestId("button-reload-email-request").click();
  await expect(page.locator("#f-worker_name")).toHaveValue("Server Reviewed Revision One");
  await expect(page.getByText(`Version ${newer.version}`, { exact: true })).toBeVisible();

  // A local draft stays on its old baseline when another saved revision arrives.
  await page.locator("#f-worker_name").fill("Unsaved local draft");
  newer = await externalEdit(newer.version, "Server Reviewed Revision Two");
  const focusRefresh = page.waitForResponse(response =>
    response.request().method() === "GET" && new URL(response.url()).pathname === endpoint);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await focusRefresh;
  await expect(page.locator("#f-worker_name")).toHaveValue("Unsaved local draft");
  const newerNotice = page.locator('[data-testid="section-classification"] [role="status"]');
  await expect(newerNotice).toContainText("A newer saved version is available");
  await expect(newerNotice).toContainText("Your unsaved fields have been kept");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByTestId("button-reload-email-request").click();
  await expect(page.locator("#f-worker_name")).toHaveValue("Unsaved local draft");
  await expect(newerNotice).toContainText("A newer saved version is available");
  await expect(newerNotice).toContainText("Your unsaved fields have been kept");
  page.once("dialog", dialog => dialog.accept());
  await page.getByTestId("button-reload-email-request").click();
  await expect(page.locator("#f-worker_name")).toHaveValue("Server Reviewed Revision Two");
  await expect(page.getByText(`Version ${newer.version}`, { exact: true })).toBeVisible();
  await expect(page.getByText("A newer saved version is available")).toHaveCount(0);

  // Exercise a real route-owned 409. No conversion/auth/error response is mocked.
  const pausedResponse = await page.request.patch(`/api/onboarding/email-intake/routes/${route.id}`, {
    headers, data: { expectedVersion: route.version, enabled: false },
  });
  expect(pausedResponse.ok(), await pausedResponse.text()).toBeTruthy();
  const pausedRoute = await pausedResponse.json();
  const convertRequests: string[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `${endpoint}/convert`)
      convertRequests.push(request.url());
  });
  const attachments = page.getByTestId("checkbox-ack-attachments");
  if (await attachments.isVisible()) await attachments.check();
  const duplicates = page.getByTestId("checkbox-ack-duplicate");
  if (await duplicates.isVisible()) await duplicates.check();
  await expect(page.getByTestId("button-convert")).toBeEnabled();
  await page.getByTestId("button-convert").click();
  const conversionError = page.getByTestId("section-convert").getByRole("alert");
  await expect(conversionError).toContainText("Mailbox routing is paused, revoked or changed");
  await expect(conversionError).not.toContainText("This record changed");
  expect(convertRequests).toHaveLength(1);
  savedResponse = await page.request.get(endpoint, { headers });
  expect(savedResponse.ok()).toBeTruthy();
  saved = await savedResponse.json();
  expect(saved.status).not.toBe("converted");

  const restored = await page.request.patch(`/api/onboarding/email-intake/routes/${route.id}`, {
    headers, data: { expectedVersion: pausedRoute.version, enabled: true },
  });
  expect(restored.ok(), await restored.text()).toBeTruthy();
  await page.getByTestId("button-save-review").click();
  await expect(page.getByTestId("button-convert")).toBeEnabled();
  if (await attachments.isVisible()) await attachments.check();
  if (await duplicates.isVisible()) await duplicates.check();
  await page.getByTestId("button-convert").click();
  await expect(page.getByRole("link", { name: "Open case", exact: true })).toBeVisible();

  const convertedResponse = await page.request.get(endpoint, { headers });
  expect(convertedResponse.ok()).toBeTruthy();
  const converted = await convertedResponse.json();
  expect(converted.status).toBe("converted");
  expect(converted.caseKind).toBe("onboarding");
  expect(converted.caseId).toBeTruthy();
  const caseResponse = await page.request.get(`/api/onboarding/cases/${converted.caseId}`, { headers });
  expect(caseResponse.ok(), await caseResponse.text()).toBeTruthy();
  const heldCase = await caseResponse.json();
  expect(heldCase.orchestrationStatus).toBe("batch-intake-pending-review");

  // The real endpoint's repeated submission returns the original linked case.
  const repeated = await page.request.post(`${endpoint}/convert`, {
    headers, data: { expectedVersion: converted.version, attachmentsAcknowledged: true, duplicateAcknowledged: true },
  });
  expect(repeated.ok(), await repeated.text()).toBeTruthy();
  const repeatedResult = await repeated.json();
  expect(repeatedResult.caseId).toBe(converted.caseId);
  expect(repeatedResult.status).toBe("converted");
  const finalRequest = await page.request.get(endpoint, { headers });
  expect(finalRequest.ok()).toBeTruthy();
  expect((await finalRequest.json()).caseId).toBe(converted.caseId);

  mkdirSync("generated-artifacts", { recursive: true });
  await page.screenshot({ path: "generated-artifacts/email-intake-refresh-journey.png", fullPage: true });
});
