import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Window } from "happy-dom";
import { ClerkProvider } from "@clerk/react";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const requestId = "setup-request-246";
const approvalValue = "a".repeat(64);
const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const DemoTestClerkProvider = ClerkProvider as unknown as React.ComponentType<{
  children?: React.ReactNode;
  user: {
    id: string;
    primaryEmailAddress: { emailAddress: string };
  };
}>;

const capabilities = {
  available: true,
  reason: null,
  organizationId: "demo",
  canCreateRuns: true,
  canDispatchLive: false,
  defaultMode: "hybrid",
  allowedSystems: ["bgv"],
  scenarios: [
    {
      key: "day-one",
      title: "Day One",
      description: "A synthetic first-day walkthrough.",
    },
  ],
  approvedVolunteers: [
    {
      id: "volunteer-missing",
      name: "Missing reviewer",
      email: "missing@example.test",
      phone: null,
      channelPreference: "email",
      approved: true,
      workCountry: "US",
      lifecyclePolicyReady: false,
      lifecyclePolicyReason: "Nominate a privacy or legal reviewer before approving the policy pack.",
      liveEmailAvailable: false,
      liveCallAvailable: false,
      capabilityReason: null,
      privacyReadiness: {
        requiredPolicyCoverage: ["identity", "contact"],
        coveredPolicyCoverage: [],
        missingPolicyCoverage: ["identity", "contact"],
        authorityStatus: "missing",
        reviewer: null,
        nomination: null,
        nextAction: "nominate-reviewer",
      },
    },
    {
      id: "volunteer-nominated",
      name: "Nominated reviewer",
      email: "nominated@example.test",
      phone: null,
      channelPreference: "email",
      approved: true,
      workCountry: "US",
      lifecyclePolicyReady: false,
      lifecyclePolicyReason: "A server-verified operator must confirm the nomination.",
      liveEmailAvailable: false,
      liveCallAvailable: false,
      capabilityReason: null,
      privacyReadiness: {
        requiredPolicyCoverage: ["identity", "contact"],
        coveredPolicyCoverage: ["identity"],
        missingPolicyCoverage: ["contact"],
        authorityStatus: "nominated",
        reviewer: null,
        nomination: {
          assignmentId: 11,
          role: "privacy",
          memberId: "clerk-nominated",
          memberDisplay: "Organization member · mina…ated",
        },
        nextAction: "wait-for-verification",
      },
    },
    {
      id: "volunteer-verified",
      name: "Verified reviewer",
      email: "verified@example.test",
      phone: null,
      channelPreference: "email",
      approved: true,
      workCountry: "US",
      lifecyclePolicyReady: true,
      lifecyclePolicyReason: null,
      liveEmailAvailable: false,
      liveCallAvailable: false,
      capabilityReason: null,
      privacyReadiness: {
        requiredPolicyCoverage: ["identity", "contact"],
        coveredPolicyCoverage: ["identity", "contact"],
        missingPolicyCoverage: [],
        authorityStatus: "verified",
        reviewer: {
          assignmentId: 12,
          role: "legal",
          memberId: "clerk-verified",
          memberDisplay: "Organization member · veri…fied",
          expiresAt: null,
        },
        nomination: null,
        nextAction: "ready",
      },
    },
    {
      id: "volunteer-revoked",
      name: "Revoked reviewer",
      email: "revoked@example.test",
      phone: null,
      channelPreference: "email",
      approved: true,
      workCountry: "US",
      lifecyclePolicyReady: false,
      lifecyclePolicyReason: "The previous reviewer is no longer current.",
      liveEmailAvailable: false,
      liveCallAvailable: false,
      capabilityReason: null,
      privacyReadiness: {
        requiredPolicyCoverage: ["identity", "contact"],
        coveredPolicyCoverage: [],
        missingPolicyCoverage: ["identity", "contact"],
        authorityStatus: "revoked",
        reviewer: null,
        nomination: null,
        nextAction: "nominate-reviewer",
      },
    },
  ],
  existingSessions: [],
};

const initialSetupStatus = {
  eligible: true,
  reason: null,
  request: null,
  completed: false,
};

const pendingSetupStatus = {
  eligible: true,
  reason: null,
  request: {
    requestId,
    approvalValue,
    expiresAt,
    approved: false,
  },
  completed: false,
};

const approvedSetupStatus = {
  ...pendingSetupStatus,
  request: {
    ...pendingSetupStatus.request,
    approved: true,
  },
};

const completedSetupStatus = {
  eligible: false,
  reason:
    "Demo Controller setup was already completed for this account; the one-time bootstrap cannot be replayed.",
  request: null,
  completed: true,
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await tick();
    });
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function pageText(): string {
  return (globalThis.document?.body.textContent ?? "").replace(/\s+/g, " ");
}

function buttonWithText(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
    (candidate.textContent ?? "").includes(label),
  );
  assert.ok(
    button,
    `Expected a button containing "${label}". Current page: ${pageText()}`,
  );
  return button as HTMLButtonElement;
}

describe("Demo Controller access setup", { concurrency: false }, () => {
  it("completes the member setup request from the normal Demo page", async () => {
    const dom = new Window({ url: "http://localhost/demo-controller" });
    const originalGlobalDescriptors = new Map<
      string,
      PropertyDescriptor | undefined
    >();
    const browserGlobals = [
      "window",
      "document",
      "navigator",
      "location",
      "self",
      "HTMLElement",
      "HTMLButtonElement",
      "HTMLInputElement",
      "HTMLTextAreaElement",
      "Node",
      "Element",
      "Text",
      "Event",
      "MouseEvent",
      "KeyboardEvent",
      "MutationObserver",
      "addEventListener",
      "removeEventListener",
      "dispatchEvent",
      "history",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "getComputedStyle",
    ];

    for (const name of browserGlobals) {
      originalGlobalDescriptors.set(
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
      );
      const value = (dom as unknown as Record<string, unknown>)[name];
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value:
          typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(dom)
            : value,
      });
    }
    for (const name of ["fetch", "IS_REACT_ACT_ENVIRONMENT"]) {
      originalGlobalDescriptors.set(
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
      );
    }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      writable: true,
      value: true,
    });

    dom.localStorage.setItem("activeOrganizationId", "demo");
    const demoUser = {
      id: "demo-member-246",
      primaryEmailAddress: { emailAddress: "member-246@example.com" },
    };

    let requestStarted = false;
    let approvalAvailable = false;
    let completeStarted = false;
    let completeResponseDelivered = false;
    let completeRequestId: string | null = null;
    let resolveCreate: (() => void) | null = null;
    let resolveApproval: (() => void) | null = null;
    let resolveComplete: (() => void) | null = null;
    const requests: Array<{ method: string; path: string }> = [];

    const fetchMock = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input), dom.location.href);
      const method = (init?.method ?? "GET").toUpperCase();
      requests.push({ method, path: url.pathname });
      assert.equal(
        new Headers(init?.headers).get("x-organization-id"),
        "demo",
        "generated fetch helpers must retain the page-pinned Demo scope",
      );

      if (method === "GET" && url.pathname === "/api/onboarding/demo-controller") {
        return response(capabilities);
      }
      if (
        method === "GET" &&
        url.pathname === "/api/organizations/demo-controller-setup"
      ) {
        if (!requestStarted) return response(initialSetupStatus);
        if (!approvalAvailable) return response(pendingSetupStatus);
        return new Promise<Response>((resolve) => {
          resolveApproval = () => resolve(response(approvedSetupStatus));
        });
      }
      if (
        method === "POST" &&
        url.pathname === "/api/organizations/demo-controller-setup/request"
      ) {
        requestStarted = true;
        return new Promise<Response>((resolve) => {
          resolveCreate = () => resolve(response(pendingSetupStatus));
        });
      }
      if (
        method === "POST" &&
        url.pathname === "/api/organizations/demo-controller-setup/complete"
      ) {
        completeStarted = true;
        completeRequestId = JSON.parse(String(init?.body)).requestId;
        return new Promise<Response>((resolve) => {
          resolveComplete = () => {
            completeResponseDelivered = true;
            resolve(response(completedSetupStatus));
          };
        });
      }

      throw new Error(`Unexpected mock HTTP request: ${method} ${url.pathname}`);
    };
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    (dom as unknown as Record<string, unknown>).fetch = fetchMock;

    let reloadCalls = 0;
    const originalReload = dom.location.reload;
    Object.defineProperty(dom.location, "reload", {
      configurable: true,
      value: () => {
        reloadCalls += 1;
      },
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    let clearCalls = 0;
    const originalClear = queryClient.clear.bind(queryClient);
    queryClient.clear = () => {
      clearCalls += 1;
      originalClear();
    };

    const { DemoControllerIndexPage } = await import("./index");
    const { getPinnedOrganizationIdForPage } = await import(
      "@workspace/api-client-react"
    );
    assert.equal(getPinnedOrganizationIdForPage(), "demo");
    const root = createRoot(document.body);

    try {
      await act(async () => {
        root.render(
          <DemoTestClerkProvider user={demoUser}>
            <QueryClientProvider client={queryClient}>
              <DemoControllerIndexPage />
            </QueryClientProvider>
          </DemoTestClerkProvider>,
        );
        await tick();
      });
      await waitFor(
        () =>
          pageText().includes("Demo Center") &&
          pageText().includes("First Demo administrator setup") &&
          pageText().includes("Create private setup request"),
        "the available normal Demo page and enabled access setup",
      );
      assert.match(pageText(), /Available to every Demo Organization user/);
      assert.doesNotMatch(pageText(), /Demo Controller access required/);
      assert.match(pageText(), /No verified reviewer/);
      assert.match(pageText(), /Nominated — verification pending/);
      assert.match(pageText(), /Verified reviewer/);
      assert.match(pageText(), /Previous reviewer revoked/);
      assert.match(pageText(), /Fully simulated walkthroughs are always available/);
      assert.match(pageText(), /Nominate reviewer/);

      const createButton = buttonWithText("Create private setup request");
      await act(async () => {
        createButton.click();
        await Promise.resolve();
      });
      assert.equal(requestStarted, true);
      await waitFor(
        () => pageText().includes("Creating request…"),
        "the request pending state",
      );

      assert.ok(resolveCreate);
      await act(async () => {
        resolveCreate!();
        await tick();
      });
      await waitFor(
        () => pageText().includes("Waiting for explicit project operator approval."),
        "the pending setup request",
      );

      approvalAvailable = true;
      const checkButton = buttonWithText("Check approval");
      await act(async () => {
        checkButton.click();
        await Promise.resolve();
      });
      await waitFor(
        () => pageText().includes("Checking…"),
        "the approval check pending state",
      );
      assert.ok(resolveApproval);
      await act(async () => {
        resolveApproval!();
        await tick();
      });
      await waitFor(
        () => pageText().includes("Operator approval received."),
        "the approved setup request",
      );

      const confirmation = document.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      );
      assert.ok(confirmation, "Expected the membership authorization checkbox");
      await act(async () => {
        confirmation!.click();
      });
      assert.equal(confirmation.checked, true);

      const completeButton = buttonWithText("Confirm and enable Demo access");
      await act(async () => {
        completeButton.click();
        await Promise.resolve();
      });
      assert.equal(completeStarted, true);
      assert.equal(completeRequestId, requestId);
      assert.match(pageText(), /Completing setup…/);

      assert.ok(resolveComplete);
      await act(async () => {
        resolveComplete!();
        await tick();
      });
      await waitFor(() => reloadCalls === 1, "the post-membership reload");
      assert.equal(clearCalls, 1, "completion must clear React Query cache");
      assert.equal(reloadCalls, 1);
      assert.equal(completeResponseDelivered, true);
      assert.ok(
        requests.some(
          ({ method, path }) =>
            method === "POST" &&
            path === "/api/organizations/demo-controller-setup/complete",
        ),
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      queryClient.clear();
      Object.defineProperty(dom.location, "reload", {
        configurable: true,
        value: originalReload,
      });
      dom.close();
      for (const name of browserGlobals) {
        const descriptor = originalGlobalDescriptors.get(name);
        if (descriptor === undefined) {
          delete (globalThis as Record<string, unknown>)[name];
        } else {
          Object.defineProperty(globalThis, name, descriptor);
        }
      }
      for (const name of ["fetch", "IS_REACT_ACT_ENVIRONMENT"]) {
        const descriptor = originalGlobalDescriptors.get(name);
        if (descriptor === undefined) {
          delete (globalThis as Record<string, unknown>)[name];
        } else {
          Object.defineProperty(globalThis, name, descriptor);
        }
      }
    }
  });
it("preserves workforce-transfer enum values in rendered controls and submitted payloads", async () => {
  const dom = new Window({ url: "http://localhost/workforce-transfers/program-1" });
  const names = ["window", "document", "navigator", "location", "self", "HTMLElement", "HTMLSelectElement", "HTMLInputElement", "HTMLFormElement", "Event", "Node", "Text", "MutationObserver"];
  const original = new Map<string, PropertyDescriptor | undefined>();
  for (const name of names) {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value = (dom as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" ? (value as Function).bind(dom) : value });
  }
  original.set("IS_REACT_ACT_ENVIRONMENT", Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), dom.location.href);
    if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/populations/pop-1/reconciliation")) {
      return response({ populationId: "pop-1", expectedHeadcount: 1, importedHeadcount: 1, migrationCounts: {}, workers: [{ id: "worker-1", migrationStatus: "pending", objectionStatus: "pending", version: 3 }] });
    }
    requests.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "{}")) });
    return response({ version: 2, actionId: "action-1", planId: "plan-1" });
  };
  globalThis.fetch = fetchMock;
  (dom as unknown as Record<string, unknown>).fetch = fetchMock;
  const program = {
    id: "program-1", version: 1, name: "Transfer", sourceLegalEntity: "Source", destinationLegalEntity: "Destination", countries: ["GB"], proposedBasis: "automatic-transfer" as const, legalDay1: "2025-01-01", owners: { hrIntegration: "hr", legal: "legal", payroll: "payroll", it: "it" }, status: "draft", createdAt: "2024-01-01T00:00:00.000Z",
    populations: [{ id: "pop-1", country: "GB", expectedHeadcount: 1, importedHeadcount: 1, status: "ready", version: 1 }], pathways: [], consultation: [], integrationActions: [],
    cutoverPlans: [{ id: "plan-1", version: 4, workerCount: 1, status: "draft" as const, readinessGeneration: 1, createdAt: "2024-01-01T00:00:00.000Z", decisionAt: null, contingencyRecorded: false, signoffs: [], workerReconciliation: [] }],
  };
  const findSelect = (optionValue: string) => {
    const select = Array.from(document.querySelectorAll("select")).find((candidate) => Array.from(candidate.options).some((option) => option.value === optionValue));
    assert.ok(select, `Expected select with ${optionValue}`);
    return select!;
  };
  const inputIn = (form: HTMLFormElement, label: string) => {
    const input = Array.from(form.querySelectorAll("input")).find((candidate) => candidate.parentElement?.textContent?.includes(label));
    assert.ok(input, `Expected ${label} input`);
    return input!;
  };
  const setValue = async (element: HTMLInputElement | HTMLSelectElement, value: string) => {
    await act(async () => {
      element.value = value;
      if (element instanceof HTMLInputElement) element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      await tick();
    });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const { OperationsSection } = await import("../workforce-transfers/operations");
  const { CutoverSection } = await import("../workforce-transfers/cutover");
  const root = createRoot(document.body);
  try {
    await act(async () => { root.render(<QueryClientProvider client={client}><OperationsSection program={program} /><CutoverSection program={program} /></QueryClientProvider>); await tick(); });
    await waitFor(() => document.querySelector('option[value="worker-1"]') !== null, "the live worker choice");
    for (const value of ["contingency-parallel-run", "in-progress", "first-pay", "unknown-effect-manual-repair"]) {
      assert.ok(document.querySelector(`option[value="${value}"]`), `Expected raw enum option ${value}`);
    }

    const milestoneStatus = findSelect("communicated");
    const milestoneForm = milestoneStatus.closest("form")!;
    await setValue(inputIn(milestoneForm, "Milestone"), "notice");
    await setValue(inputIn(milestoneForm, "Due date"), "2025-01-02");
    await setValue(inputIn(milestoneForm, "Evidence reference"), "milestone-evidence");
    await act(async () => { milestoneForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick(); });
    const milestoneRequest = requests.find((request) => request.path.endsWith("/consultation-milestones"));
    assert.equal(milestoneRequest?.body.status, "planned");
    assert.equal("completedAt" in (milestoneRequest?.body ?? {}), false, "planned milestone must omit completedAt");

    const actionKind = findSelect("contingency-parallel-run");
    await setValue(actionKind, "contingency-parallel-run");
    assert.equal(actionKind.value, "contingency-parallel-run");
    const actionForm = actionKind.closest("form")!;
    await setValue(findSelect("in-progress"), "completed");
    await setValue(inputIn(actionForm, "Owner user ID"), "owner-1");
    await setValue(inputIn(actionForm, "Due date"), "2025-01-02");
    await setValue(inputIn(actionForm, "Actual completion date"), "2025-01-03");
    await setValue(inputIn(actionForm, "Evidence reference"), "parallel-run-evidence");
    await act(async () => { actionForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick(); });
    const actionRequest = requests.find((request) => request.path.endsWith("/integration-actions"));
    assert.equal(actionRequest?.body.kind, "contingency-parallel-run");
    assert.equal(actionRequest?.body.status, "completed");
    assert.equal("completedAt" in (actionRequest?.body ?? {}), true, "completed action payload must include completedAt");

    const stream = findSelect("first-pay");
    const reconciliationForm = stream.closest("form")!;
    await setValue(stream, "first-pay");
    const reconciliationStatus = findSelect("unknown-effect-manual-repair");
    await setValue(reconciliationStatus, "unknown-effect-manual-repair");
    const reconciliationWorker = Array.from(reconciliationForm.querySelectorAll("select")).find((candidate) => Array.from(candidate.options).some((option) => option.value === "worker-1"));
    assert.ok(reconciliationWorker, "Expected the reconciliation worker choice");
    await setValue(reconciliationWorker!, "worker-1");
    await setValue(inputIn(reconciliationForm, "Evidence reference"), "reconciliation-evidence");
    await act(async () => { reconciliationForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick(); });
    const reconciliationRequest = requests.find((request) => request.path.endsWith("/workers/worker-1/reconciliation"));
    assert.equal(reconciliationRequest?.body.stream, "first-pay");
    assert.equal(reconciliationRequest?.body.status, "unknown-effect-manual-repair");
  } finally {
    await act(async () => { root.unmount(); });
    client.clear(); globalThis.fetch = originalFetch; dom.close();
    for (const name of names) {
      const descriptor = original.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as Record<string, unknown>)[name];
    }
    const actDescriptor = original.get("IS_REACT_ACT_ENVIRONMENT");
    if (actDescriptor) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actDescriptor); else delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  }
});
});