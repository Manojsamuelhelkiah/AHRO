import { expect, test } from '@playwright/test';

// Read-only navigation fixtures: no provisioning, provider calls or case actions.
const envelope = {
  id: 50401, workerName: 'Navigation Worker', workerEmail: '', role: 'Engineer',
  hireType: 'separation', geography: 'US', joiningDate: '2030-01-31',
  lifecycleStage: 'separation-held', orchestrationStatus: 'separation-only',
  createdAt: '2026-01-01T00:00:00.000Z', readiness: [], workstreams: [],
  originalIntent: 'Recorded resignation request', offlineSample: true, fictionalOfflineIdentity: true,
};
const separation = {
  ...envelope, version: 1, generation: 1, status: 'held', gatewayC: 'blocked',
  activity12: 'pending', privateVisible: false, sources: [], history: [], settlementReview: [],
  facts: { employeeId: 'NAV-1', workerName: envelope.workerName, exitType: 'resignation',
    exitReason: '', lastWorkingDay: envelope.joiningDate, terminationDate: envelope.joiningDate,
    timeZone: 'America/New_York', role: envelope.role, department: 'Engineering',
    country: 'US', legalEntity: 'Test', workerCategory: 'employee', manager: 'Manager' },
  state: { gatewayA: 'pending', tasks: [], holds: [], pauseReason: null, conflict: false,
    sensitiveTriggers: [], decisions: [], settlementVersions: [], policyCurrent: false },
};
const permissions = {
  caseId: envelope.id,
  access: { flowRead: true, profileRead: true, notesRead: false, flowEdit: false, profileEdit: false, notesEdit: false },
  sensitive: Object.fromEntries(['identity', 'medical', 'payroll', 'bgv'].map(key => [key, { read: false, edit: false }])),
};

test('single Cases destination preserves legacy and operational deep links across phone, tablet and desktop', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Demo Reviewer/ }).click();
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByTestId('active-client-name')).toHaveText('Demo Organization');

  let denied = false;
  const writes: string[] = [];
  const oldListReads: string[] = [];
  // A named administrator's shared header is represented here without granting
  // any live permissions or writes to the authenticated test principal.
  await page.route('**/api/organizations/current', route => route.fulfill({ json: {
    needsSetup: false, activeOrganizationId: 'demo', demoProfile: null,
    memberships: [{ organizationId: 'demo', name: 'Demo Organization', role: 'admin' }],
  } }));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    // Client Setup's existing POST is a read-only planning calculation.
    if (request.method() === 'POST' && path === '/api/scenario-flow-basis') return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && path.startsWith('/api/')) writes.push(request.url());
  });
  await page.route('**/api/onboarding/workforce-transfers/programs', route => route.fulfill({ json: [] }));
  await page.route('**/api/onboarding/cases', route => {
    expect(route.request().headers()['x-organization-id']).toBe('demo');
    return route.fulfill(denied ? { status: 403, json: { message: 'Access denied' } }
      : { json: [envelope, { ...envelope, id: 50402, workerName: 'Onboarding Worker', hireType: 'new-hire' }] });
  });
  await page.route(`**/api/onboarding/cases/${envelope.id}`, route => route.fulfill(denied
    ? { status: 403, json: { message: 'Access denied' } } : { json: envelope }));
  await page.route(`**/api/onboarding/cases/${envelope.id}/access-permissions`, route => route.fulfill({ json: { ...permissions, access: { ...permissions.access, flowRead: !denied } } }));
  await page.route(`**/api/onboarding/cases/${envelope.id}/documents`, route => route.fulfill({ json: [] }));
  await page.route(`**/api/offboarding/cases/${envelope.id}`, route => {
    expect(route.request().headers()['x-organization-id']).toBe('demo');
    return route.fulfill(denied ? { status: 403, json: { message: 'Access denied' } } : { json: separation });
  });
  await page.route('**/api/offboarding/cases', route => {
    oldListReads.push(route.request().url());
    return route.fulfill({ status: 500, json: { message: 'Redundant list must not be read' } });
  });
  await page.route('**/api/offboarding/policies', route => route.fulfill({ json: [] }));
  const caseRow = (id: number) => page.locator(`tr[aria-label^="Open case S${id}"]:visible`)
    .or(page.getByRole('button').filter({ hasText: `S${id}` }));
  const caseLink = () => caseRow(envelope.id);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/cases/separations?source=email&source=setup#saved');
    await expect(page).toHaveURL(/\/cases\?source=email&source=setup&caseType=Offboarding#saved$/);
    await expect(page.getByRole('heading', { name: 'Offboarding Cases', exact: true })).toBeVisible();
    await expect(caseLink()).toHaveCount(1);
    await expect(caseLink()).toContainText(`S${envelope.id}`);
    await expect(caseRow(50402)).toHaveCount(0);
    await expect(page.getByTestId('panel-provision-exchanges')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Offboarding \d+ cases$/ })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: /^All Cases\s/ }).click();
    await expect(page.getByRole('heading', { name: 'HR Operations Cases' })).toBeVisible();
    await expect(caseRow(50402)).toHaveCount(1);
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Offboarding Cases' })).toBeVisible();
    await page.getByRole('button', { name: /^Filters/ }).click();
    await page.getByRole('combobox', { name: 'Work item type' }).selectOption('Onboarding');
    await expect(page.getByRole('heading', { name: 'Onboarding Cases' })).toBeVisible();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: /^Offboarding \d+ cases$/ }).click();
    const nav = width < 768 ? page.getByRole('navigation', { name: 'Primary navigation' }) : page.locator('aside nav');
    await expect(nav.getByRole('link', { name: 'Cases', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Separations', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    if (width === 1440) expect(await caseLink().evaluate(link => link.closest('tr')!.getBoundingClientRect().height)).toBeLessThan(65);
    await page.screenshot({ path: `test-results/separation-navigation-${width}.png`, fullPage: true });
    await caseLink().click();
    await expect(page).toHaveURL(new RegExp(`/cases/separations/${envelope.id}$`));
    await expect(page.getByTestId('text-worker-name')).toHaveText(envelope.workerName);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `test-results/separation-detail-navigation-${width}.png`, fullPage: true });
    await page.getByRole('link', { name: 'Back to Cases' }).click();
    await expect(page).toHaveURL(/\/cases\?caseType=Offboarding$/);
  }
  await page.goto(`/cases/${envelope.id}?tab=Progress&section=history&source=email#receipt`);
  await expect(page).toHaveURL(new RegExp(`/cases/separations/${envelope.id}\\?tab=Progress&section=history&source=email#receipt$`));
  await expect(page.getByTestId('text-worker-name')).toBeVisible();
  await page.goto('/cases?caseType=Payroll');
  await page.goto('/cases/separations');
  await expect(page).toHaveURL(/\/cases\?caseType=Offboarding$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/cases\?caseType=Payroll$/);

  // Existing administrative entry points remain routes, not redirect casualties.
  await page.goto('/cases?caseType=Offboarding');
  await expect(page.getByRole('button', { name: 'Trusted Intake', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'New Case', exact: true }).click();
  await expect(page).toHaveURL(/\/cases\/separations\/new$/);
  await expect(page.getByRole('heading', { name: 'New Offboarding case', exact: true })).toBeVisible();
  await expect(page.getByTestId('link-sep-list')).toHaveAttribute('href', '/cases?caseType=Offboarding');
  await expect(page.getByTestId('link-sep-intake')).toHaveAttribute('href', '/cases/separations/intake');
  await expect(page.getByTestId('link-sep-policies')).toHaveAttribute('href', '/settings/offboarding');
  await page.getByTestId('link-sep-intake').click();
  await expect(page.getByRole('heading', { name: 'Offboarding intake', exact: true })).toBeVisible();
  await page.getByTestId('link-sep-new').click();
  await expect(page.getByRole('heading', { name: 'New Offboarding case', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(/\/cases\?caseType=Offboarding$/);
  await page.getByRole('button', { name: 'Batch Intake', exact: true }).click();
  await expect(page).toHaveURL(/\/cases\/separations\/intake$/);
  await expect(page.getByRole('heading', { name: 'Offboarding intake', exact: true })).toBeVisible();
  await page.getByTestId('link-sep-list').click();
  await expect(page).toHaveURL(/\/cases\?caseType=Offboarding$/);
  await page.goto('/cases/separations/policies?source=legacy');
  await expect(page.getByRole('heading', { name: 'Offboarding policies', exact: true })).toBeVisible();
  await page.goto('/settings/offboarding');
  await expect(page.getByRole('link', { name: 'View Offboarding cases' })).toHaveAttribute('href', '/cases?caseType=Offboarding');

  await page.route('**/api/offboarding/exchanges/setup*', route => route.fulfill({ json: {
    cases: [{ id: envelope.id, name: envelope.workerName }], agents: [], members: [],
    defaults: { revision: 1, enabled: false, escalationEnabled: false, agentId: null, recipients: [] },
  } }));
  await page.route(`**/api/offboarding/cases/${envelope.id}/exchanges`, route => route.fulfill({ json: {
    caseId: envelope.id, blockers: [], tasks: [],
    enrollment: { revision: 1, enabled: false, generation: 1, operator: null, agentId: null,
      mailbox: null, approvedAt: null, recipients: [], escalationEnabled: false },
  } }));
  await page.goto(`/client-setup?offboardingCaseId=${envelope.id}#gmail-communication`);
  const setup = page.getByLabel('Gmail enrollment', { exact: true });
  await expect(setup.getByRole('link', { name: 'View Offboarding cases' })).toHaveAttribute('href', '/cases?caseType=Offboarding');
  await setup.getByRole('link', { name: `Open case S${envelope.id}` }).click();
  await expect(page.getByTestId('text-worker-name')).toHaveText(envelope.workerName);
  await page.goto(`/client-setup?offboardingCaseId=${envelope.id}#gmail-communication`);
  await setup.getByRole('link', { name: 'View Offboarding cases' }).click();
  await expect(page).toHaveURL(/\/cases\?caseType=Offboarding$/);

  await page.route('**/api/onboarding/email-intake', route => route.fulfill({ json: { canReview: true, templates: [] } }));
  await page.route('**/api/onboarding/email-intake/requests/navigation-request', route => route.fulfill({ json: {
    id: 'navigation-request', version: 1, status: 'converted', caseId: envelope.id, caseKind: 'separation',
    family: 'Offboarding', fields: {}, fieldSources: {}, missingFields: [], duplicateCandidates: [],
    attachments: [], warnings: [], receivedAt: '2026-01-01T00:00:00.000Z',
  } }));
  await page.route('**/api/onboarding/email-intake/requests/navigation-request/source', route => route.fulfill({ json: { state: 'unavailable' } }));
  await page.goto('/email-intake/navigation-request');
  await expect(page.getByRole('link', { name: 'Open case', exact: true })).toHaveAttribute('href', `/cases/separations/${envelope.id}`);
  await page.getByRole('link', { name: 'Open case', exact: true }).click();
  await expect(page.getByTestId('text-worker-name')).toHaveText(envelope.workerName);

  // Cross-client/denied reads keep using the existing server-enforced denial.
  denied = true;
  await page.goto('/cases/separations');
  await expect(page.getByRole('heading', { name: 'Offboarding Cases' })).toBeVisible();
  await expect(caseLink()).toHaveCount(0);
  await page.goto(`/cases/${envelope.id}?source=denied`);
  await expect(page.getByRole('heading', { name: 'Case access restricted' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/cases/${envelope.id}\\?source=denied$`));
  await page.goto(`/cases/separations/${envelope.id}`);
  await expect(page.getByRole('alert').filter({ hasText: 'Access denied' })).toBeVisible();
  await expect(page.getByTestId('text-worker-name')).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to Cases' }).click();
  await expect(page).toHaveURL(/\/cases\?caseType=Offboarding$/);
  // APIRequestContext bypasses page mocks: exercise actual tenant middleware.
  for (const path of ['/api/onboarding/cases', `/api/offboarding/cases/${envelope.id}`]) {
    const response = await page.request.get(path, { headers: { 'x-organization-id': 'ungranted-navigation-client' } });
    expect(response.status()).toBe(403);
  }
  expect(writes).toEqual([]);
  expect(oldListReads).toEqual([]);
});
