import assert from "node:assert/strict";
import test from "node:test";
import { Window, type HTMLSelectElement } from "happy-dom";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { pinOrganizationIdForPage } from "@workspace/api-client-react";

test("starter picker refreshes persisted selectors, handles failure/retry and remains owner-only", async () => {
  const dom = new Window({ url: "http://localhost/settings" });
  const names = ["window", "document", "navigator", "location", "localStorage", "self",
    "HTMLElement", "HTMLInputElement", "Event", "Node", "Text", "MutationObserver", "IS_REACT_ACT_ENVIRONMENT"];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, {
    configurable: true, writable: true,
    value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom as unknown as Record<string, unknown>)[name],
  });
  const { createRoot } = await import("react-dom/client");
  const { AccessGovernanceSettings } = await import("./settings-access-governance");
  const starters = ["HR", "Hiring Managers", "IT Operations", "Payroll", "Compliance Reviewers", "AI Agents"]
    .map((name, index) => ({ id: `starter-${index}`, name }));
  const groups: Array<Record<string, unknown>> = [];
  const requests: Array<Record<string, unknown>> = [];
  let role = "owner";
  let failCreate = true;
  let failRefresh = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/organizations/current") return Response.json({
      activeOrganizationId: "picker-org", memberships: [{ organizationId: "picker-org", role }],
    });
    assert.equal(new Headers(init?.headers).get("x-organization-id"), "picker-org");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      requests.push(body);
      if (failCreate) return Response.json({ message: "Creation temporarily unavailable" }, { status: 503 });
      const existing = groups.find((group) => group.starterId === body.starterId);
      if (existing) return Response.json({ created: false, reusedLegacy: false, userGroup: existing });
      const group = { id: "persisted-hr", starterId: body.starterId, name: "HR",
        status: "active", version: 1, members: [], securityGroups: [], securityGroupAttachments: [] };
      groups.push(group);
      return Response.json({ created: true, reusedLegacy: false, userGroup: group }, { status: 201 });
    }
    if (failRefresh) return Response.json({ message: "Refresh temporarily unavailable" }, { status: 503 });
    return Response.json({ catalog: [], members: [], agents: [], userGroups: groups,
      userGroupStarters: starters, securityGroups: [], grants: [], history: [] });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root = createRoot(document.body);
  const render = () => root.render(<QueryClientProvider client={client}><AccessGovernanceSettings /></QueryClientProvider>);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const changeChoice = async (value: string) => {
    const select = dom.document.querySelector<HTMLSelectElement>("[data-testid=select-access-user-group-starter]")!;
    await act(async () => { select.value = value; select.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  };
  const submit = async (twice = false) => {
    const form = dom.document.querySelector("[data-testid=select-access-user-group-starter]")!.closest("form")!;
    await act(async () => {
      form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }));
      if (twice) form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }));
      await settle();
    });
    await act(async () => { await settle(); });
  };
  pinOrganizationIdForPage("picker-org");
  try {
    await act(async () => { render(); await settle(); });
    await act(async () => { await settle(); });
    assert.match(dom.document.body.textContent!, /No user groups yet/);
    assert.match(dom.document.body.textContent!, /grant no permissions or specialist authority/);
    const select = dom.document.querySelector<HTMLSelectElement>("[data-testid=select-access-user-group-starter]")!;
    assert.deepEqual([...select.options].map((option) => option.textContent).slice(1), [...starters.map((starter) => starter.name), "Custom group"]);
    await changeChoice("custom");
    assert.ok(dom.document.querySelector("[data-testid=input-access-user-group-name]"));
    await changeChoice("starter-0");
    assert.equal(dom.document.querySelector("[data-testid=input-access-user-group-name]"), null);
    await submit(true);
    assert.equal(requests.length, 1, "synchronous repeated submissions must be fenced");
    assert.deepEqual(requests[0], { starterId: "starter-0" });
    assert.match(dom.document.querySelector("[role=alert]")!.textContent!, /Creation temporarily unavailable/);
    failCreate = false;
    await submit();
    for (const label of ["Group for principal", "User group to attach security group"]) {
      const groupSelect = dom.document.querySelector(`select[aria-label="${label}"]`)!;
      assert.match(groupSelect.innerHTML, /value="persisted-hr">HR/);
    }
    assert.match(dom.document.body.textContent!, /No members or access were added/);
    groups[0].name = "Renamed HR";
    groups[0].status = "retired";
    await submit();
    assert.match(dom.document.body.textContent!, /retired group “Renamed HR”/);
    assert.match(dom.document.body.textContent!, /not recreated or reactivated/);
    assert.equal(groups.length, 1);
    // A saved mutation with a failed refresh must never announce successful visibility.
    failRefresh = true;
    await submit();
    assert.match(dom.document.querySelector("[data-testid=status-access-user-group]")!.textContent!, /group was saved, but refreshing the list failed/);
    failRefresh = false;
    await act(async () => { root.unmount(); });
    client.clear();
    root = createRoot(document.body);
    role = "admin";
    await act(async () => { render(); await settle(); });
    await act(async () => { await settle(); });
    assert.match(dom.document.body.textContent!, /Read-only access/);
    assert.equal(dom.document.querySelector("[data-testid=select-access-user-group-starter]"), null);
  } finally {
    await act(async () => { root.unmount(); });
    client.clear();
    globalThis.fetch = originalFetch;
    pinOrganizationIdForPage(null);
    dom.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});
