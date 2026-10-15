import { test, expect } from "@playwright/test";

test("contextual offboarding: three additive cases, interface resolution, paused enrollment and scoped drafts at all widths", async ({ page }) => {
  const session = await page.request.post("/api/test/offboarding-session", { data: { profile: "offboarding-operator" } });
  expect(session.ok()).toBeTruthy();
  const seeded = await page.request.post("/api/test/offboarding-exchange-fixture");
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  const fixture = await seeded.json();
  expect(fixture.sent).toBe(0);
  await page.addInitScript(() => {
    localStorage.setItem("onboarding-e2e-demo-profile", "offboarding-operator");
    localStorage.setItem("activeOrganizationId", "demo");
  });
  const headers = { "X-Organization-Id": "demo" };
  const get = async (id: number) => {
    const r = await page.request.get(`/api/offboarding/cases/${id}/exchanges`, { headers });
    expect(r.ok(), await r.text()).toBeTruthy(); return r.json();
  };
  const id = fixture.caseIds[0];
  await page.goto("/cases/separations");
  for (const caseId of fixture.caseIds) {
    await expect(page.getByTestId(`row-separation-${caseId}`)).toContainText(`S${caseId}`);
    await expect(page.getByTestId(`row-separation-${caseId}`)).not.toContainText("FICTIONAL");
  }
  await page.goto(`/cases/separations/${id}`);
  await expect(page.getByRole("heading", { name: "Access and equipment" })).toBeVisible();
  await expect(page.getByTestId("text-closure-blocker").first()).toBeVisible();
  const actions = page.getByRole("region", { name: "Actions" }).or(page.locator('section[aria-label="Actions"]'));
  await actions.locator("select").selectOption("asset-inventory");
  await page.getByRole("button", { name: "Inspect selected interface" }).click();
  await expect(page.getByText("Interface response recorded.", { exact: true })).toBeVisible();
  expect((await get(id)).tasks.find((t: { id: string }) => t.id === "asset-inventory").status).toBe("resolved");
  // Read-only directory fixture. No live binding is enrolled or sent.
  await page.route("**/api/offboarding/exchanges/setup*", async route => {
    await route.fulfill({ json: {
      cases: fixture.caseIds.map((caseId: number, index: number) => ({ id: caseId, name: ["Alex Morgan", "Jordan Ellis", "Taylor Reed"][index] })),
      agents: [{ id: "owned-directory-agent", name: "Conversation agent" }],
      defaults: { revision: 1, agentId: "", recipients: [] },
      members: [{ id: "directory-owner", name: "Alex Owner", addresses: ["owner@example.test"] },
        { id: "directory-escalation", name: "Jordan Escalation", addresses: ["escalation@example.test"] }],
    } });
  });
  await page.goto(`/client-setup?offboardingCaseId=${id}`);
  const settings = page.locator('[aria-label="Gmail enrollment"]');
  await expect(settings).toBeVisible();
  await settings.getByLabel("Registered agent", { exact: true }).selectOption({ label: "Conversation agent" });
  // Labels follow the current task wording rather than internal IDs.
  const firstTask = settings.locator("fieldset").first();
  await firstTask.getByRole("checkbox").check();
  await firstTask.getByLabel("Task owner", { exact: true }).selectOption({ label: "Alex Owner" });
  await expect(settings.getByLabel("Owner consent record")).toHaveCount(0);
  await expect(settings.getByLabel("Registered agent id")).toHaveCount(0);
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(firstTask.getByLabel("Task owner", { exact: true })).toHaveValue("directory-owner");
    const overflow = await page.evaluate(() => [...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 8).map(e => ({ tag: e.tagName, className: e.className, right: e.getBoundingClientRect().right })));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), JSON.stringify(overflow)).toBeTruthy();
  }
  await settings.getByRole("button", { name: "Enable Gmail for this case" }).click();
  await expect(settings.getByRole("alert").filter({ hasText: "different escalation contact" })).toBeVisible();
  await page.getByLabel("Case", { exact: true }).selectOption(String(fixture.caseIds[1]));
  await expect(settings.getByLabel("Task owner", { exact: true })).toHaveCount(0);
  await page.getByLabel("Case", { exact: true }).selectOption(String(id));
  await expect(settings.locator("fieldset").first().getByLabel("Task owner", { exact: true })).toHaveValue("directory-owner");
  expect((await get(id)).enrollment.enabled).toBe(false);
  await page.goto("/client-setup");
  const defaults = page.getByLabel("Client Gmail defaults", { exact: true });
  await defaults.locator("summary").click();
  await defaults.getByLabel("Default registered agent").selectOption({ label: "Conversation agent" });
  await defaults.locator("fieldset").first().getByRole("checkbox").check();
  await defaults.locator("fieldset").first().getByLabel("Task owner", { exact: true }).selectOption({ label: "Alex Owner" });
  await defaults.locator("fieldset").first().getByLabel("Escalation contact", { exact: true }).selectOption({ label: "Jordan Escalation" });
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  }
  const defaultValue = { revision: 2, agentId: "owned-directory-agent", recipients: [{
    taskId: "access-inventory", memberId: "directory-owner", address: "owner@example.test", persona: "Access inventory",
    escalationMemberId: "directory-escalation", escalationAddress: "escalation@example.test",
  }] };
  await page.route("**/api/offboarding/exchanges/defaults", async route => {
    expect(route.request().postDataJSON()).not.toHaveProperty("consentReference");
    await route.fulfill({ json: defaultValue });
  });
  await defaults.getByRole("button", { name: "Save client defaults" }).click();
  await expect(defaults.getByRole("status")).toHaveText("Client Gmail defaults saved.");
  await page.getByLabel("Case", { exact: true }).selectOption(String(fixture.caseIds[2]));
  await expect(settings.getByLabel("Registered agent", { exact: true })).toHaveValue("owned-directory-agent");
  await expect(settings.locator("fieldset").first().getByLabel("Task owner", { exact: true })).toHaveValue("directory-owner");
  expect((await get(fixture.caseIds[2])).enrollment.enabled).toBe(false);
  await page.goto(`/cases/separations/${id}`);
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
  await expect(page.locator('section[aria-label="Enrollment"]')).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Manage Gmail contacts in Client Setup" })).toHaveAttribute("href", `/client-setup?offboardingCaseId=${id}#gmail-communication`);
  for (const size of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(size);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    await expect(page.locator('section[aria-label="Enrollment"]')).toHaveCount(0);
    await expect(actions.getByRole("button", { name: "Request", exact: true })).toBeDisabled();
  }
  expect((await get(id)).enrollment.enabled).toBe(false);
  const exchanges = (await get(id)).exchanges;
  expect(exchanges.filter((m: { direction: string }) => m.direction === "outbound")).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Access and equipment" })).toBeVisible();
  expect((await get(id)).tasks.find((t: { id: string }) => t.id === "asset-inventory").status).toBe("resolved");
  for (const [caseId, expected] of [[fixture.caseIds[1], "pending"], [fixture.caseIds[2], "review"]] as const) {
    await page.goto(`/cases/separations/${caseId}`);
    await expect(page.getByRole("heading", { name: "Access and equipment" })).toBeVisible();
    await expect(page.locator('section[aria-label="Enrollment"]')).toHaveCount(0);
    await page.locator('section[aria-label="Actions"] select').selectOption("asset-inventory");
    await page.getByRole("button", { name: "Inspect selected interface" }).click();
    await expect(page.getByText("Interface response recorded.", { exact: true })).toBeVisible();
    await page.locator('section[aria-label="Actions"] select').selectOption("asset-return");
    await page.getByRole("button", { name: "Inspect selected interface" }).click();
    await expect.poll(async () => (await get(caseId)).tasks.find((t: { id: string }) => t.id === "asset-return").status).toBe(expected);
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    }
  }
});
