import { expect, test, type Page } from "@playwright/test";

test.skip(process.env.ADMIN_READ_E2E_TEST !== "true", "Requires isolated administrator proof/provider fixtures.");
async function login(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo Reviewer/ }).click();
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByTestId("active-client-name")).toBeVisible();
}
async function admin(page: Page, mode: string, options: Record<string, unknown> = {}) {
  const response = await page.request.post("/api/test/admin-read/session", { data: { mode, ...options } });
  expect(response.ok()).toBeTruthy();
  const fixture = await response.json();
  await page.evaluate(org => localStorage.setItem("activeOrganizationId", org), fixture.organizationId);
  return fixture;
}
test("verified administrator intake navigation, focus, reload and denial guidance are stable and read-only", async ({ page }) => {
  await login(page);
  for (const mode of ["development", "private"]) {
    const fixture = await admin(page, mode);
    for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      await page.goto("/email-intake");
      await expect(page.getByTestId("section-readiness")).toBeVisible();
      await expect(page.getByTestId("current-session-access")).toContainText("Administrator access verified");
      await expect(page.getByText("No route exists yet.", { exact: false })).toBeVisible();
      for (let navigation = 0; navigation < 3; navigation++) {
        // Sidebar links stay off-canvas on small screens. Native anchor clicks
        // exercise the same SPA handler without turning this into reload-only coverage.
        await page.evaluate(() => (document.querySelector('a[href="/cases"]') as HTMLAnchorElement).click());
        await expect(page.getByRole("heading", { name: "HR Operations Cases", exact: true })).toBeVisible();
        await page.evaluate(() => (document.querySelector('a[href="/email-intake"]') as HTMLAnchorElement).click());
        await expect(page.getByTestId("section-readiness")).toBeVisible();
        const concurrent = await Promise.all(["", "/requests"].map(path => page.request.get(`/api/onboarding/email-intake${path}`, {
          headers: { "x-organization-id": fixture.organizationId },
        })));
        for (const result of concurrent) expect(result.status(), await result.text()).toBe(200);
      }
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.getByTestId("section-readiness")).toBeVisible();
      await page.reload();
      await expect(page.getByTestId("section-readiness")).toBeVisible();
      await expect(page.getByTestId("section-routes").getByText("No route exists yet.", { exact: false })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
    }
    // Server denial removes the whole privileged subtree and does not keep
    // retrying queue/source requests, even if a successful readiness was cached.
    await admin(page, mode, { revoked: true });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("session-access-explanation")).toBeVisible();
    await expect(page.getByTestId("section-readiness")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out / sign in again" })).toBeVisible();
    await admin(page, mode);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("section-readiness")).toBeVisible();
    await admin(page, mode, { expired: true });
    await page.reload();
    await expect(page.getByTestId("session-access-explanation")).toContainText("expired");
    await expect(page.getByTestId("section-readiness")).toHaveCount(0);
  }
});

test("public Demo intake and denied deep links show actionable guidance without fetching private queues", async ({ page }) => {
  await login(page); // genuine restricted Demo fixture, not an admin-proof adapter identity
  let privateReads = 0;
  page.on("request", request => {
    if (/\/email-intake\/(?:requests|triage)/.test(request.url())) privateReads++;
  });
  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/email-intake");
    await expect(page.getByTestId("session-access-explanation")).toContainText("Public Demo");
    await expect(page.getByTestId("session-access-explanation")).toContainText("Account initials");
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    await page.goto("/email-intake/00000000-0000-0000-0000-000000000000");
    await expect(page.getByTestId("session-access-explanation")).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
  }
  expect(privateReads).toBe(0);
});

test("headerless reads, background refresh and tenant switching preserve live administrator access", async ({ page }) => {
  await login(page);
  const fixture = await admin(page, "development");
  await page.clock.install();
  let headerless = 0;
  await page.route("**/api/onboarding/email-intake", async route => {
    const response = await route.fetch();
    const headers = response.headers();
    delete headers["x-platform-admin-expires-at"];
    headerless++;
    await route.fulfill({ response, headers });
  });
  await page.goto("/email-intake");
  await expect(page.getByTestId("section-readiness")).toBeVisible();
  const initial = headerless;
  // Observe the actual timer, not an artificial focus event or API-only read.
  await page.clock.fastForward(60_001);
  await expect.poll(() => headerless, { timeout: 20_000 }).toBeGreaterThan(initial);
  await expect(page.getByTestId("current-session-access")).toContainText("Administrator access verified");
  await expect(page.getByTestId("section-readiness")).toBeVisible();

  await page.getByLabel("Active client workspace").selectOption({ label: "Demo Organization" });
  await expect(page.getByTestId("active-client-name")).toHaveText("Demo Organization");
  await expect(page.getByTestId("section-readiness")).toBeVisible();
  await page.getByLabel("Active client workspace").selectOption(fixture.organizationId);
  await expect(page.getByTestId("section-readiness")).toBeVisible();
  await expect(page.getByTestId("current-session-access")).toContainText("Administrator access verified");
  const missing = await page.request.get("/api/onboarding/email-intake", { headers: { "x-organization-id": "missing-client" } });
  expect(missing.status()).toBe(403);
});
