import { test, expect } from "@playwright/test";
import { caseListReference } from "../artifacts/onboarding-agent/src/pages/cases/case-presentation";

test("client email saves reach existing and future cases without sending; overrides, pauses and queued-send fences persist", async ({ page }) => {
  const session = await page.request.post("/api/test/offboarding-session", { data: { profile: "offboarding-operator" } });
  expect(session.ok()).toBeTruthy();
  const seeded = await page.request.post("/api/test/offboarding-exchange-fixture");
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  const fixture = await seeded.json();
  expect(fixture.sent).toBe(0);
  expect(fixture.caseIds).toHaveLength(2);
  expect(fixture.administratorNamedGrants).toBe(0);
  const [overrideId, pausedId] = fixture.caseIds;
  await page.addInitScript(() => {
    localStorage.setItem("onboarding-e2e-demo-profile", "offboarding-operator");
    localStorage.setItem("activeOrganizationId", "demo");
  });
  const get = async (id: number) => {
    const r = await page.request.get(`/api/offboarding/cases/${id}/exchanges`, { headers: { "X-Organization-Id": "demo" } });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const state = async () => {
    const r = await page.request.get("/api/test/offboarding-exchange-state");
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const noMail = async () => {
    const s = await state();
    expect(s.sent).toBe(0);
    expect(s.exchanges.filter((m: { direction: string }) => m.direction === "outbound")).toHaveLength(0);
  };
  // These endpoints must remain real throughout the test. Observe browser
  // payloads/responses, never route.fulfill directory/defaults/case state.
  const saves: Array<{ status: number; body: Record<string, unknown> }> = [];
  page.on("response", response => {
    if (response.request().method() === "PUT" && response.url().endsWith("/api/offboarding/exchanges/defaults")) {
      saves.push({ status: response.status(), body: response.request().postDataJSON() });
    }
  });
  await page.goto("/cases/separations");
  // These retained fixtures are not approved fixed-inventory ordinary examples.
  // Keep the shared list's history boundary rather than upgrading their identity.
  await page.getByRole("checkbox", { name: "Show all historical test records" }).check();
  const envelopesResponse = await page.request.get("/api/onboarding/cases", { headers: { "X-Organization-Id": "demo" } });
  expect(envelopesResponse.ok()).toBeTruthy();
  const envelopes = await envelopesResponse.json();
  for (const id of fixture.caseIds) {
    const envelope = envelopes.find((record: { id: number }) => record.id === id);
    expect(envelope).toBeTruthy();
    const reference = caseListReference(envelope);
    const row = page.locator(`tr[aria-label^="Open case ${reference}"]:visible`)
      .or(page.getByRole('button').filter({ hasText: reference }));
    await expect(row).toContainText(reference);
    await expect(row).not.toContainText("FICTIONAL");
    expect((await get(id)).enrollment.enabled).toBe(false);
  }
  await page.goto(`/cases/separations/${overrideId}`);
  await expect(page.getByRole("heading", { name: "Access and equipment" })).toBeVisible();
  await expect(page.getByTestId("text-closure-blocker").first()).toBeVisible();
  const actions = page.locator('section[aria-label="Actions"]');
  await actions.locator("select").selectOption("asset-inventory");
  await page.getByRole("button", { name: "Inspect selected interface" }).click();
  await expect(page.getByText("Interface response recorded.", { exact: true })).toBeVisible();
  expect((await get(overrideId)).tasks.find((t: { id: string }) => t.id === "asset-inventory").status).toBe("resolved");

  await page.goto("/client-setup");
  const settings = page.getByLabel("Gmail enrollment", { exact: true });
  const defaults = page.getByLabel("Client Gmail defaults", { exact: true });
  const chooseCase = async (id: number) => {
    await page.getByLabel("Case", { exact: true }).selectOption(String(id));
    await expect(settings).toBeVisible();
  };
  const saveDefaults = async () => {
    const before = saves.length;
    const response = page.waitForResponse(r => r.request().method() === "PUT" && r.url().endsWith("/api/offboarding/exchanges/defaults"));
    await defaults.getByRole("button", { name: "Save client email settings" }).click();
    const r = await response;
    expect(r.ok(), await r.text()).toBeTruthy();
    await expect(defaults.getByRole("status")).toHaveText("Client Gmail defaults saved.");
    expect(saves).toHaveLength(before + 1);
    expect(saves[before].status).toBe(200);
    expect(saves[before].body).not.toHaveProperty("consentReference");
  };
  const saveOverride = async (enabled: boolean) => {
    const response = page.waitForResponse(r => r.request().method() === "PUT" && r.url().endsWith("/exchanges/enrollment"));
    await settings.getByRole("button", { name: enabled ? "Save and enable case override" : "Pause conversations", exact: true }).click();
    const r = await response;
    expect(r.ok(), await r.text()).toBeTruthy();
    await expect(settings.getByRole("status")).toHaveText(enabled ? "Gmail settings saved for this case." : "Conversations paused.");
  };
  await chooseCase(overrideId);
  await settings.getByLabel("Registered agent", { exact: true }).selectOption({ label: "Conversation agent" });
  await settings.locator("fieldset").first().getByRole("checkbox").check();
  await settings.locator("fieldset").first().getByLabel("Task owner", { exact: true }).selectOption({ label: "owner" });
  await expect(settings.getByLabel("Owner consent record")).toHaveCount(0);
  await expect(settings.getByLabel("Registered agent id")).toHaveCount(0);
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  }
  await settings.getByRole("button", { name: "Save and enable case override" }).click();
  await expect(settings.getByRole("alert").filter({ hasText: "Escalation contacts are required" })).toBeVisible();
  await chooseCase(pausedId);
  await expect(settings.getByLabel("Task owner", { exact: true })).toHaveCount(0);
  await chooseCase(overrideId);
  await expect(settings.locator("fieldset").first().getByLabel("Task owner", { exact: true })).toHaveValue("browser-exchange-owner");
  await noMail();

  // Reload discards only unsaved case drafts; real choices and writes now
  // exercise the full browser -> route -> inherited persisted state path.
  await page.goto("/client-setup");
  await defaults.getByLabel("Enable email for client").check();
  await defaults.getByLabel("Enable escalation for client").uncheck();
  await defaults.getByLabel("Default registered agent").selectOption({ label: "Conversation agent" });
  await defaults.locator("fieldset").first().getByRole("checkbox").check();
  await defaults.locator("fieldset").first().getByLabel("Task owner", { exact: true }).selectOption({ label: "owner" });
  await expect(defaults.getByLabel("Escalation contact", { exact: true })).toHaveCount(0);
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  }
  await saveDefaults();
  const firstRecipient = { taskId: "access-inventory", memberId: "browser-exchange-owner",
    address: "owner@offboarding-fixture.com", persona: "Access inventory" };
  expect(saves[0].body).toMatchObject({ enabled: true, escalationEnabled: false, recipients: [firstRecipient] });
  for (const id of fixture.caseIds) {
    expect((await get(id)).enrollment).toMatchObject({ enabled: true, inheritsClientDefaults: true, escalationEnabled: false,
      agentId: "browser-exchange-agent", recipients: [firstRecipient] });
  }
  await noMail();
  await chooseCase(overrideId);
  await expect(settings.getByText("This case uses the client's email settings. Saving below creates a case-specific override.", { exact: true })).toBeVisible();
  await expect(settings.getByLabel("Enable escalation for this case")).not.toBeChecked();
  await expect(settings.getByLabel("Escalation contact", { exact: true })).toHaveCount(0);
  await saveOverride(true); // Owner only: no escalation contact required.
  await chooseCase(pausedId);
  await saveOverride(false);
  await noMail();

  // Change inherited contacts: overrides/pauses must not be overwritten.
  await defaults.locator("fieldset").first().getByLabel("Task owner", { exact: true }).selectOption({ label: "escalation" });
  await saveDefaults();
  await noMail();
  // Same-origin browser request to the real retry-safe constructor: the two
  // existing cases remain, and the missing third scenario is newly created.
  const future = await page.evaluate(async () => {
    const r = await fetch("/api/offboarding/exchanges/provision", { method: "POST",
      headers: { "Content-Type": "application/json", "X-Organization-Id": "demo" }, body: JSON.stringify({ confirmAddThree: true }) });
    return { status: r.status, body: await r.json() };
  });
  expect(future.status).toBe(200);
  expect(future.body.sent).toBe(0);
  expect(future.body.caseIds).toHaveLength(3);
  const futureId = future.body.caseIds.find((id: number) => !fixture.caseIds.includes(id));
  expect(Number.isSafeInteger(futureId)).toBeTruthy();
  expect((await get(futureId)).enrollment).toMatchObject({ enabled: true, inheritsClientDefaults: true,
    escalationEnabled: false, recipients: [{ memberId: "browser-exchange-escalation", address: "escalation@offboarding-fixture.com" }] });
  await noMail();
  await page.reload();
  await chooseCase(futureId);
  await expect(settings.getByText("This case uses the client's email settings. Saving below creates a case-specific override.", { exact: true })).toBeVisible();
  await expect(settings.locator("fieldset").first().getByLabel("Task owner", { exact: true })).toHaveValue("browser-exchange-escalation");
  await chooseCase(overrideId);
  await expect(settings.getByText("Case-specific email settings.", { exact: true })).toBeVisible();
  await expect(settings.locator("fieldset").first().getByLabel("Task owner", { exact: true })).toHaveValue("browser-exchange-owner");
  expect((await get(overrideId)).enrollment).toMatchObject({ enabled: true, inheritsClientDefaults: false, recipients: [firstRecipient] });
  expect((await get(pausedId)).enrollment).toMatchObject({ enabled: false, inheritsClientDefaults: false });

  // Queue using the real case action, then disable at client scope before a
  // deterministic dispatch. No background worker runs in this owned process.
  await page.goto(`/cases/separations/${overrideId}`);
  await actions.locator("select").selectOption("access-inventory");
  const request = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/exchanges/actions"));
  await actions.getByRole("button", { name: "Request", exact: true }).click();
  const requested = await request;
  expect(requested.ok(), await requested.text()).toBeTruthy();
  const queued = (await state()).exchanges.filter((m: { status: string }) => m.status === "queued");
  expect(queued).toHaveLength(1);
  expect((await state()).sent).toBe(0);
  await page.goto("/client-setup");
  await defaults.getByLabel("Enable email for client").uncheck();
  await saveDefaults();
  for (const id of future.body.caseIds) expect((await get(id)).enrollment.enabled).toBe(false);
  const dispatch = await page.request.post("/api/test/offboarding-exchange-dispatch", { data: { id: queued[0].id } });
  expect(dispatch.ok(), await dispatch.text()).toBeTruthy();
  const blocked = await dispatch.json();
  expect(blocked.blocked).toMatch(/paused for this client/i);
  expect(blocked.probes).toBeGreaterThan(0); // Proves the fake runtime was exercised.
  expect(blocked.sent).toBe(0);
  expect(blocked.exchanges.find((m: { id: string }) => m.id === queued[0].id).status).toBe("queued");
  await defaults.getByLabel("Enable email for client").check();
  await saveDefaults();
  await page.reload();
  expect((await get(overrideId)).enrollment).toMatchObject({ enabled: true, inheritsClientDefaults: false, recipients: [firstRecipient] });
  expect((await get(pausedId)).enrollment).toMatchObject({ enabled: false, inheritsClientDefaults: false });
  expect((await get(futureId)).enrollment).toMatchObject({ enabled: true, inheritsClientDefaults: true });
  expect((await state()).sent).toBe(0);
  expect((await state()).exchanges.filter((m: { direction: string }) => m.direction === "outbound")).toHaveLength(1);

  await page.goto(`/cases/separations/${overrideId}`);
  const indicators = page.getByLabel("Case email indicators", { exact: true });
  await expect(indicators.getByRole("checkbox", { name: "Email consent: Yes" })).toBeChecked();
  await expect(indicators.getByRole("checkbox", { name: "Email verified: Yes" })).toBeChecked();
  await indicators.getByRole("checkbox", { name: "Email consent: Yes" }).click();
  await expect(indicators.getByText("Emails paused — manual review required")).toBeVisible();
  await page.reload();
  await expect(indicators.getByRole("checkbox", { name: "Email consent: No" })).not.toBeChecked();
  await indicators.getByRole("checkbox", { name: "Email consent: No" }).click();
  await expect(indicators.getByRole("checkbox", { name: "Email consent: Yes" })).toBeChecked();
  await expect(indicators.getByText("Emails paused — manual review required")).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage Gmail contacts in Client Setup" })).toHaveAttribute("href", `/client-setup?offboardingCaseId=${overrideId}#gmail-communication`);
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    await expect(page.locator('section[aria-label="Enrollment"]')).toHaveCount(0);
    await expect(actions.getByRole("button", { name: "Request", exact: true })).toBeDisabled();
  }
  // A communication-review pause gates requests without destroying the
  // independently saved case override or its enabled flag.
  expect((await get(overrideId)).communicationChecks.reviewRequired).toBe(true);
  expect((await get(overrideId)).tasks.find((t: { id: string }) => t.id === "asset-inventory").status).toBe("resolved");
  expect((await state()).sent).toBe(0);

  // Preserve the delayed/exception interface regression on the additive third
  // case. Prepare its plan through real authenticated routes, not fixture DB
  // writes, so inheritance is checked BEFORE policy readiness is adopted.
  const prepared = await page.evaluate(async ({ id, policy }) => {
    const headers = { "Content-Type": "application/json", "X-Organization-Id": "demo" };
    const outcomes = [];
    for (const step of [
      { action: "screen", sensitiveTriggers: [] },
      { action: "classify", confirmed: true, classification: "Human-reviewed resignation", urgency: "Standard",
        flags: { privileged: false, highRisk: false, clientFacing: false, peopleManager: false, statutory: false } },
      { action: "adopt-policy", policyId: policy.id, policyVersion: policy.version },
    ]) {
      const read = await fetch(`/api/offboarding/cases/${id}`, { headers });
      if (!read.ok) return [{ status: read.status, body: await read.text() }];
      const detail = await read.json();
      const r = await fetch(`/api/offboarding/cases/${id}/actions`, { method: "POST", headers,
        body: JSON.stringify({ expectedVersion: detail.version, reference: `browser:${step.action}`, ...step }) });
      outcomes.push({ status: r.status, body: await r.text() });
      if (!r.ok) break;
    }
    return outcomes;
  }, { id: futureId, policy: fixture.policy });
  expect(prepared.map(r => r.status), JSON.stringify(prepared)).toEqual([200, 200, 200]);
  for (const [id, expected] of [[pausedId, "pending"], [futureId, "review"]] as const) {
    await page.goto(`/cases/separations/${id}`);
    await expect(page.getByRole("heading", { name: "Access and equipment" })).toBeVisible();
    await expect(page.locator('section[aria-label="Enrollment"]')).toHaveCount(0);
    for (const taskId of ["asset-inventory", "asset-return"]) {
      await actions.locator("select").selectOption(taskId);
      await page.getByRole("button", { name: "Inspect selected interface" }).click();
      await expect(page.getByText("Interface response recorded.", { exact: true })).toBeVisible();
    }
    await expect.poll(async () => (await get(id)).tasks.find((t: { id: string }) => t.id === "asset-return").status).toBe(expected);
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    }
  }
  expect((await state()).sent).toBe(0);
});
