import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function readOnlySession(page: Page) {
  const response = await page.request.post("/api/test/offboarding-session", { data: { profile: "offboarding-operator" } });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await page.addInitScript(({ organizationId }) => {
    localStorage.setItem("onboarding-e2e-demo-profile", "offboarding-operator");
    localStorage.setItem("activeOrganizationId", organizationId);
  }, session);
  const result = await page.request.get("/api/onboarding/action-center?scope=all", {
    headers: { "x-organization-id": session.organizationId },
  });
  expect(result.ok()).toBeTruthy();
  return result.json();
}

// UI snapshots exercise filtering/races without creating cases or sends.
// The real isolated route suite separately proves authorization, record
// projection, pre-limit family filtering, revocation and three separations.
test("unified family filter preserves navigation and typed empty states at 390, 768 and 1280px", async ({ page }) => {
  const base = await readOnlySession(page);
  const summaries = [
    ...[901, 902, 903].map(caseId => ({ caseId, caseType: "Offboarding", label: `S${caseId}`,
      status: "held", caseHref: `/cases/separations/${caseId}` })),
    { caseId: 904, caseType: "Onboarding", label: "S904", status: "held", caseHref: "/cases/904" },
    { caseId: 905, caseType: "Payroll", label: "S905", status: "held", caseHref: "/cases/905" },
  ];
  let mode: "available" | "denied" | "failed" = "available";
  await page.route(url => url.pathname === "/api/onboarding/action-center", async route => {
    if (mode === "failed") {
      await route.fulfill({ status: 503, json: { message: "private source error" } }); return;
    }
    const params = new URL(route.request().url()).searchParams;
    const type = params.get("caseType");
    const matches = summaries.filter(s => !type || s.caseType === type);
    await route.fulfill({ json: { ...base, caseSummaries: mode === "denied" ? [] : matches,
      domainRecords: [], offboardingSource: mode === "denied" ? "denied" : "available",
      workItems: [], approvals: [], missingDocuments: [], pendingDocumentReviews: [], lowReadiness: [],
      notifications: [], communicationFailures: [], resumed: [], completedCommunications: [],
      counts: Object.fromEntries(Object.keys(base.counts).map(k => [k, 0])) } });
  });
  await page.route(url => url.pathname === "/api/onboarding/approvals", r => r.fulfill({ json: [] }));
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/approvals");
    const select = page.getByRole("combobox", { name: "Case type", exact: true });
    await expect(select).toHaveValue("");
    await expect(select.locator("option")).toHaveText([
      "All case types", "Onboarding", "Employee Changes", "Payroll", "Benefits", "Leave", "Compliance",
      "Offboarding", "HR Helpdesk", "IT Access", "Learning", "Mobility", "Documents",
    ]);
    await expect(page.getByText("Case summaries (5)", { exact: true })).toBeVisible();
    for (const type of ["Onboarding", "Payroll", "Offboarding"]) {
      await select.selectOption(type);
      await expect(page).toHaveURL(new RegExp(`caseType=${type}`));
      await expect(page.getByText(`Case summaries (${type === "Offboarding" ? 3 : 1})`, { exact: true })).toBeVisible();
    }
    for (const id of [901, 902, 903]) {
      await expect(page.getByRole("link", { name: `S${id}`, exact: true })).toHaveAttribute("href", `/cases/separations/${id}`);
    }
    await expect(page.getByText(/No recorded attention items match/)).toBeVisible();
    for (const tab of ["Approvals", "Communications", "Completed"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await expect(select).toHaveValue("Offboarding");
      await page.reload(); await expect(select).toHaveValue("Offboarding");
      if (tab === "Approvals") await expect(page.getByText(/No recorded approvals match/)).toBeVisible();
      if (tab === "Communications") await expect(page.getByText(/No recorded communications match/)).toBeVisible();
      if (tab === "Completed") await expect(page.getByText(/No recorded completed actions match/)).toBeVisible();
    }
    await page.getByRole("tab", { name: "Conversation", exact: true }).click();
    await expect(page.getByText("S901", { exact: false })).toBeVisible();
    await expect(page.getByText("S904", { exact: false })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    await page.screenshot({ path: `generated-artifacts/action-center-family-${width}.png`, fullPage: true });
    await page.goto("/approvals?tab=conversation&caseId=901&workItemId=8&approvalId=2&approvalRef=Gate-A&caseType=Offboarding");
    await select.selectOption("Payroll");
    const params = new URL(page.url()).searchParams;
    expect(params.get("caseId")).toBe("901"); expect(params.get("workItemId")).toBe("8");
    expect(params.get("approvalId")).toBe("2"); expect(params.get("approvalRef")).toBe("Gate-A");
    expect(params.get("tab")).toBe("conversation");
    await expect(page.getByText(/Case type filters apply to discovery/)).toBeVisible();
    await page.getByRole("button", { name: "Clear case type", exact: true }).click();
    expect(new URL(page.url()).searchParams.has("caseType")).toBe(false);
    expect(new URL(page.url()).searchParams.get("caseId")).toBe("901");
  }
  mode = "denied";
  await page.goto("/approvals?caseType=Offboarding");
  await expect(page.getByText(/Offboarding source access was denied/)).toBeVisible();
  await expect(page.getByRole("link", { name: "S901", exact: true })).toHaveCount(0);
  mode = "failed";
  await page.reload();
  await expect(page.getByText(/Action Center sources could not be loaded/)).toBeVisible();
  await expect(page.getByText("private source error")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "S901", exact: true })).toHaveCount(0);
});

test("late results from an obsolete family cannot restore another family", async ({ page }) => {
  const base = await readOnlySession(page);
  let release!: () => void;
  let began!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { began = r; });
  await page.route(url => url.pathname === "/api/onboarding/action-center", async route => {
    const type = new URL(route.request().url()).searchParams.get("caseType");
    if (type === "Onboarding") { began(); await held; }
    await route.fulfill({ json: { ...base, domainRecords: [], caseSummaries: [{
      caseId: type === "Offboarding" ? 901 : 904, caseType: type ?? "Onboarding",
      label: type === "Offboarding" ? "S901" : "OBSOLETE-S904", status: "held",
      caseHref: type === "Offboarding" ? "/cases/separations/901" : "/cases/904",
    }] } });
  });
  await page.goto("/approvals");
  const select = page.getByRole("combobox", { name: "Case type", exact: true });
  await select.selectOption("Onboarding"); await started;
  await select.selectOption("Offboarding");
  await expect(page.getByRole("link", { name: "S901", exact: true })).toBeVisible();
  release();
  await expect(page.getByRole("link", { name: "OBSOLETE-S904", exact: true })).toHaveCount(0);
  await expect(select).toHaveValue("Offboarding");
});
