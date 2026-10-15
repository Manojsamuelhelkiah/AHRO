import { expect, test, type Page } from "@playwright/test";

const CASE_ID = 990071;
const REVIEWER_EMAIL = "demo.reviewer@example.com";
const VIEWPORTS = [
  { width: 390, height: 844, label: "phone" },
  { width: 768, height: 1024, label: "tablet" },
  { width: 1280, height: 900, label: "desktop" },
];

function candidateMessage(id: number, status: string, audience = "candidate", subject = "Offer package") {
  return {
    id, caseId: CASE_ID, channel: "email", direction: "outbound", audience,
    status, subject, body: `Synthetic ${status} email outcome ${id}`,
    toAddress: "person@northstar.example", createdAt: "2026-06-01T12:00:00.000Z",
    failureReason: ["blocked", "failed", "logged-only"].includes(status) ? `Synthetic ${status} reason` : null,
  };
}

test("candidate email defaults, outcomes and retry controls stay clear and usable at responsive sizes", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#login-email")).toBeVisible();
  await page.getByRole("button", { name: /Demo Reviewer/ }).click();
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page.getByTestId("active-client-name")).toHaveText("Demo Organization");

  let candidateEmail = "person@northstar.example";
  let gateReason = "Candidate email is enabled by the provided address. Sending email is not acceptance; a dedicated HR confirmation is required and onboarding remains held.";
  let sendOutcome = "sending";
  let sendFailure: string | null = null;
  let holdSend = false;
  let releaseHeldSend: (() => void) | undefined;
  let nextMessageId = 20;
  const communications = [
    candidateMessage(1, "blocked"),
    candidateMessage(2, "failed"),
    candidateMessage(3, "logged-only"),
    candidateMessage(4, "sending"),
    candidateMessage(5, "failed", "admin", "[AP-52] Admin notification"),
  ];
  const sendRequests: string[] = [];
  const retryRequests: string[] = [];
  const permissions = {
    caseId: CASE_ID,
    access: { flowRead: true, profileRead: true, profileEdit: false, notesRead: true, notesEdit: true, flowEdit: true },
    sensitive: Object.fromEntries(["identity", "medical", "payroll", "bgv"].map((key) => [key, { read: true, edit: true }])),
  };
  const caseProjection = () => ({
    id: CASE_ID, controllerRetired: false, caseFamily: null, requestType: null, batchIntake: null,
    workerName: "Synthetic Candidate", workerEmail: candidateEmail, workerPhone: null,
    channelPreference: "whatsapp", hireType: "external-fte", workerCategory: "employee",
    workerBand: null, role: "Analyst", department: "People", geography: "US", legalEntity: "Demo",
    managerName: "Synthetic Manager", recruiterName: "Synthetic Recruiter", joiningDate: "2035-01-01",
    urgency: "normal", lifecycleStage: "preboarding", orchestrationStatus: "waiting-approval",
    readiness: [], workstreams: [], primarySkill: null, skillCriticality: null, scenarioKey: null,
    offlineSample: false, fictionalOfflineIdentity: false, planSummary: null,
    checklistTemplateVersion: 1, checklistSnapshot: [], checklistProfileId: "synthetic",
    checklistProfileName: "Synthetic", checklistProfileVersion: 1, checklistMatchedCriteria: {},
    checklistMatchExplanation: "", workforceContext: {}, workforceClassification: null,
    workforceContextVersion: 1, processPolicySnapshot: {}, jobProfileId: null, jobProfileVersion: null,
    orchestrationCheckpoint: null, candidateEmailAuthorized: true, offerAcceptanceComplete: false,
    offerAcceptanceCompletedAt: null, offerAcceptanceCompletedBy: null,
    gateways: {
      a: { status: "human-review", label: "Gate A — offer acceptance", reason: gateReason },
      b: { status: "pending", label: "Gate B — background verification", reason: "Awaiting live source." },
      c: { status: "pending", label: "Gate C — Day-1 readiness", reason: "Awaiting review." },
    },
    createdAt: "2026-06-01T12:00:00.000Z", updatedAt: "2026-06-01T12:00:00.000Z",
  });

  // Test-only API projections and receipts: every target POST is fulfilled here,
  // so neither authorization nor any real mail provider is contacted.
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "POST" && path === `/api/onboarding/cases/${CASE_ID}/offer-package-request`) {
      sendRequests.push(path);
      if (holdSend) await new Promise<void>((resolve) => { releaseHeldSend = resolve; });
      const id = Number(retryMatch[1]);
      communications.push({ ...candidateMessage(id, sendOutcome), failureReason: sendFailure });
      await route.fulfill({ status: 200, json: { id, caseId: CASE_ID, status: sendOutcome, failureReason: sendFailure } });
      return;
    }
    const retryMatch = path.match(new RegExp(`^/api/onboarding/cases/${CASE_ID}/communications/(\\d+)/retry$`));
    if (request.method() === "POST" && retryMatch) {
      const id = Number(retryMatch[1]);
      retryRequests.push(path);
      const row = communications.find((message) => message.id === id);
      if (row) Object.assign(row, { status: "sent", failureReason: null, retriedAt: "2026-06-01T12:05:00.000Z" });
      await route.fulfill({ status: 200, json: { id, caseId: CASE_ID, status: "sent", retriedAt: "2026-06-01T12:05:00.000Z", createdAt: "2026-06-01T12:00:00.000Z" } });
      return;
    }
    if (request.method() === "POST") {
      await route.fulfill({ status: 200, json: {} });
      return;
    }
    if (path === `/api/onboarding/cases/${CASE_ID}`) return void await route.fulfill({ json: caseProjection() });
    if (path === `/api/onboarding/cases/${CASE_ID}/access-permissions`) return void await route.fulfill({ json: permissions });
    if (path === `/api/onboarding/cases/${CASE_ID}/governance-impact`) {
      return void await route.fulfill({ json: { caseId: CASE_ID, snapshot: null, impacts: [] } });
    }
    if (path === `/api/onboarding/cases/${CASE_ID}/communications`) return void await route.fulfill({ json: communications });
    if (path === `/api/onboarding/cases/${CASE_ID}/governance-impact`) {
      return void await route.fulfill({ json: { snapshot: null, impacts: [] } });
    }
    if (path === `/api/onboarding/cases/${CASE_ID}/operational-requests`) {
      return void await route.fulfill({ json: { requests: [], offlinePaused: false, version: 1, capabilities: { aiCall: { hrefTemplate: "/cases/{caseId}" } } } });
    }
    if (path === `/api/onboarding/cases/${CASE_ID}/standard-operations`) return void await route.fulfill({ status: 503, json: { message: "Synthetic safeguards projection unavailable." } });
    if (path === `/api/onboarding/cases/${CASE_ID}/bgv-notifications`) return void await route.fulfill({ status: 404, json: { message: "No synthetic BGV notification configuration." } });
    if (path === `/api/onboarding/cases/${CASE_ID}/standard-intake-evidence`) return void await route.fulfill({ status: 404, json: { message: "Not applicable" } });
    if (path.startsWith(`/api/onboarding/cases/${CASE_ID}/`)) return void await route.fulfill({ json: [] });
    if (path.includes("/onboarding/approvals")) return void await route.fulfill({ json: [] });
    if (path.includes("/onboarding/channels")) return void await route.fulfill({ json: { whatsapp: { enabled: false }, email: { enabled: true } } });
    if (path.includes("/privacy/lifecycle/holds")) return void await route.fulfill({ json: [] });
    await route.continue();
  });

  for (const viewport of VIEWPORTS) {
    communications.splice(0, communications.length,
      candidateMessage(1, "blocked"), candidateMessage(2, "failed"),
      candidateMessage(3, "logged-only"), candidateMessage(4, "sending"),
      candidateMessage(5, "failed", "admin", "[AP-52] Admin notification"));
    await page.setViewportSize(viewport);
    const sentBeforeOpen = sendRequests.length;
    const retriesBeforeOpen = retryRequests.length;
    await page.goto(`/cases/${CASE_ID}?tab=communications`);
    const logistics = page.getByRole("button", { name: /^Status, gateways and logistics/ });
    await expect(logistics).toHaveAttribute("aria-expanded", "false");
    await logistics.click();
    await expect(page.getByText("Offer-Acceptance Package", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Background Checks", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Day-1 Readiness", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Gateway [ABC]|Gate [ABC]/)).toHaveCount(0);
    const stageBoxes = await Promise.all(["Offer-Acceptance Package", "Background Checks", "Day-1 Readiness"]
      .map(label => page.getByText(label, { exact: true }).first().locator("xpath=../..").boundingBox()));
    for (const box of stageBoxes) {
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      expect(box!.width).toBeGreaterThan(180);
    }
    if (viewport.width < 1024) expect(stageBoxes[0]!.x).toBe(stageBoxes[1]!.x);
    await expect(page.getByText(/A deliverable candidate address enables email by default, including with WhatsApp selected/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Request offer-package email" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Communication History" })).toBeVisible();
    expect(sendRequests.length).toBe(sentBeforeOpen);
    expect(retryRequests.length).toBe(retriesBeforeOpen);

    const requestButton = page.getByRole("button", { name: "Request offer-package email" });
    await requestButton.scrollIntoViewIfNeeded();
    const requestBox = await requestButton.boundingBox();
    expect(requestBox).not.toBeNull();
    expect(requestBox!.x).toBeGreaterThanOrEqual(0);
    expect(requestBox!.x + requestBox!.width).toBeLessThanOrEqual(viewport.width);
    await expect(page.getByRole("button", { name: "Retry email" })).toHaveCount(3);
    await expect(page.getByText("Synthetic failed email outcome 5")).toBeVisible();
    expect(await page.getByRole("button", { name: "Retry email" }).count()).toBe(3);

    holdSend = true;
    sendOutcome = "sending";
    sendFailure = "Delivery outcome uncertain";
    await requestButton.click();
    await expect(page.getByRole("button", { name: "Requesting email…" })).toBeDisabled();
    await page.getByRole("button", { name: "Requesting email…" }).click({ force: true });
    expect(sendRequests.length).toBe(sentBeforeOpen + 1);
    holdSend = false;
    releaseHeldSend?.();
    await expect(page.getByRole("status").filter({ hasText: "Delivery outcome is uncertain" })).toBeVisible();
    await expect(page.getByText("sending", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("human review", { exact: true })).toBeVisible();
    await expect(page.getByText(/Email sending does not confirm offer acceptance/)).toBeVisible();

    for (const expectedCount of [2, 1, 0]) {
      const retry = page.getByRole("button", { name: "Retry email" }).first();
      // Refetch after the preceding retry can replace the button during scrolling.
      // Retry only the read-only layout check, never the delivery mutation.
      await expect(async () => {
        await retry.scrollIntoViewIfNeeded();
        const retryBox = await retry.boundingBox();
        expect(retryBox).not.toBeNull();
        expect(retryBox!.x).toBeGreaterThanOrEqual(0);
        expect(retryBox!.x + retryBox!.width).toBeLessThanOrEqual(viewport.width);
      }).toPass({ timeout: 10_000 });
      await retry.click();
      await expect(page.getByRole("button", { name: "Retry email" })).toHaveCount(expectedCount);
    }
    expect(retryRequests.length).toBe(retriesBeforeOpen + 3);

    for (const [email, reason] of [
      ["not-an-email", "Candidate email on the onboarding record is invalid — message logged, not delivered."],
      ["candidate@example.invalid", "Candidate email uses a reserved placeholder domain — message logged, not delivered."],
    ]) {
      candidateEmail = email;
      gateReason = reason;
      const sendsBeforeReload = sendRequests.length;
      const retriesAtReload = retryRequests.length;
      await page.reload();
      await page.getByRole("button", { name: /^Status, gateways and logistics/ }).click();
      await expect(page.getByText(reason, { exact: false })).toBeVisible();
      expect(sendRequests.length).toBe(sendsBeforeReload);
      expect(retryRequests.length).toBe(retriesAtReload);
      sendOutcome = "blocked";
      sendFailure = reason;
      await page.getByRole("button", { name: "Request offer-package email" }).click();
      await expect(page.getByRole("status").filter({ hasText: "blocked" })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: reason })).toBeVisible();
    }

    const overflow = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(overflow.documentWidth, `${viewport.label}: changed candidate email controls must not cause horizontal overflow`).toBeLessThanOrEqual(overflow.viewportWidth + 1);
    await page.screenshot({ path: testInfo.outputPath(`candidate-email-${viewport.label}.png`), fullPage: true });
  }
});
