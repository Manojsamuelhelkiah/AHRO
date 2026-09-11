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
  approvedVolunteers: [],
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

describe("Demo Controller access setup", () => {
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
});