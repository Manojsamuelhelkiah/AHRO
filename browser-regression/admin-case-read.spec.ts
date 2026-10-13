import { expect, test, type Page } from "@playwright/test";

test.skip(process.env.ADMIN_READ_E2E_TEST !== "true", "Requires the isolated admin-read adapter.");
const viewports = [
  { width: 390, height: 844, label: "phone" },
  { width: 768, height: 1024, label: "tablet" },
  { width: 1280, height: 900, label: "desktop" },
];
async function login(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo Reviewer/ }).click();
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByTestId("active-client-name")).toBeVisible();
}
async function session(page: Page, options: Record<string, unknown>) {
  const response = await page.request.post("/api/test/admin-read/session", { data: options });
  expect(response.status()).toBe(200);
  const fixture = await response.json() as { organizationId: string; caseId: number };
  await page.evaluate(org => localStorage.setItem("activeOrganizationId", org), fixture.organizationId);
  return fixture;
}
async function caseResponse(page: Page, fixture: { organizationId: string; caseId: number }, path = "") {
  return page.request.get(`/api/onboarding/cases/${fixture.caseId}${path}`, {
    headers: { "x-organization-id": fixture.organizationId },
  });
}

test("verified administrative permissions agree with real projections while tenant and employee-consent safeguards remain separate", async ({ page }) => {
  await login(page);
  for (const mode of ["development", "private"]) {
    // Proof-mode changes are API assertions, not changes to a mounted case.
    // Stop that case's background polls before switching server fixture mode.
    await page.goto("/api/test/ready");
    const fixture = await session(page, { mode });
    const detail = await caseResponse(page, fixture);
    expect(detail.status(), await detail.text()).toBe(200);
    const body = await detail.json();
    expect(body.workerName).toBe("Confidential Read Fixture");
    expect(body.workerEmail).toBe("fixture@example.invalid");
    expect(body.workerPhone).toBe("+15550000000");
    expect(body.managerName).toBe("Fixture Manager");
    expect(body.recruiterName).toBe("Fixture Recruiter");
    const permissionsResponse = await caseResponse(page, fixture, "/access-permissions");
    expect(permissionsResponse.status()).toBe(200);
    const permissions = await permissionsResponse.json();
    for (const value of Object.values(permissions.sensitive) as { read: boolean; edit: boolean }[]) {
      expect(value).toEqual({ read: true, edit: true });
    }
    const documents = await caseResponse(page, fixture, "/documents");
    expect(documents.status()).toBe(200);
    expect((await documents.json()).some((d: any) => d.note === "Private document note" && !d.restricted)).toBe(true);
    const comms = await caseResponse(page, fixture, "/communications");
    expect(comms.status()).toBe(200);
    expect((await comms.json())[0].body).toBe("Private message body");
    const boundaries = await page.request.get("/api/test/admin-read/boundaries", { timeout: 15_000 });
    expect(boundaries.status()).toBe(200);
    const results = await boundaries.json();
    expect(results.access.identity).toBe(true);
    expect(results.access.edit.identity).toBe(true);
    for (const key of ["wrongCase", "wrongTenant", "wrongActor"]) {
      expect(results[key].identity).toBe(false);
    }
    expect(results.humanDecisionPermission).toBe(true);
    const background = await page.request.get("/api/test/admin-read/background");
    expect((await background.json()).identity).toBe(false);
    const vault = await page.request.post(`/api/onboarding/cases/${fixture.caseId}/employee-vault`, {
      headers: { "x-organization-id": fixture.organizationId,
        origin: `${mode === "private" ? "https" : "http"}://${new URL(page.url()).host}` },
      data: { purpose: "Admin must not request employee consent", expiresAt: new Date(Date.now() + 86400000).toISOString() },
    });
    expect(vault.status()).toBe(409);
    expect((await vault.json()).message).toBe("Completed cases cannot request new disclosure.");

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto(`/cases/${fixture.caseId}`);
      await expect(page.getByRole("heading", { name: "Confidential Read Fixture", exact: true })).toBeVisible();
      await expect(page.getByText("Operational View Restricted", { exact: true })).toHaveCount(0);
      await expect(page.getByText(/Logistics and portal edits are restricted/)).toHaveCount(0);
      await expect(page.getByText(/Some case actions are restricted/)).toHaveCount(0);
      await page.screenshot({ path: `test-results/admin-case-${mode}-${viewport.label}.png` });
      const sizes = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      expect(sizes.scroll).toBeLessThanOrEqual(sizes.width + 1);
    }
    // Provider session/proof failures cannot unlock fields.
    for (const denial of ["expired", "revoked", "wrongSession", "invalid", ...(mode === "private" ? ["rotated"] : [])]) {
      await session(page, { mode, [denial]: true });
      const denied = await caseResponse(page, fixture);
      expect(denied.status()).toBe(403);
    }
    await session(page, { mode: "ordinary" });
    const ordinary = await caseResponse(page, fixture);
    expect(ordinary.status()).toBe(200);
    expect((await ordinary.json()).workerName).toBe("Restricted candidate");
    const ordinaryPermissions = await caseResponse(page, fixture, "/access-permissions");
    expect((await ordinaryPermissions.json()).sensitive.identity).toEqual({ read: false, edit: false });
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto(`/cases/${fixture.caseId}`);
      await expect(page.getByText("Operational View Restricted", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Confidential Read Fixture", exact: true })).toHaveCount(0);
      await page.screenshot({ path: `test-results/ordinary-case-${viewport.label}.png` });
    }
  }
});

test("expiry, renewal, downgrade and delayed privileged data cannot restore protected case content", async ({ page }) => {
  await login(page);
  const fixture = await session(page, { mode: "private" });
  await page.goto(`/cases/${fixture.caseId}`);
  await expect(page.getByRole("heading", { name: "Confidential Read Fixture", exact: true })).toBeVisible();
  await session(page, { mode: "private", short: true });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Confidential Read Fixture", exact: true })).toBeVisible();
  await expect(page.getByTestId("session-access-explanation")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Confidential Read Fixture", exact: true })).toHaveCount(0);
  await session(page, { mode: "private" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: "Confidential Read Fixture", exact: true })).toBeVisible();

  // Hold a genuine privileged response, not a fixture-shaped replacement.
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const ready = new Promise<void>(resolve => { captured = resolve; });
  await page.route(`**/api/onboarding/cases/${fixture.caseId}`, async route => {
    const response = await route.fetch();
    captured();
    await wait;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.evaluate(async id => {
    // Trigger a normal generated-query refetch through window focus.
    window.dispatchEvent(new Event("focus"));
  }, fixture.caseId);
  // A reload starts the held privileged request while keeping the same page realm.
  const navigation = page.goto(`/cases/${fixture.caseId}`, { waitUntil: "domcontentloaded" });
  await ready;
  await session(page, { mode: "ordinary" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  release();
  await navigation;
  await page.unroute(`**/api/onboarding/cases/${fixture.caseId}`);
  await expect(page.getByTestId("session-access-explanation")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Confidential Read Fixture", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expect(page.locator("#login-email")).toBeVisible();
  const loggedOut = await caseResponse(page, fixture);
  expect(loggedOut.status()).toBe(401);
});
