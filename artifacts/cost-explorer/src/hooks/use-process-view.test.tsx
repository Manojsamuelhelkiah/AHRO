import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const window = new Window({
  url: "https://app.test/cost-explorer/scenario?id=123&overlayId=456&view=sipoc#results",
});

for (const [key, value] of Object.entries({
  window,
  document: window.document,
  location: window.location,
  history: window.history,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  Event: window.Event,
  PopStateEvent: window.PopStateEvent,
  addEventListener: window.addEventListener.bind(window),
  removeEventListener: window.removeEventListener.bind(window),
  dispatchEvent: window.dispatchEvent.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const [{ createElement, act }, { createRoot }, { Router }, processView] = await Promise.all([
  import("react"),
  import("react-dom/client"),
  import("wouter"),
  import("./use-process-view"),
]);

after(async () => {
  await window.happyDOM.close();
});

test("accepts supported values and falls back for invalid or retired values", () => {
  assert.equal(processView.parseProcessView("bpmn"), "bpmn");
  assert.equal(processView.parseProcessView("sipoc"), "sipoc");
  assert.equal(processView.parseProcessView("technical"), "technical");
  assert.equal(processView.parseProcessView(null), "bpmn");
  assert.equal(processView.parseProcessView("workflow"), "bpmn");
  assert.equal(processView.parseProcessView("BPMN"), "bpmn");
});

test("preserves scenario context and follows same-route history navigation", async () => {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container as unknown as Element);

  function Harness() {
    const [view, setView] = processView.useProcessViewPreference();
    return createElement(
      "button",
      { type: "button", onClick: () => setView("technical") },
      view,
    );
  }

  await act(async () => {
    root.render(createElement(Router, {
      base: "/cost-explorer",
      children: createElement(Harness),
    }));
  });
  assert.equal(container.textContent, "sipoc");

  await act(async () => {
    container.querySelector("button")!.click();
  });
  assert.equal(window.location.pathname, "/cost-explorer/scenario");
  assert.equal(window.location.search, "?id=123&overlayId=456&view=technical");
  assert.equal(window.location.hash, "#results");
  assert.equal(window.localStorage.getItem(processView.PROCESS_VIEW_STORAGE_KEY), "technical");
  assert.equal(container.textContent, "technical");

  await act(async () => {
    window.history.pushState(null, "", "/cost-explorer/scenario?id=123&overlayId=456&view=sipoc#results");
  });
  assert.equal(container.textContent, "sipoc");

  await act(async () => {
    window.history.pushState(null, "", "/cost-explorer/scenario?id=123&overlayId=456&view=bpmn#results");
  });
  assert.equal(container.textContent, "bpmn");

  await act(async () => {
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(window.location.search, "?id=123&overlayId=456&view=sipoc");
  assert.equal(container.textContent, "sipoc");

  await act(async () => {
    window.history.forward();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(window.location.search, "?id=123&overlayId=456&view=bpmn");
  assert.equal(container.textContent, "bpmn");

  await act(async () => root.unmount());
  container.remove();
});