import "../components/enterprise-architecture/test-support/dom";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { ReactElement } from "react";
import { disposeDom } from "../components/enterprise-architecture/test-support/dom";

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
Object.defineProperties(globalThis, {
  location: { configurable: true, value: window.location },
  history: { configurable: true, value: window.history },
  navigator: { configurable: true, value: window.navigator },
  HTMLInputElement: { configurable: true, value: window.HTMLInputElement },
  HTMLFormElement: { configurable: true, value: window.HTMLFormElement },
  Element: { configurable: true, value: window.Element },
  SVGElement: { configurable: true, value: window.SVGElement },
  Document: { configurable: true, value: window.Document },
  DocumentFragment: { configurable: true, value: window.DocumentFragment },
  Text: { configurable: true, value: window.Text },
  MutationObserver: { configurable: true, value: window.MutationObserver },
  Event: { configurable: true, value: window.Event },
  MouseEvent: { configurable: true, value: window.MouseEvent },
  FocusEvent: { configurable: true, value: window.FocusEvent },
  PopStateEvent: { configurable: true, value: window.PopStateEvent },
  addEventListener: { configurable: true, value: window.addEventListener.bind(window) },
  removeEventListener: { configurable: true, value: window.removeEventListener.bind(window) },
  getComputedStyle: { configurable: true, value: window.getComputedStyle.bind(window) },
  requestAnimationFrame: {
    configurable: true,
    value: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
  },
  cancelAnimationFrame: {
    configurable: true,
    value: (handle: number) => clearTimeout(handle),
  },
});
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: () => ({
    matches: false,
    media: "",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }),
});
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value() {},
});

const [{ QueryClient, QueryClientProvider }, { createRoot }] = await Promise.all([
  import("@tanstack/react-query"),
  import("react-dom/client"),
]);
const [{ default: Scenario }, { default: Calibration }] = await Promise.all([
  import("./scenario"),
  import("./calibration"),
]);

after(disposeDom);

const referenceIntent = {
  id: 1,
  key: "reference-intent",
  name: "Reference intent",
  domain: "employee",
  flowClass: "FC1",
  description: "Built-in reference intent",
  source: { name: "test", confidence: "measured" },
  asIsHandlingMin: 5,
  toBeHumanMin: 1,
  baseWeight: 1,
  actGetActions: 1,
  actPutActions: 0,
  systemsTouchedBase: 1,
  tags: [],
  isCustom: false,
};

const customIntent = {
  ...referenceIntent,
  id: 2,
  key: "custom-intent",
  name: "Custom intent",
  description: "Approved custom intent",
  isCustom: true,
};

function button(container: HTMLElement, name: string) {
  const match = Array.from(container.querySelectorAll("button")).find(
    candidate => candidate.textContent?.includes(name),
  );
  assert.ok(match, `expected button "${name}"`);
  return match;
}

async function until(assertion: () => void, message: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
    }
  }
  throw new Error(`${message}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function json(data: unknown) {
  return Response.json(data);
}

async function mountPage(Page: () => ReactElement) {
  let intentRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const requestUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const path = new URL(requestUrl, window.location.href).pathname;
    if (path.endsWith("/api/intents")) {
      intentRequests += 1;
      return json({
        intents: [referenceIntent, customIntent],
        customIntentsAvailable: intentRequests > 1,
        ...(intentRequests === 1 ? { warning: "Custom intent storage is temporarily unavailable." } : {}),
      });
    }
    if (path.endsWith("/api/profiles")) return json([]);
    if (path.endsWith("/api/model-catalog")) return json([]);
    if (path.endsWith("/api/systems")) return json([]);
    if (path.endsWith("/api/scenarios")) return json([]);
    if (path.endsWith("/api/actuals")) return json([]);
    if (path.endsWith("/api/assumptions")) return json([]);
    if (path.endsWith("/api/flow-classes")) return json([]);
    throw new Error(`Unexpected request: ${path}`);
  };

  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>,
    );
  });

  return {
    container,
    intentRequests: () => intentRequests,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      client.clear();
      globalThis.fetch = originalFetch;
    },
  };
}

test("Scenario Retry restores corpus-dependent actions on the mounted page", async t => {
  const mounted = await mountPage(Scenario);
  t.after(mounted.cleanup);
  const initialLocation = window.location.href;

  await until(() => {
    assert.match(mounted.container.textContent ?? "", /Custom intents are temporarily unavailable/);
    assert.equal(button(mounted.container, "Compute").disabled, true);
    assert.equal(button(mounted.container, "Import Workbook").disabled, true);
  }, "Scenario should enter degraded mode");

  await act(async () => button(mounted.container, "Retry").click());
  await until(() => {
    assert.equal(mounted.intentRequests(), 2);
    assert.doesNotMatch(mounted.container.textContent ?? "", /Custom intents are temporarily unavailable/);
    assert.equal(button(mounted.container, "Compute").disabled, false);
    assert.equal(button(mounted.container, "Import Workbook").disabled, false);
  }, "Scenario actions should recover after Retry");

  assert.equal(window.location.href, initialLocation, "Retry must not navigate or reload the page");
});

test("Calibration keeps reference actions available and restores custom actions after Retry", async t => {
  const mounted = await mountPage(Calibration);
  t.after(mounted.cleanup);
  const initialLocation = window.location.href;

  await until(() => {
    assert.match(mounted.container.textContent ?? "", /Built-in reference measurements remain available/);
    assert.equal(button(mounted.container, "Reference intent").disabled, false);
    assert.equal(button(mounted.container, "Custom intent").disabled, true);
  }, "Calibration should selectively disable only custom intent work");

  await act(async () => button(mounted.container, "Retry").click());
  await until(() => {
    assert.equal(mounted.intentRequests(), 2);
    assert.doesNotMatch(mounted.container.textContent ?? "", /Custom intents are temporarily unavailable/);
    assert.equal(button(mounted.container, "Reference intent").disabled, false);
    assert.equal(button(mounted.container, "Custom intent").disabled, false);
  }, "Calibration custom intent actions should recover after Retry");

  assert.equal(window.location.href, initialLocation, "Retry must not navigate or reload the page");
});