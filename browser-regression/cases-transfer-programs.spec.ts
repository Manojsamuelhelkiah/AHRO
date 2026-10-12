import { expect, test } from '@playwright/test';

const program = {
  id: 'transfer-program-browser', version: 1, name: 'Browser acquisition program',
  sourceLegalEntity: 'Source Entity', destinationLegalEntity: 'Destination Entity',
  countries: ['US'], proposedBasis: 'cross-border', legalDay1: '2031-01-01T00:00:00.000Z',
  status: 'go', createdAt: '2026-01-01T00:00:00.000Z', hrIntegrationOwner: 'HR integration lead',
  partialCountryScope: true, populationSummary: { importedHeadcount: 3, expectedHeadcount: 12 },
};
const individualCase = {
  id: 358, workerName: 'Browser Individual Worker', workerEmail: 'browser-worker@example.test',
  joiningDate: '2031-01-01', geography: 'CA', lifecycleStage: 'completed', orchestrationStatus: 'completed',
  createdAt: '2026-01-01T00:00:00.000Z',
};

test('Cases retains separate program summaries, filters, accessible detail links and failures at phone/tablet/desktop sizes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Demo Reviewer/ }).click();
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByTestId('active-client-name')).toHaveText('Demo Organization');

  let mode: 'mixed' | 'denied' | 'empty' | 'program-only' = 'mixed';
  await page.route('**/api/onboarding/cases', async (route) => {
    await route.fulfill({ json: mode === 'program-only' ? [] : [individualCase] });
  });
  await page.route('**/api/onboarding/workforce-transfers/programs', async (route) => {
    expect(route.request().headers()['x-organization-id']).toBe('demo');
    await route.fulfill(mode === 'denied' ? { status: 403, json: { message: 'sensitive server error not for display' } }
      : { json: mode === 'empty' ? [] : [program] });
  });
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/cases');
    await expect(page.getByText('Showing 1 individual cases · 1 programs.', { exact: false })).toBeVisible();
    const item = page.locator(`[data-program-id="${program.id}"]:visible`);
    await expect(item).toHaveCount(1);
    for (const text of ['Browser acquisition program', '3 imported', '12 expected', 'Partial country scope', 'HR integration lead', '2031-01-01', 'Not proof of cutover']) {
      await expect(item).toContainText(new RegExp(text, 'i'));
    }
    const action = item.getByRole('link', { name: /Open Workforce Transfer Program/ });
    await expect(action).toHaveAttribute('href', `/workforce-transfers/${program.id}`);
    await action.focus();
    await expect(action).toBeFocused();
    await page.getByRole('button', { name: /^Completed\s*1$/ }).click();
    await expect(page.locator('[data-program-id]:visible')).toHaveCount(0);
    await page.getByRole('button', { name: /^Individual cases\s*1$/ }).click();
    const search = page.getByRole('textbox', { name: 'Search cases and programs' });
    await search.fill('Destination Entity');
    await expect(item).toBeVisible();
    await expect(page.getByText('Showing 0 individual cases · 1 programs.', { exact: false })).toBeVisible();
    await search.fill('');
    await page.getByRole('button', { name: /^Workforce Transfer Programs/ }).click();
    await expect(page.getByText('Showing 0 individual cases · 1 programs.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: /^Filters/ }).click();
    const panel = page.getByRole('dialog', { name: 'Case filters' });
    await expect(panel).toBeVisible();
    await page.getByRole('combobox', { name: 'Recorded program status' }).selectOption('go');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(item).toBeVisible();
    const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.width + 1);
    await page.screenshot({ path: `test-results/cases-programs-${width}.png`, fullPage: true });
    await action.click();
    await expect(page).toHaveURL(new RegExp(`/workforce-transfers/${program.id}$`));
  }
  mode = 'denied';
  await page.goto('/cases');
  await expect(page.getByText('Transfer program results are unavailable.', { exact: false })).toBeVisible();
  await expect(page.getByText('Browser Individual Worker').first()).toBeVisible();
  await expect(page.getByText('sensitive server error not for display')).toHaveCount(0);
  mode = 'empty';
  await page.getByRole('button', { name: 'Retry programs' }).click();
  await expect(page.getByText('No authorized transfer programs returned.')).toBeVisible();
  mode = 'program-only';
  await page.reload();
  await expect(page.getByText('Showing 0 individual cases · 1 programs.', { exact: false })).toBeVisible();
  await expect(page.locator('[data-program-id]:visible')).toHaveCount(1);
  // The dedicated list continues to consume the extended list contract.
  await page.goto('/workforce-transfers');
  await expect(page.getByRole('link', { name: 'Browser acquisition program' })).toBeVisible();
});
