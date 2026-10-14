import { expect, test } from "@playwright/test";

test.skip(process.env.TRANSACTION_CONTEXT_E2E_TEST !== "true", "Requires disposable context harness.");
test("shared context handoff, concurrency, source navigation and responsive details", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo Reviewer/ }).click();
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByTestId("active-client-name")).toBeVisible();
  await page.goto("/api/test/ready");
  const session = await page.request.post("/api/test/admin-read/session", { data: { mode: "development" } });
  expect(session.status(), await session.text()).toBe(200);
  const fixture = await session.json();
  await page.evaluate(org => localStorage.setItem("activeOrganizationId", org), fixture.organizationId);
  const caseId = fixture.active.caseId;
  const path = `/api/onboarding/cases/${caseId}/transaction-context`;
  await page.goto(`/cases/${caseId}`);
  await page.getByRole("button", { name: "Transaction context", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Transaction context", exact: true })).toBeVisible();
  const context = page.locator('section[aria-labelledby="txc-h"]');
  await expect(context.getByText("Source-backed summary", { exact: true })).toBeVisible();
  await context.getByRole("button", { name: "Add Open question" }).click();
  await context.getByLabel("Open question", { exact: true }).fill("Confirm the recorded collection time with the equipment owner.");
  const saveResponse = page.waitForResponse(r => r.url().endsWith(path) && r.request().method() === "PUT");
  await context.getByRole("button", { name: "Save note", exact: true }).click();
  const saved = await saveResponse;
  expect(saved.status(), await saved.text()).toBe(200);
  await page.reload();
  await page.getByRole("button", { name: "Transaction context", exact: true }).click();
  await expect(context.getByText("Confirm the recorded collection time with the equipment owner.", { exact: true }).first()).toBeVisible();
  await context.getByRole("button", { name: "Edit Open question" }).click();
  await context.getByLabel("Open question", { exact: true }).fill("Revised handoff explanation");
  // An annotation is never silently rebased against a background refresh.
  const headers = { "x-organization-id": fixture.organizationId, origin: new URL(page.url()).origin, "sec-fetch-site": "same-origin" };
  const read = await page.request.get(path, { headers });
  expect(read.status(), await read.text()).toBe(200);
  const state = await read.json();
  const competing = await page.request.put(path, { headers, data: {
    kind: "question", body: "A concurrent human edit", expectedRevision: 1, sourceRevision: state.sourceRevision,
  } });
  expect(competing.status(), await competing.text()).toBe(200);
  const conflictResponse = page.waitForResponse(r => r.url().endsWith(path) && r.request().method() === "PUT");
  await context.getByRole("button", { name: "Save note", exact: true }).click();
  expect((await conflictResponse).status()).toBe(409);
  await expect(context.getByRole("alert")).toContainText("Nothing was overwritten");
  await context.getByRole("button", { name: "Reload latest" }).click();
  await expect(context.getByText("A concurrent human edit", { exact: true }).first()).toBeVisible();
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await context.scrollIntoViewIfNeeded();
    expect(await context.evaluate(node => node.scrollWidth <= node.clientWidth + 2)).toBe(true);
    await context.locator("summary").filter({ hasText: "Source details" }).first().click();
    await expect(context.getByText(/Source case:/).first()).toBeVisible();
    await context.locator("summary").filter({ hasText: "Source details" }).first().click();
    await page.screenshot({ path: `generated-artifacts/transaction-context-${viewport.width}.png`, fullPage: false });
  }
  await context.getByRole("button", { name: /Open in Overview tab/ }).first().click();
  await expect(page.getByRole("heading", { name: "Transaction context", exact: true })).toHaveCount(0);
  const boundary = await page.request.get(`/api/test/admin-edit/state/${caseId}`);
  const boundaryState = await boundary.json();
  expect(boundaryState.providerBoundary).toBe("deny-external-providers");
  expect(boundaryState.effects).toEqual([]);
  expect(boundaryState.communications).toEqual([]);
});

test("scope switches discard drafts and delayed context; denied refresh hides protected data", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo Reviewer/ }).click();
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByTestId("active-client-name")).toBeVisible();
  await page.goto("/api/test/ready");
  const session = await page.request.post("/api/test/admin-read/session", { data: { mode: "development" } });
  expect(session.status(), await session.text()).toBe(200);
  const fixture = await session.json();
  await page.evaluate(org => localStorage.setItem("activeOrganizationId", org), fixture.organizationId);
  const caseId = fixture.active.caseId;
  const path = `/api/onboarding/cases/${caseId}/transaction-context`;
  await page.goto(`/cases/${caseId}`);
  await page.getByRole("button", { name: "Transaction context", exact: true }).click();
  const context = page.locator('section[aria-labelledby="txc-h"]');
  const headers = { "x-organization-id": fixture.organizationId, origin: new URL(page.url()).origin, "sec-fetch-site": "same-origin" };
  const response = await page.request.get(path, { headers });
  expect(response.status(), await response.text()).toBe(200);
  const initial = await response.json();
  const seeded = await page.request.put(path, { headers, data: {
    kind: "question", body: "A concurrent human edit", expectedRevision: 0, sourceRevision: initial.sourceRevision,
  } });
  expect(seeded.status(), await seeded.text()).toBe(200);
  await context.getByRole("button", { name: "Refresh transaction context" }).click();
  await expect(context.getByText("A concurrent human edit", { exact: true }).first()).toBeVisible();
  // A delayed response from the previous case cannot enter a different case,
  // and a scoped draft must be discarded during SPA navigation.
  await context.getByRole("button", { name: "Edit Open question" }).click();
  await context.getByLabel("Open question", { exact: true }).fill("Previous case draft");
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let intercepted = false;
  await page.route(`**${path}`, async route => {
    const response = await route.fetch();
    intercepted = true;
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  await context.getByRole("button", { name: "Refresh transaction context" }).click();
  await expect.poll(() => intercepted).toBe(true);
  await page.evaluate(id => history.pushState({}, "", `/cases/${id}?tab=context`), fixture.historical.caseId);
  await expect(context.getByText(`onboarding:case:${fixture.historical.caseId}`, { exact: true })).toBeVisible();
  release();
  await expect(context.getByText("A concurrent human edit", { exact: true })).toHaveCount(0);
  await expect(context.locator("textarea")).toHaveCount(0);
  await page.unroute(`**${path}`);
  await page.evaluate(id => history.pushState({}, "", `/cases/${id}?tab=context`), caseId);
  await expect(context.getByText("A concurrent human edit", { exact: true }).first()).toBeVisible();
  await context.getByRole("button", { name: "Edit Open question" }).click();
  await context.getByLabel("Open question", { exact: true }).fill("Unsaved confidential draft");
  // Denied refetch must hide React Query's retained successful payload.
  await page.route(`**${path}`, async route => {
    const upstream = await route.fetch();
    await route.fulfill({ status: 403, headers: upstream.headers(), body: JSON.stringify({ message: "Context permission withdrawn" }) });
  });
  await context.getByRole("button", { name: "Refresh transaction context" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Transaction context could not be loaded" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("A concurrent human edit", { exact: true })).toHaveCount(0);
  await expect(page.locator("#txc-question")).toHaveCount(0);
  await page.unroute(`**${path}`);
  const boundary = await page.request.get(`/api/test/admin-edit/state/${caseId}`);
  const boundaryState = await boundary.json();
  expect(boundaryState.providerBoundary).toBe("deny-external-providers");
  expect(boundaryState.effects).toEqual([]);
  expect(boundaryState.communications).toEqual([]);
});
