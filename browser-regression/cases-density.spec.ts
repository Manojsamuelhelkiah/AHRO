import { expect, test } from '@playwright/test';

const fixture = {
  id: 358, workerName: 'Example Worker', workerEmail: 'worker@example.test',
  originalIntent: 'Confirm payroll setup before the employee starts',
  joiningDate: '2031-01-01', geography: 'CA', lifecycleStage: 'completed',
  orchestrationStatus: 'completed', createdAt: '2026-01-01T00:00:00.000Z',
  workingListHidden: false, workingListVersion: 0, canManageWorkingList: true,
  gateways: { a: { status: 'complete', label: 'Accepted' }, b: { status: 'pending', label: 'Evidence needed' } },
};

test('Cases compact layout preserves readable controls and bounded filters across viewports', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Demo Reviewer/ }).click();
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByTestId('active-client-name')).toHaveText('Demo Organization');
  await page.route('**/api/onboarding/cases', route => route.fulfill({ json: [fixture] }));
  await page.route('**/api/onboarding/workforce-transfers/programs', route => route.fulfill({ json: [] }));
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/cases');
    await expect(page.getByText(fixture.originalIntent, { exact: width >= 1024 }).filter({ visible: true })).toBeVisible();
    const list = width >= 1024 ? page.locator('tbody tr').first() : page.getByRole('link', { name: /Open case HRO/ });
    const top = (await list.boundingBox())!.y;
    console.log(`CASES_LIST_TOP ${width}: ${top}`);
    await page.screenshot({ path: `generated-artifacts/cases-${process.env.CASES_BASELINE ? 'before' : 'after'}-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: /^Filters/ }).click();
    const panel = page.getByRole('dialog', { name: 'Case filters' });
    await expect(panel).toBeVisible();
    if (!process.env.CASES_BASELINE) {
      const bounds = (await panel.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      if (width === 1440) {
        const pageTop = (await page.getByTestId('cases-page').boundingBox())!.y;
        // Baseline page content starts at 216px; first row at 751.125px.
        expect(top - pageTop).toBeLessThanOrEqual((751.125 - 216) * 0.75);
      }
    }
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
});

test('Cases responsive states retain history, hidden-case curation, retries and keyboard disclosures without real writes', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByRole('button', { name: /Demo Reviewer/ }).click();
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByTestId('active-client-name')).toHaveText('Demo Organization');
  let mode: 'loaded' | 'empty' | 'failed' | 'loading' = 'loaded';
  let hidden = false;
  let version = 0;
  let release!: () => void;
  let wait = Promise.resolve();
  const writes: unknown[] = [];
  const history = { ...fixture, id: 359, workerName: 'Retained historical worker', controllerRetired: true, canManageWorkingList: false };
  await page.route('**/api/onboarding/cases', async route => {
    if (mode === 'loading') await wait;
    await route.fulfill(mode === 'failed' ? { status: 503, json: { message: 'Private failure' } }
      : { json: mode === 'empty' ? [] : [{ ...fixture, workingListHidden: hidden, workingListVersion: version }, history] });
  });
  await page.route('**/api/onboarding/workforce-transfers/programs', async route => {
    if (mode === 'loading') await wait;
    await route.fulfill(mode === 'failed' ? { status: 503, json: { message: 'Private program failure' } } : { json: [] });
  });
  await page.route('**/api/onboarding/case-list-visibility', async route => {
    const body = route.request().postDataJSON();
    writes.push(body); hidden = body.hidden; version++;
    await route.fulfill({ json: { updatedCount: 1 } });
  });
  const assertNoOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    mode = 'loaded'; hidden = false;
    await page.goto('/cases?source=email#saved');
    const row = width >= 1024 ? page.getByRole('row', { name: /Open case HRO-2026-00358/ })
      : page.getByRole('link', { name: /Open case HRO-2026-00358/ });
    await expect(row).toBeVisible();
    const info = row.locator('summary');
    await info.focus();
    await page.keyboard.press('Enter');
    await expect(row.locator('.case-list-facts')).toBeVisible();
    await expect(row.locator('.case-list-facts')).toContainText('worker@example.test');
    await page.keyboard.press('Enter');
    await expect(row.locator('.case-list-facts')).toBeHidden();
    const historyToggle = page.getByRole('checkbox', { name: 'Show all historical test records' });
    await historyToggle.check();
    await expect(page.getByText('Historical test records are read-only and non-operational.', { exact: false })).toBeVisible();
    await expect(page.getByText('Retained historical worker', { exact: true }).filter({ visible: true })).toBeVisible();
    await assertNoOverflow();
    await historyToggle.uncheck();
    const check = row.getByRole('checkbox', { name: /Show HRO-2026-00358/ });
    // Visibility is server-confirmed, not optimistic; click and wait for the refreshed projection.
    await check.click();
    await expect(row).toBeHidden();
    await page.getByRole('combobox', { name: 'Cases list visibility' }).selectOption('hidden');
    await expect(row).toBeVisible();
    await expect(page.getByText('Hidden cases include individually hidden', { exact: false })).toBeVisible();
    await check.click();
    await expect(row).toBeHidden();
    await page.getByRole('combobox', { name: 'Cases list visibility' }).selectOption('working');
    await expect(row).toBeVisible();
    const search = page.getByRole('textbox', { name: 'Search cases and programs' });
    await search.fill('no matching item');
    await expect(page.getByText(width >= 1024 ? 'No matching work items returned' : 'No loaded work items match the selected filters.').filter({ visible: true })).toBeVisible();
    await assertNoOverflow();
    await page.getByRole('button', { name: 'Clear filters', exact: true }).filter({ visible: true }).click();
    await expect(row).toBeVisible();
    if (width < 1024) await page.getByRole('combobox', { name: 'Case family', exact: true }).selectOption('Payroll');
    else await page.getByRole('button', { name: /^Payroll:/ }).click();
    await expect(page).toHaveURL(/source=email&caseType=Payroll#saved$/);
    await expect(row).toBeHidden();
    mode = 'empty';
    await page.goto('/cases');
    await expect(page.getByText('No individual HR operations cases yet', { exact: false }).filter({ visible: true })).toBeVisible();
    await assertNoOverflow();
    mode = 'failed';
    await page.reload();
    await expect(page.getByText("Cases couldn't be loaded").filter({ visible: true })).toBeVisible();
    await expect(page.getByText('Transfer program results are unavailable.', { exact: false })).toBeVisible();
    await expect(page.getByText('Private failure', { exact: true })).toHaveCount(0);
    await assertNoOverflow();
    mode = 'loading';
    wait = new Promise<void>(resolve => { release = resolve; });
    await page.getByRole('button', { name: 'Retry', exact: true }).filter({ visible: true }).click();
    await page.getByRole('button', { name: 'Retry programs', exact: true }).click();
    // The program count may retain its prior failed state during retry; it must never become a fabricated zero.
    mode = 'loaded'; release();
    await expect(row).toBeVisible();
    mode = 'loading';
    wait = new Promise<void>(resolve => { release = resolve; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Loading transfer programs… Individual cases load independently.')).toBeVisible();
    if (width >= 1024) await expect(page.locator('tbody .animate-pulse').first()).toBeVisible();
    else await expect(page.getByText('Loading...', { exact: true }).filter({ visible: true })).toBeVisible();
    if (width >= 1024) {
      const program = page.getByRole('button', { name: 'Workforce Transfer Programs: programs loading' });
      await expect(program).toContainText('…');
    } else {
      await expect(page.getByRole('combobox', { name: 'Case family', exact: true })).toContainText('programs loading');
    }
    await assertNoOverflow();
    mode = 'loaded'; release();
    await expect(row).toBeVisible();
  }
  expect(writes).toHaveLength(6);
});
