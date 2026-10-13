import { expect, test } from "@playwright/test";

test("retired deep links retain fresh UAT admission, tenant isolation and history without execution", async ({ page, context }) => {
  // Secure admission cookies must use Chromium's loopback transport.
  const api = {
    async request(path: string, method = "GET", options: { headers?: Record<string, string>; data?: unknown } = {}) {
      return page.evaluate(async ({ path, method, options }) => {
        const response = await fetch(path, {
          method, credentials: "include", headers: { ...options.headers, ...(options.data ? { "content-type": "application/json" } : {}) },
          ...(options.data ? { body: JSON.stringify(options.data) } : {}),
        });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
      }, { path, method, options });
    },
    get(path: string, options?: { headers?: Record<string, string> }) { return this.request(path, "GET", options); },
    post(path: string, options?: { headers?: Record<string, string>; data?: unknown }) { return this.request(path, "POST", options); },
  };
  await page.goto("/uat/fairness");
  await expect(page.getByRole("heading", { name: "Sign in to UAT", exact: true })).toBeVisible();
  expect((await api.get("/uat/api/onboarding/uat")).status).toBe(401);
  const ticket = await api.post("/uat/api/onboarding/demo-login", { data: { email: "demo.reviewer@example.com" } });
  await api.post("/uat/api/test/auth/finalize", { data: { ticket: ticket.body.ticket } });
  await page.reload();
  await expect(page.getByTestId("button-start-uat-sign-in")).toHaveText("End shared session and sign in fresh");
  expect((await api.get("/uat/api/onboarding/uat")).status).toBe(401);
  const headers = { Origin: "http://127.0.0.1:4179" };
  await api.post("/uat/api/uat-auth/challenge", { headers });
  expect((await api.post("/uat/api/uat-auth/admission", { headers })).status).toBe(401);
  await page.getByTestId("button-start-uat-sign-in").click();
  await page.getByRole("button", { name: "Complete test credential" }).click();
  await page.getByRole("heading", { name: "Choose a workspace" }).waitFor();
  await page.locator('[data-testid^="button-workspace-"]').first().click();
  await expect(page.getByRole("heading", { name: "Historical evaluation evidence" })).toBeVisible();
  expect((await api.get("/uat/api/onboarding/uat", { headers: { "x-organization-id": "other-workspace" } })).status).toBe(403);
  const before = (await api.get("/uat/api/onboarding/uat")).body;
  expect(before.scenarios).toEqual([]);
  for (const path of [
    "/onboarding/uat/runs", "/onboarding/uat/runs/old/actions",
    "/onboarding/uat/fairness/actions", "/policies/evaluation/runs",
    "/policies/evaluation/review", "/policies/evaluation/drift",
  ]) {
    const result = await api.post(`/uat/api${path}`, { data: { mode: "live", kind: "run", expectedVersion: 0 } });
    expect(result.status, path).toBe(410);
    expect(result.body.code).toBe("CASE_TEST_CAPABILITY_RETIRED");
  }
  expect((await api.get("/uat/api/onboarding/uat/runs/old/fixture-pack")).status).toBe(410);
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, heading] of [
      ["/uat/?scenario=UAT-STD-01&run=old", "Acceptance history"],
      ["/uat/policy-quality", "Policy governance"],
      ["/uat/fairness", "Historical evaluation evidence"],
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /Start run|Run evaluation|Advance.*clock|Download fixtures|Reset/i })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.goto("/uat/");
  const other = await context.newPage();
  await other.goto("/uat/");
  await expect(other.getByRole("heading", { name: "Acceptance history", exact: true })).toBeVisible();
  await other.evaluate(() => localStorage.setItem("activeOrganizationId", "not-a-uat-workspace"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Acceptance history", exact: true })).toBeVisible();
  // Protected UI exits immediately, before asynchronous server revocation.
  // Test access only after that revocation completes, not a racing read.
  const revocation = page.waitForResponse(response =>
    response.url().endsWith("/uat/api/uat-auth/admission") && response.request().method() === "DELETE");
  await page.getByTestId("button-uat-logout").click();
  expect((await revocation).status()).toBe(204);
  await expect(page.getByRole("heading", { name: "Sign in to UAT", exact: true })).toBeVisible();
  await expect(other.getByRole("heading", { name: "Sign in to UAT", exact: true })).toBeVisible();
  expect((await api.get("/uat/api/onboarding/uat/fairness/evidence-report")).status).toBe(401);
  expect((await api.get("/uat/api/policies/capabilities")).status).toBe(200);
  await page.getByTestId("button-start-uat-sign-in").click();
  await page.getByRole("button", { name: "Complete test credential" }).click();
  await page.locator('[data-testid^="button-workspace-"]').first().click();
  await expect(page.getByRole("heading", { name: "Acceptance history", exact: true })).toBeVisible();
  const after = (await api.get("/uat/api/onboarding/uat")).body;
  expect(after.runs.map((r: { runId: string }) => r.runId)).toEqual(before.runs.map((r: { runId: string }) => r.runId));
  await api.post("/uat/api/test/uat-expire");
  await page.goto("/uat/policy-quality");
  await expect(page.getByRole("heading", { name: "Sign in to UAT", exact: true })).toBeVisible();
  await other.close();
});
