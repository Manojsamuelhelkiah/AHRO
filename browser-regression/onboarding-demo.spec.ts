import { expect, test, type Page } from "@playwright/test";

const ADMIN_EMAIL = "demo.admin@example.com";
const REVIEWER_EMAIL = "demo.reviewer@example.com";
const VIEWPORTS = [
  { width: 390, height: 844, label: "phone" },
  { width: 768, height: 1024, label: "tablet" },
  { width: 1280, height: 900, label: "desktop" },
];

async function assertUsableCaseControls(page: Page, label: string) {
  await expect(page.getByRole("heading", { name: "Response-Driven Simulation" })).toBeVisible();
  const simulate = page.getByRole("button", { name: "Simulate next exchange" });
  await simulate.scrollIntoViewIfNeeded();
  await expect(simulate).toBeVisible();
  await expect(simulate).toBeEnabled();
  const box = await simulate.boundingBox();
  expect(box, `${label}: simulation control should have a layout box`).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);

  // The tab strip is intentionally horizontally scrollable on a phone. Scroll
  // each required tab into view before checking its actual clickable bounds.
  for (const tabName of ["Activity", "Communications"]) {
    const tab = page.getByRole("button", { name: tabName, exact: true });
    await tab.scrollIntoViewIfNeeded();
    await expect(tab).toBeVisible();
    await expect(tab).toBeEnabled();
    const tabBox = await tab.boundingBox();
    expect(tabBox, `${label}: ${tabName} tab should have a layout box`).not.toBeNull();
    expect(tabBox!.x).toBeGreaterThanOrEqual(0);
    expect(tabBox!.x + tabBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }

  const overflow = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(overflow.documentWidth).toBeLessThanOrEqual(
    overflow.viewportWidth + 1,
  );
}

async function signInDemo(page: Page, email: string) {
  await page.goto("/");
  await expect(page.locator("#login-email")).toBeVisible();
  await page.getByRole("button", { name: /Demo (Administrator|Reviewer)/ }).filter({
    hasText: email === ADMIN_EMAIL ? "Demo Administrator" : "Demo Reviewer",
  }).click();
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page.getByText("Agentic HRO Suite").first()).toBeVisible();
  await expect(page.locator("#login-email")).toHaveCount(0);
}

async function createOfflineCase(page: Page) {
  const workerName = `Browser Regression Worker ${Date.now()}`;
  await page.goto("/cases");
  await expect(page.getByRole("button", { name: "New Case" })).toBeVisible();
  await page.getByRole("button", { name: "New Case" }).click();
  await expect(page.getByRole("heading", { name: "New Case", exact: true })).toBeVisible();

  await page.locator("#workerName").fill(workerName);
  await page.locator("#workerEmail").fill(`browser-${Date.now()}@example.invalid`);
  await page.locator("#role").fill("Demo Engineer");
  await page.locator("#department").fill("Quality");
  await page.locator("#geography").fill("US");
  await page.locator("#legalEntity").fill("Demo Organization");
  await page.locator("#joiningDate").fill("2035-01-01");
  await page.locator("#managerName").fill("Demo Manager");
  await page.locator("#recruiterName").fill("Demo Recruiter");
  await page.locator('input[name="workCountry"]').fill("US");
  await page.locator('select[name="workEnvironment"]').selectOption("office");
  await page.getByRole("button", { name: "Create Offline Synthetic Case" }).click();

  await expect(page).toHaveURL(/\/cases\/\d+$/);
  await expect(page.getByText("Simulated/manual sample only.", { exact: false })).toBeVisible();
  return {
    caseId: Number(new URL(page.url()).pathname.split("/").pop()),
    workerName,
  };
}

async function assertNoExternalRequests(page: Page, requests: string[]) {
  const staticFontRequests = requests.filter((url) => {
    const origin = new URL(url).origin;
    return origin === "https://fonts.googleapis.com" || origin === "https://fonts.gstatic.com";
  });
  const nonStaticExternalRequests = requests.filter((url) => !staticFontRequests.includes(url));
  expect(
    nonStaticExternalRequests,
    "the browser must not contact an external provider or Clerk",
  ).toEqual([]);
  const state = await page.evaluate(async (caseId) => {
    const response = await fetch(`/api/test/fixture-state/${caseId}`, {
      credentials: "include",
    });
    if (!response.ok) throw new Error(`fixture-state failed: ${response.status}`);
    return response.json();
  }, Number(new URL(page.url()).pathname.split("/").pop()));
  expect(state).toMatchObject({
    simulatedEvents: 1,
    simulatedCommunications: 1,
    providerEffects: 0,
    providerBoundary: "deny-external-providers",
  });
}

test("Demo Administrator creates and durably simulates one offline case", async ({
  browser,
  page,
}) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!["http:", "https:"].includes(url.protocol)) return;
    if (url.origin !== "http://127.0.0.1:4177") externalRequests.push(request.url());
  });

  await signInDemo(page, ADMIN_EMAIL);
  const fixture = await createOfflineCase(page);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.reload();
    await assertUsableCaseControls(page, viewport.label);
  }

  const simulate = page.getByRole("button", { name: "Simulate next exchange" });
  await simulate.click();
  await expect(page.getByText("Simulated Outbound", { exact: false })).toHaveCount(1);
  await expect(page.getByText("Simulated Inbound", { exact: false })).toHaveCount(1);

  await page.reload();
  await expect(page.getByText(fixture.workerName, { exact: false })).toBeVisible();
  await expect(page.getByText("Simulated Outbound", { exact: false })).toHaveCount(1);
  await expect(page.getByText("Simulated Inbound", { exact: false })).toHaveCount(1);
  await expect(page.getByText("Response-Driven Simulation")).toBeVisible();

  await page.getByRole("button", { name: "Communications", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Communication History" })).toBeVisible();
  await expect(page.getByText("[SIMULATED]", { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Operational Timeline" })).toBeVisible();
  await expect(page.getByText("[SIMULATED]", { exact: false }).first()).toBeVisible();

  // Confirm the same persisted case through the harness's DB-backed
  // observation endpoint. The create/simulation/read requests above all hit
  // the real API router; this endpoint only counts owned durable effects.
  await assertNoExternalRequests(page, externalRequests);
  expect(fixture.caseId).toBeGreaterThan(0);

  const reviewer = await browser.newContext({ viewport: VIEWPORTS[0] });
  const reviewerPage = await reviewer.newPage();
  const reviewerExternalRequests: string[] = [];
  reviewerPage.on("request", (request) => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== "http://127.0.0.1:4177") {
      reviewerExternalRequests.push(request.url());
    }
  });
  await signInDemo(reviewerPage, REVIEWER_EMAIL);
  await reviewerPage.goto(`/cases/${fixture.caseId}`);
  await expect(reviewerPage.getByText("Service-case synopsis", { exact: false })).toBeVisible();
  await reviewerPage.getByRole("button", { name: "Communications", exact: true }).click();
  await expect(
    reviewerPage.getByText("Details are restricted to the assigned specialist.", { exact: false }).first(),
  ).toBeVisible();
  await reviewerPage.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(
    reviewerPage.getByText("Restricted confidential onboarding record", { exact: false }).first(),
  ).toBeVisible();
  await expect(reviewerPage.getByRole("heading", { name: "Response-Driven Simulation" })).toHaveCount(0);
  await expect(reviewerPage.getByRole("button", { name: "Simulate next exchange" })).toHaveCount(0);
  expect(
    reviewerExternalRequests.filter((url) => {
      const origin = new URL(url).origin;
      return origin !== "https://fonts.googleapis.com" && origin !== "https://fonts.gstatic.com";
    }),
  ).toEqual([]);
  await reviewer.close();
});