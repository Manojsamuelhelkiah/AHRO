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
  await page.getByRole("button", { name: email === ADMIN_EMAIL ? /Super Admin/ : /Demo Reviewer/ }).click();
  if (email === ADMIN_EMAIL) {
    // The isolated test server supplies only a restricted Demo identity.
    // This non-secret input satisfies form validation, not real Super Admin
    // authentication, provider MFA, or a private platform grant.
    await page.locator("#login-password").fill(`browser-harness-only-${Date.now()}`);
  }
  await page.getByRole("button", { name: "Sign In" }).click();
  // The desktop brand is intentionally hidden on phones. A visible, resolved
  // tenant identity proves signed-in workspace entry at every viewport.
  await expect(page.getByTestId("active-client-name")).toHaveText("Demo Organization");
  await expect(page.locator("#login-email")).toHaveCount(0);
}

test("Client Setup recovers scoped legacy drafts without guessing unsupported choices", async ({
  page,
}) => {
  await signInDemo(page, ADMIN_EMAIL);

  const legacyDraft = {
    clientName: "Legacy Browser Client",
    sector: "Technology",
    employees: 2400,
    countries: 4,
    annualTransactions: 120000,
    companyType: "multi-country",
    isolationTier: "siloed",
    landscapeMaturity: "mixed",
    hrHourlyCostUsd: 52,
    hitlHourlyCostUsd: 68,
    processMode: "recommended",
    selectedDomains: ["Hire", "Pay", "Leave"],
    processFiles: [],
    personas: [
      { role: "Implementation lead", name: "Avery Chen", email: "avery.chen@example.com" },
    ],
    systems: [
      {
        domain: "Intake",
        name: "Greenhouse",
        vendor: "Greenhouse",
        mode: "API",
        ownerEmail: "ats@example.com",
      },
      {
        domain: "Learning",
        name: "Cornerstone",
        vendor: "Cornerstone",
        mode: "Flat File",
        ownerEmail: "lms@example.com",
      },
      {
        domain: "Mainframe Mystery",
        name: "Legacy",
        vendor: "Internal",
        mode: "Carrier Pigeon",
        ownerEmail: "",
      },
    ],
    notes: "Recovered from a pre-v2 browser draft.",
  };
  const adminDemoKey = "clientSetupDraft:v2:browser-e2e-administrator:demo";
  const adminOtherTenantKey = "clientSetupDraft:v2:browser-e2e-administrator:other-tenant";

  await page.evaluate(
    ({ draft, currentKey, otherTenantKey }) => {
      localStorage.setItem(currentKey, JSON.stringify(draft));
      localStorage.setItem(
        otherTenantKey,
        JSON.stringify({ ...draft, clientName: "Other Tenant Secret" }),
      );
      localStorage.setItem("activeOrganizationId", "demo");
    },
    { draft: legacyDraft, currentKey: adminDemoKey, otherTenantKey: adminOtherTenantKey },
  );

  await page.goto("/client-setup");
  await expect(page.getByRole("heading", { name: "Implementation Cockpit" })).toBeVisible();
  await expect(page.getByPlaceholder("e.g. Acme Corp")).toHaveValue("Legacy Browser Client");

  await page.getByRole("button", { name: /Next Step/ }).click();
  await expect(page.getByText("Source Systems Integration")).toBeVisible();

  const systemTypes = page.locator('select[name$=".key"]');
  const connectionModes = page.locator('select[name$=".mode"]');
  await expect(systemTypes).toHaveCount(3);
  await expect(connectionModes).toHaveCount(3);
  await expect(systemTypes.nth(0)).toHaveValue("ats");
  await expect(connectionModes.nth(0)).toHaveValue("direct-integration");
  await expect(systemTypes.nth(1)).toHaveValue("lms");
  await expect(connectionModes.nth(1)).toHaveValue("file-transfer");
  await expect(systemTypes.nth(2)).toHaveValue("");
  await expect(connectionModes.nth(2)).toHaveValue("");
  await expect(systemTypes.nth(2).locator("option:checked")).toHaveText("Choose a system type");
  await expect(connectionModes.nth(2).locator("option:checked")).toHaveText(
    "Choose a connection method",
  );

  await page.getByRole("button", { name: /Next Step/ }).click();
  await expect(page.getByText("Source Systems Integration")).toBeVisible();
  await expect(page.getByText("Process Adoption Mode")).toHaveCount(0);

  await page.getByTitle("Sign out").click();
  await expect(page.locator("#login-email")).toBeVisible();
  await signInDemo(page, REVIEWER_EMAIL);
  await page.goto("/client-setup");
  await expect(page.getByRole("heading", { name: "Implementation Cockpit" })).toBeVisible();
  await expect(page.getByPlaceholder("e.g. Acme Corp")).toHaveValue(
    "Northstar Global Services — Synthetic Demo",
  );
  await expect(page.getByPlaceholder("e.g. Acme Corp")).not.toHaveValue("Legacy Browser Client");
  await expect(page.getByPlaceholder("e.g. Acme Corp")).not.toHaveValue("Other Tenant Secret");
});

async function createOfflineCase(page: Page) {
  const submittedWorkerName = `Browser Regression Worker ${Date.now()}`;
  await page.goto("/cases");
  await expect(page.getByRole("button", { name: "New Case" })).toBeVisible();
  await page.getByRole("button", { name: "New Case" }).click();
  await expect(page.getByRole("heading", { name: "New Case", exact: true })).toBeVisible();

  await page.locator("#workerName").fill(submittedWorkerName);
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
  const caseId = Number(new URL(page.url()).pathname.split("/").pop());
  const created = await page.evaluate(async (id) => {
    const response = await fetch(`/api/onboarding/cases/${id}`, { credentials: "include" });
    if (!response.ok) throw new Error(`case read failed: ${response.status}`);
    return response.json();
  }, caseId);
  expect(created.workerName).toMatch(/^Fictional Demo Hire /);
  expect(created.workerName).not.toBe(submittedWorkerName);
  expect(created.workerEmail).toMatch(/^fictional-demo-[a-f0-9]+@example\.invalid$/);
  return {
    caseId,
    workerName: created.workerName as string,
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
  const privacyHoldRequests: string[] = [];
  const browserErrors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!["http:", "https:"].includes(url.protocol)) return;
    if (url.origin !== "http://127.0.0.1:4177") externalRequests.push(request.url());
    if (url.pathname === "/api/privacy/lifecycle/holds") privacyHoldRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await signInDemo(page, ADMIN_EMAIL);
  const fixture = await createOfflineCase(page);
  await expect(page.getByText("Restricted for offline samples")).toBeVisible();
  await expect(page.getByText("Could not load holds", { exact: false })).toHaveCount(0);

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
  expect(privacyHoldRequests, "offline case pages must not request privacy holds").toEqual([]);
  expect(
    browserErrors.filter((message) => /privacy|hold|403/i.test(message)),
    "offline case pages must not log privacy authorization errors",
  ).toEqual([]);
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
  // A shared low-access reviewer has no explicit case-read grant. The new
  // governance policy denies the whole case, rather than exposing a partial
  // operational view solely because the case belongs to Demo Organization.
  await expect(reviewerPage.getByRole("heading", { name: "Case access restricted" })).toBeVisible();
  await expect(reviewerPage.getByText("Service-case synopsis", { exact: false })).toHaveCount(0);
  await expect(reviewerPage.getByRole("button", { name: "Communications", exact: true })).toHaveCount(0);
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

test("retired URLs and stale outreach requests are unavailable", async ({ page }) => {
  await signInDemo(page, ADMIN_EMAIL);
  const fixture = await createOfflineCase(page);
  const results = await page.evaluate(async (caseId) => {
    const requests = [
      ["GET", "/api/onboarding/demo-controller"],
      ["POST", "/api/onboarding/demo-runs"],
      ["POST", "/api/onboarding/demo-runs/00000000-0000-4000-8000-000000000000/actions"],
      ["POST", "/api/organizations/demo-controller-setup/request"],
      ["POST", "/api/organizations/demo-controller-setup/complete"],
      ["PUT", "/api/onboarding/demo/volunteers"],
      ["POST", `/api/onboarding/cases/${caseId}/simulation/send-email`],
    ];
    return Promise.all(requests.map(async ([method, path]) => {
      const response = await fetch(path, { method, credentials: "include",
        headers: { "Content-Type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({ kind: "communication", mode: "live" }) }) });
      return response.status;
    }));
  }, fixture.caseId);
  expect(results).toEqual(results.map(() => 404));
  await page.goto("/demo-controller");
  await expect(page.getByRole("heading", { name: /404|not found/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Demo Center", exact: true })).toHaveCount(0);
  await page.goto("/demo-controller/retained-run");
  await expect(page.getByRole("heading", { name: /404|not found/i })).toBeVisible();
  await page.goto("/cases");
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("link", { name: "Demo Center", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Learning Guide", exact: true })).toBeVisible();
    await test.info().attach(`remaining-navigation-${width}`, {
      body: await page.screenshot(), contentType: "image/png",
    });
  }
});