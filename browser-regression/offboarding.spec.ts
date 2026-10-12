import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

// The real router and pages run against a disposable migrated schema. Auth is
// test-cookie-only; every provider boundary is denied by the harness, not headers.
async function session(page: Page, profile = "offboarding-operator") {
  const r = await page.request.post("/api/test/offboarding-session", { data: { profile } });
  expect(r.ok()).toBeTruthy();
  const fixture = await r.json();
  await page.addInitScript(({ p, org }) => {
    localStorage.setItem("onboarding-e2e-demo-profile", p);
    localStorage.setItem("activeOrganizationId", org);
  }, { p: profile, org: fixture.organizationId });
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
