# Control Tower appearance checks

## Scope

Classic is the default. Vibrant and Midnight use the same pages, shared
components and data as Classic. Only this artifact reads
`onboarding-agent:appearance`. The candidate entry point skips initialization.
Theme changes update document presentation without replacing business pages.

## Automated checks

- `pnpm --filter @workspace/onboarding-agent typecheck`: passed.
- `pnpm --filter @workspace/onboarding-agent build`: passed. Existing
  sourcemap warnings and the large JavaScript chunk warning remain.
- New appearance tests: all three passed. They cover pre-paint initialization,
  valid/invalid/blocked storage, artifact-specific storage keys, candidate/base
  path exclusion, dark native controls, and preservation of mounted draft state
  and unrelated organization/app preferences.
- The normal application test command was run, but the existing suite does not
  terminate cleanly. Running its compiled test files independently with bounded
  timeouts gave 67 passing files out of 69. The remaining files are:
  - `settings-access-governance.integration.test.tsx`: the existing starter-picker
    test expects “Read-only access” after switching to an administrator, while
    the current screen renders administration controls.
  - `settings-organization-members.test.tsx`: three assertions pass, but the
    existing cleanup does not finish before the per-file timeout.
- Neither failing test's source, authorization implementation, nor expectations
  were changed for this presentation task.
- The diff was checked for non-presentation changes: existing authentication
  predicates, handlers, fetches, permissions, columns, case calculations and
  navigation destinations are retained.

## Browser checks

Checks used the built-in restricted Demo Reviewer session, with no case actions,
configuration saves, approvals or messages. The only persisted change was the
browser appearance preference. A temporary Settings draft was discarded by reload.

- Classic, Vibrant and Midnight menu choices; selected radio state and previews.
- Keyboard menu navigation/selection, Escape dismissal and focus restoration.
- Navigation and reload persistence; organization and session remained unchanged.
- Dashboard at 390px and 1440px; Cases at 390px and 1440px; read-only case detail
  at 768px and 1440px; Settings at 390px, 768px and 1440px; Action Center's
  error surface at 768px. No document-level horizontal overflow was observed.
- Case search and result selection remained unchanged after switching themes.
- Unsaved Settings text survived theme switching.
- Phone Appearance options fit on-screen. The existing mobile navigation strip
  scrolls horizontally to reveal full labels; this is not page-level overflow.
- Root login, Clerk sign-in and Clerk sign-up rendered with Midnight stored.
- Invalid preference and throwing preference storage defaulted to Classic.
- Candidate's invalid-link screen stayed light, without a staff theme attribute.
  Cost Explorer also stayed light despite the saved Midnight preference.
- Reduced-motion emulation produced 10-microsecond transition/animation
  durations on the open Appearance menu and its items. Keyboard focus outlines
  remained visible on tablet and desktop.
- Representative Midnight text measured 14.24:1 against its rendered surface.
  Direct token-pair checks also exceeded 4.5:1 for primary/muted text, white
  action labels, and dark semantic status text/background pairs.

## Limits

The reviewer account's Action Center sources returned HTTP 403, so populated
approval/communication content could not be exercised. Its error state and
appearance control were checked without weakening access. A valid candidate
invitation was not available; candidate isolation was checked on the invalid-link
screen and in the initialization tests. No live loader was present when reduced
motion was sampled. Sign-in/up briefly wait for Clerk to render its form.

The browser pass is representative rather than every possible combination of
page, theme and viewport. Shared tokens cover the remaining staff routes,
including document-level overlays; dropdowns and the case filter panel were
opened in the browser. No operational dialog was submitted to produce a toast.
