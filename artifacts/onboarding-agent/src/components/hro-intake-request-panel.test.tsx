import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HroIntakeRequestPanel } from './hro-intake-request-panel';
import { HRO_BATCH_TEMPLATES, hroRequestForRow } from '../../../api-server/src/lib/onboarding/hro-batch-templates';

const sampleContext = { id: 3644, fictionalOfflineIdentity: true, offlineSample: true };
test('all sample families omit generated reference codes without asserting evidence identity', () => {
  for (const template of HRO_BATCH_TEMPLATES) {
    const data = Object.fromEntries(template.columns.map(column => [column.key,
      column.key === 'request_id' ? 'UAT-DEMO-EXAMPLES:complementary-v1:2:10'
      : column.key === 'worker_name' ? 'Example — Kiran Pine'
      : column.key.endsWith('_reference') || column.key.endsWith('employee_id') ? 'FICTIONAL-SOURCE-10'
      : 'Pending']));
    const request = hroRequestForRow(template, data);
    const html = renderToStaticMarkup(<HroIntakeRequestPanel request={request} sampleContext={sampleContext} />);
    assert.ok(html.includes('Case reference'));
    assert.equal((html.match(/S3644/g) ?? []).length, 1);
    assert.ok(html.includes('Kiran Pine'));
    assert.ok(!html.includes('Example — Kiran Pine'));
    assert.ok(!html.includes('FICTIONAL-'));
    assert.ok(!html.includes('UAT-DEMO-'));
    assert.ok(html.includes('Evidence and reference verification remain pending'));
    assert.ok(html.includes('not employee identity or evidence'));
    const real = renderToStaticMarkup(<HroIntakeRequestPanel request={request} sampleContext={{ ...sampleContext, fictionalOfflineIdentity: false }} />);
    assert.ok(real.includes('Source ID'));
    assert.ok(real.includes('UAT-DEMO-'));
    assert.ok(!real.includes('S3644'));
  }
});

test('missing and conflicting references remain explicit and unverified', () => {
  const template = HRO_BATCH_TEMPLATES.find(t => t.id === 'payroll-bank-change')!;
  const request = hroRequestForRow(template, {
    request_id: 'UAT-DEMO-EXAMPLES:complementary-v1:3:7', employee_id: '',
    secure_submission_reference: 'FICTIONAL-REF-A / FICTIONAL-REF-B',
  });
  const html = renderToStaticMarkup(<HroIntakeRequestPanel request={request} sampleContext={sampleContext} />);
  assert.ok(html.includes('Missing — clarification required'));
  assert.ok(html.includes('Conflicting references A and B — neither verified'));
  assert.ok(html.includes('Specialist review only'));
  assert.ok(!html.includes('FICTIONAL-'));
});

test('unconfirmed inventory dates are presentation-only, while ordinary submitted dates remain unchanged', () => {
  const template = HRO_BATCH_TEMPLATES.find(t => t.id === 'payroll-bank-change')!;
  const data = { request_id: 'FICTIONAL-REF', effective_date: '2030-11-13', due_date: '2031-01-31' };
  const request = hroRequestForRow(template, data);
  const before = JSON.stringify(request);
  const html = renderToStaticMarkup(<HroIntakeRequestPanel request={request} sampleContext={sampleContext} />);
  assert.doesNotMatch(html, /2030-11-13|2031-01-31/);
  assert.match(html, /Not confirmed/);
  const live = renderToStaticMarkup(<HroIntakeRequestPanel request={request} sampleContext={{ ...sampleContext, fictionalOfflineIdentity: false }} />);
  assert.match(live, /2030-11-13/);
  assert.equal(JSON.stringify(request), before);
});
