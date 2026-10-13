import { expect, test } from "@playwright/test";

test.skip(process.env.ADMIN_READ_E2E_TEST !== "true", "Requires isolated administrator proof adapter.");

test("Frontline separates administrative access, private disclosure, retention and release at every viewport", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo Reviewer/ }).click();
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByTestId("active-client-name")).toBeVisible();
  const session = async (options: Record<string, unknown>) => {
    const response = await page.request.post("/api/test/admin-read/session", { data: { ...options, frontline: true } });
    expect(response.status()).toBe(200);
    const fixture = await response.json();
    await page.evaluate(org => localStorage.setItem("activeOrganizationId", org), fixture.organizationId);
    return fixture;
  };
  const fixture = await session({ mode: "private" });
  const headers = { "x-organization-id": fixture.organizationId, origin: `https://${new URL(page.url()).host}` };
  const base = `/api/onboarding/cases/${fixture.frontline.active}/frontline`;
  const readiness = await page.request.get(`${base}/readiness`, { headers });
  expect(readiness.status(), await readiness.text()).toBe(200);
  const initial = await readiness.json();
  expect(initial.access.fulfillmentEdit).toBe(true);
  expect(initial.release.eligible).toBe(false);
  const release = await page.request.post(`${base}/floor-release`, { headers, data: { expectedVersion: initial.version } });
  expect(release.status(), await release.text()).toBe(200);
  expect((await release.json()).release.eligible).toBe(false);
  // The loopback browser uses HTTP. Exercise browser writes with the real
  // development verifier; production proof API checks above/below use HTTPS
  // Origin explicitly rather than weakening the production same-origin guard.
  await session({ mode: "development", sharedDemo: true });
  headers.origin = `http://${new URL(page.url()).host}`;
  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/cases/${fixture.frontline.active}`);
    await page.getByRole("button", { name: "Frontline", exact: true }).click();
    await expect(page.getByText("Floor Release Readiness", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Record Issue" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Authorize Floor Release" })).toBeDisabled();
    await expect(page.getByText("Frontline case actions are restricted by your current permissions.", { exact: true })).toHaveCount(0);
    // Save a real persisted fixture through the UI; nothing dispatches externally.
    await page.getByRole("button", { name: "Record Issue" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("select").first().selectOption("badge");
    await dialog.getByPlaceholder("Barcode/SN").fill(`private-fixture-asset-${viewport.width}`);
    await dialog.getByPlaceholder("Worker or recipient reference").fill("fixture-recipient");
    await dialog.getByRole("button", { name: "Save Issuance" }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    await page.reload();
    await page.getByRole("button", { name: "Frontline", exact: true }).click();
    await expect(page.getByText("badge", { exact: true })).toBeVisible();
    const current = await (await page.request.get(`${base}/readiness`, { headers })).json();
    expect(current.fulfillments.some((row: any) => row.item === "badge" && row.acknowledged)).toBe(true);
    expect(JSON.stringify(current)).not.toContain("private-fixture-asset");
    await page.screenshot({ path: `test-results/frontline-active-${viewport.width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    await page.goto(`/cases/${fixture.frontline.retained}`);
    await page.getByRole("button", { name: "Frontline", exact: true }).click();
    await expect(page.getByText(/Retained Frontline record — read-only/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Record Issue" })).toBeDisabled();
    const retainedBase = `/api/onboarding/cases/${fixture.frontline.retained}/frontline`;
    const retained = await (await page.request.get(`${retainedBase}/readiness`, { headers })).json();
    expect(retained.access.readOnly).toBe(true);
    const immutable = await page.request.post(`${retainedBase}/fulfillments`, { headers, data: {
      expectedVersion: retained.version, item: "badge", assetReference: "must-not-save",
      requestedQuantity: 1, issuedQuantity: 1, issuerTimestamp: new Date().toISOString(),
    } });
    expect(immutable.status()).toBe(410);
    await page.screenshot({ path: `test-results/frontline-retained-${viewport.width}.png` });
    await page.goto(`/cases/${fixture.frontline.office}`);
    await page.getByRole("button", { name: "Frontline", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Frontline Not Applicable" })).toBeVisible();
  }
  // API denial matrix reuses real verifiers, never a browser-supplied role.
  await page.goto("/api/test/ready");
  await session({ mode: "ordinary", sharedDemo: true });
  expect((await page.request.get(`${base}/readiness`, { headers })).status()).toBe(403);
  await session({ mode: "development", sharedDemo: true, expired: true });
  expect((await page.request.get(`${base}/readiness`, { headers })).status()).toBe(403);
  await session({ mode: "development", sharedDemo: true, revoked: true });
  expect((await page.request.get(`${base}/readiness`, { headers })).status()).toBe(403);
  for (const denied of [{ mode: "ordinary" }, { mode: "private", expired: true }, { mode: "private", revoked: true }]) {
    headers.origin = `https://${new URL(page.url()).host}`;
    await session(denied);
    const read = await page.request.get(`${base}/readiness`, { headers });
    if (denied.mode === "ordinary") {
      expect(read.status()).toBe(200);
      const value = await read.json();
      expect(value.access.fulfillmentEdit).toBe(false);
      expect(value.access.historyRead).toBe(false);
      expect(value.access.kpiRead).toBe(false);
      expect((await page.request.get(`${base}/evidence-history`, { headers })).status()).toBe(403);
      expect((await page.request.get(`${base}/kpis`, { headers })).status()).toBe(403);
      await page.goto(`/cases/${fixture.frontline.active}`);
      await page.getByRole("button", { name: "Frontline", exact: true }).click();
      await expect(page.getByRole("button", { name: "Record Issue" })).toBeDisabled();
      await expect(page.getByText(/No private history has been requested/)).toBeVisible();
      await page.goto("/api/test/ready");
    } else expect(read.status()).toBe(403);
    const write = await page.request.post(`${base}/fulfillments`, { headers, data: {
      expectedVersion: 0, item: "badge", assetReference: "unauthorized",
      requestedQuantity: 1, issuedQuantity: 1, issuerTimestamp: new Date().toISOString(),
    } });
    expect(write.status()).toBe(403);
  }
  await session({ mode: "private" });
  expect((await page.request.get(`${base}/readiness`, { headers: { ...headers, "x-organization-id": "other-tenant" } })).status()).toBe(403);
  const unknownCase = await page.request.get(`/api/onboarding/cases/99999999/frontline/readiness`, { headers });
  expect(unknownCase.status()).toBe(404);
});
