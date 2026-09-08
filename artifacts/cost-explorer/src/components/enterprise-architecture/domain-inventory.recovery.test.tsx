import test, { after } from "node:test";
import assert from "node:assert/strict";
import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Window } from "happy-dom";

// leave-guard installs itself at module evaluation time. Set up a real DOM
// before dynamically importing any of the editor modules.
const window = new Window({ url: "https://app.test/workspace/1" });
// React act's browser fallback creates MessageChannels in this ESM harness.
// Close those test-owned ports after all assertions rather than forcing Node
// to exit, which can truncate other test files in a parallel suite.
const channels: NodeMessageChannel[] = [];
class TestMessageChannel extends NodeMessageChannel {
  constructor() {
    super();
    channels.push(this);
  }
}
after(() => {
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
});
const domGlobals = {
  MessageChannel: TestMessageChannel,
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  history: window.history,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  SVGElement: window.SVGElement,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  Node: window.Node,
  Text: window.Text,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  FocusEvent: window.FocusEvent,
  PopStateEvent: window.PopStateEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
};
for (const [key, value] of Object.entries(domGlobals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});
// The production refresh has a 15-second timeout. A never-firing signal keeps
// that safety timer from holding Node's targeted test process open.
Object.defineProperty(AbortSignal, "timeout", {
  configurable: true,
  value: () => new AbortController().signal,
});

const { createRoot } = await import("react-dom/client");
const {
  DomainInventory,
} = await import("./domain-inventory");
const {
  TargetArchitectureManager,
} = await import("./target-architecture");
const {
  EditRecoveryProvider,
} = await import("./edit-recovery");
const {
  getGetEaAssessmentQueryKey,
  setBaseUrl,
} = await import("@workspace/api-client-react");

setBaseUrl("https://api.test");

const item = {
  id: "inventory-1",
  name: "Payroll",
  kind: "system",
  description: "",
  maturity: 3,
  criticality: "high",
  lifecycle: "active",
  owner: "Finance",
  confidence: "high",
  notes: "",
  evidence: [],
};
const targetComponent = {
  id: "target-1",
  name: "Customer portal",
  domain: "application",
  componentType: "system",
  description: "",
  status: "proposed",
  owner: "Digital",
  addressesGapIds: [],
  deliveredByWorkPackageIds: [],
};
const secondTargetComponent = {
  ...targetComponent,
  id: "target-2",
  name: "Identity service",
  owner: "Security",
};
const targetRelationship = {
  id: "relationship-1",
  sourceComponentId: targetComponent.id,
  targetComponentId: secondTargetComponent.id,
  relationshipType: "integrates-with",
  description: "Authenticates customers",
};

const fixture = {
  id: 1,
  name: "Architecture review",
  clientName: "Example Co",
  currentPhase: "business",
  status: "active",
  version: 7,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  content: {
    phaseProgress: [],
    requirements: [],
    currentState: {
      business: [item],
      data: [],
      application: [],
      technology: [],
      integration: [],
      ai: [],
      security: [],
      operatingModel: [],
    },
    gaps: [],
    targetArchitecture: {
      components: [targetComponent, secondTargetComponent],
      relationships: [targetRelationship],
    },
    opportunities: { solutionOptions: [], transitionArchitectures: [] },
    roadmap: { workPackages: [], waves: [], dependencies: [], prioritization: [] },
    governance: { contracts: [], reviews: [], deviations: [], waivers: [], remediation: [] },
    changeManagement: { requests: [], versionHistory: [] },
    decisions: [],
    risks: [],
    costLinks: [],
  },
} as any;

type ApiMode = "success" | "patch-503-get-success" | "patch-503-get-fail";
let mode: ApiMode = "success";
let patchCount = 0;
let getCount = 0;
let persistedName = item.name;
let patchGate: Promise<void> | null = null;

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  assert.equal(url, "https://api.test/api/enterprise-architecture/assessments/1");
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "PATCH") {
    patchCount++;
    const body = JSON.parse(String(init?.body));
    persistedName = body.content.currentState.business[0]?.name ?? persistedName;
    await patchGate;
    if (mode !== "success") {
      return new Response("temporarily unavailable", { status: 503 });
    }
    return Response.json({
      ...fixture,
      version: fixture.version + 1,
      content: {
        ...body.content,
        targetArchitecture: {
          ...body.content.targetArchitecture,
          components: body.content.targetArchitecture.components.map((component: typeof targetComponent) =>
            component.id === secondTargetComponent.id
              ? { ...component, owner: "Server security" }
              : component),
        },
      },
    });
  }
  if (method === "GET") {
    getCount++;
    if (mode === "patch-503-get-fail") {
      return new Response("still unavailable", { status: 503 });
    }
    return Response.json({
      ...fixture,
      version: fixture.version + 1,
      content: {
        ...fixture.content,
        currentState: {
          ...fixture.content.currentState,
          business: [{ ...item, name: "Server payroll" }],
        },
        targetArchitecture: {
          ...fixture.content.targetArchitecture,
          components: [
            { ...targetComponent, name: "Server portal" },
            { ...secondTargetComponent, owner: "Server security" },
          ],
        },
      },
    });
  }
  throw new Error(`Unexpected API method ${method}`);
};

function AssessmentFromCache() {
  const { data } = useQuery({
    queryKey: getGetEaAssessmentQueryKey(fixture.id),
    queryFn: async () => fixture,
    enabled: false,
  });
  assert.ok(data);
  return <DomainInventory assessment={data as any} domain="business" />;
}

function TargetArchitectureFromCache() {
  const { data } = useQuery({
    queryKey: getGetEaAssessmentQueryKey(fixture.id),
    queryFn: async () => fixture,
    enabled: false,
  });
  assert.ok(data);
  return <TargetArchitectureManager assessment={data as any} isReadOnly={false} />;
}

async function renderEditor() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } },
  });
  queryClient.setQueryData(getGetEaAssessmentQueryKey(fixture.id), structuredClone(fixture));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <EditRecoveryProvider>
          <AssessmentFromCache />
        </EditRecoveryProvider>
      </QueryClientProvider>,
    );
  });
  const input = container.querySelector(`[data-testid="input-item-name-${item.id}"]`) as HTMLInputElement;
  assert.ok(input);
  return { queryClient, container, root, input };
}

async function renderTargetArchitecture() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } },
  });
  queryClient.setQueryData(getGetEaAssessmentQueryKey(fixture.id), structuredClone(fixture));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <EditRecoveryProvider>
          <TargetArchitectureFromCache />
        </EditRecoveryProvider>
      </QueryClientProvider>,
    );
  });
  const input = container.querySelector(`[data-testid="input-target-name-${targetComponent.id}"]`) as HTMLInputElement;
  assert.ok(input);
  return { queryClient, container, root, input };
}

function delayPatch() {
  let release!: () => void;
  patchGate = new Promise<void>(resolve => {
    release = resolve;
  });
  return () => {
    patchGate = null;
    release();
  };
}

async function cleanup(root: Root, container: HTMLElement, queryClient: QueryClient) {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
}

async function typeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
  assert.equal(input.value, value);
}

async function blur(input: HTMLInputElement) {
  await act(async () => {
    input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
  });
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
}

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(message);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
    });
  }
}

function isBeforeUnloadBlocked() {
  const event = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

test("enterprise architecture editors protect drafts and integrate persistence recovery", async t => {
  await t.test("typing before blur warns on beforeunload and Back; cancel preserves draft", async () => {
    mode = "success";
    patchCount = getCount = 0;
    window.history.replaceState({}, "", "/workspace/1");
    window.history.pushState({}, "", "/workspace/2");
    const { root, container, input, queryClient } = await renderEditor();
    await typeValue(input, "Payroll draft");

    assert.equal(isBeforeUnloadBlocked(), true);
    let confirmations = 0;
    (window as unknown as globalThis.Window).confirm = () => {
      confirmations++;
      return false;
    };
    window.history.back();
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    assert.equal(confirmations, 1, "Back navigation should show the leave warning");
    assert.equal(window.location.pathname, "/workspace/2");
    assert.equal(input.value, "Payroll draft");
    assert.equal(patchCount, 0, "typing alone must not submit");
    await cleanup(root, container, queryClient);
  });

  for (const getSucceeds of [true, false]) {
    await t.test(`PATCH 503 and latest GET ${getSucceeds ? "success" : "failure"} retain recovery warning after settling`, async () => {
      mode = getSucceeds ? "patch-503-get-success" : "patch-503-get-fail";
      patchCount = getCount = 0;
      const { root, container, input, queryClient } = await renderEditor();
      await typeValue(input, `Rejected ${getSucceeds ? "with latest" : "without latest"}`);
      await blur(input);

      await waitFor(
        () => Boolean(container.querySelector('[aria-label="Unsaved edits"]')) &&
          [...container.querySelectorAll<HTMLButtonElement>("button")]
            .some(button => button.textContent === "Discard draft" && !button.disabled) &&
          patchCount === 1 && getCount === 1,
        "rejected edit recovery did not settle",
      );
      const recovery = container.querySelector('[aria-label="Unsaved edits"]')!;
      assert.match(recovery.textContent ?? "", /Resolve unsaved edits/);
      assert.match(recovery.textContent ?? "", getSucceeds ? /Server payroll/ : /Could not load the latest assessment/);
      assert.equal(isBeforeUnloadBlocked(), true);
      await cleanup(root, container, queryClient);
    });
  }

  await t.test("explicit discard clears warning and restores the saved value", async () => {
    mode = "patch-503-get-success";
    patchCount = getCount = 0;
    const { root, container, input, queryClient } = await renderEditor();
    await typeValue(input, "Rejected then discarded");
    await blur(input);
    await waitFor(
      () => (container.querySelector('[aria-label="Unsaved edits"]')?.textContent ?? "").includes("Server payroll"),
      "latest server value was not loaded",
    );
    const discard = [...container.querySelectorAll("button")]
      .find(button => button.textContent === "Discard draft") as HTMLButtonElement;
    assert.ok(discard);
    await click(discard);
    await waitFor(
      () => input.value === "Server payroll" && !container.querySelector('[aria-label="Unsaved edits"]'),
      "discard did not reset the inventory draft",
    );
    assert.equal(isBeforeUnloadBlocked(), false);
    await cleanup(root, container, queryClient);
  });

  await t.test("successful persistence clears the leave warning", async () => {
    mode = "success";
    patchCount = getCount = 0;
    const { root, container, input, queryClient } = await renderEditor();
    await typeValue(input, "Persisted payroll");
    assert.equal(isBeforeUnloadBlocked(), true);
    await blur(input);
    await waitFor(
      () => patchCount === 1 && input.value === "Persisted payroll" && !isBeforeUnloadBlocked(),
      "successful PATCH did not settle and clear dirty state",
    );
    assert.equal(getCount, 0);
    assert.equal(container.querySelector('[aria-label="Unsaved edits"]'), null);
    await cleanup(root, container, queryClient);
  });

  await t.test("target component draft survives a cache version-only update without submitting", async () => {
    mode = "success";
    patchCount = getCount = 0;
    const { root, container, input, queryClient } = await renderTargetArchitecture();
    try {
      await typeValue(input, "Version-safe portal");
      await act(async () => {
        queryClient.setQueryData(getGetEaAssessmentQueryKey(fixture.id), {
          ...structuredClone(fixture),
          version: fixture.version + 1,
        });
      });
      assert.equal(input.value, "Version-safe portal");
      assert.equal(isBeforeUnloadBlocked(), true);
      assert.equal(patchCount, 0);
    } finally {
      await cleanup(root, container, queryClient);
    }
  });

  for (const secondDraft of ["Second local portal", targetComponent.name]) {
    await t.test(`delayed target save preserves later draft ${secondDraft === targetComponent.name ? "reverted to original" : "with a new value"}`, async () => {
      mode = "success";
      patchCount = getCount = 0;
      const release = delayPatch();
      const { root, container, input, queryClient } = await renderTargetArchitecture();
      try {
        await typeValue(input, "Submitted portal");
        await blur(input);
        await waitFor(() => patchCount === 1, "target PATCH did not reach the response gate");
        await typeValue(input, secondDraft);
        release();
        await waitFor(
          () => {
            const cached = queryClient.getQueryData<any>(getGetEaAssessmentQueryKey(fixture.id));
            const refreshedOwner = container.querySelector<HTMLInputElement>(
              `[data-testid="input-target-owner-${secondTargetComponent.id}"]`,
            )?.value;
            return cached?.content.targetArchitecture.components[0].name === "Submitted portal" &&
              input.value === secondDraft && refreshedOwner === "Server security" &&
              isBeforeUnloadBlocked();
          },
          "later unblurred target edit was erased by the earlier save",
        );
        assert.equal(container.querySelector('[aria-label="Unsaved edits"]'), null);
      } finally {
        patchGate = null;
        await cleanup(root, container, queryClient);
      }
    });
  }

  for (const secondDraft of ["Second after rejection", targetComponent.name]) {
    await t.test(`target 503 refresh preserves later draft ${secondDraft === targetComponent.name ? "reverted to original" : "with a new value"}`, async () => {
      mode = "patch-503-get-success";
      patchCount = getCount = 0;
      const release = delayPatch();
      const { root, container, input, queryClient } = await renderTargetArchitecture();
      try {
        await typeValue(input, "Rejected portal");
        await blur(input);
        await waitFor(() => patchCount === 1, "target PATCH did not reach the response gate");
        await typeValue(input, secondDraft);
        release();
        await waitFor(
          () => getCount === 1 && [...container.querySelectorAll<HTMLButtonElement>("button")]
            .some(button => button.textContent === "Discard draft" && !button.disabled),
          "target recovery did not settle after refresh",
        );
        assert.equal(input.value, secondDraft);
        assert.equal(
          container.querySelector<HTMLInputElement>(
            `[data-testid="input-target-owner-${secondTargetComponent.id}"]`,
          )?.value,
          "Server security",
          "an untouched field should refresh from the server",
        );
        assert.equal(isBeforeUnloadBlocked(), true);
      } finally {
        patchGate = null;
        await cleanup(root, container, queryClient);
      }
    });
  }

  await t.test("ordinary target retry persists the rejected draft and becomes clean", async () => {
    mode = "patch-503-get-success";
    patchCount = getCount = 0;
    const release = delayPatch();
    const { root, container, input, queryClient } = await renderTargetArchitecture();
    try {
      await typeValue(input, "Rejected portal");
      await blur(input);
      await waitFor(() => patchCount === 1, "target PATCH did not reach the response gate");
      release();
      await waitFor(
        () => getCount === 1 && [...container.querySelectorAll<HTMLButtonElement>("button")]
          .some(button => button.textContent === "Retry draft" && !button.disabled),
        "ordinary target recovery did not settle",
      );

      const recovery = container.querySelector('[aria-label="Unsaved edits"]');
      assert.ok(recovery);
      assert.match(recovery.textContent ?? "", /Rejected portal/);
      assert.match(recovery.textContent ?? "", /Server portal/);
      assert.equal(input.value, "Rejected portal", "the rejected draft should remain inline before retry");
      assert.equal(isBeforeUnloadBlocked(), true);

      mode = "success";
      const retry = [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find(button => button.textContent === "Retry draft");
      assert.ok(retry);
      await click(retry);
      await waitFor(() => {
        const cached = queryClient.getQueryData<any>(getGetEaAssessmentQueryKey(fixture.id));
        return patchCount === 2 &&
          cached?.content.targetArchitecture.components[0].name === "Rejected portal" &&
          input.value === "Rejected portal" &&
          !container.querySelector('[aria-label="Unsaved edits"]') &&
          !isBeforeUnloadBlocked();
      }, "successful ordinary retry did not persist and settle cleanly");

      const settledPatchCount = patchCount;
      await blur(input);
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      assert.equal(patchCount, settledPatchCount, "blurring a settled retry must not issue another PATCH");
      assert.equal(
        queryClient.getQueryData<any>(getGetEaAssessmentQueryKey(fixture.id))
          ?.content.targetArchitecture.components[0].name,
        "Rejected portal",
        "a redundant blur must not revert the persisted retry",
      );
      assert.equal(isBeforeUnloadBlocked(), false);
    } finally {
      patchGate = null;
      await cleanup(root, container, queryClient);
    }
  });

  for (const resolution of ["Retry draft", "Discard draft"] as const) {
    await t.test(`${resolution} of the first target snapshot preserves the second local edit`, async () => {
      mode = "patch-503-get-success";
      patchCount = getCount = 0;
      const release = delayPatch();
      const { root, container, input, queryClient } = await renderTargetArchitecture();
      try {
        await typeValue(input, "First rejected portal");
        await blur(input);
        await waitFor(() => patchCount === 1, "target PATCH did not reach the response gate");
        await typeValue(input, `Second local after ${resolution}`);
        release();
        await waitFor(
          () => getCount === 1 && [...container.querySelectorAll<HTMLButtonElement>("button")]
            .some(button => button.textContent === resolution && !button.disabled),
          "target recovery controls did not appear",
        );
        mode = "success";
        const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find(candidate => candidate.textContent === resolution);
        assert.ok(button);
        await click(button);
        await waitFor(
          () => !container.querySelector('[aria-label="Unsaved edits"]'),
          `${resolution} did not settle`,
        );
        assert.equal(input.value, `Second local after ${resolution}`);
        assert.equal(isBeforeUnloadBlocked(), true);
      } finally {
        patchGate = null;
        await cleanup(root, container, queryClient);
      }
    });
  }
  void window.happyDOM.abort();
  window.close();
});