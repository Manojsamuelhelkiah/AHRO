import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectedReadinessSla } from './ConnectedReadinessSla';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getGetOnboardingCaseReadinessSlaQueryKey } from '@workspace/api-client-react';

test('ConnectedReadinessSla renders enrolled and unenrolled states based on query cache', () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  // 1. Unenrolled State
  queryClient.setQueryData(getGetOnboardingCaseReadinessSlaQueryKey(42), {
    enrolled: false
  });

  let html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ConnectedReadinessSla caseId={42} />
    </QueryClientProvider>
  );

  assert.match(html, /This case is not enrolled/);

  // 2. Enrolled State
  queryClient.setQueryData(getGetOnboardingCaseReadinessSlaQueryKey(43), {
    enrolled: true,
    snapshotVersion: 2,
    score: 85,
    thresholds: { green: 100, amberMinimum: 80 },
    streams: [
      { key: 'documentation', label: 'Documentation', weight: 20, status: 'incomplete' },
      { key: 'payroll', label: 'Payroll', weight: 20, status: 'complete', completedAt: '2026-09-01T12:00:00Z' },
      { key: 'bgv', label: 'Background verification', weight: 25, status: 'not-applicable' }
    ],
    actions: [
      { streamKey: 'documentation', label: 'Verify Docs', owner: 'HR Operations', status: 'pending', dueAt: '2026-09-05T12:00:00Z' }
    ]
  });

  html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ConnectedReadinessSla caseId={43} />
    </QueryClientProvider>
  );

  assert.match(html, /85/, 'Displays score correctly');
  assert.match(html, /Documentation/, 'Displays stream label');
  assert.match(html, /Verify Docs/, 'Displays action label');
  assert.match(html, /Payroll/, 'Displays completed stream');
  assert.match(html, /N\/A/, 'Displays not-applicable status');
});