import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

test.skip(process.env.ADMIN_EDIT_E2E_TEST !== "true", "Requires the disposable admin-edit harness; run playwright.workforce-insights.config.ts.");

test("administrator completes one protected workforce human-review lifecycle", async ({ page }) => {
  mkdirSync("generated-artifacts", { recursive: true });

  // Establish the same disposable browser identity and verified admin fixture
  // used by admin-case-edit.spec.ts. This never uses project credentials.
  await page.goto("/");
  await page.getByRole("button", { name: /Demo Reviewer/ }).click();
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByTestId("active-client-name")).toBeVisible();
  await page.goto("/api/test/ready");
  const session = await page.request.post("/api/test/admin-read/session", { data: { mode: "development" } });
  expect(session.status(), await session.text()).toBe(200);
  const fixture = await session.json() as {
    organizationId: string;
    actorUserId: string;
    active: { caseId: number };
    historical: { caseId: number };
  };
  await page.evaluate(org => localStorage.setItem("activeOrganizationId", org), fixture.organizationId);

  const tomorrow = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  });
  const reason = "UI verification only — no employee concern asserted";
  const action = "Verify review workflow; do not contact anyone";
  const outcome = "UI verification completed; no employee finding or outreach";
  const caseId = fixture.historical.caseId;
  const row = (p: Page) => p.getByTestId(`row-subject-${caseId}`);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/analytics");
  await expect(page.getByTestId("section-early-warning")).toBeVisible();
  await expect(row(page)).toBeVisible();
  await expect(row(page)).toContainText("Retained Admin Edit Fixture");
  await expect(row(page)).toContainText(`S${caseId}`);
  const analytics = page.getByTestId("section-early-warning");
  await expect(row(page).getByTestId("indicator-not-assessed-talent-risk")).toBeVisible();
  await expect(row(page).getByTestId("indicator-not-assessed-resume-integrity")).toBeVisible();
  await expect(analytics).toContainText("No prediction model is connected");
  await expect(analytics).toContainText("No risk percentages or colours are shown");
  await expect(analytics.getByTestId("text-coverage-note")).toContainText("existing source cases");
  await expect(analytics.getByTestId("text-coverage-note")).toContainText("not a complete employee directory");
  expect(await analytics.innerText()).not.toMatch(/\b\d+(?:\.\d+)?%/);
  await page.screenshot({ path: "generated-artifacts/workforce-analytics-1280.png" });

  // Check the alternate review wording without creating another review.
  await page.getByTestId("button-new-review").click();
  const dialog = page.getByRole("dialog", { name: "Start a human review" });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("select-review-kind").selectOption("resume-integrity");
  await expect(dialog).toContainText("verification, not a conclusion of fraud");
  await expect(dialog.getByTestId("button-submit-review")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  // Analytics and its dialog are exercised at each requested viewport.
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/analytics");
    await expect(page.getByTestId("section-early-warning")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
    await page.screenshot({ path: `generated-artifacts/workforce-analytics-${width}.png` });
    await page.getByTestId("button-new-review").click();
    const viewportDialog = page.getByRole("dialog", { name: "Start a human review" });
    await expect(viewportDialog).toBeVisible();
    await expect(viewportDialog.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(viewportDialog.getByTestId("button-submit-review")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
    await page.screenshot({ path: `generated-artifacts/workforce-review-dialog-${width}.png` });
    await viewportDialog.getByRole("button", { name: "Cancel" }).click();
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/analytics");
  await expect(row(page)).toBeVisible();
  await page.getByTestId("button-new-review").click();
  const createDialog = page.getByRole("dialog", { name: "Start a human review" });
  await createDialog.getByTestId("select-review-case").selectOption(String(caseId));
  await createDialog.getByTestId("select-review-kind").selectOption("talent-risk");
  await createDialog.getByTestId("select-review-priority").selectOption("critical");
  await createDialog.getByTestId("input-review-reason").fill(reason);
  await createDialog.getByTestId("input-review-action").fill(action);
  await createDialog.getByTestId("select-review-owner").selectOption(fixture.actorUserId);
  await createDialog.getByTestId("input-review-due").fill(tomorrow);
  const createResponsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/workforce-insights/reviews" &&
    response.request().method() === "POST");
  await createDialog.getByTestId("button-submit-review").click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status(), await createResponse.text()).toBe(200);
  const createdSnapshot = await createResponse.json();
  const review = createdSnapshot.reviews.find((r: any) => r.reason === reason);
  expect(review).toMatchObject({
    caseId, kind: "talent-risk", origin: "human", status: "open",
    priority: "critical", ownerUserId: fixture.actorUserId, dueDate: expect.stringContaining(tomorrow),
    recommendedAction: action,
  });
  const id = review.id as string;
  const reference = review.reference as string;
  console.log(`Resolved verification review ${reference} (${id}) for existing source S${caseId}.`);
  await expect(page.getByTestId(`card-review-${id}`)).toContainText(reference);
  await expect(page.getByTestId(`card-review-${id}`)).toContainText("Human-initiated");
  await expect(page.getByTestId(`card-review-${id}`)).toContainText("Review priority: Critical");
  await expect(row(page).getByTestId("indicator-not-assessed-talent-risk")).toBeVisible();
  await expect(row(page).getByTestId("indicator-not-assessed-resume-integrity")).toBeVisible();

  // Persisted reload and both open-review panels.
  await page.reload();
  await expect(page.getByTestId(`card-review-${id}`)).toBeVisible();
  await page.goto("/");
  const dashboardPanel = page.getByTestId("panel-workforce-reviews");
  await expect(dashboardPanel.getByTestId(`row-workforce-review-${id}`)).toBeVisible();
  await expect(dashboardPanel.getByTestId(`row-workforce-review-${id}`))
    .toContainText("Review priority: Critical");
  await page.goto("/cases");
  const casesPanel = page.getByTestId("panel-workforce-reviews");
  await expect(casesPanel.getByTestId(`row-workforce-review-${id}`)).toBeVisible();
  await expect(casesPanel.getByTestId(`row-workforce-review-${id}`)).toContainText(reference);
  await casesPanel.getByTestId(`link-review-${id}`).click();
  await expect(page).toHaveURL(new RegExp(`/analytics#review-${id}$`));
  await expect(page.getByTestId(`card-review-${id}`)).toBeVisible();

  // Move to in progress, then resolve with the required explicit outcome.
  await page.getByTestId(`button-edit-review-${id}`).click();
  let editDialog = page.getByRole("dialog", { name: `${reference} - update` });
  await editDialog.getByTestId("select-edit-status").selectOption("in-progress");
  const inProgressResponsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === `/api/workforce-insights/reviews/${id}` &&
    response.request().method() === "PATCH");
  await editDialog.getByTestId("button-save-review").click();
  const inProgressResponse = await inProgressResponsePromise;
  expect(inProgressResponse.status(), await inProgressResponse.text()).toBe(200);
  await expect(page.getByTestId(`card-review-${id}`)).toContainText("In progress");
  await expect(row(page).getByTestId("indicator-not-assessed-talent-risk")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId(`card-review-${id}`)).toContainText("In progress");

  await page.getByTestId(`button-edit-review-${id}`).click();
  editDialog = page.getByRole("dialog", { name: `${reference} - update` });
  await editDialog.getByTestId("select-edit-status").selectOption("resolved");
  await editDialog.getByTestId("input-edit-outcome").fill(outcome);
  const resolvedResponsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === `/api/workforce-insights/reviews/${id}` &&
    response.request().method() === "PATCH");
  await editDialog.getByTestId("button-save-review").click();
  const resolvedResponse = await resolvedResponsePromise;
  expect(resolvedResponse.status(), await resolvedResponse.text()).toBe(200);
  const resolvedSnapshot = await resolvedResponse.json();
  const resolved = resolvedSnapshot.reviews.find((r: any) => r.id === id);
  expect(resolved).toMatchObject({ status: "resolved", outcome });
  expect(resolved.history.length).toBeGreaterThanOrEqual(3);
  expect(resolved.history.some((entry: any) => entry.outcome === outcome)).toBe(true);
  await page.reload();
  await expect(page.getByTestId(`card-review-${id}`)).toContainText("Resolved");
  await expect(page.getByTestId(`card-review-${id}`)).toContainText(`Outcome: ${outcome}`);
  await page.getByTestId(`button-edit-review-${id}`).click();
  editDialog = page.getByRole("dialog", { name: `${reference} - update` });
  await expect(editDialog).toContainText(outcome);
  await expect(editDialog).toContainText("human-review-created");
  await expect(editDialog).toContainText("review-in-progress");
  await expect(editDialog).toContainText("review-resolved");
  await editDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(row(page).getByTestId("indicator-not-assessed-talent-risk")).toBeVisible();
  await expect(row(page).getByTestId("indicator-not-assessed-resume-integrity")).toBeVisible();

  // Resolved reviews must not appear in either open-only panel.
  await page.goto("/");
  await expect(page.getByTestId("panel-workforce-reviews")).toContainText("No open human reviews");
  await expect(page.getByTestId(`row-workforce-review-${id}`)).toHaveCount(0);
  await page.goto("/cases");
  await expect(page.getByTestId("panel-workforce-reviews")).toContainText("No open human reviews");
  await expect(page.getByTestId(`row-workforce-review-${id}`)).toHaveCount(0);
});
