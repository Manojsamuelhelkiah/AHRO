import { test } from "node:test";
import assert from "node:assert/strict";
import { installLeaveGuard, LEAVE_WARNING } from "./leave-guard";

function browser() {
  const events = new EventTarget();
  const location = { href: "https://example.test/cost-explorer/enterprise-architecture/1" };
  const entries = [{ url: "https://example.test/cost-explorer/", state: null }, { url: location.href, state: null }];
  let index = 1;
  let confirmResult = false;
  const prompts: string[] = [];
  const history = {
    state: null as unknown,
    pushState(data: unknown, _: string, url?: string | URL | null) {
      if (url != null) location.href = new URL(url, location.href).href;
      this.state = data;
      entries.splice(++index, Infinity, { url: location.href, state: data as null });
      events.dispatchEvent(new Event("pushState"));
    },
    replaceState(data: unknown, _: string, url?: string | URL | null) {
      if (url != null) location.href = new URL(url, location.href).href;
      this.state = data;
      entries[index] = { url: location.href, state: data as null };
      events.dispatchEvent(new Event("replaceState"));
    },
    back() {
      if (index > 0) {
        const entry = entries[--index];
        location.href = entry.url;
        this.state = entry.state;
        events.dispatchEvent(new Event("popstate"));
      }
    },
  };
  const target = Object.assign(events, {
    location, history,
    confirm(message: string) { prompts.push(message); return confirmResult; },
  }) as unknown as Window;
  return { target, history, prompts, accept: () => { confirmResult = true; } };
}

test("cancel protects router pushes and replacements, accept deliberately leaves", () => {
  const b = browser();
  const url = b.target.location.href;
  const remove = installLeaveGuard(b.target, () => true);
  b.history.pushState(null, "", "/cost-explorer/");
  b.history.replaceState(null, "", "/cost-explorer/enterprise-architecture/2");
  assert.equal(b.target.location.href, url);
  assert.deepEqual(b.prompts, [LEAVE_WARNING, LEAVE_WARNING]);
  b.accept();
  b.history.pushState(null, "", "/cost-explorer/");
  assert.equal(b.target.location.href, "https://example.test/cost-explorer/");
  remove();
});

test("canceling browser back restores the workspace synchronously", () => {
  const b = browser();
  const url = b.target.location.href;
  const remove = installLeaveGuard(b.target, () => true);
  b.history.back();
  assert.equal(b.target.location.href, url);
  b.accept();
  b.history.back();
  assert.equal(b.target.location.href, "https://example.test/cost-explorer/");
  remove();
});

test("reload/close is blocked only while unresolved work exists; cleanup releases guard", () => {
  const b = browser();
  let dirty = true;
  const push = b.history.pushState;
  const replace = b.history.replaceState;
  const remove = installLeaveGuard(b.target, () => dirty);
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    b.target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(unload(), true);
  dirty = false;
  assert.equal(unload(), false);
  b.history.pushState(null, "", "/cost-explorer/");
  assert.equal(b.prompts.length, 0);
  dirty = true;
  remove();
  assert.equal(unload(), false);
  assert.equal(b.history.pushState, push);
  assert.equal(b.history.replaceState, replace);
});

test("same-URL history updates do not discard drafts or prompt", () => {
  const b = browser();
  const remove = installLeaveGuard(b.target, () => true);
  b.history.replaceState({ marker: 1 }, "");
  assert.equal(b.prompts.length, 0);
  remove();
});

test("Back guard uses capture so synchronous router subscribers cannot unmount it first", () => {
  const b = browser();
  const registrations: Array<{ type: string; options: unknown }> = [];
  const add = b.target.addEventListener.bind(b.target);
  b.target.addEventListener = ((type: string, listener: EventListener, options?: boolean) => {
    registrations.push({ type, options });
    add(type, listener, options);
  }) as Window["addEventListener"];
  const remove = installLeaveGuard(b.target, () => true);
  assert.equal(registrations.find(item => item.type === "popstate")?.options, true);
  remove();
});