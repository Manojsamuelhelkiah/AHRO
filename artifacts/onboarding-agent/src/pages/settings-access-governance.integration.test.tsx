import assert from "node:assert/strict";
import test from "node:test";
import { Window, type HTMLSelectElement, type HTMLInputElement } from "happy-dom";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { pinOrganizationIdForPage } from "@workspace/api-client-react";

test("name conflicts retain all four group drafts and navigate to the existing tenant group", async () => {
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
  const userGroups = ["Existing users", "Editable users"].map((name, index) => ({
    id: `users-${index}`, name, status: "active", version: 1, members: [], securityGroups: [], securityGroupAttachments: [],
  }));
  const securityGroups = ["Existing security", "Editable security"].map((name, index) => ({
    id: `security-${index}`, name, status: "active", version: 1, allows: [], approvalStatus: "approved",
  }));
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let succeed = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/organizations/current") return Response.json({
      activeOrganizationId: "conflict-org", memberships: [{ organizationId: "conflict-org", role: "owner" }],
    });
    assert.equal(new Headers(init?.headers).get("x-organization-id"), "conflict-org");
    if (init?.method === "POST" || init?.method === "PATCH") {
      requests.push({ path, body: JSON.parse(String(init.body)) });
      if (succeed) return Response.json({ ok: true });
      const type = path.includes("/security-groups") ? "security-group" : "user-group";
      const group = type === "security-group" ? securityGroups[0] : userGroups[0];
      return Response.json({
        code: "ACCESS_GROUP_NAME_CONFLICT",
        message: `A group named “${group.name}” already exists in this organization. View the existing group or choose a different name.`,
        existingGroup: { id: group.id, name: group.name, status: group.status, type },
      }, { status: 409 });
    }
    return Response.json({ catalog: [{ key: "data.case.notes.read", label: "Case notes", sensitivity: "medium", kind: "field" }],
      members: [], agents: [], userGroups, securityGroups, userGroupStarters: [], grants: [], history: [] });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(document.body);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  const click = async (element: { click(): void }) => {
    await act(async () => { element.click(); await settle(); });
    await act(async () => { await settle(); });
  };
  const fill = async (selector: string, value: string) => {
    const input = dom.document.querySelector(selector)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
  };
  const submit = async (selector: string) => {
    await act(async () => {
      dom.document.querySelector(selector)!.closest("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }));
      await settle();
    });
    await act(async () => { await settle(); });
  };
  const button = (scope: string, text: string) =>
    [...dom.document.querySelector(scope)!.querySelectorAll("button")].find((item) => item.textContent === text)!;
  pinOrganizationIdForPage("conflict-org");
  try {
    await act(async () => { root.render(<QueryClientProvider client={client}><AccessGovernanceSettings /></QueryClientProvider>); await settle(); });
    await act(async () => { await settle(); });
    const choice = dom.document.querySelector<HTMLSelectElement>("[data-testid=select-access-user-group-starter]")!;
    await act(async () => { choice.value = "custom"; choice.dispatchEvent(new dom.Event("change", { bubbles: true })); });
    await fill("[data-testid=input-access-user-group-name]", "Existing users");
    await submit("[data-testid=input-access-user-group-name]");
    assert.equal(dom.document.querySelector<HTMLInputElement>("[data-testid=input-access-user-group-name]")!.value, "Existing users");
    assert.match(dom.document.querySelector("[data-testid=status-access-user-group]")!.textContent!, /already exists/);
    await click(button("[data-testid=status-access-user-group]", "View existing group"));
    assert.equal(dom.document.activeElement?.id, "access-user-group-users-0");
    await click(button("#access-user-group-users-1", "Rename"));
    await fill('[aria-label="Rename Editable users"]', "Existing users");
    await submit('[aria-label="Rename Editable users"]');
    assert.equal(dom.document.querySelector<HTMLInputElement>('[aria-label="Rename Editable users"]')!.value, "Existing users");
    await fill('[aria-label="New security group name"]', "Existing security");
    await submit('[aria-label="New security group name"]');
    assert.equal(dom.document.querySelector<HTMLInputElement>('[aria-label="New security group name"]')!.value, "Existing security");
    await click(button("#access-security-group-security-1", "Edit policies"));
    await fill('[aria-label="Security group name"]', "Existing security");
    await click(dom.document.querySelector<HTMLInputElement>('[aria-label="Allow Case notes"]')!);
    await click(button("#access-security-group-security-1", "Save policy"));
    assert.equal(dom.document.querySelector<HTMLInputElement>('[aria-label="Security group name"]')!.value, "Existing security");
    assert.equal(dom.document.querySelector<HTMLInputElement>('[aria-label="Allow Case notes"]')!.checked, true);
    assert.deepEqual(requests.map((request) => request.body), [
      { name: "Existing users" }, { name: "Existing users", expectedVersion: 1 },
      { name: "Existing security", allows: [] },
      { name: "Existing security", allows: ["data.case.notes.read"], expectedVersion: 1 },
    ]);
    await click(button("[data-testid=status-access-governance]", "View existing group"));
    assert.equal(dom.document.activeElement?.id, "access-security-group-security-0");
    succeed = true;
    await click(button("#access-security-group-security-1", "Save policy"));
    assert.equal(dom.document.querySelector('[aria-label="Security group name"]'), null);
    await submit('[aria-label="New security group name"]');
    assert.equal(dom.document.querySelector<HTMLInputElement>('[aria-label="New security group name"]')!.value, "");
    await submit('[aria-label="Rename Editable users"]');
    assert.equal(dom.document.querySelector('[aria-label="Rename Editable users"]'), null);
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

test("agent registration preserves drafts, prevents repeat submissions and targets only the current tenant's conflict", async () => {
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
  let tenant = "agent-org-a";
  let outcome: "conflict" | "failure" | "success" = "conflict";
  const requests: Array<{ tenant: string; body: Record<string, unknown> }> = [];
  let release: (() => void) | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === "/api/organizations/current") return Response.json({
      activeOrganizationId: tenant, memberships: [{ organizationId: tenant, role: "owner" }],
    });
    const requestTenant = new Headers(init?.headers).get("x-organization-id");
    assert.equal(requestTenant, tenant);
    const agent = { id: `${requestTenant}-agent`, name: "Existing agent",
      status: requestTenant === "agent-org-a" ? "active" : "retired", version: 1, ownerUserId: "owner-1" };
    if (init?.method === "POST") {
      requests.push({ tenant: requestTenant!, body: JSON.parse(String(init.body)) });
      await new Promise<void>((resolve) => { release = resolve; });
      if (outcome === "success") return Response.json({ agent }, { status: 201 });
      if (outcome === "failure") return Response.json({ message: "Registration temporarily unavailable" }, { status: 503 });
      return Response.json({ code: "ACCESS_AGENT_NAME_CONFLICT",
        message: `An agent already exists in this organization${agent.status === "retired" ? " and is retired" : ""}. Choose a different name.`,
        existingAgent: { id: agent.id, name: agent.name, status: agent.status } }, { status: 409 });
    }
    return Response.json({ catalog: [], members: [
      { clerkUserId: "owner-1", role: "owner" }, { clerkUserId: "member-2", role: "member" },
    ], agents: [agent], userGroups: [], securityGroups: [], userGroupStarters: [], grants: [], history: [] });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(document.body);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  const input = () => dom.document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!;
  const owner = () => dom.document.querySelector<HTMLSelectElement>('[aria-label="Agent owner"]')!;
  const submit = async (twice = false) => {
    await act(async () => {
      const form = input().closest("form")!;
      form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }));
      if (twice) form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }));
      await settle();
    });
  };
  const finish = async () => {
    await act(async () => { release!(); await settle(); });
    await act(async () => { await settle(); });
  };
  try {
    for (tenant of ["agent-org-a", "agent-org-b"]) {
      outcome = "conflict";
      pinOrganizationIdForPage(tenant);
      await act(async () => {
        root.render(<QueryClientProvider client={client}><AccessGovernanceSettings key={tenant} /></QueryClientProvider>);
        await settle();
      });
      await act(async () => { await settle(); });
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input(), " Existing agent ");
        input().dispatchEvent(new dom.Event("input", { bubbles: true }));
        owner().value = "member-2";
        owner().dispatchEvent(new dom.Event("change", { bubbles: true }));
      });
      const before = requests.length;
      await submit(true);
      assert.equal(requests.length, before + 1);
      assert.equal(input().value, " Existing agent ");
      await finish();
      assert.equal(input().value, " Existing agent ");
      assert.equal(owner().value, "member-2");
      const notice = dom.document.querySelector("[data-testid=status-access-governance]")!;
      assert.equal(notice.getAttribute("role"), "alert");
      assert.match(notice.textContent!, /already exists/);
      if (tenant === "agent-org-b") assert.match(notice.textContent!, /is retired/);
      await act(async () => {
        [...notice.querySelectorAll("button")].find((button) => button.textContent === "View existing agent")!.click();
        await settle();
      });
      assert.equal(dom.document.activeElement?.id, `access-agent-${tenant}-agent`);
      assert.equal(dom.document.querySelector(`#access-agent-${tenant === "agent-org-a" ? "agent-org-b" : "agent-org-a"}-agent`), null);
      outcome = "failure";
      await submit();
      await finish();
      assert.equal(input().value, " Existing agent ");
      assert.equal(owner().value, "member-2");
      assert.match(dom.document.querySelector("[role=alert]")!.textContent!, /temporarily unavailable/);
      outcome = "success";
      await submit();
      await finish();
      assert.equal(input().value, "");
      assert.equal(owner().value, "member-2");
      assert.match(dom.document.querySelector("[data-testid=status-access-governance]")!.textContent!, /Registered agent created/);
    }
    assert.deepEqual(requests.map((request) => request.body), Array.from({ length: 6 }, () => ({
      name: "Existing agent", ownerUserId: "member-2",
    })));
    assert.deepEqual(requests.map((request) => request.tenant), [
      "agent-org-a", "agent-org-a", "agent-org-a", "agent-org-b", "agent-org-b", "agent-org-b",
    ]);
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

for (const kind of ["user", "security"] as const) {
  test(`${kind} group edits retain drafts through another owner's update and retirement until cancelled`, async () => {
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
    const group = {
      id: "shared-group", name: "Original group", status: "active", version: 1,
      members: [], securityGroups: [], securityGroupAttachments: [],
      allows: ["flow.case.read"], approvalStatus: "approved",
    };
    const requests: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    let reads = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/organizations/current") return Response.json({
        activeOrganizationId: "shared-org", memberships: [{ organizationId: "shared-org", role: "owner" }],
      });
      assert.equal(new Headers(init?.headers).get("x-organization-id"), "shared-org");
      if (init?.method === "PATCH") {
        assert.equal(path, `/api/organizations/current/access/${kind}-groups/shared-group`);
        const body = JSON.parse(String(init.body));
        requests.push(body);
        const code = body.expectedVersion !== group.version ? "ACCESS_VERSION_CONFLICT" : "ACCESS_GROUP_RETIRED";
        assert.ok(body.expectedVersion !== group.version || group.status === "retired",
          "refresh and cancel must never submit a valid write automatically");
        errors.push(code);
        return Response.json({ code, message: code === "ACCESS_VERSION_CONFLICT"
          ? "Group version is stale; reload and try again." : "Retired groups cannot be changed." }, { status: 409 });
      }
      assert.equal(init?.method ?? "GET", "GET");
      assert.equal(path, "/api/organizations/current/access");
      reads++;
      return Response.json({
        catalog: [
          { key: "flow.case.read", label: "Case overview", sensitivity: "low", kind: "flow" },
          { key: "data.case.notes.read", label: "Case notes", sensitivity: "medium", kind: "field" },
        ],
        members: [], agents: [], userGroupStarters: [], grants: [], history: [],
        userGroups: kind === "user" ? [group] : [], securityGroups: kind === "security" ? [group] : [],
      });
    }) as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(document.body);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    const row = `#access-${kind}-group-shared-group`;
    const nameSelector = `${row} input[aria-label^="${kind === "user" ? "Rename " : "Security group name"}"]`;
    const button = (scope: string, text: string) => {
      const element = [...dom.document.querySelector(scope)!.querySelectorAll("button")]
        .find((item) => item.textContent?.trim() === text);
      assert.ok(element, `Missing ${text} in ${scope}`);
      return element;
    };
    const click = async (element: { click(): void }) => {
      await act(async () => { element.click(); await settle(); });
      await act(async () => { await settle(); });
    };
    const fill = async (value: string) => {
      const input = dom.document.querySelector(nameSelector)!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new dom.Event("input", { bubbles: true }));
      });
    };
    const assertDraft = (name: string) => {
      assert.equal(dom.document.querySelector<HTMLInputElement>(nameSelector)!.value, name);
      if (kind === "security") {
        assert.equal(dom.document.querySelector<HTMLInputElement>('[aria-label="Allow Case overview"]')!.checked, false);
        assert.equal(dom.document.querySelector<HTMLInputElement>('[aria-label="Allow Case notes"]')!.checked, true);
      }
    };
    const assertFailure = (message: RegExp) => {
      const notice = dom.document.querySelector("[data-testid=status-access-governance]")!;
      assert.equal(notice.getAttribute("role"), "alert");
      assert.match(notice.textContent!, message);
      assert.doesNotMatch(dom.document.body.textContent!, /User group renamed\.|Security group and policy grants updated\./);
    };
    const beginDraft = async (name: string) => {
      await click(button(row, kind === "user" ? "Rename" : "Edit policies"));
      await fill(name);
      if (kind === "security") {
        const overview = dom.document.querySelector<HTMLInputElement>('[aria-label="Allow Case overview"]')!;
        const notes = dom.document.querySelector<HTMLInputElement>('[aria-label="Allow Case notes"]')!;
        if (overview.checked) await click(overview);
        if (!notes.checked) await click(notes);
      }
    };
    const save = () => click(button(row, kind === "user" ? "Save name" : "Save policy"));
    const refresh = () => click(button("body", "Refresh"));
    pinOrganizationIdForPage("shared-org");
    try {
      await act(async () => { root.render(<QueryClientProvider client={client}><AccessGovernanceSettings /></QueryClientProvider>); await settle(); });
      await act(async () => { await settle(); });
      await beginDraft("Unsaved rename");
      group.name = "Other owner's rename";
      group.version = 2;
      if (kind === "security") group.allows = [];
      const updated = structuredClone(group);
      await save();
      assert.deepEqual(errors, ["ACCESS_VERSION_CONFLICT"]);
      assertDraft("Unsaved rename");
      assertFailure(/version is stale/);
      const readsBefore = reads;
      await refresh();
      assert.ok(reads > readsBefore);
      const refreshed = client.getQueryData<{ userGroups: typeof group[]; securityGroups: typeof group[] }>(
        ["organization-access-governance", "shared-org"],
      )!;
      assert.deepEqual((kind === "user" ? refreshed.userGroups : refreshed.securityGroups)[0], updated);
      assertDraft("Unsaved rename");
      assertFailure(/version is stale/);
      assert.equal(requests.length, 1, "refresh must not retry the rejected draft");
      await click(button(row, "Cancel"));
      assert.equal(dom.document.querySelector(nameSelector), null);
      assert.match(dom.document.querySelector(row)!.textContent!, /Other owner's rename/);
      assert.deepEqual(group, updated);
      // Reopening uses the current owner's values, not the cancelled draft.
      await click(button(row, kind === "user" ? "Rename" : "Edit policies"));
      assert.equal(dom.document.querySelector<HTMLInputElement>(nameSelector)!.value, updated.name);
      if (kind === "security") {
        assert.equal(dom.document.querySelector<HTMLInputElement>('[aria-label="Allow Case overview"]')!.checked, false);
        assert.equal(dom.document.querySelector<HTMLInputElement>('[aria-label="Allow Case notes"]')!.checked, false);
      }
      await click(button(row, "Cancel"));
      await beginDraft("Unsaved after retirement");
      group.status = "retired";
      group.version = 3;
      const retired = structuredClone(group);
      await save();
      assertDraft("Unsaved after retirement");
      assertFailure(/version is stale/);
      await refresh();
      const refreshedRetirement = client.getQueryData<{ userGroups: typeof group[]; securityGroups: typeof group[] }>(
        ["organization-access-governance", "shared-org"],
      )!;
      assert.deepEqual((kind === "user" ? refreshedRetirement.userGroups : refreshedRetirement.securityGroups)[0], retired);
      assertDraft("Unsaved after retirement");
      assert.equal(requests.length, 2, "refresh must not resubmit into a retired group");
      await save();
      assert.deepEqual(errors, ["ACCESS_VERSION_CONFLICT", "ACCESS_VERSION_CONFLICT", "ACCESS_GROUP_RETIRED"]);
      assertDraft("Unsaved after retirement");
      assertFailure(/Retired groups cannot be changed/);
      await refresh();
      assertDraft("Unsaved after retirement");
      assertFailure(/Retired groups cannot be changed/);
      await click(button(row, "Cancel"));
      assert.equal(dom.document.querySelector(nameSelector), null);
      assert.match(dom.document.querySelector(row)!.textContent!, /retired/);
      assert.equal(requests.length, 3, "cancel must never write");
      assert.deepEqual(requests, [
        { name: "Unsaved rename", ...(kind === "security" ? { allows: ["data.case.notes.read"] } : {}), expectedVersion: 1 },
        { name: "Unsaved after retirement", ...(kind === "security" ? { allows: ["data.case.notes.read"] } : {}), expectedVersion: 2 },
        { name: "Unsaved after retirement", ...(kind === "security" ? { allows: ["data.case.notes.read"] } : {}), expectedVersion: 3 },
      ]);
      assert.deepEqual(group, retired);
      assert.ok(![...dom.document.querySelector(row)!.querySelectorAll("button")]
        .some((item) => ["Rename", "Edit policies"].includes(item.textContent?.trim() ?? "")));
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
}

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
    assert.match(dom.document.body.textContent!, /grant no permissions or professional qualifications/);
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
