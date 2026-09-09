import "./enterprise-architecture/test-support/dom";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { FlowStep } from "@workspace/api-client-react";
import { disposeDom } from "./enterprise-architecture/test-support/dom";

Object.defineProperties(globalThis, {
  navigator: { configurable: true, value: window.navigator },
  location: { configurable: true, value: window.location },
  history: { configurable: true, value: window.history },
  HTMLInputElement: { configurable: true, value: window.HTMLInputElement },
  HTMLFormElement: { configurable: true, value: window.HTMLFormElement },
  addEventListener: { configurable: true, value: window.addEventListener.bind(window) },
  removeEventListener: { configurable: true, value: window.removeEventListener.bind(window) },
  dispatchEvent: { configurable: true, value: window.dispatchEvent.bind(window) },
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

const [{ createRoot }, { FlowDiagram }, { QueryClient, QueryClientProvider }, { default: IntentDetail }] = await Promise.all([
  import("react-dom/client"),
  import("./flow-diagram"),
  import("@tanstack/react-query"),
  import("../pages/intent-detail"),
]);

after(disposeDom);

const steps: FlowStep[] = [
  {
    id: "receive",
    stage: "intake",
    label: "Receive employee request",
    human: false,
    agents: ["Experience Layer"],
    systems: [],
    componentRefs: ["1"],
    costs: [],
    benefits: [],
  },
  {
    id: "update",
    stage: "act",
    label: "Update payroll record",
    human: true,
    agents: ["Payroll Specialist"],
    systems: [{ systemKey: "payroll", actions: ["put"], scalesWithLandscape: false }],
    componentRefs: ["6", "7"],
    costs: [],
    benefits: [{ type: "cycle-time", label: "Faster resolution", dollarized: false, unitBenefitUsd: 0, qualitative: "", assumption: "" }],
  },
];

function findButton(container: HTMLElement, label: string) {
  const match = Array.from(container.querySelectorAll("button")).find(
    candidate => candidate.textContent?.includes(label),
  );
  assert.ok(match, `expected button "${label}"`);
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

async function mount(viewportWidth: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: viewportWidth });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <FlowDiagram
        steps={steps}
        annotations={{
          adoptionFraction: 0.72,
          containmentFraction: 0.81,
          hitlSamplingFraction: 0.27,
          annualTransactions: 12_345,
          usingDefaults: false,
        }}
      />,
    );
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

for (const [label, width] of [["phone", 390], ["desktop", 1440]] as const) {
  test(`${label} process controls switch views, preserve annotations, and remain reachable`, async t => {
    const mounted = await mount(width);
    t.after(mounted.cleanup);

    const tablist = mounted.container.querySelector('[role="tablist"][aria-label="Process view"]');
    assert.ok(tablist);
    assert.equal(tablist.querySelectorAll('[role="tab"]').length, 3);
    assert.ok(mounted.container.querySelector('svg[aria-label="BPMN Process Diagram"]'));
    assert.match(mounted.container.textContent ?? "", /72% · 8\.9K txn/);
    assert.doesNotMatch(mounted.container.textContent ?? "", /payroll \(put\)/);

    const evidence = findButton(mounted.container, "Evidence & technical details");
    assert.equal(evidence.getAttribute("aria-expanded"), "false");
    await act(async () => evidence.click());
    assert.equal(evidence.getAttribute("aria-expanded"), "true");
    assert.match(mounted.container.textContent ?? "", /payroll \(put\)/);

    await act(async () => findButton(mounted.container, "SIPOC").click());
    assert.ok(mounted.container.querySelector("table"));
    assert.doesNotMatch(mounted.container.textContent ?? "", /72% · 8\.9K txn/);

    await act(async () => findButton(mounted.container, "Technical").click());
    const technical = mounted.container.querySelector('svg[aria-label="Transaction flow diagram"]');
    assert.ok(technical);
    assert.match(mounted.container.textContent ?? "", /72% · 8\.9K txn/);
    assert.match(mounted.container.textContent ?? "", /81% · 7\.2K txn/);
    assert.match(mounted.container.textContent ?? "", /HITL 27% · 1\.9K txn/);
    assert.ok(technical.parentElement?.className.includes("overflow-x-auto"));

    await act(async () => findButton(mounted.container, "BPMN").click());
    assert.ok(mounted.container.querySelector('svg[aria-label="BPMN Process Diagram"]'));
    assert.match(mounted.container.textContent ?? "", /72% · 8\.9K txn/);
    assert.equal(findButton(mounted.container, "Evidence & technical details").getAttribute("aria-expanded"), "true");
  });
}

test("intent detail renders the effective business process from the latest approved override", async t => {
  window.history.pushState({}, "", "/intents/payroll-change");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const requestUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const path = new URL(requestUrl, window.location.href).pathname;
    if (path.endsWith("/api/intents")) {
      return Response.json({
        intents: [{
          id: 1,
          key: "payroll-change",
          name: "Payroll change",
          domain: "pay",
          flowClass: "fc1-deterministic",
          description: "Change payroll details",
          source: { name: "test", confidence: "measured" },
          asIsHandlingMin: 10,
          toBeHumanMin: 2,
          baseWeight: 1,
          actGetActions: 1,
          actPutActions: 1,
          systemsTouchedBase: 1,
          tags: [],
          isCustom: false,
        }],
        customIntentsAvailable: true,
      });
    }
    if (path.endsWith("/api/flow-classes")) {
      return Response.json([
        { key: "fc1-deterministic", name: "Original", steps: [{ ...steps[0], label: "Original deterministic step" }] },
        { key: "fc3-multiagent", name: "Approved process", steps: [{ ...steps[1], label: "Approved multi-agent process" }] },
      ]);
    }
    if (path.endsWith("/api/flow-overrides")) {
      return Response.json([
        { id: 1, intentKey: "payroll-change", version: 1, flowClass: "fc1-deterministic", status: "approved", author: "A", rationale: "old" },
        { id: 2, intentKey: "payroll-change", version: 2, flowClass: "fc3-multiagent", status: "approved", author: "B", rationale: "current" },
      ]);
    }
    if (path.endsWith("/api/systems")) return Response.json([]);
    throw new Error(`Unexpected request: ${path}`);
  };

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
    globalThis.fetch = originalFetch;
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <IntentDetail />
      </QueryClientProvider>,
    );
  });

  await until(() => {
    assert.match(container.textContent ?? "", /approved override v2: fc3-multiagent/);
    assert.match(container.textContent ?? "", /Approved multi-/);
  }, "intent detail should render the approved override");
  assert.doesNotMatch(container.textContent ?? "", /Original deterministic step/);
  assert.ok(container.querySelector('svg[aria-label="BPMN Process Diagram"]'));
  await act(async () => findButton(container, "SIPOC").click());
  assert.match(container.textContent ?? "", /Approved multi- process/);
});