import "./test-support/organization-members-dom";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { disposeOrganizationMembersDom, testWindow } from "./test-support/organization-members-dom";

type RemovedMember = {
  clerkUserId: string;
  revokedAt: string;
  revision: number;
};

type MutationOutcome =
  | { kind: "success"; value?: unknown }
  | { kind: "error"; error: unknown };

type TestState = {
  activeMembers: Array<{ clerkUserId: string; role: string; createdAt: string }>;
  removedMembers: RemovedMember[];
  removedHookOptions: Array<{ query?: { enabled?: boolean; staleTime?: number } }>;
  removedRefetches: number;
  reinstateCalls: unknown[];
  reinstateOutcome: MutationOutcome;
};

const [{ createRoot }, { QueryClient, QueryClientProvider }, { OrganizationMembersSettings }] =
  await Promise.all([
    import("react-dom/client"),
    import("@tanstack/react-query"),
    import("./settings-organization-members"),
  ]);

after(async () => {
  await disposeOrganizationMembersDom();
});

function resetState(role: "owner" | "admin", overrides: Partial<TestState> = {}) {
  const state: TestState = {
    activeMembers: [
      {
        clerkUserId: "user-active",
        role: "member",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    removedMembers: [
      {
        clerkUserId: "user-removed",
        revokedAt: "2026-02-03T04:05:06.000Z",
        revision: 2,
      },
    ],
    removedHookOptions: [],
    removedRefetches: 0,
    reinstateCalls: [],
    reinstateOutcome: { kind: "success" },
    ...overrides,
  };
  Object.defineProperty(globalThis, "__organizationMembersTestRole", {
    configurable: true,
    writable: true,
    value: role,
  });
  Object.defineProperty(globalThis, "__organizationMembersTestState", {
    configurable: true,
    writable: true,
    value: state,
  });
  return state;
}

async function mount(state: TestState) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const invalidatedKeys: unknown[][] = [];
  const invalidateQueries = client.invalidateQueries.bind(client);
  (client as unknown as {
    invalidateQueries: (filters?: { queryKey?: unknown[] }) => Promise<unknown>;
  }).invalidateQueries = (filters = {}) => {
    if (filters.queryKey) invalidatedKeys.push(filters.queryKey);
    return invalidateQueries(filters);
  };

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <OrganizationMembersSettings />
      </QueryClientProvider>,
    );
  });

  return {
    container,
    invalidatedKeys,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      client.clear();
      state.removedHookOptions.length = 0;
    },
  };
}

function button(container: Element, text: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  assert.ok(match, `expected button containing "${text}"`);
  return match as HTMLButtonElement;
}

async function eventually(assertion: () => void, message: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw new Error(
    `${message}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function openReinstatement(container: HTMLElement) {
  await act(async () => button(container, "Review reinstatement").click());
  const form = container.querySelector("form");
  assert.ok(form, "expected reinstatement form");
  const textarea = form.querySelector("textarea");
  assert.ok(textarea, "expected required reason textarea");
  return {
    form,
    textarea: textarea as HTMLTextAreaElement,
    submit: button(form, "Reinstate as member"),
  };
}

async function fillReason(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      testWindow.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
  });
}

test("owner sees removed accounts and cannot submit without a reinstatement reason", async (t) => {
  const state = resetState("owner");
  const mounted = await mount(state);
  t.after(mounted.cleanup);

  const removedPanel = mounted.container.querySelector('[aria-label="Removed members"]');
  assert.ok(removedPanel);
  assert.match(removedPanel.textContent ?? "", /user-removed/);

  const reinstatement = await openReinstatement(mounted.container);
  assert.equal(reinstatement.textarea.required, true);
  assert.equal(reinstatement.submit.disabled, true);
});

test("successful reinstatement sends the clerk user and revocation version, then refreshes both lists", async (t) => {
  const state = resetState("owner", {
    reinstateOutcome: { kind: "success" },
  });
  const mounted = await mount(state);
  t.after(mounted.cleanup);

  const reinstatement = await openReinstatement(mounted.container);
  await fillReason(reinstatement.textarea, "Access restored after verified identity review.");
  await eventually(
    () => assert.equal(reinstatement.submit.disabled, false),
    "reason should enable reinstatement",
  );

  await act(async () => reinstatement.submit.click());
  await eventually(
    () => assert.equal(mounted.container.querySelector("form"), null),
    "successful reinstatement should close the form",
  );

  assert.deepEqual(state.reinstateCalls, [
    {
      userId: "user-removed",
      data: {
        expectedRevokedAt: "2026-02-03T04:05:06.000Z",
        expectedRevision: 2,
        reason: "Access restored after verified identity review.",
      },
    },
  ]);
  assert.match(
    mounted.container.textContent ?? "",
    /Account reinstated as an ordinary member/,
  );
  assert.deepEqual(mounted.invalidatedKeys, [
    ["organization-members"],
    ["organization-removed-members"],
  ]);
});

test("a stale reinstatement error closes the form, refreshes both lists, and shows the server message", async (t) => {
  const state = resetState("owner", {
    reinstateOutcome: {
      kind: "error",
      error: { message: "The removed membership changed; refresh and try again." },
    },
  });
  const mounted = await mount(state);
  t.after(mounted.cleanup);
  assert.equal(state.removedHookOptions.at(-1)?.query?.staleTime, 0);

  const reinstatement = await openReinstatement(mounted.container);
  await fillReason(reinstatement.textarea, "Verified recovery request.");
  await act(async () => reinstatement.submit.click());
  await eventually(
    () =>
      assert.match(
        mounted.container.textContent ?? "",
        /The removed membership changed; refresh and try again\./,
      ),
    "stale reinstatement error should be visible",
  );

  assert.equal(mounted.container.querySelector("form"), null);
  assert.deepEqual(mounted.invalidatedKeys, [
    ["organization-members"],
    ["organization-removed-members"],
  ]);
});

test("admins can review active membership but cannot see the removed-members reinstatement panel", async (t) => {
  const state = resetState("admin");
  const mounted = await mount(state);
  t.after(mounted.cleanup);

  assert.equal(mounted.container.querySelector('[aria-label="Removed members"]'), null);
  assert.doesNotMatch(mounted.container.textContent ?? "", /Review reinstatement/);
  assert.equal(state.removedHookOptions.at(-1)?.query?.enabled, false);
});