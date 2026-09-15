import "./test-support/cases-dom";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import {
  disposeCasesDom,
  eventually,
  jsonResponse,
  testWindow,
} from "./test-support/cases-dom";

const [{ createRoot }, { QueryClient, QueryClientProvider }, { NewCaseForm }] =
  await Promise.all([
    import("react-dom/client"),
    import("@tanstack/react-query"),
    import("./index"),
  ]);

after(async () => {
  await disposeCasesDom();
});

type FetchCall = {
  url: string;
  init?: RequestInit;
};

function installFetch(
  handler: (call: FetchCall) => Promise<Response> | Response,
): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return handler({ url, init });
    },
  });
}

async function mountForm() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let closed = false;

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NewCaseForm onClose={() => { closed = true; }} />
      </QueryClientProvider>,
    );
  });

  return {
    container,
    get closed() {
      return closed;
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      queryClient.clear();
    },
  };
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    element instanceof testWindow.HTMLSelectElement
      ? testWindow.HTMLSelectElement.prototype
      : testWindow.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(
    new testWindow.Event("input", { bubbles: true }) as unknown as Event,
  );
  element.dispatchEvent(
    new testWindow.Event("change", { bubbles: true }) as unknown as Event,
  );
}

function fillOrdinaryFields(form: HTMLFormElement): void {
  const values: Record<string, string> = {
    workerName: "Ada Lovelace",
    workerEmail: "ada@example.test",
    workerPhone: "+15551234567",
    role: "Operations Analyst",
    department: "Operations",
    geography: "United Kingdom",
    legalEntity: "Example Holdings Ltd",
    joiningDate: "2030-04-15",
    managerName: "Grace Hopper",
    recruiterName: "Katherine Johnson",
  };

  for (const [name, value] of Object.entries(values)) {
    const element = form.elements.namedItem(name);
    assert.ok(element, `expected form control ${name}`);
    setValue(element as HTMLInputElement, value);
  }
}

function postBody(calls: FetchCall[]): Record<string, unknown> {
  const call = calls.find(
    (candidate) =>
      candidate.url === "/api/onboarding/cases" &&
      candidate.init?.method === "POST",
  );
  assert.ok(call, "expected the case-create request");
  assert.equal(typeof call.init?.body, "string");
  return JSON.parse(call.init?.body as string) as Record<string, unknown>;
}

test("NewCaseForm explains privacy restrictions and excludes forbidden intake fields", async (t) => {
  const calls: FetchCall[] = [];
  installFetch((call) => {
    calls.push(call);
    if (call.url === "/api/onboarding/job-profiles") {
      return jsonResponse([]);
    }
    if (
      call.url === "/api/onboarding/cases" &&
      call.init?.method === "POST"
    ) {
      return jsonResponse({ id: 274 });
    }
    return jsonResponse({});
  });

  const mounted = await mountForm();
  t.after(mounted.cleanup);
  const form = mounted.container.querySelector("form");
  assert.ok(form, "expected the intake form");

  const controls = Array.from(form.querySelectorAll("input, textarea, select"));
  const names = controls
    .map((control) => control.getAttribute("name"))
    .filter((name): name is string => Boolean(name));
  assert.equal(names.includes("notes"), false);
  assert.equal(names.includes("accessibilityNeeds"), false);
  assert.equal(form.querySelector("textarea"), null);
  assert.match(
    form.textContent ?? "",
    /cannot save free-form candidate or recruiter notes/i,
  );
  assert.match(
    form.textContent ?? "",
    /accessibility and medical details/i,
  );
  assert.match(form.textContent ?? "", /No specialist handoff is available/i);

  await act(async () => {
    fillOrdinaryFields(form);
  });
  await act(async () => {
    (form.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    await Promise.resolve();
  });
  await eventually(
    () => assert.equal(mounted.closed, true),
    "successful intake should close the form",
  );

  const payload = postBody(calls);
  const forbiddenKeys = Object.keys(payload).filter((key) =>
    /notes|accessibility|medical/i.test(key),
  );
  const workforceContext = payload.workforceContext;
  assert.deepEqual(forbiddenKeys, []);
  assert.ok(workforceContext && typeof workforceContext === "object");
  assert.deepEqual(
    Object.keys(workforceContext as Record<string, unknown>).filter((key) =>
      /notes|accessibility|medical/i.test(key),
    ),
    [],
  );
  assert.equal(payload.workerName, "Ada Lovelace");
  assert.equal(payload.workerEmail, "ada@example.test");
  assert.equal(payload.offerAcceptanceComplete, false);
});

test("NewCaseForm keeps ordinary values and remains open after an API error", async (t) => {
  installFetch((call) => {
    if (call.url === "/api/onboarding/job-profiles") {
      return jsonResponse([]);
    }
    if (
      call.url === "/api/onboarding/cases" &&
      call.init?.method === "POST"
    ) {
      return jsonResponse({ message: "The intake was rejected by policy." }, 422);
    }
    return jsonResponse({});
  });

  const mounted = await mountForm();
  t.after(mounted.cleanup);
  const form = mounted.container.querySelector("form");
  assert.ok(form, "expected the intake form");
  await act(async () => {
    fillOrdinaryFields(form);
  });

  await act(async () => {
    (form.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    await Promise.resolve();
  });
  await eventually(
    () =>
      assert.match(
        mounted.container.textContent ?? "",
        /The intake was rejected by policy/,
      ),
    "the API error should be visible",
  );

  assert.equal(mounted.closed, false);
  assert.equal(mounted.container.querySelector("form"), form);
  for (const [name, value] of Object.entries({
    workerName: "Ada Lovelace",
    workerEmail: "ada@example.test",
    workerPhone: "+15551234567",
    role: "Operations Analyst",
    department: "Operations",
    geography: "United Kingdom",
    legalEntity: "Example Holdings Ltd",
    joiningDate: "2030-04-15",
    managerName: "Grace Hopper",
    recruiterName: "Katherine Johnson",
  })) {
    const element = form.elements.namedItem(name) as HTMLInputElement;
    assert.equal(element.value, value, `${name} should remain entered`);
  }
});