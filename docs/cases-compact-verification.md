# Compact Cases presentation verification

## Baseline and comparison

Captured with the isolated browser-regression server and the same Demo Reviewer,
one visible individual case, empty program result and unchanged suite banners.
No real case writes or external effects were used.

| Viewport width | Before: first list item Y | After: first list item Y |
| --- | ---: | ---: |
| 1440px | 751.13px | 579.73px |
| 768px | 1008.80px | 733.13px |
| 390px | 1236.36px | 852.30px |

On desktop, removing the unchanged suite header area (approximately 216px)
reduces page-specific space before the first row from about 535px to 364px:
approximately **32% less**, exceeding the 25% target. Screenshots are local,
ignored outputs in `generated-artifacts/cases-{before,after}-{width}.png`.
The fixture and comparison assertion live in `browser-regression/cases-density.spec.ts`.

## Preserved controls and information

- All 13 case categories (including All Cases) plus transfer programs; canonical
  category names remain in accessible button names and native selector options.
- Search, status shortcuts, advanced case/program filters, checklist scope,
  URL query and fragment preservation, reset/clear, history and warnings.
- Working/Hidden visibility, explicit per-case hide/restore, pending-state
  disabling, server-confirmed results, failure notice and scope restrictions.
  The full list-only explanation remains under “How hiding works”.
- Email intake, New Case, Batch Intake and Trusted Intake retain the original
  tenant predicates, Offboarding routes and handlers.
- References, originating intent, worker, family, effective date, business stages,
  status, owner and links. Native keyboard/touch disclosures expose full
  truncated values, workforce context and stage explanations without navigation.
- Program status, owner, cutover date and its qualification, population
  completeness, links, loading, unavailable and retry states remain separate
  from individual-case counts and completion.
- No API/database changes, count alterations, authorization changes, execution,
  deletions, workflow-guard changes or changes to fictional/history predicates.
  Shared suite header/sidebar/components were not restyled.

## Checks

- `pnpm run typecheck`: passed across the workspace.
- Focused Onboarding Agent tests: Cases page, case presentation, list navigation,
  transfer presentation, status mapping and gateways passed (31 tests).
- Browser Cases density, program navigation and sample-label regressions passed.
  All three widths exercised populated, filtered, historical, hidden,
  restored, empty, failed/retry and loading states; filters stayed bounded,
  keyboard disclosures and Escape worked, and no page-level horizontal overflow
  was found. Visibility writes were intercepted and held entirely in test memory.
- Development web workflow restarted cleanly. Unauthenticated real-preview
  capture renders the expected sign-in page; signed-in Cases screenshots and
  interactions were verified in the isolated browser harness.
- Diff inspection confirmed fetches, selection/mutation guards, business
  predicates and navigation destinations are unchanged. Disclosure interactions
  are excluded from row navigation; the narrow selector reuses the original
  URL handler.

## Separate existing check failure

The broad `pnpm --filter @workspace/onboarding-agent test` attempt exposed an
unrelated failure and timed out. Running its failing file alone confirmed:

`TEST_FILE=src/pages/settings-access-governance.integration.test.tsx pnpm --filter @workspace/onboarding-agent test`

fails in “starter picker refreshes persisted selectors, handles failure/retry
and remains owner-only”, expecting “Read-only access”. The implementation and
test file are outside this presentation change and were left untouched.
