import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HRO_EMAIL_TEMPLATES, emailExample, classifyEmail, validateEmailReview } from '../../../../api-server/src/lib/hro-email-registry';
import { emailHtmlStructure } from '../../../../api-server/src/lib/hro-email-structure';
import { TemplateExample, templateCopyFormats, fictionalNotice } from './template-example';

test('every registered template copies all fields and round-trips both inert formats through existing extraction', () => {
  for (const template of HRO_EMAIL_TEMPLATES) {
    const entry = { template, example: emailExample(template) };
    const formats = templateCopyFormats(entry);
    assert.deepEqual(formats.rows.map(row => row.key), template.columns.map(column => column.key));
    for (const column of template.columns) {
      assert.ok(formats.plain.includes(`${column.key}: `), `${template.id}: ${column.key}`);
      if (column.values) assert.ok(column.values.includes(formats.rows.find(row => row.key === column.key)!.value));
    }
    assert.ok(formats.plain.startsWith(fictionalNotice));
    if (template.columns.some(column => column.key === 'job_profile_id'))
      assert.equal(formats.rows.find(row => row.key === 'job_profile_id')!.value, '', 'Do not invent an enabled tenant profile');
    assert.doesNotMatch(formats.html, /<script|<a |<img|href=|src=|onload=/i);
    const structure = emailHtmlStructure(formats.html);
    assert.deepEqual(structure.issues, []);
    assert.ok(structure.tables.every(table => !table.invalid));
    const plain = classifyEmail('', formats.plain);
    for (const parsed of [plain, classifyEmail('', '', structure), classifyEmail('', formats.plain, structure)]) {
      assert.equal(parsed.templateId, template.id);
      assert.equal(parsed.blockedReason, null);
      assert.deepEqual(parsed.fields, plain.fields);
      assert.equal(validateEmailReview(template.id, parsed.fields).valid, true);
      assert.equal(parsed.issues.length, 0, JSON.stringify(parsed.issues));
    }
  }
});

test('copied HTML escapes example text and whitelists registered fields', () => {
  const template = HRO_EMAIL_TEMPLATES[0];
  const formats = templateCopyFormats({ template, example: `${emailExample(template)}\nworker_name: <img src="https://bad.invalid" onerror='attack()'>&\nunknown_key: not retained` });
  assert.doesNotMatch(formats.html, /<img|unknown_key|<script/);
  assert.match(formats.html, /&lt;img/);
  assert.match(formats.html, /&quot;/);
  assert.match(formats.html, /&#39;/);
});

test('example controls label fictional samples and clipboard-only behavior', () => {
  const template = HRO_EMAIL_TEMPLATES[0];
  const html = renderToStaticMarkup(<TemplateExample entry={{ template, example: emailExample(template) }} />);
  assert.match(html, /Plain text/);
  assert.match(html, /Header\/value table/);
  assert.match(html, /Copy plain text/);
  assert.match(html, /Fictional example only/);
  assert.match(html, /unknown optional fields blank/);
  assert.match(html, /does not send mail, create a request, verify facts or change routing/);
  assert.match(html, /site_exposure:/);
  assert.doesNotMatch(html, /<form|mailto:|<iframe/);
});
