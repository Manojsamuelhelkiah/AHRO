import { expect, test } from "@playwright/test";

test("registration enables unattended held conversion; responsive screens explain origin, quarantine and exceptions", async ({ page, browser }) => {
  const session = await page.request.post("/api/test/offboarding-session", { data: { profile: "offboarding-operator" } });
  expect(session.ok()).toBeTruthy();
  const fixture = await session.json();
  const headers = { "x-organization-id": fixture.organizationId, Origin: "http://127.0.0.1:4177" };
  await page.addInitScript(org => {
    localStorage.setItem("onboarding-e2e-demo-profile", "offboarding-operator");
    localStorage.setItem("activeOrganizationId", org);
  }, fixture.organizationId);
  const config = await page.request.post("/api/onboarding/email-intake", { headers,
    data: { reference: "controlled-automation-mailbox-review", backfillHours: 1 } });
  expect(config.ok(), await config.text()).toBeTruthy();
  const receive = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/test/email-intake-message", { data });
    expect(r.ok(), await r.text()).toBeTruthy();
    return (await r.json()).id as string;
  };
  const read = async (id: string) => {
    const r = await page.request.get(`/api/onboarding/email-intake/requests/${id}`, { headers });
    expect(r.ok()).toBeTruthy();
    return r.json();
  };
  const oldId = await receive({ templateId: "leave-request", unique: true });
  expect((await read(oldId)).caseId).toBeNull();
  await page.goto("/agents");
  await page.getByTestId("button-select-intake-conversion").click();
  await expect(page.getByTestId("registration-capability-notice")).toContainText("standing instruction");
  await page.getByTestId("input-principal-name").fill("Controlled Intake Conversion Agent");
  await page.getByTestId("select-owner").selectOption(fixture.userId);
  const registrationResponse = page.waitForResponse(r => r.request().method() === "POST" &&
    new URL(r.url()).pathname === "/api/agent-catalogue/registrations");
  await page.getByTestId("button-submit-registration").click();
  const registration = await registrationResponse;
  expect(registration.ok(), await registration.text()).toBeTruthy();
  const binding = (await registration.json()).binding;
  expect(binding.intakeAuthorization.capability).toBe("intake-conversion/v1");
  // No request is allowed to invoke Convert or Save Review for automatic work.
  const conversionCalls: string[] = [];
  page.on("request", request => {
    if (request.method() !== "GET" && /\/email-intake\/requests\//.test(request.url())) conversionCalls.push(request.url());
  });
  // Leave the app entirely while the server receives and processes a new mail.
  await page.goto("about:blank");
  const automatic = await receive({ templateId: "leave-request", unique: true, attachment: true });
  await expect.poll(async () => (await read(automatic)).status).toBe("converted");
  const result = await read(automatic);
  expect(result.conversionOrigin).toBe("automatic");
  expect(result.reviewed).toBe(false);
  expect(result.conversionAgentId).toBe(binding.agentId);
  expect(result.conversionOwnerUserId).toBe(fixture.userId);
  expect((await read(oldId)).caseId).toBeNull();
  const exception = await receive({ templateId: "benefits-life-event", unique: true, missingWorker: true });
  await expect.poll(async () => (await read(exception)).automationState).toBe("exception");
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/email-intake");
    await expect(page.getByTestId("section-intake-automation")).toContainText("enabled");
    await page.goto(`/email-intake/${automatic}`);
    await expect(page.getByTestId("text-case-result")).toContainText("Automatically converted");
    await expect(page.getByTestId("text-case-result").getByRole("link", { name: "Open case" })).toHaveAttribute("href", `/cases/${result.caseId}`);
    await expect(page.getByTestId("section-attachments")).toContainText("quarantined");
    await expect(page.getByTestId("button-save-review")).toHaveCount(0);
    await page.goto(`/email-intake/${exception}`);
    await expect(page.getByTestId("intake-automation-state")).toContainText("exception");
    await expect(page.getByTestId("button-save-review")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.goto("/agents");
    await page.getByTestId("button-select-intake-conversion").click();
    await expect(page.getByTestId("registration-capability-notice")).toContainText("standing instruction");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  expect(conversionCalls).toEqual([]);
  // A second real session sees the persisted result, not the first tab's state.
  const second = await browser.newContext({ storageState: await page.context().storageState() });
  const response = await second.request.get(`http://127.0.0.1:4177/api/onboarding/email-intake/requests/${automatic}`, { headers });
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).conversionOrigin).toBe("automatic");
  await second.close();
});
