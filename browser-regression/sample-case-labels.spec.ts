import { expect, test } from '@playwright/test';

const summary = 'Clarify the proposed effective date against a reported 2030-11-25 cutoff; payroll acceptance is pending.';
const sample = {
  id: 3644, workerName: 'Example — Kiran Pine', workerEmail: 'sample@hro.invalid',
  role: 'Support Engineer', geography: 'Singapore', joiningDate: '2030-11-24',
  caseFamily: 'Employee Changes', requestType: 'Role change near payroll cutoff',
  hireType: 'internal-transfer', lifecycleStage: 'service-intake', orchestrationStatus: 'blocked',
  urgency: 'standard', createdAt: '2026-10-13T00:00:00Z', controllerRetired: true,
  offlineSample: true, fictionalOfflineIdentity: true, workstreams: [], readiness: [],
  planSummary: `${summary} Offline example only; all evidence and human decisions remain pending.`,
  batchIntake: {
    templateId: 'employee-changes-role', templateVersion: 1, requestType: 'Role change near payroll cutoff',
    requestId: 'UAT-DEMO-EXAMPLES:complementary-v1:2:10', executionMode: 'specialist-review-only',
    employeeReferenceStatus: 'supplied-not-verified',
    data: { request_id: 'UAT-DEMO-EXAMPLES:complementary-v1:2:10', worker_name: 'Example — Kiran Pine',
      employee_id: 'FICTIONAL-EMPLOYEE-2-10', change_reference: 'FICTIONAL-CUTOFF-10', effective_date: '2030-11-24' },
  },
};
const historical = { ...sample, id: 3645, workerName: 'Historical Worker', fictionalOfflineIdentity: false, batchIntake: undefined };
const genuine = { ...sample, id: 3646, workerName: 'Example — Genuine Worker', controllerRetired: false, offlineSample: false, fictionalOfflineIdentity: false, batchIntake: undefined };

test('sample labels, reference cleanup and read-only navigation at phone, tablet and desktop widths', async ({ page }) => {
  if (process.env.SAMPLE_LABELS_UI_ONLY === 'true') {
    await page.addInitScript(() => {
      localStorage.setItem('onboarding-e2e-demo-profile', 'reviewer');
      localStorage.setItem('activeOrganizationId', 'demo');
    });
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const json = path === '/api/organizations/current'
        ? { needsSetup: false, activeOrganizationId: 'demo', demoProfile: 'reviewer', memberships: [{ organizationId: 'demo', name: 'Demo Organization', role: 'member' }] }
        : path.endsWith('/settings/operations') ? { configuration: { defaults: { dateFormat: 'MMM d, yyyy' } } }
        : path.endsWith('/channels') ? { email: { status: 'offline' }, whatsapp: { status: 'offline' } }
        : [];
      await route.fulfill({ json });
    });
    await page.goto('/cases');
  } else {
    await page.goto('/');
    await page.getByRole('button', { name: /Demo Reviewer/ }).click();
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  }
  await expect(page.getByTestId('active-client-name')).toBeVisible({ timeout: 30_000 });
  let restricted = false;
  await page.route('**/api/onboarding/cases', route => route.fulfill({ json: [sample, historical, genuine] }));
  await page.route('**/api/onboarding/workforce-transfers/programs', route => route.fulfill({ json: [] }));
  await page.route(/\/api\/onboarding\/cases\/364[45](?:\/.*)?(?:\?.*)?$/, async route => {
    const path = new URL(route.request().url()).pathname;
    const c = path.includes('/3645') ? historical : sample;
    if (path.endsWith('/access-permissions')) {
      await route.fulfill({ json: { caseId: c.id,
        access: { flowRead: true, profileRead: !restricted, notesRead: true, flowEdit: false, notesEdit: false, profileEdit: false },
        sensitive: Object.fromEntries(['identity', 'medical', 'payroll', 'bgv'].map(key => [key, { read: false, edit: false }])) } });
    } else if (path.endsWith('/operational-preparation')) {
      await route.fulfill({ status: 404, json: { message: 'No operational preparation exists for this retained example.' } });
    } else if (path.endsWith('/governance-impact')) {
      await route.fulfill({ json: { caseId: c.id, snapshot: null, impacts: [] } });
    } else if (path.endsWith(String(c.id))) {
      await route.fulfill({ json: restricted ? { ...c, workerName: 'Restricted candidate', fictionalOfflineIdentity: false, batchIntake: undefined } : c });
    } else {
      await route.fulfill({ json: [] });
    }
  });
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/cases');
    const search = page.getByRole('textbox', { name: 'Search cases and programs' });
    await search.fill('S3644');
    await expect(page.getByText('Kiran Pine', { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(page.locator('[title*="Offline example only;"]')).toHaveCount(0);
    await expect(page.getByText('Example — Kiran Pine', { exact: true })).toHaveCount(0);
    await search.fill('Kiran Pine');
    const desktopLink = page.getByRole('link', { name: 'View details for case S3644' });
    if (width >= 1024) {
      await expect(page.getByRole('row', { name: /Open case S3644.*for Kiran Pine/ })).toBeVisible();
      await expect(desktopLink).toHaveAttribute('href', '/cases/3644');
      await desktopLink.click();
    } else {
      await page.getByRole('button', { name: /Role change near payroll cutoff.*Kiran Pine.*S3644/ }).click();
    }
    await expect(page).toHaveURL(/\/cases\/3644$/);
    await expect(page.getByText('Kiran Pine • Support Engineer • Singapore • Effective Nov 24, 2030', { exact: true })).toBeVisible();
    await expect(page.getByText('Offline — read-only; no outreach or business completion.', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Awaiting prerequisites', { exact: true })).toBeVisible();
    await expect(page.getByText('Activation, verified evidence and current human decisions are required.', { exact: true })).toBeVisible();
    await expect(page.getByText(`${summary} All evidence and human decisions remain pending.`, { exact: true })).toBeVisible();
    const intake = page.getByTestId('panel-hro-intake-request');
    await expect(intake.getByText('Case reference', { exact: true })).toBeVisible();
    await expect(intake.getByTestId('text-request-id')).toHaveText('S3644');
    await expect(intake).not.toContainText(/FICTIONAL-|UAT-DEMO-/);
    await expect(page.locator('body')).not.toContainText(/Offline example only;|Example · Offline — read-only and permanently|Retained events and private evidence|Manual Demo data; execution is intentionally disabled/);
    await expect(page.getByRole('button', { name: /Take Action|Contact|Approve|Start onboarding/i })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `test-results/sample-detail-${width}.png`, fullPage: true });
  }
  await page.goto('/cases');
  await page.getByRole('textbox', { name: 'Search cases and programs' }).fill('Genuine Worker');
  await expect(page.getByText('Example — Genuine Worker', { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByText('HRO-2026-03646', { exact: true }).filter({ visible: true })).toBeVisible();
  await page.goto('/cases/3645');
  await expect(page.getByText('Case #3645', { exact: true })).toBeVisible();
  await expect(page.getByText('This case is retained historical evidence.', { exact: false })).toBeVisible();
  await expect(page.getByText('Historical test record — read-only and permanently non-operational.', { exact: false })).toBeVisible();
  restricted = true;
  await page.goto('/cases/3644');
  await expect(page.getByText('Restricted candidate', { exact: true })).toBeVisible();
  await expect(page.getByText('Kiran Pine', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Worker Details' })).toHaveCount(0);
});
