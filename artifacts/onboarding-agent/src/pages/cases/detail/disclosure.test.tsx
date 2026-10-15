import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Disclosure } from './disclosure';
import { CaseTabs } from './components';

test('disclosure is collapsed and labelled by default', () => {
  const html = renderToStaticMarkup(<Disclosure title="Original intake request"><p>x</p></Disclosure>);
  assert.ok(html.includes('aria-expanded="false"'));
  assert.ok(html.includes('hidden'));
});
test('forceOpen opens the disclosure', () => {
  assert.ok(renderToStaticMarkup(<Disclosure title="T" forceOpen><p>x</p></Disclosure>).includes('aria-expanded="true"'));
});
test('CaseTabs can suppress the second Ask AI entry', () => {
  assert.ok(!renderToStaticMarkup(<CaseTabs activeTab="Overview" setTab={() => {}} hideAsk />).includes('Ask AI'));
});
