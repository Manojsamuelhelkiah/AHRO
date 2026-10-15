import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";

test.skip(process.env.CASE_LIST_VISIBILITY_E2E_TEST !== "true", "Requires disposable case-list harness.");
test("per-case checkboxes hide/restore at desktop, tablet and phone widths without affecting operations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo Reviewer/ }).click();
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByTestId("active-client-name")).toBeVisible();
  const login = await page.request.post("/api/test/offboarding-session", { data: { profile: "offboarding-operator" } });
  expect(login.ok()).toBeTruthy();
  const seed = await page.request.post("/api/test/case-list-fixture", { data: {} });
  expect(seed.status(), await seed.text()).toBe(200);
  const fixtures = (await seed.json()).cases as { id: number; reference: string; family: string }[];
  const before = await (await page.request.post("/api/test/case-list-fixture", { data: { action: "state" } })).json();
  await page.evaluate(() => localStorage.setItem("activeOrganizationId", "demo"));
  mkdirSync("generated-artifacts/case-list-visibility", { recursive: true });
  const viewports = [["desktop", 1440, 1000], ["tablet", 820, 1180], ["phone", 390, 844]] as const;
  for (const [name, width, height] of viewports.filter(([name]) => !process.env.CASE_LIST_VIEWPORT || name === process.env.CASE_LIST_VIEWPORT)) {
    await page.setViewportSize({ width, height });
    await page.goto("/cases");
    await expect(page.getByLabel("Cases list visibility")).toHaveValue("working");
    const c = fixtures[name === "tablet" ? 1 : 0]!;
    const checkbox = page.getByRole("checkbox", { name: `Show ${c.reference} (${c.family}) in working cases` }).filter({ visible: true });
    await expect(checkbox).toBeVisible();
    if (name === "desktop") {
      const row = page.getByRole("row", { name: new RegExp(`Open case ${c.reference}`) });
      expect((await row.boundingBox())!.height).toBeLessThanOrEqual(64);
    }
    await expect(checkbox).toBeChecked();
    await page.screenshot({ path: `generated-artifacts/case-list-visibility/${name}-working.png` });
    const hide = page.waitForResponse(response => response.url().endsWith("/api/onboarding/case-list-visibility") && response.request().method() === "PUT");
    // The row disappears after a successful write; do not wait for a checkbox
    // state on an element that unmounts as soon as the list is refreshed.
    await checkbox.click();
    expect((await hide).status()).toBe(200);
    await expect(checkbox).toHaveCount(0);
    await page.reload();
    await expect(checkbox).toHaveCount(0);
    // Fresh request proves server persistence, rather than browser-local state.
    const fresh = await page.request.get("/api/onboarding/cases", { headers: { "x-organization-id": "demo" } });
    expect(fresh.status()).toBe(200);
    expect((await fresh.json()).find((row: { id: number }) => row.id === c.id).workingListHidden).toBe(true);
    await page.getByLabel("Cases list visibility").selectOption("hidden");
    await expect(checkbox).toBeVisible();
    await page.screenshot({ path: `generated-artifacts/case-list-visibility/${name}-hidden.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(checkbox).not.toBeChecked();
    const restore = page.waitForResponse(response => response.url().endsWith("/api/onboarding/case-list-visibility") && response.request().method() === "PUT");
    await checkbox.click();
    expect((await restore).status()).toBe(200);
    await expect(checkbox).toHaveCount(0);
    await page.getByLabel("Cases list visibility").selectOption("working");
    await expect(checkbox).toBeVisible();
  }
  const after = await (await page.request.post("/api/test/case-list-fixture", { data: { action: "state" } })).json();
  expect(after).toEqual(before);
});
