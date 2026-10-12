import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClerkProvider } from "@clerk/react";
import { getPinnedOrganizationIdForPage, pinOrganizationIdForPage } from "@workspace/api-client-react";
let OrganizationSwitcher: typeof import("./organization-switcher").OrganizationSwitcher;
let ClientSetupPage: typeof import("../pages/client-setup").ClientSetupPage;

const TestAuth = ClerkProvider as unknown as React.ComponentType<{
  children: React.ReactNode; user: { id: string };
}>;
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

async function fixture(
  url: string,
  handler: typeof fetch,
  run: (dom: Window, render: (element: React.ReactNode) => Promise<void>) => Promise<void>,
) {
  const dom = new Window({ url: `http://localhost${url}` });
  const names = ["window", "document", "navigator", "location", "localStorage", "sessionStorage",
    "self", "history", "addEventListener", "removeEventListener", "dispatchEvent",
    "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Event", "CustomEvent", "Node", "NodeFilter",
    "Text", "MutationObserver", "getComputedStyle",
    "IS_REACT_ACT_ENVIRONMENT"];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const oldFetch = globalThis.fetch;
  for (const name of names) Object.defineProperty(globalThis, name, {
    configurable: true, writable: true,
    value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom as unknown as Record<string, unknown>)[name],
  });
  globalThis.fetch = handler;
  dom.localStorage.setItem("activeOrganizationId", "client-a");
  pinOrganizationIdForPage("client-a");
  const { createRoot } = await import("react-dom/client");
  ({ OrganizationSwitcher } = await import("./organization-switcher"));
  ({ ClientSetupPage } = await import("../pages/client-setup"));
  const root = createRoot(document.body);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = async (element: React.ReactNode) => {
    await act(async () => {
      root.render(<QueryClientProvider client={client}><TestAuth user={{ id: "fixture-user" }}>{element}</TestAuth></QueryClientProvider>);
      await settle();
    });
    await act(settle);
  };
  try { await run(dom, render); }
  finally {
    await act(async () => root.unmount());
    client.clear();
    pinOrganizationIdForPage(null);
    globalThis.fetch = oldFetch;
    dom.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

function current(count = 1, admin = false) {
  return {
    needsSetup: false, activeOrganizationId: "client-a", platformSuperAdmin: admin,
    memberships: [
      { organizationId: "client-a", name: "Fictional Client A", role: "owner" },
      ...(count > 1 ? [{ organizationId: "client-b", name: "Fictional Client B", role: "member" }] : []),
    ],
  };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});

test("Settings removes only workspace management, not membership or access governance", () => {
  const source = readFileSync("src/pages/settings.tsx", "utf8");
  assert.doesNotMatch(source, />Organizations<|organizationAction=|Create organization|Join organization/);
  assert.match(source, /<OrganizationMembersSettings \/>/);
  assert.match(source, /<AccessGovernanceSettings \/>/);
});

for (const count of [1, 2]) {
  test(`${count} memberships retain visible selector and create/join mode destinations without retargeting`, async () => {
    await fixture("/", async () => json(current(count)), async (dom, render) => {
      await render(<OrganizationSwitcher />);
      const selector = dom.document.querySelector("select")!;
      assert.equal(selector.getAttribute("aria-label"), "Active client workspace");
      assert.equal(selector.options.length, count);
      assert.equal(selector.value, "client-a");
      assert.match(dom.document.body.textContent!, /Client workspaces/);
      assert.equal(dom.document.querySelector('[data-testid="link-create-client-workspace"]')?.getAttribute("href"),
        "/client-setup?organizationAction=create");
      assert.equal(dom.document.querySelector('[data-testid="link-join-client-workspace"]')?.getAttribute("href"),
        "/client-setup?organizationAction=join");
      assert.equal(dom.localStorage.getItem("activeOrganizationId"), "client-a");
      assert.equal(getPinnedOrganizationIdForPage(), "client-a");
    });
  });
}

test("privileged quick-create is the only header create action and opening/cancelling preserves scope", async () => {
  let requests = 0;
  await fixture("/", async () => { requests++; return json(current(2, true)); }, async (dom, render) => {
    await render(<OrganizationSwitcher />);
    assert.equal(dom.document.querySelector('[data-testid="link-create-client-workspace"]'), null);
    const trigger = dom.document.querySelector('[data-testid="button-create-client"]') as unknown as HTMLButtonElement;
    assert.equal(trigger.textContent, "Create client workspace");
    trigger.focus();
    await act(async () => trigger.click());
    assert(dom.document.querySelector('[role="dialog"]'));
    const cancel = [...dom.document.querySelectorAll("button")].find(button => button.textContent === "Cancel")!;
    await act(async () => { cancel.click(); await settle(); });
    assert.equal(dom.document.querySelector('[role="dialog"]'), null);
    assert.equal(dom.localStorage.getItem("activeOrganizationId"), "client-a");
    assert.equal(getPinnedOrganizationIdForPage(), "client-a");
    assert.equal(requests, 1, "opening setup must not create or validate another tenant");
  });
});

test("rejected switch preserves the selector, stored tenant, and page-pinned scope", async () => {
  let calls = 0;
  await fixture("/", async (_url, init) => {
    calls++;
    if (calls === 1) return json(current(2));
    assert.equal(new Headers(init?.headers).get("x-organization-id"), "client-b");
    return json({ ...current(1), activeOrganizationId: null });
  }, async (dom, render) => {
    await render(<OrganizationSwitcher />);
    const select = dom.document.querySelector("select")!;
    await act(async () => {
      select.value = "client-b";
      select.dispatchEvent(new dom.Event("change", { bubbles: true }));
      await settle();
    });
    assert.match(dom.document.querySelector('[role="alert"]')?.textContent ?? "", /no longer have access/);
    assert.equal(select.value, "client-a");
    assert.equal(dom.localStorage.getItem("activeOrganizationId"), "client-a");
    assert.equal(getPinnedOrganizationIdForPage(), "client-a");
  });
});

for (const mode of ["create", "join"] as const) {
  test(`setup opens in ${mode} mode and failed submission leaves the workspace unchanged`, async () => {
    const posts: string[] = [];
    await fixture(`/client-setup?organizationAction=${mode}`, async (url, init) => {
      assert.equal(new Headers(init?.headers).get("x-organization-id"), "client-a");
      if (init?.method === "POST") { posts.push(String(url)); return json({ message: "Fixture denied" }, 403); }
      return json(current());
    }, async (dom, render) => {
      await render(<ClientSetupPage />);
      assert.equal(dom.document.querySelector("h1")?.textContent, `${mode === "create" ? "Create" : "Join"} client workspace`);
      assert.equal(dom.document.querySelector('button[aria-pressed="true"]')?.textContent?.trim(),
        `${mode === "create" ? "Create" : "Join"} client workspace`);
      const fields = [...dom.document.querySelectorAll("input")].filter(input => input.type !== "file");
      await act(async () => {
        for (const input of fields) {
          const label = input.parentElement?.textContent ?? "";
          const value = label.includes("country") ? "US" : mode === "join" ? "FICTIONAL" : "Fictional workspace";
          Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
          input.dispatchEvent(new dom.Event("input", { bubbles: true }));
        }
      });
      const submit = [...dom.document.querySelectorAll("button")].find(button =>
        !button.hasAttribute("aria-pressed") && button.textContent?.trim() === `${mode === "create" ? "Create" : "Join"} client workspace`)!;
      assert.equal(submit.disabled, false);
      await act(async () => { submit.click(); await settle(); });
      assert.deepEqual(posts, [mode === "create" ? "/api/organizations" : "/api/organizations/join"]);
      assert.match(dom.document.querySelector('[role="alert"]')?.textContent ?? "", /Fixture denied/);
      assert.equal(dom.localStorage.getItem("activeOrganizationId"), "client-a");
      assert.equal(getPinnedOrganizationIdForPage(), "client-a");
    });
  });
}
