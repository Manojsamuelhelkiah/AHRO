import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HroContextHistoryItem } from '@workspace/api-client-react';
import { ContextTransactionList } from './settings-context-manager';

const unfinished: HroContextHistoryItem = {
  id: 'transaction-id', anchorId: 'opaque-anchor', correlationId: '8b106d54-cf8a-4e19-a2f2-fb1c15e074b9',
  parentTransactionId: null, workflow: 'documents', status: 'running', version: 2,
  executorType: 'system', initiatorType: 'system', startedAt: '2026-10-01T00:00:00Z',
  finishedAt: null, ageSeconds: 86_400, steps: [{ code: 'checkpoint-recorded', createdAt: '2026-10-01T00:00:00Z' }],
};

test('old system attempts show unfinished, age and safe metadata-only correlation links', () => {
  const html = renderToStaticMarkup(<ContextTransactionList transactions={[unfinished]} view="operator" />);
  assert.match(html, /Unfinished — no final result/);
  assert.match(html, /Started 1440 minutes ago/);
  assert.match(html, /system-initiated/);
  assert.match(html, /href="\?contextView=operator&amp;contextCorrelation=8b106d54-cf8a-4e19-a2f2-fb1c15e074b9#unified-context-manager"/);
  assert.match(html, /checkpoint recorded/);
  assert.doesNotMatch(html, /Confirmed failed|<button|\/cases\/|\/documents\/|retry|replay/i);
});

test('confirmed failure and completion describe execution attempts, not business outcomes', () => {
  const html = renderToStaticMarkup(<ContextTransactionList transactions={[
    { ...unfinished, id: 'failed-id', status: 'failed', finishedAt: '2026-10-01T00:01:00Z' },
    { ...unfinished, id: 'completed-id', status: 'completed', finishedAt: '2026-10-01T00:01:00Z' },
  ]} view="personal" />);
  assert.match(html, /Confirmed failed attempt/);
  assert.match(html, /Completed attempt/);
  assert.match(html, /\?contextView=personal&amp;contextCorrelation=/);
  assert.doesNotMatch(html, /hire complete|Unfinished — no final result/);
});
