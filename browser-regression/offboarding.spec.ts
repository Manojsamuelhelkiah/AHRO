import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

// The real router and pages run against a disposable migrated schema. Auth is
// test-cookie-only; every provider boundary is denied by the harness, not headers.
async function session(page: Page, profile = "offboarding-operator") {
  const r = await page.request.post("/api/test/offboarding-session", { data: { profile } });
  expect(r.ok()).toBeTruthy();
  const fixture = await r.json();
  await page.addInitScript(({ p, org }) => {
    // Initialize a new page realm only; do not undo a verified workspace
    // switch when the production switcher deliberately reloads the page.
    if (!localStorage.getItem("onboarding-e2e-demo-profile")) localStorage.setItem("onboarding-e2e-demo-profile", p);
    if (!localStorage.getItem("activeOrganizationId")) localStorage.setItem("activeOrganizationId", org);
  }, { p: profile, org: fixture.organizationId });
  if (page.url() !== "about:blank") {
    await page.evaluate(({ p, org }) => {
      localStorage.setItem("onboarding-e2e-demo-profile", p);
      localStorage.setItem("activeOrganizationId", org);
    }, { p: profile, org: fixture.organizationId });
  }
  return fixture;
}

test("controlled separation: intake, reviewed policy, workstream evidence, privacy and closure denial across viewports", async ({ page }) => {
  const fixture = await session(page);
  const facts = {
    employeeId: `BROWSER-${Date.now()}`, workerName: "Separation Regression Worker",
    exitType: "voluntary", exitReason: "Private separation regression reason",
    lastWorkingDay: "2020-01-15", terminationDate: "2020-01-16", timeZone: "America/New_York",
    role: "Engineer", department: "Quality", country: "US", legalEntity: "Isolated Test Entity",
    workerCategory: "employee", manager: "Receiving Test Manager",
  };
  await page.goto("/cases/separations/new");
  await expect(page.getByRole("heading", { name: "New separation", exact: true })).toBeVisible();
  for (const [key, value] of Object.entries(facts)) await page.getByTestId(`input-${key}`).fill(value);
  await page.getByTestId("input-source-reference").fill(`browser-source-${Date.now()}`);
  await page.getByTestId("button-submit-separation").click();
  await expect(page).toHaveURL(/\/cases\/separations\/\d+/);
  const id = Number(page.url().split("/").pop());
  const headers = { "X-Organization-Id": fixture.organizationId };
  const get = async () => {
    const r = await page.request.get(`/api/offboarding/cases/${id}`, { headers }); expect(r.ok()).toBeTruthy(); return r.json();
  };
  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    const d = await get();
    const r = await page.request.post(`/api/offboarding/cases/${id}/actions`, { headers, data: { action, expectedVersion: d.version, reference: `browser:${action}:${d.version}`, ...extra } });
    expect(r.ok(), await r.text()).toBeTruthy();
  };
  await act("screen", { sensitiveTriggers: [] });
  await act("classify", { classification: "Human-confirmed voluntary", urgency: "Standard", confirmed: true, flags: { privileged: false, highRisk: false, clientFacing: true, peopleManager: false, statutory: false } });
  const policy = { country: "US", role: facts.role, workerCategory: facts.workerCategory, timeZone: facts.timeZone, endOfLwd: "17:00", rulesReference: "isolated-test-source-rules", retentionReference: "isolated-test-retention-review", obligations: [], defaultAssets: ["unconfirmed laptop expectation"] };
  const draftResponse = await page.request.post("/api/offboarding/policies", { headers, data: { expectedVersion: 0, policy } });
  expect(draftResponse.ok(), await draftResponse.text()).toBeTruthy();
  const draft = await draftResponse.json();
  await session(page, "offboarding-legal");
  const approved = await page.request.post(`/api/offboarding/policies/${draft.id}/${draft.version}/decision`, { headers, data: { decision: "approve", reference: "independent-browser-legal-policy-review" } });
  expect(approved.ok(), await approved.text()).toBeTruthy();
  await session(page);
  await act("adopt-policy", { policyId: draft.id, policyVersion: draft.version });
  await page.reload();
  await expect(page.getByTestId("card-task-asset-inventory")).toBeVisible();
  await page.getByTestId("button-assign-asset-inventory").click();
  await page.getByTestId("input-owner-asset-inventory").fill(fixture.userId);
  await page.getByTestId("input-ref-asset-inventory").fill("browser-inventory-owner-review");
  await page.getByTestId("button-submit-task-asset-inventory").click();
  await expect(page.getByTestId("card-task-asset-inventory")).toContainText(fixture.userId);
  await page.getByTestId("button-evidence-asset-inventory").click();
  await page.getByTestId("check-asset-inventory-confirmed").check();
  await page.getByTestId("input-ref-asset-inventory").fill("browser-source-attested-inventory");
  await page.getByTestId("button-submit-task-asset-inventory").click();
  await expect(page.getByTestId("card-task-asset-inventory")).toContainText("verified");
  await mkdir("test-results/offboarding-visuals", { recursive: true });
  for (const size of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(size);
    for (const { path, heading, slug } of [
      { path: `/cases/separations/${id}`, heading: null, slug: "detail" },
      { path: "/cases/separations", heading: "Separations", slug: "list" },
      { path: "/cases/separations/intake", heading: "Separation intake", slug: "intake" },
      { path: "/cases/separations/policies", heading: "Offboarding policies", slug: "policies" },
       { path: "/settings/offboarding", heading: "Offboarding configuration", slug: "offboarding-settings" },
    ]) {
      await page.goto(path);
      if (heading) await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      else await expect(page.getByTestId("text-closure-blocker").first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
      await page.screenshot({ path: `test-results/offboarding-visuals/offboarding-${size.width}-${slug}.png`, fullPage: true });
    }
  }
  await page.goto(`/cases/separations/${id}`);
  const final = await get();
  const denied = await page.request.post(`/api/offboarding/cases/${id}/actions`, { headers, data: { action: "finalize", expectedVersion: final.version, reference: "browser-not-a-closure-override" } });
  expect(denied.status()).toBe(409);
  expect((await denied.json()).message).toContain("4.6");
  expect(final.finalizationAvailable).toBe(false);
  await session(page, "offboarding-viewer");
  const redacted = await get();
  expect(redacted.privateVisible).toBe(false);
  expect(redacted.privateFacts).toBeNull();
  expect(redacted.history).toEqual([]);
  expect(JSON.stringify(redacted)).not.toContain(facts.exitReason);
});

test("Settings and Cases share versioned offboarding proposals and independent decisions without leaking workspace drafts", async ({ page }) => {
  const fixture = await session(page);
  const headers = { "X-Organization-Id": fixture.organizationId };
  await page.goto("/settings");
  await expect(page.getByTestId("card-offboarding-settings")).toContainText("last-working-day");
  await expect(page.getByTestId("text-onboarding-only-settings")).toContainText("onboarding only");
  await page.getByTestId("link-settings-offboarding").click();
  await expect(page.getByRole("heading", { name: "Offboarding configuration", exact: true })).toBeVisible();
  await page.getByTestId("button-new-policy").click();
  const role = `Settings engineer ${Date.now()}`;
  for (const [field, value] of Object.entries({
    country: "US", role, workerCategory: "employee", timeZone: "America/New_York",
    endOfLwd: "17:30", rulesReference: "isolated-settings-rules", retentionReference: "isolated-settings-retention",
  })) await page.getByTestId(`input-policy-${field}`).fill(value);
  await page.getByTestId("input-policy-assets").fill("fixture laptop\nfixture badge");
  await page.getByTestId("button-add-obligation").click();
  for (const [field, value] of Object.entries({
    id: "settings-review", label: "Settings source review", stream: "legal",
    scope: "legal-approve", prerequisites: "access-inventory", dueOffsetDays: "-2",
  })) await page.getByTestId(`input-obligation-0-${field}`).fill(value);
  await page.getByTestId("button-submit-policy").click();
  await expect(page.getByTestId("input-policy-role")).toHaveCount(0);
  const list = await page.request.get("/api/offboarding/policies", { headers });
  expect(list.ok()).toBeTruthy();
  const draft = (await list.json()).find((p: { policy: { role: string } }) => p.policy.role === role);
  expect(draft.status).toBe("proposal");
  const card = page.getByTestId(`card-policy-${draft.id}-1`);
  await expect(card).toContainText("access-inventory");
  await expect(card).toContainText("-2 days from LWD");
  await expect(page.getByTestId(`button-approve-${draft.id}-1`)).toHaveCount(0);
  const self = await page.request.post(`/api/offboarding/policies/${draft.id}/1/decision`, {
    headers, data: { decision: "approve", reference: "forbidden-self-review" },
  });
  expect(self.status()).toBe(403);

  await session(page, "offboarding-legal");
  await page.goto("/cases/separations/policies");
  await page.getByTestId(`input-decision-ref-${draft.id}-1`).fill("independent-settings-policy-review");
  await page.getByTestId(`button-approve-${draft.id}-1`).click();
  await expect(page.getByTestId(`card-policy-${draft.id}-1`)).toContainText("approved");
  await page.goto("/settings/offboarding");
  await expect(page.getByTestId(`card-policy-${draft.id}-1`)).toContainText("approved");

  await session(page);
  await page.reload();
  await page.getByTestId(`button-revise-${draft.id}-1`).click();
  await page.getByTestId("input-policy-endOfLwd").fill("16:45");
  // A concurrent proposal must not be silently overwritten.
  const competing = await page.request.post("/api/offboarding/policies", {
    headers, data: { id: draft.id, expectedVersion: 1, policy: { ...draft.policy, endOfLwd: "16:30" } },
  });
  expect(competing.ok(), await competing.text()).toBeTruthy();
  await page.getByTestId("button-submit-policy").click();
  await expect(page.getByRole("alert").filter({ hasText: "Policy changed" })).toBeVisible();
  await expect(page.getByTestId("input-policy-endOfLwd")).toHaveValue("16:45");
  await page.getByRole("button", { name: "Refresh saved revisions" }).click();
  await expect(page.getByTestId(`card-policy-${draft.id}-2`)).toBeVisible();
  await expect(page.getByTestId("input-policy-endOfLwd")).toHaveValue("16:45");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByTestId(`button-revise-${draft.id}-2`).click();
  await page.getByTestId("input-policy-endOfLwd").fill("16:45");
  await page.getByTestId("button-submit-policy").click();
  await expect(page.getByTestId(`card-policy-${draft.id}-3`)).toContainText("proposal");
  await page.goto("/cases/separations/policies");
  await expect(page.getByTestId(`card-policy-${draft.id}-3`)).toContainText("16:45");

  await session(page, "offboarding-legal");
  await page.reload();
  await page.getByTestId(`input-decision-ref-${draft.id}-3`).fill("withdraw-unused-revision");
  await page.getByTestId(`button-withdraw-${draft.id}-3`).click();
  await expect(page.getByTestId(`card-policy-${draft.id}-3`)).toContainText("withdrawn");
  await page.goto("/settings/offboarding");
  await expect(page.getByTestId(`card-policy-${draft.id}-3`)).toContainText("withdrawn");
  // Real API filtered response and denied mutation; the UI must not offer bypass.
  await session(page, "offboarding-viewer");
  await page.reload();
  await expect(page.getByText("Permission-limited view.", { exact: false })).toBeVisible();
  await expect(page.getByTestId("button-new-policy")).toBeDisabled();
  await expect(page.locator('[data-testid^="button-revise-"]:enabled')).toHaveCount(0);
  const denied = await page.request.post("/api/offboarding/policies", { headers, data: { expectedVersion: 0, policy: draft.policy } });
  expect(denied.status()).toBe(403);
  await page.route("**/api/offboarding/policies", async route => {
    if (route.request().method() !== "GET") return route.continue();
    const real = await route.fetch();
    await route.fulfill({ response: real, status: 403, json: { message: "Policy access denied." } });
  });
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Access denied" })).toBeVisible();
  await expect(page.getByText("No policies are visible", { exact: false })).toHaveCount(0);
  await page.unroute("**/api/offboarding/policies");

  // Create a second disposable client through the real organization API.
  await session(page);
  const created = await page.request.post("/api/organizations", { data: { name: `Offboarding scope ${Date.now()}`, primaryCountry: "US" } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const { organization: second } = await created.json();
  await page.goto("/settings/offboarding");
  await page.getByTestId(`button-revise-${draft.id}-2`).click();
  await page.getByTestId("input-policy-role").fill("PRIVATE PREVIOUS CLIENT DRAFT");
  await page.getByRole("combobox", { name: "Active client workspace" }).selectOption(second.id);
  await expect(page.getByTestId("active-client-name")).toHaveText(second.name);
  await expect(page.getByTestId("input-policy-role")).toHaveCount(0);
  await expect(page.getByText("PRIVATE PREVIOUS CLIENT DRAFT")).toHaveCount(0);
  await expect(page.locator('[data-testid^="card-policy-"]')).toHaveCount(0);
  // A named workspace owner has client-local administrative rights, but no
  // policy records or unsaved edits from the previously selected client.
  await expect(page.getByText("No policies are visible", { exact: false })).toBeVisible();
  await expect(page.getByTestId("button-new-policy")).toBeEnabled();
  await expect(page.getByRole("alert").filter({ hasText: "Access denied" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Active client workspace" }).selectOption(fixture.organizationId);
  await expect(page.getByTestId(`card-policy-${draft.id}-2`)).toBeVisible();

  await mkdir("test-results/offboarding-visuals", { recursive: true });
  for (const size of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(size);
    for (const path of ["/settings/offboarding", "/cases/separations/policies"]) {
      await page.goto(path);
      await expect(page.getByTestId(`card-policy-${draft.id}-2`)).toBeVisible();
      await page.getByTestId(`button-revise-${draft.id}-2`).click();
      await expect(page.getByTestId("input-policy-timeZone")).toHaveValue("America/New_York");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
      await page.screenshot({ path: `test-results/offboarding-visuals/settings-${size.width}-${path.includes("/settings/") ? "settings" : "cases"}-editor.png`, fullPage: true });
    }
  }
});
