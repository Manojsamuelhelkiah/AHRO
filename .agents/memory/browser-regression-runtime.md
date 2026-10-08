---
name: Browser regression runtime
description: Workspace Playwright tooling is independent from the browser used by the UI tester.
---

A successful UI testing-subagent run does not prove the workspace's configured Playwright regression runner can launch its own browser or video recorder.

**Why:** The tester's browser and the workspace runner have independent runtime installations, including version-specific video recorders.

**How to apply:** Treat a missing browser executable as a tooling/setup failure, not an application regression or permission to skip validation. Use the workspace's native Chromium configuration where available, preserve standard Playwright behavior elsewhere, and provision the matching Playwright recorder when video capture is enabled.
