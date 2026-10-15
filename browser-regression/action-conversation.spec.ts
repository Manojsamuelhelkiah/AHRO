import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  const session = await page.request.post("/api/test/offboarding-session", { data: { profile: "offboarding-operator" } });
  expect(session.ok()).toBeTruthy();
  const response = await page.request.post("/api/test/action-conversation-fixture", { data: {} });
  expect(response.ok()).toBeTruthy();
  const data = await response.json() as { organizationId: string; caseId: number; otherCaseId: number; workItemId: number };
  await page.addInitScript(({ organizationId }) => {
    localStorage.setItem("onboarding-e2e-demo-profile", "offboarding-operator");
    localStorage.setItem("activeOrganizationId", organizationId);
  }, data);
  return data;
}

for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1440, height: 1000 }]) {
  test(`case conversations remain read-only and durable at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
  const data = await fixture(page);
    const url = `/approvals?tab=conversation&caseId=${data.caseId}`;
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Action Center", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Needs Attention", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Conversation", exact: true })).toBeInViewport();
    await expect(page.getByText("Outcome uncertain", { exact: true })).toBeVisible();
    const composer = page.locator("#conv-text");
    await page.getByRole("radiogroup", { name: "Message type" }).getByText("Human note", { exact: true }).click();
    await composer.fill("Durable browser note: laptop not received");
    const postResponse = page.waitForResponse(r => r.url().includes(`/cases/${data.caseId}/conversation`) && r.request().method() === "POST");
    await page.getByRole("button", { name: "Record note", exact: true }).click();
    expect((await postResponse).ok()).toBeTruthy();
    await expect(page.getByText("Durable browser note: laptop not received", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("Durable browser note: laptop not received", { exact: true })).toBeVisible();
    await composer.fill("PRIVATE UNSAVED DRAFT");
    await page.goto(`/approvals?tab=conversation&caseId=${data.otherCaseId}`);
    await expect(page.locator("#conv-text")).toHaveValue("");
    await expect(page.getByText("Durable browser note: laptop not received", { exact: true })).toHaveCount(0);
    await page.goto(url);
    await page.getByRole("radiogroup", { name: "Message type" }).getByText("Ask for triage", { exact: true }).click();
    await page.locator("#conv-text").fill("What is currently blocking this case?");
    await page.getByRole("button", { name: "Ask for triage", exact: true }).click();
    await expect(page.getByText("AI triage is unavailable under current provider, sensitive-content or model policy.", { exact: false })).toBeVisible();
    await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
    const stateResponse = await page.request.post("/api/test/action-conversation-fixture", { data: { action: "state", caseId: data.caseId } });
    expect(await stateResponse.json()).toMatchObject({ communications: 0, work: 1, events: 0, stage: "trigger-received" });
    await page.goto(`${url}&workItemId=${data.workItemId}`);
    await expect(page.getByText("No messages on this case yet.", { exact: false })).toBeVisible();
    await page.getByRole("radiogroup", { name: "Message type" }).getByText("Human note", { exact: true }).click();
    await page.locator("#conv-text").fill("Work-item-specific annotation");
    await page.getByRole("button", { name: "Record note", exact: true }).click();
    await expect(page.getByText("Work-item-specific annotation", { exact: true })).toBeVisible();
    await page.goto(url);
    await expect(page.getByText("Durable browser note: laptop not received", { exact: true })).toBeVisible();
    await expect(page.getByText("Work-item-specific annotation", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    const storage = await page.evaluate(() => JSON.stringify(localStorage));
    expect(storage).not.toContain("Durable browser note");
    expect(storage).not.toContain("PRIVATE UNSAVED DRAFT");
    await page.screenshot({ path: `generated-artifacts/conversation-${viewport.width}.png`, fullPage: true });
    await page.request.post("/api/test/action-conversation-fixture", { data: { action: "revoke-notes", caseId: data.caseId } });
    await page.reload();
    await expect(page.getByText("Conversation could not be loaded", { exact: false })).toBeVisible();
    await expect(page.getByText("Durable browser note: laptop not received", { exact: true })).toHaveCount(0);
  });
}

test("historical reply disclosure revocation discards older cached excerpts and denied pagination clears the thread", async ({ page }) => {
  const data = await fixture(page);
  for (let i = 0; i < 2; i++) {
    const seeded = await page.request.post("/api/test/action-conversation-fixture", { data: { action: "history", caseId: data.caseId } });
    expect(seeded.ok()).toBeTruthy();
  }
  let withdrawn = false;

  const endpoint = `/api/onboarding/action-center/cases/${data.caseId}/conversation`;
  let holdPagination = false;
  let paginationStarted!: () => void;
  let releasePagination!: () => void;
  const paginationHeld = new Promise<void>(resolve => { paginationStarted = resolve; });
  const paginationReleased = new Promise<void>(resolve => { releasePagination = resolve; });
  // The live test server forbids all provider disclosure. A UI-only response
  // snapshot models a reply disclosed BEFORE revocation without opening that
  // boundary or sending any real data to a provider. All pagination, notes
  // authorization and grant withdrawal otherwise use the real persisted API.
  await page.route(`**${endpoint}*`, async route => {
    if (holdPagination && new URL(route.request().url()).searchParams.has("before")) {
      holdPagination = false;
      paginationStarted();
      await paginationReleased;
    }
    const response = await route.fetch();
    if (response.ok() && new URL(route.request().url()).searchParams.has("before") && !withdrawn) {
      const body = await response.json();
      const m = body.messages[0];
      Object.assign(m, {
        mode: "triage", state: "completed", outcome: "answer", reply: "Historical authorized reply snapshot.",
        explanation: {
          asOf: new Date().toISOString(), truncated: false, limitations: [],
          paragraphs: [{ kind: "supported", text: "Fictional historical answer.", sourceIds: ["fixture:historical"] }],
          sources: [{ id: "fixture:historical", kind: "event", title: "Historical fixture source",
            excerpt: "FICTIONAL OLDER PRIVATE EXCERPT", occurredAt: null, tab: "activity" }],
        },
      });
      await route.fulfill({ response, json: body });
    } else await route.fulfill({ response });
  });
  await page.goto(`/approvals?tab=conversation&caseId=${data.caseId}`);
  await page.getByRole("button", { name: "Load older messages", exact: true }).click();
  await page.getByText("Historical fixture source", { exact: true }).click();
  await expect(page.getByText("FICTIONAL OLDER PRIVATE EXCERPT", { exact: true })).toBeVisible();
  const revoked = await page.request.post("/api/test/action-conversation-fixture", { data: { action: "revoke-disclosure", caseId: data.caseId } });
  expect(revoked.ok()).toBeTruthy();
  withdrawn = true;
  const refreshed = page.waitForResponse(r => new URL(r.url()).pathname === endpoint && !new URL(r.url()).searchParams.has("before"));

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await refreshed;
  await expect(page.getByText("FICTIONAL OLDER PRIVATE EXCERPT", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Fictional historical answer.", { exact: true })).toHaveCount(0);
  const reloadedOlder = page.waitForResponse(r => new URL(r.url()).pathname === endpoint && new URL(r.url()).searchParams.has("before"));
  await page.getByRole("button", { name: "Load older messages", exact: true }).click();
  const olderResponse = await reloadedOlder;
  expect(olderResponse.ok()).toBeTruthy();
  expect((await olderResponse.json()).nextBefore).not.toBeNull();
  await expect(page.getByRole("button", { name: "Load older messages", exact: true })).toBeEnabled();
  await expect(page.getByText("FICTIONAL OLDER PRIVATE EXCERPT", { exact: true })).toHaveCount(0);
  // Start pagination while its control is still authorized, then revoke before
  // its real server read. Revoking first races both the in-flight previous page
  // and background refresh, either of which can already remove the button.
  holdPagination = true;
  const deniedPagination = page.waitForResponse(r => new URL(r.url()).pathname === endpoint && new URL(r.url()).searchParams.has("before"));
  await page.getByRole("button", { name: "Load older messages", exact: true }).click();
  await paginationHeld;
  try {
    const notesDenied = await page.request.post("/api/test/action-conversation-fixture", { data: { action: "revoke-notes", caseId: data.caseId } });
    expect(notesDenied.ok()).toBeTruthy();
  } finally { releasePagination(); }
  expect((await deniedPagination).ok()).toBeFalsy();
  await expect(page.getByText("Conversation could not be loaded", { exact: false })).toBeVisible();
  await expect(page.getByText(/^Fictional historical annotation/)).toHaveCount(0);
  await expect(page.getByText("FICTIONAL OLDER PRIVATE EXCERPT", { exact: true })).toHaveCount(0);
});
