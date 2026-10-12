import { expect, test, type Page } from "@playwright/test";

test.skip(process.env.ADMIN_READ_E2E_TEST !== "true", "Requires the isolated non-demo/admin fixture.");

async function storedWorkspace(page: Page) {
  return page.evaluate(() => localStorage.getItem("activeOrganizationId"));
}
async function noOverflow(page: Page) {
  const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
}

test("client workspace header and setup preserve tenant scope across keyboard navigation, entry and denial", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo Reviewer/ }).click();
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByTestId("active-client-name")).toBeVisible();
  const demoCreate = await page.request.post("/api/organizations", {
    data: { name: "Forbidden demo fixture", primaryCountry: "US" },
  });
  expect(demoCreate.status()).toBe(403);

  const session = await page.request.post("/api/test/admin-read/session", { data: { mode: "ordinary" } });
  expect(session.ok()).toBeTruthy();
  const fixture = await session.json() as { organizationId: string };
  await page.evaluate(org => localStorage.setItem("activeOrganizationId", org), fixture.organizationId);
  await page.goto("/settings");
  const selector = page.getByRole("combobox", { name: "Active client workspace" });
  await expect(selector).toBeVisible();
  await expect(selector.locator("option")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Organizations", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("link-create-client-workspace")).toBeVisible();
  await expect(page.getByTestId("link-join-client-workspace")).toBeVisible();
  await expect(page.getByTestId("button-create-client")).toHaveCount(0);

  for (const viewport of [
    { width: 390, height: 844, label: "phone" },
    { width: 768, height: 1024, label: "tablet" },
    { width: 1280, height: 900, label: "desktop" },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/settings");
    await expect(selector).toBeVisible();
    await noOverflow(page);
    for (const mode of ["create", "join"] as const) {
      const link = page.getByTestId(`link-${mode}-client-workspace`);
      await link.focus();
      await expect(link).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`organizationAction=${mode}`));
      await expect(page.getByRole("heading", { name: `${mode === "create" ? "Create" : "Join"} client workspace`, exact: true })).toBeVisible();
      await expect(page.locator('button[aria-pressed="true"]')).toHaveText(`${mode === "create" ? "Create" : "Join"} client workspace`);
      expect(await storedWorkspace(page)).toBe(fixture.organizationId);
      await noOverflow(page);
      const field = page.getByRole("textbox", { name: mode === "create" ? "Client workspace name" : "Client workspace join code", exact: true });
      await field.focus();
      await expect(field).toBeFocused();
      await page.screenshot({ path: `test-results/client-workspace-${mode}-${viewport.label}.png` });
      await page.goBack();
      await expect(selector).toHaveValue(fixture.organizationId);
    }
  }

  // Real rejected join must not move the selector or page request scope.
  await page.getByTestId("link-join-client-workspace").click();
  await page.getByRole("textbox", { name: "Client workspace join code", exact: true }).fill("INVALID-CODE");
  await page.getByRole("button", { name: "Join client workspace", exact: true }).last().click();
  await expect(page.getByRole("alert").filter({ hasText: "Organization join code was not found" })).toBeVisible();
  expect(await storedWorkspace(page)).toBe(fixture.organizationId);

  // Creation retains the owner-only code recovery screen until explicit entry.
  await page.goto("/client-setup?organizationAction=create");
  const name = `Fictional navigation ${Date.now()}`;
  await page.getByRole("textbox", { name: "Client workspace name", exact: true }).fill(name);
  await page.getByRole("textbox", { name: /Primary country/ }).fill("US");
  await page.getByRole("button", { name: "Create client workspace", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Save your client workspace join code" })).toBeVisible();
  const code = await page.getByRole("textbox", { name: "One-time client workspace join code" }).inputValue();
  expect(code).not.toBe("");
  expect(await storedWorkspace(page)).toBe(fixture.organizationId);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "One-time client workspace join code" })).toHaveValue(code);
  await page.getByRole("button", { name: "I’ve saved the code — Continue" }).click();
  await expect(page.getByTestId("active-client-name")).toHaveText(name);
  const createdId = await storedWorkspace(page);
  expect(createdId).not.toBe(fixture.organizationId);
  await expect(selector.locator("option")).toHaveCount(2);

  // Validate denial from the actual switcher while the new tenant remains pinned.
  await page.route("**/api/organizations/current", async route => {
    if (route.request().headers()["x-organization-id"] === fixture.organizationId) {
      await route.fulfill({ json: {
        needsSetup: false, activeOrganizationId: null,
        memberships: [{ organizationId: createdId, name, role: "owner" }],
      } });
    } else await route.continue();
  });
  await selector.selectOption(fixture.organizationId);
  await expect(page.getByRole("alert").filter({ hasText: "no longer have access" })).toBeVisible();
  await expect(selector).toHaveValue(createdId!);
  expect(await storedWorkspace(page)).toBe(createdId);
  await page.unroute("**/api/organizations/current");
  await selector.selectOption(fixture.organizationId);
  await expect(selector).toHaveValue(fixture.organizationId);
  expect(await storedWorkspace(page)).toBe(fixture.organizationId);
  // Joining an accessible workspace still uses the existing join and reload path.
  await page.getByTestId("link-join-client-workspace").click();
  await page.getByRole("textbox", { name: "Client workspace join code", exact: true }).fill(code);
  await page.getByRole("button", { name: "Join client workspace", exact: true }).last().click();
  await expect(page.getByTestId("active-client-name")).toHaveText(name);
  expect(await storedWorkspace(page)).toBe(createdId);
});

test("privileged client workspace shortcut supports keyboard focus, denial and successful entry", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo Reviewer/ }).click();
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByTestId("active-client-name")).toBeVisible();
  // Existing privileged shortcut remains a single creation action and traps focus.
  const session = await page.request.post("/api/test/admin-read/session", { data: { mode: "development" } });
  expect(session.ok()).toBeTruthy();
  const fixture = await session.json() as { organizationId: string };
  const createdId = fixture.organizationId;
  await page.evaluate(org => localStorage.setItem("activeOrganizationId", org), createdId);
  // Keep this navigation regression in workspace setup, not the unrelated
  // implementation wizard whose planning permissions this fixture lacks.
  await page.goto("/client-setup?organizationAction=join");
  const selector = page.getByRole("combobox", { name: "Active client workspace" });
  const trigger = page.getByTestId("button-create-client");
  await expect(trigger).toBeVisible();
  await expect(page.getByTestId("link-create-client-workspace")).toHaveCount(0);
  const previousMembershipCount = await selector.locator("option").count();
  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Create client workspace" });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("input-new-client-name")).toBeFocused();
    expect(await storedWorkspace(page)).toBe(createdId);
    for (let n = 0; n < 7; n++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    }
    await noOverflow(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  await trigger.click();
  await page.getByTestId("input-new-client-name").fill(`Fictional shortcut ${Date.now()}`);
  const current = await page.request.get("/api/organizations/current", { headers: { "x-organization-id": createdId } });
  const expiry = current.headers()["x-platform-admin-expires-at"];
  expect(expiry).toBeTruthy();
  await page.route("**/api/organizations", async route => {
    if (route.request().method() === "POST") await route.fulfill({
      status: 403, headers: { "X-Platform-Admin-Expires-At": expiry }, json: { message: "Fixture create denied" },
    });
    else await route.continue();
  });
  await page.getByTestId("button-create-client-confirm").click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Fixture create denied");
  expect(await storedWorkspace(page)).toBe(createdId);
  await page.unroute("**/api/organizations");
  await page.getByTestId("button-create-client-confirm").click();
  await expect(page.getByTestId("active-client-name")).toContainText("Fictional shortcut");
  expect(await storedWorkspace(page)).not.toBe(createdId);
  await expect(selector.locator("option")).toHaveCount(previousMembershipCount + 1);
});
