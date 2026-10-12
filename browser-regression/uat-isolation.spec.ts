import { expect, test } from "@playwright/test";

test("separate admission, deep links, saved synthetic evidence, expiry and tab isolation", async ({ page, context }) => {
  // Chromium accepts Secure cookies on loopback; the APIRequestContext cookie
  // transport does not. Use the actual browser's cookie transport throughout.
  const api = {
    async request(path: string, method = "GET", options: { headers?: Record<string, string>; data?: unknown } = {}) {
      const result = await page.evaluate(async ({ path, method, options }) => {
        const response = await fetch(path, {
          method, credentials: "include", headers: { ...options.headers, ...(options.data ? { "content-type": "application/json" } : {}) },
          ...(options.data ? { body: JSON.stringify(options.data) } : {}),
        });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
      }, { path, method, options });
      return { status: () => result.status, json: async () => result.body };
    },
    get(path: string, options?: { headers?: Record<string, string> }) { return this.request(path, "GET", options); },
    post(path: string, options?: { headers?: Record<string, string>; data?: unknown }) { return this.request(path, "POST", options); },
  };
  await page.goto("/uat/fairness");
  await expect(page.getByRole("heading", { name: "Sign in to UAT", exact: true })).toBeVisible();
  expect((await api.get("/uat/api/onboarding/uat")).status()).toBe(401);
  // A genuine Control Tower session adapter (ticket strategy) must not admit.
  const ticket = await api.post("/uat/api/onboarding/demo-login", { data: { email: "demo.reviewer@example.com" } });
  const { ticket: value } = await ticket.json();
  await api.post("/uat/api/test/auth/finalize", { data: { ticket: value } });
  await page.reload();
  await expect(page.getByTestId("button-start-uat-sign-in")).toHaveText("End shared session and sign in fresh");
  expect((await api.get("/uat/api/onboarding/uat")).status()).toBe(401);
  const sameOrigin = { Origin: "http://127.0.0.1:4179" };
  await api.post("/uat/api/uat-auth/challenge", { headers: sameOrigin });
  expect((await api.post("/uat/api/uat-auth/admission", { headers: sameOrigin })).status()).toBe(401);

  await page.getByTestId("button-start-uat-sign-in").click();
  await page.getByRole("button", { name: "Complete test credential" }).click();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.locator('[data-testid^="button-workspace-"]').first().click();
  await expect(page.getByRole("heading", { name: "Synthetic fairness evaluation" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Synthetic fairness evaluation" })).toBeVisible();
  expect((await api.get("/uat/api/onboarding/uat")).status()).toBe(200);
  expect((await api.get("/uat/api/onboarding/uat", { headers: { "x-organization-id": "other-workspace" } })).status()).toBe(403);
  const catalog = await (await api.get("/uat/api/onboarding/uat")).json();
  expect(catalog.scenarios.length).toBeGreaterThan(0);
  await page.goto("/uat/");
  await expect(page.getByRole("heading", { name: "UAT Test Center", exact: true })).toBeVisible();
  await page.getByTestId("button-select-uat-UAT-STD-01").click();
  await page.getByTestId("button-start-uat-run").click();
  await expect(page.getByTestId("button-pause-uat")).toBeVisible();
  const runId = new URL(page.url()).searchParams.get("run")!;
  await page.getByTestId("button-pause-uat").click();
  await expect(page.getByTestId("button-resume-uat")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("button-resume-uat")).toBeVisible();
  await page.getByTestId("button-resume-uat").click();
  for (const testId of ["button-download-uat-fixtures", "button-export-uat-evidence"]) {
    const download = page.waitForEvent("download");
    await page.getByTestId(testId).click();
    expect((await download).suggestedFilename()).toContain(runId);
  }
  await page.getByTestId("input-uat-hours").fill("1");
  await page.getByTestId("button-advance-uat-clock").click();
  await expect(page.getByText("+1h", { exact: false }).first()).toBeVisible();
  const before = await (await api.get("/uat/api/onboarding/uat")).json();
  await page.goto("/uat/");

  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    const oversized = await page.evaluate(() => [...document.querySelectorAll("body *")].filter(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.right > window.innerWidth && !element.closest("nav") && !element.closest("[class*='overflow']");
    }).slice(0, 8).map(element => `${element.tagName}.${element.className} ${element.getBoundingClientRect().width}`));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), oversized.join("\n")).toBe(true);
    await page.goto("/uat/policy-quality");
    await expect(page.getByRole("heading", { name: "Policy answer-quality benchmarks" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.goto("/uat/fairness");
    await expect(page.getByRole("heading", { name: "Synthetic fairness evaluation" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.goto("/uat/");
  }
  const other = await context.newPage();
  await other.goto("/uat/");
  await expect(other.getByRole("heading", { name: "UAT Test Center", exact: true })).toBeVisible();
  await other.evaluate(() => localStorage.setItem("activeOrganizationId", "not-a-uat-workspace"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "UAT Test Center", exact: true })).toBeVisible();
  await page.getByTestId("button-uat-logout").click();
  await expect(page.getByRole("heading", { name: "Sign in to UAT", exact: true })).toBeVisible();
  await expect(other.getByRole("heading", { name: "Sign in to UAT", exact: true })).toBeVisible();
  expect((await api.get("/uat/api/onboarding/uat/fairness/evidence-report")).status()).toBe(401);
  expect((await api.get("/uat/api/policies/capabilities")).status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in to UAT", exact: true })).toBeVisible();
  // Re-admission uses a fresh credential; existing runs remain intact.
  await page.getByTestId("button-start-uat-sign-in").click();
  await page.getByRole("button", { name: "Complete test credential" }).click();
  await page.locator('[data-testid^="button-workspace-"]').first().click();
  await expect(page.getByRole("heading", { name: "UAT Test Center", exact: true })).toBeVisible();
  const after = await (await api.get("/uat/api/onboarding/uat")).json();
  expect(after.runs.map((r: { runId: string }) => r.runId)).toEqual(before.runs.map((r: { runId: string }) => r.runId));
  await api.post("/uat/api/test/uat-expire");
  await page.goto("/uat/policy-quality");
  await expect(page.getByRole("heading", { name: "Sign in to UAT", exact: true })).toBeVisible();
  expect((await api.get("/uat/api/policies/evaluation")).status()).toBe(401);
});
