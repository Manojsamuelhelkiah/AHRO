import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import type { HroContextHistoryItem } from '@workspace/api-client-react';
import { ContextTransactionList, ContextHistoryPagination } from './settings-context-manager';

const unfinished: HroContextHistoryItem = {
  id: 'transaction-id', anchorId: 'opaque-anchor', correlationId: '8b106d54-cf8a-4e19-a2f2-fb1c15e074b9',
  parentTransactionId: null, workflow: 'documents', status: 'running', version: 2,
  executorType: 'system', initiatorType: 'system', startedAt: '2026-10-01T00:00:00Z',
  finishedAt: null, ageSeconds: 86_400, steps: [{ code: 'checkpoint-recorded', createdAt: '2026-10-01T00:00:00Z' }],
};

test('old system attempts show unfinished, age and safe metadata-only correlation links', () => {
  const html = renderToStaticMarkup(<Router ssrPath="/execution-history"><ContextTransactionList transactions={[unfinished]} view="operator" /></Router>);
  assert.match(html, /Unfinished — no final result/);
  assert.match(html, /Started 1440 minutes ago/);
  assert.match(html, /system-initiated/);
  assert.match(html, /href="\/execution-history\?contextView=operator&amp;contextCorrelation=8b106d54-cf8a-4e19-a2f2-fb1c15e074b9"/);
  assert.match(html, /checkpoint recorded/);
  assert.doesNotMatch(html, /Confirmed failed|<button|\/cases\/|\/documents\/|retry|replay/i);
});

test('bounded read-only pagination identifies the page and disables unavailable navigation', () => {
  const first = renderToStaticMarkup(<ContextHistoryPagination page={1} hasOlder busy={false}
    onNewer={() => {}} onOlder={() => {}} />);
  assert.match(first, /Execution history pages/);
  assert.match(first, /Page 1 · up to 30 attempts/);
  assert.match(first, /disabled=""[^>]*>Newer attempts/);
  assert.doesNotMatch(first, /disabled=""[^>]*>Older attempts/);
  const last = renderToStaticMarkup(<ContextHistoryPagination page={3} hasOlder={false} busy={false}
    onNewer={() => {}} onOlder={() => {}} />);
  assert.doesNotMatch(last, /disabled=""[^>]*>Newer attempts/);
  assert.match(last, /disabled=""[^>]*>Older attempts/);
  const loading = renderToStaticMarkup(<ContextHistoryPagination page={2} hasOlder busy
    onNewer={() => {}} onOlder={() => {}} />);
  assert.equal((loading.match(/disabled=""/g) ?? []).length, 2);
});

test('correlation links retain the suite base path', () => {
  const html = renderToStaticMarkup(<Router base="/suite" ssrPath="/suite/execution-history">
    <ContextTransactionList transactions={[unfinished]} view="personal" />
  </Router>);
  assert.match(html, /href="\/suite\/execution-history\?contextView=personal&amp;contextCorrelation=/);
});

test('confirmed failure and completion describe execution attempts, not business outcomes', () => {
  const html = renderToStaticMarkup(<Router ssrPath="/execution-history"><ContextTransactionList transactions={[
    { ...unfinished, id: 'failed-id', status: 'failed', finishedAt: '2026-10-01T00:01:00Z' },
    { ...unfinished, id: 'completed-id', status: 'completed', finishedAt: '2026-10-01T00:01:00Z' },
  ]} view="personal" /></Router>);
  assert.match(html, /Confirmed failed attempt/);
  assert.match(html, /Completed attempt/);
  assert.match(html, /\?contextView=personal&amp;contextCorrelation=/);
  assert.doesNotMatch(html, /hire complete|Unfinished — no final result/);
});
