import { expect, test } from "@playwright/test";

// Presentation fixtures are intercepted only in this disposable, provider-denied
// browser harness. They never change real case authority or send any action.
test("both case details expose readable versioned flows, holds and failures at three widths without performing case actions", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Super Admin/ }).click();
  // Only satisfies the existing isolated harness form; no platform credential.
  await page.locator("#login-password").fill("browser-harness-only-flow");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByTestId("active-client-name")).toHaveText("Demo Organization");
  const onboarding = await page.evaluate(async () => {
    const response = await fetch("/api/test/historical-case", { method: "POST", credentials: "include" });
    if (!response.ok) throw new Error(`Disposable historical fixture unavailable: ${response.status}`);
    return response.json();
  });
  const separationId = 50401;
  const envelope = {
    id: separationId, workerName: "Flow Navigation Worker", workerEmail: "", role: "Engineer",
    hireType: "separation", geography: "US", joiningDate: "2030-01-31",
    lifecycleStage: "separation-held", orchestrationStatus: "separation-only",
    createdAt: "2026-01-01T00:00:00.000Z", readiness: [], workstreams: [],
  };
  await page.route(`**/api/onboarding/cases/${separationId}`, r => r.fulfill({ json: envelope }));
  await page.route(`**/api/onboarding/cases/${separationId}/access-permissions`, r => r.fulfill({ json: {
    caseId: separationId,
    access: { flowRead: true, profileRead: true, notesRead: false, flowEdit: false, profileEdit: false, notesEdit: false },
    sensitive: Object.fromEntries(["identity", "medical", "payroll", "bgv"].map(key => [key, { read: false, edit: false }])),
  } }));
  await page.route(`**/api/offboarding/cases/${separationId}`, r => r.fulfill({ json: {
    ...envelope, version: 1, generation: 1, status: "held", gatewayC: "blocked", activity12: "pending",
    privateVisible: false, sources: [], history: [], settlementReview: [],
    facts: { employeeId: "FLOW-1", workerName: envelope.workerName, exitType: "resignation", exitReason: "",
      lastWorkingDay: envelope.joiningDate, terminationDate: envelope.joiningDate, timeZone: "America/New_York",
      role: "Engineer", department: "Engineering", country: "US", legalEntity: "Fixture", workerCategory: "employee", manager: "Manager" },
    state: { gatewayA: "pending", tasks: [], holds: [], pauseReason: null, conflict: false,
      sensitiveTriggers: [], decisions: [], settlementVersions: [], policyCurrent: false },
  } }));
  let mode: "executable" | "compatibility-review" | "failed" | "malformed" = "executable";
  let flowReads = 0;
  await page.route(/\/api\/onboarding\/cases\/\d+\/flow$/, r => {
    flowReads++;
    if (mode === "failed") return r.fulfill({ status: 403, json: { message: "Case flow access unavailable" } });
    if (mode === "malformed") return r.fulfill({ json: [] });
    const id = Number(new URL(r.request().url()).pathname.split("/").at(-2));
    const family = id === separationId ? "separation" : "onboarding";
    return r.fulfill({ json: {
      caseId: id, family, mode, compatibilityReason: mode === "executable" ? "Bound at admission" : "Unknown historical checkpoint requires review",
      definitionId: mode === "executable" ? `${family}.base` : undefined, definitionVersion: mode === "executable" ? 1 : undefined,
      progressRedacted: false,
      informationalNotice: "Informational only. Every operation rechecks current domain permissions and evidence.",
      stages: mode === "executable" ? [
        { id: "intake", label: "Confirmed intake", role: "HR", prerequisites: [], status: "complete", blockers: [] },
        { id: "workstreams", label: "Parallel dependent workstreams", role: "Task owners", prerequisites: ["intake"], status: "active", blockers: ["Current source evidence required"] },
      ] : [],
      tasks: mode === "executable" ? [
        { id: "documents", label: "Document review", role: "HR", status: "pending", prerequisites: [], blockers: ["Awaiting fresh evidence"] },
        { id: "access", label: "Access request", role: "IT", status: "pending", prerequisites: ["documents"], blockers: ["Prerequisite documents is incomplete"] },
      ] : [],
      actions: mode === "executable" ? [{ id: "review", stage: "workstreams", handler: `${family}.reconcile`, eligible: false,
        blockers: ["Fresh human review required"], requiredAuthority: ["current-human-permission"], requiredEvidence: ["source-attestation"] }] : [],
      history: mode === "executable" ? [{ actionId: "intake", outcome: "recorded", reason: "Recorded domain checkpoint, not a provider delivery receipt",
        definitionId: `${family}.base`, definitionVersion: 1, occurredAt: "2026-10-15T10:00:00.000Z" }] : [],
    } });
  });
  const writes: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.url());
  });
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [`/cases/${onboarding.caseId}`, `/cases/separations/${separationId}`]) {
      mode = "executable";
      await page.goto(path);
      const flow = page.getByTestId("disclosure-flow");
      await flow.getByRole("button", { name: /^Flow/ }).click();
      await expect(flow.getByTestId("flow-body")).toBeVisible();
      await expect(flow.getByTestId("flow-stage-workstreams")).toContainText("Parallel dependent workstreams");
      await expect(flow.getByText(/Fresh human review required/)).toBeVisible();
      await expect(flow.getByText(/Informational only/)).toBeVisible();
      await expect(flow.getByText("Recorded domain checkpoint, not a provider delivery receipt")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      await flow.screenshot({ path: `test-results/flow-${path.includes("separations") ? "separation" : "onboarding"}-${width}.png` });
    }
  }
  mode = "compatibility-review";
  await page.reload();
  const heldFlow = page.getByTestId("disclosure-flow");
  await heldFlow.getByRole("button", { name: /^Flow/ }).click();
  await expect(heldFlow.getByText("Unknown historical checkpoint requires review")).toBeVisible();
  await expect(heldFlow.getByTestId("flow-stage-workstreams")).toHaveCount(0);
  mode = "failed";
  await page.reload();
  const failedFlow = page.getByTestId("disclosure-flow");
  await failedFlow.getByRole("button", { name: /^Flow/ }).click();
  await expect(failedFlow.getByRole("alert")).toContainText("The flow could not be loaded");
  mode = "malformed";
  await page.reload();
  const malformedFlow = page.getByTestId("disclosure-flow");
  await malformedFlow.getByRole("button", { name: /^Flow/ }).click();
  await expect(malformedFlow.getByRole("alert")).toContainText("The Flow response did not match the expected contract");
  await expect(page.getByRole("heading", { name: "Something went wrong", exact: true })).toHaveCount(0);
  expect(flowReads).toBeGreaterThanOrEqual(9);
  expect(writes).toEqual([]);
});
