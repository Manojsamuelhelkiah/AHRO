import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const artifactDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function until(run, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await run();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `${message}${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const eventWaiters = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    const waiters = eventWaiters.get(message.method);
    if (!waiters) return;
    eventWaiters.delete(message.method);
    for (const resolve of waiters) resolve(message.params);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const waitForEvent = (method) =>
    new Promise((resolve) => {
      eventWaiters.set(method, [...(eventWaiters.get(method) ?? []), resolve]);
    });

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "Browser evaluation failed");
    }
    return result.result.value;
  };

  return { socket, send, waitForEvent, evaluate };
}

function clickButtonScript(containerSelector, label) {
  return `(() => {
    const container = document.querySelector(${JSON.stringify(containerSelector)});
    const button = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent.includes(${JSON.stringify(label)}));
    if (!button) return false;
    button.click();
    return true;
  })()`;
}

test("real browser keeps process switching reachable and tenant tabs isolated", async (t) => {
  const appPort = await reservePort();
  const debugPort = await reservePort();
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), "process-view-chromium-"),
  );
  process.env.PORT = String(appPort);
  process.env.BASE_PATH = "/";
  process.env.NODE_ENV = "production";
  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: path.join(artifactDir, "vite.config.ts"),
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: appPort,
      strictPort: true,
    },
  });
  await vite.listen();

  const chromium = spawn(
    process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const chromiumExited = new Promise((resolve) => {
    chromium.once("exit", resolve);
  });

  t.after(async () => {
    if (chromium.exitCode === null) {
      chromium.kill("SIGTERM");
      await chromiumExited;
    }
    await vite.close();
    await rm(userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  const target = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    if (!response.ok) return null;
    const targets = await response.json();
    return targets.find((candidate) => candidate.type === "page");
  }, "Chromium did not expose a page target");
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  t.after(() => cdp.socket.close());
  await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable")]);

  for (const [label, width, height] of [
    ["desktop", 1440, 1000],
    ["phone", 390, 844],
  ]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: label === "phone",
    });
    const loaded = cdp.waitForEvent("Page.loadEventFired");
    await cdp.send("Page.navigate", {
      url: `http://127.0.0.1:${appPort}/browser-tests/process-view.html?viewport=${label}`,
    });
    await loaded;
    await until(
      () =>
        cdp.evaluate(
          `window.__PROCESS_VIEW_READY__ === true &&
           document.querySelector("#direct-flow [role=tablist]") !== null &&
           document.querySelector("#intent-detail")?.textContent.includes("approved override v2")`,
        ),
      `${label} fixture did not become ready`,
    );

    const initial = await cdp.evaluate(`(() => {
      const root = document.querySelector("#direct-flow");
      const tablist = root.querySelector("[role=tablist][aria-label='Process view']");
      const tabs = [...tablist.querySelectorAll("[role=tab]")];
      const evidence = [...root.querySelectorAll("button")]
        .find((button) => button.textContent.includes("Evidence & technical details"));
      const tabRect = tablist.getBoundingClientRect();
      const evidenceRect = evidence.getBoundingClientRect();
      return {
        tabCount: tabs.length,
        tablistWithinViewport: tabRect.left >= 0 && tabRect.right <= innerWidth,
        tabsReachable: tabs.every((tab) => {
          const rect = tab.getBoundingClientRect();
          const style = getComputedStyle(tab);
          return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth &&
            style.visibility !== "hidden" && style.display !== "none";
        }),
        evidenceWithinViewport:
          evidenceRect.width > 0 &&
          evidenceRect.left >= 0 &&
          evidenceRect.right <= innerWidth,
        evidenceExpanded: evidence.getAttribute("aria-expanded"),
        hasBpmn: Boolean(root.querySelector("svg[aria-label='BPMN Process Diagram']")),
        hasAnnotation: root.textContent.includes("72% · 8.9K txn"),
        hasTechnicalDetail: root.textContent.includes("payroll (put)"),
      };
    })()`);
    assert.equal(initial.tabCount, 3, label);
    assert.equal(initial.tablistWithinViewport, true, label);
    assert.equal(initial.tabsReachable, true, label);
    assert.equal(initial.evidenceWithinViewport, true, label);
    assert.equal(initial.evidenceExpanded, "false", label);
    assert.equal(initial.hasBpmn, true, label);
    assert.equal(initial.hasAnnotation, true, label);
    assert.equal(initial.hasTechnicalDetail, false, label);

    assert.equal(
      await cdp.evaluate(
        clickButtonScript("#direct-flow", "Evidence & technical details"),
      ),
      true,
      label,
    );
    await until(
      () =>
        cdp.evaluate(
          `document.querySelector("#direct-flow").textContent.includes("payroll (put)")`,
        ),
      `${label} technical evidence did not expand`,
    );

    assert.equal(
      await cdp.evaluate(clickButtonScript("#direct-flow", "SIPOC")),
      true,
      label,
    );
    await until(
      () => cdp.evaluate(`Boolean(document.querySelector("#direct-flow table"))`),
      `${label} SIPOC view did not render`,
    );

    assert.equal(
      await cdp.evaluate(clickButtonScript("#direct-flow", "Technical")),
      true,
      label,
    );
    const technical = await until(
      () =>
        cdp.evaluate(`(() => {
          const root = document.querySelector("#direct-flow");
          const svg = root.querySelector("svg[aria-label='Transaction flow diagram']");
          if (!svg) return null;
          const scroller = svg.parentElement;
          return {
            hasAnnotations:
              root.textContent.includes("72% · 8.9K txn") &&
              root.textContent.includes("81% · 7.2K txn") &&
              root.textContent.includes("HITL 27% · 1.9K txn"),
            hasHorizontalOverflow: scroller.scrollWidth > scroller.clientWidth,
          };
        })()`),
      `${label} technical view did not render`,
    );
    assert.equal(technical.hasAnnotations, true, label);
    if (label === "phone") {
      assert.equal(technical.hasHorizontalOverflow, true, label);
    }

    assert.equal(
      await cdp.evaluate(clickButtonScript("#direct-flow", "BPMN")),
      true,
      label,
    );
    const restored = await until(
      () =>
        cdp.evaluate(`(() => {
          const root = document.querySelector("#direct-flow");
          const evidence = [...root.querySelectorAll("button")]
            .find((button) => button.textContent.includes("Evidence & technical details"));
          if (!root.querySelector("svg[aria-label='BPMN Process Diagram']")) return null;
          return {
            annotation: root.textContent.includes("72% · 8.9K txn"),
            evidenceExpanded: evidence.getAttribute("aria-expanded"),
          };
        })()`),
      `${label} BPMN view did not restore`,
    );
    assert.equal(restored.annotation, true, label);
    assert.equal(restored.evidenceExpanded, "true", label);

    const override = await cdp.evaluate(`(() => {
      const root = document.querySelector("#intent-detail");
      return {
        current:
          root.textContent.includes("approved override v2: fc3-multiagent") &&
          root.textContent.includes("Approved multi-"),
        stale: root.textContent.includes("Original deterministic step"),
      };
    })()`);
    assert.equal(override.current, true, label);
    assert.equal(override.stale, false, label);
    assert.equal(
      await cdp.evaluate(clickButtonScript("#intent-detail", "SIPOC")),
      true,
      label,
    );
    await until(
      () =>
        cdp.evaluate(
          `document.querySelector("#intent-detail").textContent.includes("Approved multi- process")`,
        ),
      `${label} approved override did not render in SIPOC`,
    );
  }

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.evaluate(
    `localStorage.setItem("activeOrganizationId", "workspace-a")`,
  );
  let loaded = cdp.waitForEvent("Page.loadEventFired");
  await cdp.send("Page.navigate", {
    url: `http://127.0.0.1:${appPort}/browser-tests/tenant-tab.html?app=cost`,
  });
  await loaded;
  await until(
    () =>
      cdp.evaluate(
        `window.__TENANT_TAB_READY__ === true &&
         document.querySelector("[data-testid='workspace-label']")?.textContent.includes("workspace-a")`,
      ),
    "Cost Explorer tenant tab did not become ready",
  );

  const onboardingUrl =
    `http://127.0.0.1:${appPort}/browser-tests/tenant-tab.html?app=onboarding`;
  const onboardingTargetResponse = await fetch(
    `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(onboardingUrl)}`,
    { method: "PUT" },
  );
  assert.equal(onboardingTargetResponse.ok, true);
  const onboardingTarget = await onboardingTargetResponse.json();
  const onboardingCdp = await connectCdp(
    onboardingTarget.webSocketDebuggerUrl,
  );
  t.after(() => onboardingCdp.socket.close());
  await Promise.all([
    onboardingCdp.send("Page.enable"),
    onboardingCdp.send("Runtime.enable"),
  ]);
  await until(
    () =>
      onboardingCdp.evaluate(
        `window.__TENANT_TAB_READY__ === true &&
         document.querySelector("[data-testid='workspace-label']")?.textContent.includes("workspace-a")`,
      ),
    "Onboarding tenant tab did not become ready",
  );

  assert.equal(
    await onboardingCdp.evaluate(
      clickButtonScript("body", "Switch to workspace B"),
    ),
    true,
  );
  await until(
    () =>
      onboardingCdp.evaluate(
        `window.__TENANT_TAB_READY__ === true &&
         document.querySelector("[data-testid='workspace-label']")?.textContent.includes("workspace-b")`,
      ),
    "Onboarding tab did not reload into workspace B",
  );
  const switchedOnboardingTab = await onboardingCdp.evaluate(`(() => ({
    draft: document.querySelector("[aria-label='Unsaved draft']")?.value,
    workspaceADraft: localStorage.getItem(
      "clientSetupDraft:v2:fixture-user:workspace-a"
    ),
    workspaceBDraft: localStorage.getItem(
      "clientSetupDraft:v2:fixture-user:workspace-b"
    ),
  }))()`);
  assert.equal(
    switchedOnboardingTab.draft,
    "Workspace B blank client setup",
  );
  assert.match(
    switchedOnboardingTab.workspaceADraft,
    /Workspace A confidential hire/,
  );
  assert.equal(switchedOnboardingTab.workspaceBDraft, null);

  const staleCostTab = await cdp.evaluate(`(() => ({
    sharedSelector: localStorage.getItem("activeOrganizationId"),
    visibleWorkspace: document.querySelector("[data-testid='workspace-label']")?.textContent,
    draft: document.querySelector("[aria-label='Unsaved draft']")?.value,
  }))()`);
  assert.equal(staleCostTab.sharedSelector, "workspace-b");
  assert.match(staleCostTab.visibleWorkspace, /workspace-a/);
  assert.equal(staleCostTab.draft, "Workspace A confidential scenario");

  assert.equal(
    await cdp.evaluate(clickButtonScript("body", "Submit scenario")),
    true,
  );
  const costDispatch = await until(
    () => cdp.evaluate(`window.__LAST_TENANT_REQUEST__ ?? null`),
    "Cost Explorer scenario was not dispatched",
  );
  assert.equal(costDispatch.organizationId, "workspace-a");
  assert.match(costDispatch.body, /Workspace A confidential scenario/);
  assert.match(costDispatch.url, /\/api\/workbook\/export$/);

  assert.equal(
    await onboardingCdp.evaluate(clickButtonScript("body", "Submit hire")),
    true,
  );
  const onboardingDispatch = await until(
    () =>
      onboardingCdp.evaluate(`window.__LAST_TENANT_REQUEST__ ?? null`),
    "Onboarding hire was not dispatched",
  );
  assert.equal(onboardingDispatch.organizationId, "workspace-b");
  assert.match(onboardingDispatch.body, /Workspace B blank client setup/);
  assert.doesNotMatch(
    onboardingDispatch.body,
    /Workspace A confidential hire/,
  );
  assert.match(onboardingDispatch.url, /\/api\/onboarding\/cases$/);
});