import { expect, test, type Page } from "@playwright/test";

test.skip(process.env.ADMIN_EDIT_E2E_TEST !== "true", "Requires the disposable admin-edit harness.");

type Fixture = {
  organizationId: string;
  actorUserId: string;
  itemId: string;
  active: { caseId: number; evidenceId: number };
  historical: { caseId: number; evidenceId: number };
};

async function state(page: Page, caseId: number) {
  const response = await page.request.get(`/api/test/admin-edit/state/${caseId}`);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

async function save(page: Page, path: string, click: () => Promise<void>, method = "PUT") {
  const responsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === path && response.request().method() === method, { timeout: 20_000 });
  await click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(200);
}

for (const mode of ["development", "private"]) {
  test(`${mode} verified administrator edits survive reload; retained samples stay immutable`, async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Demo Reviewer/ }).click();
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(page.getByTestId("active-client-name")).toBeVisible();
    await page.goto("/api/test/ready"); // stop unrelated client polling before switching proof mode
    const session = await page.request.post("/api/test/admin-read/session", { data: { mode } });
    expect(session.status(), await session.text()).toBe(200);
    const fixture: Fixture = await session.json();
    await page.evaluate(org => localStorage.setItem("activeOrganizationId", org), fixture.organizationId);
    const { caseId, evidenceId } = fixture.active;
    const path = `/api/onboarding/cases/${caseId}`;
    const before = await state(page, caseId);
    expect(before.providerBoundary).toBe("deny-external-providers");
    expect(before.schema).toMatch(/^browser_regression_[0-9]+_[a-f0-9]+$/);
    expect(before.cases[0].lifecycleStage).toBe("preboarding");
    expect(before.cases[0].controllerRetired).toBe(false);
    const headers = { "x-organization-id": fixture.organizationId };
    const permissionsResponse = await page.request.get(`${path}/access-permissions`, { headers });
    expect(permissionsResponse.status()).toBe(200);
    const permissions = await permissionsResponse.json();
    for (const key of ["flowEdit", "profileEdit", "notesEdit"]) expect(permissions.access[key]).toBe(true);
    for (const permission of Object.values(permissions.sensitive) as { edit: boolean }[]) expect(permission.edit).toBe(true);
    await page.goto(`/cases/${caseId}`);
    await expect(page.getByRole("heading", { name: "Active Admin Edit Fixture", exact: true })).toBeVisible();
    // Complete incidental initial reads before this sequential edit journey.
    await page.waitForLoadState("networkidle");

    // Profile facts: use the real correction dialog and its version precondition.
    const contextReason = `${mode}: verified fictional department correction`;
    const department = `${mode} edited department`;
    await page.getByRole("button", { name: "Correct context", exact: true }).click();
    const dialog = page.getByRole("dialog");
    // Existing labels are visual siblings, not associated HTML labels.
    await dialog.locator("label").filter({ hasText: /^Department$/ }).locator("..").locator("input").fill(department);
    await dialog.getByPlaceholder("Explain the verified source of this correction").fill(contextReason);
    await save(page, `${path}/workforce-context`, () =>
      dialog.getByRole("button", { name: "Save correction", exact: true }).click());
    await expect(dialog).toHaveCount(0);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Correct context", exact: true }).click();
    await expect(page.getByRole("dialog").locator("label").filter({ hasText: /^Department$/ })
      .locator("..").locator("input")).toHaveValue(department);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    const afterProfile = await state(page, caseId);
    expect(afterProfile.cases[0].workforceContext.department).toBe(department);
    expect(afterProfile.cases[0].workforceContextVersion).toBe(before.cases[0].workforceContextVersion + 1);
    expect(afterProfile.cases[0].checklistSnapshot).toEqual(expect.arrayContaining(before.cases[0].checklistSnapshot));

    // An optional manually editable item cannot release the independent rebase gate.
    const checklistNote = `${mode}: local manual checklist note`;
    await page.getByTestId(`input-checklist-note-${fixture.itemId}`).fill(checklistNote);
    await save(page, `${path}/checklist/${fixture.itemId}`, () =>
      page.getByTestId(`button-complete-checklist-${fixture.itemId}`).click());
    await expect(page.getByTestId(`button-reopen-checklist-${fixture.itemId}`)).toBeVisible();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId(`button-reopen-checklist-${fixture.itemId}`)).toBeVisible();
    await expect(page.getByText(`• ${checklistNote}`, { exact: true })).toBeVisible();

    // Evidence note: request correction, never assert authenticity or approve
    // quarantined/unscanned evidence, and never dispatch a notification.
    const evidenceNote = `${mode}: fictional source needs a legible replacement`;
    await page.getByRole("button", { name: "Documents", exact: true }).click();
    await page.getByRole("button", { name: "Human Review", exact: true }).click();
    await page.getByTestId(`input-document-decision-reason-${evidenceId}`).fill(evidenceNote);
    await save(page, `${path}/evidence/${evidenceId}/decision`, () =>
      page.getByRole("button", { name: "Request Correction", exact: true }).click(), "POST");
    await expect(page.getByText(evidenceNote, { exact: false }).first()).toBeVisible();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Documents", exact: true }).click();
    await expect(page.getByText(evidenceNote, { exact: false }).first()).toBeVisible();

    const persisted = await state(page, caseId);
    expect(persisted.cases[0].workforceContext.department).toBe(department);
    expect(persisted.cases[0].readiness.find((item: any) => item.key === fixture.itemId))
      .toMatchObject({ status: "ready", note: checklistNote });
    expect(persisted.documents[0].note).toBe(evidenceNote);
    expect(persisted.uploads[0]).toMatchObject({
      validationState: "correction_requested",
      validationReasons: [{ code: "hr_decision", message: evidenceNote }],
    });
    expect(persisted.uploads[0].validatedAt).not.toBeNull();
    expect(persisted.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Authorized workforce context correction recorded", detail: expect.stringContaining("Isolated Administrator") }),
      expect.objectContaining({ title: "Checklist item completed", detail: expect.stringContaining(`Isolated Administrator completed`) }),
      expect.objectContaining({ title: "Document request correction", detail: evidenceNote }),
    ]));
    for (const objectType of ["case", "checklist", "evidence"]) {
      const writes = persisted.audit.filter((entry: any) => entry.objectType === objectType &&
        entry.outcome === "success" && ["PUT", "POST"].includes(entry.payload.method) &&
        !before.audit.some((old: any) => old.id === entry.id));
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ actorId: fixture.actorUserId, actorKind: "authenticated", source: "http" });
      expect(writes[0].actorAuthority).not.toBe("tenant-membership:unverified");
    }
    expect(persisted.communications).toEqual([]);
    expect(persisted.effects).toEqual([]);

    // Direct requests ensure disabled historical controls are not the only
    // protection. Same verified session, same bodies, same real endpoints.
    await page.goto("/api/test/ready");
    const retained = await state(page, fixture.historical.caseId);
    const historicalPath = `/api/onboarding/cases/${fixture.historical.caseId}`;
    const writeHeaders = { ...headers, origin: new URL(page.url()).origin };
    const writes = [
      { endpoint: "/workforce-context", data: { workforceContext: { workCountry: "US", department: "Forbidden edit" },
        expectedUpdatedAt: retained.cases[0].updatedAt, reason: "Must not mutate retained profile" } },
      { endpoint: `/checklist/${fixture.itemId}`, data: { status: "ready", note: "Forbidden checklist note" } },
      { endpoint: `/evidence/${fixture.historical.evidenceId}/decision`,
        method: "POST",
        data: { decision: "request_correction", reason: "Forbidden evidence note" } },
    ];
    for (const write of writes) {
      const denied = await page.request.fetch(`${historicalPath}${write.endpoint}`, {
        method: "method" in write ? write.method : "PUT", headers: writeHeaders, data: write.data,
      });
      expect(denied.status(), await denied.text()).toBe(410);
      expect(await denied.json()).toMatchObject({
        code: "CASE_TEST_CAPABILITY_RETIRED",
        message: "This capability has been retired. Existing history is read-only and non-operational.",
      });
    }
    // The protected audit outcome is appended after the HTTP response finishes.
    // Wait for that durable result, not an arbitrary sleep or an early snapshot.
    await expect.poll(async () => {
      const snapshot = await state(page, fixture.historical.caseId);
      return snapshot.audit.filter((entry: any) => entry.outcome === "denied" &&
        !retained.audit.some((old: any) => old.id === entry.id)).length;
    }).toBe(3);
    const unchanged = await state(page, fixture.historical.caseId);
    for (const key of ["cases", "documents", "uploads", "events", "communications", "effects"]) {
      expect(unchanged[key]).toEqual(retained[key]);
    }
    const deniedAudit = unchanged.audit.filter((entry: any) => !retained.audit.some((old: any) => old.id === entry.id));
    expect(deniedAudit.filter((entry: any) => entry.outcome === "denied")).toHaveLength(3);
    expect(deniedAudit.some((entry: any) => entry.outcome === "success")).toBe(false);
    for (const entry of deniedAudit) expect(entry.actorId).toBe(fixture.actorUserId);
  });
}
