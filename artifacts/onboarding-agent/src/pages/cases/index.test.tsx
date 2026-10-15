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

const [{ createRoot }, { QueryClient, QueryClientProvider }, { NewCaseForm, CasesPage }] =
  await Promise.all([
    import("react-dom/client"),
    import("@tanstack/react-query"),
    import("./index"),
  ]);
const { pinOrganizationIdForPage } = await import("@workspace/api-client-react");

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
      // Cases now reads the incoming client date-format settings separately.
      // Never feed case/program arrays to that configuration query.
      if (url === "/api/organizations/current/settings/operations") {
        return Promise.resolve(jsonResponse({
          version: 1, configuration: { defaults: { dateFormat: "yyyy-MM-dd" } },
        }));
      }
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

const programFixture = {
  id: "program/358", name: "Example acquisition", version: 1, status: "go",
  sourceLegalEntity: "Source Ltd", destinationLegalEntity: "Destination Ltd",
  countries: ["US"], proposedBasis: "cross-border", legalDay1: "2031-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z", hrIntegrationOwner: "Recorded HR Owner",
  partialCountryScope: true, populationSummary: { importedHeadcount: 3, expectedHeadcount: null },
};
const caseFixture = {
  id: 358, workerName: "Individual Worker", workerEmail: "worker@example.test",
  joiningDate: "2031-01-01", geography: "CA", lifecycleStage: "completed",
  orchestrationStatus: "completed", createdAt: "2026-01-01T00:00:00.000Z",
};

async function mountCases(client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }), path = '/cases') {
  testWindow.history.replaceState(null, '', path);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async () => act(async () => root.render(<QueryClientProvider client={client}><CasesPage /></QueryClientProvider>));
  await render();
  return { container, render, cleanup: async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
    pinOrganizationIdForPage(null);
  } };
}

test("CasesPage renders program rows/cards without counting program go as case completion; search and case-only tabs stay distinct", async (t) => {
  pinOrganizationIdForPage("cases-test");
  installFetch(({ url, init }) => {
    assert.equal(new Headers(init?.headers).get("x-organization-id"), "cases-test");
    return jsonResponse(url.includes("workforce-transfers") ? [programFixture] : [caseFixture]);
  });
  const mounted = await mountCases();
  t.after(mounted.cleanup);
  await eventually(() => assert.equal(mounted.container.querySelectorAll("[data-program-id]").length, 2), "table and mobile program presentations");
  assert.match(mounted.container.textContent ?? "", /Showing 1 individual cases · 1 programs/);
  assert.match(mounted.container.textContent ?? "", /3 imported/);
  assert.match(mounted.container.textContent ?? "", /Unknown expected/);
  assert.match(mounted.container.textContent ?? "", /Partial country scope/);
  assert.match(mounted.container.textContent ?? "", /Recorded HR Owner/);
  assert.match(mounted.container.textContent ?? "", /Planned cutover \(legal Day 1\): 2031-01-01/);
  assert.equal(mounted.container.querySelectorAll('a[href="/workforce-transfers/program%2F358"]').length, 2);
  const completed = Array.from(mounted.container.querySelectorAll("button")).find((b) => b.textContent === "Completed1");
  assert.ok(completed);
  await act(async () => completed.click());
  assert.equal(mounted.container.querySelectorAll("[data-program-id]").length, 0);
  await act(async () => (Array.from(mounted.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Individual cases"))!).click());
  const input = mounted.container.querySelector('input[aria-label="Search cases and programs"]') as HTMLInputElement;
  for (const query of ["acquisition", "Source Ltd", "Destination Ltd", "program/358"]) {
    await act(async () => setValue(input, query));
    assert.equal(mounted.container.querySelectorAll("[data-program-id]").length, 2);
    assert.match(mounted.container.textContent ?? "", /Showing 0 individual cases · 1 programs/);
  }
  await act(async () => setValue(input, ""));
  const family = Array.from(mounted.container.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Onboarding "));
  await act(async () => family!.click());
  assert.equal(mounted.container.querySelectorAll("[data-program-id]").length, 0);
  const programTab = Array.from(mounted.container.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Workforce Transfer Programs "));
  await act(async () => programTab!.click());
  assert.match(mounted.container.textContent ?? "", /Showing 0 individual cases · 1 programs/);
});

test("Cases URL selects Offboarding envelopes once and type navigation preserves unrelated context", async t => {
  pinOrganizationIdForPage("cases-test");
  installFetch(({ url }) => jsonResponse(url.includes("workforce-transfers") ? [] : [
    caseFixture, { ...caseFixture, id: 359, workerName: "Separation Worker", hireType: "separation" },
  ]));
  const mounted = await mountCases(undefined, '/cases?caseType=Offboarding&source=email#saved');
  t.after(mounted.cleanup);
  await eventually(() => assert.match(mounted.container.textContent ?? "", /Separation Worker/), "separation envelope visible through URL filter");
  assert.doesNotMatch(mounted.container.textContent ?? "", /Individual Worker/);
  assert.equal(mounted.container.querySelectorAll('tr[aria-label^="Open case HRO-2026-00359"]').length, 1);
  assert.match(mounted.container.textContent ?? "", /Showing 1 individual cases/);
  const all = Array.from(mounted.container.querySelectorAll("button")).find(button => button.textContent?.startsWith("All Cases "));
  await act(async () => all!.click());
  assert.match(mounted.container.textContent ?? "", /Individual Worker/);
  assert.equal(testWindow.location.search, "?source=email");
  assert.equal(testWindow.location.hash, "#saved");
});

test("offline-only lists keep permission refreshes and discard cached case metadata on denial", async t => {
  pinOrganizationIdForPage("cases-test");
  let denied = false;
  installFetch(({ url }) => url.includes("workforce-transfers")
    ? jsonResponse([])
    : jsonResponse(denied ? { message: "Denied" } : [{ ...caseFixture, offlineSample: true }], denied ? 403 : 200));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const mounted = await mountCases(client);
  t.after(mounted.cleanup);
  await eventually(() => assert.match(mounted.container.textContent ?? "", /Individual Worker/), "initial offline case is visible");
  const query = client.getQueryCache().getAll().find(row => row.queryKey[0] === "/api/onboarding/cases");
  assert.ok(query);
  assert.ok(query.getObserversCount() > 0);
  const options = query.options as unknown as { refetchInterval: (query: unknown) => number };
  assert.equal(options.refetchInterval(query), 30_000);
  denied = true;
  await act(async () => {
    await client.invalidateQueries({ queryKey: query.queryKey });
  });
  await eventually(() => assert.doesNotMatch(mounted.container.textContent ?? "", /Individual Worker/), "denied refresh clears cached case identity");
  assert.doesNotMatch(mounted.container.textContent ?? "", /Completed1/);
});

test("program denial hides no individual cases, discloses no server error and can retry to a truly empty list", async (t) => {
  pinOrganizationIdForPage("cases-test");
  let denied = true;
  installFetch(({ url }) => jsonResponse(url.includes("workforce-transfers") ? denied ? { message: "secret program details" } : [] : [caseFixture], url.includes("workforce-transfers") && denied ? 403 : 200));
  const mounted = await mountCases();
  t.after(mounted.cleanup);
  await eventually(() => assert.match(mounted.container.textContent ?? "", /Transfer program results are unavailable/), "notice for denied programs");
  assert.match(mounted.container.textContent ?? "", /Individual Worker/);
  assert.doesNotMatch(mounted.container.textContent ?? "", /secret program details|No authorized transfer programs returned/);
  denied = false;
  await act(async () => (Array.from(mounted.container.querySelectorAll("button")).find((b) => b.textContent === "Retry programs")!).click());
  await eventually(() => assert.match(mounted.container.textContent ?? "", /No authorized transfer programs returned/), "successful empty retry");
});

test("program-only organizations load independently and delayed old organization results cannot repopulate rows", async (t) => {
  pinOrganizationIdForPage("old-org");
  let finishOld!: (response: Response) => void;
  installFetch(({ url, init }) => {
    if (!url.includes("workforce-transfers")) return jsonResponse([]);
    if (new Headers(init?.headers).get("x-organization-id") === "old-org") return new Promise<Response>((resolve) => { finishOld = resolve; });
    return jsonResponse([{ ...programFixture, id: "new-program", name: "New organization program" }]);
  });
  const mounted = await mountCases();
  t.after(mounted.cleanup);
  assert.match(mounted.container.textContent ?? "", /Loading transfer programs/);
  pinOrganizationIdForPage("new-org");
  await mounted.render();
  await eventually(() => assert.match(mounted.container.textContent ?? "", /New organization program/), "new organization programs");
  await act(async () => { finishOld(jsonResponse([programFixture])); await Promise.resolve(); });
  assert.doesNotMatch(mounted.container.textContent ?? "", /Example acquisition/);
  assert.match(mounted.container.textContent ?? "", /Showing 0 individual cases · 1 programs/);
});

test("Demo working-list checkboxes hide and restore one case at a time; history stays separate", async t => {
  pinOrganizationIdForPage("demo");
  let hidden = false;
  let version = 0;
  const writes: Record<string, any>[] = [];
  installFetch(({ url, init }) => {
    if (url.includes("workforce-transfers")) return jsonResponse([programFixture]);
    if (url === "/api/onboarding/case-list-visibility") {
      const body = JSON.parse(init?.body as string);
      writes.push(body); hidden = body.hidden; version++;
      return jsonResponse({ updatedCount: 1 });
    }
    if (url === "/api/organizations/current") return jsonResponse({ id: "demo", role: "owner" });
    return jsonResponse([
      { ...caseFixture, workingListHidden: hidden, workingListVersion: version, canManageWorkingList: true },
      { ...caseFixture, id: 360, workerName: "Payroll unchanged", caseFamily: "Payroll" },
      { ...caseFixture, id: 361, workerName: "Hidden historical fixture", hireType: "offboarding",
        controllerRetired: true, workingListHidden: true, workingListVersion: 1, canManageWorkingList: true },
    ]);
  });
  const mounted = await mountCases();
  t.after(mounted.cleanup);
  const button = (text: string) => Array.from(document.querySelectorAll("button")).find(button => button.textContent === text)!;
  await eventually(() => assert.equal(mounted.container.querySelectorAll('input[aria-label="Show HRO-2026-00358 (Onboarding) in working cases"]').length, 2), "per-case checkboxes");
  assert.equal(writes.length, 0);
  assert.doesNotMatch(mounted.container.textContent ?? "", /Hidden historical fixture/);
  assert.match(mounted.container.textContent ?? "", /does not change case status, operations, alerts/);
  assert.equal(mounted.container.querySelector('input[aria-label*="Payroll"]'), null);
  await act(async () => (mounted.container.querySelector('input[aria-label="Show HRO-2026-00358 (Onboarding) in working cases"]') as HTMLInputElement).click());
  await eventually(() => assert.doesNotMatch(mounted.container.textContent ?? "", /Individual Worker/), "hidden case removed");
  assert.deepEqual(writes[0], { hidden: true, confirmWorkingListOnly: true,
    selection: [{ caseId: 358, expectedVersion: 0, caseFamily: "Onboarding" }] });
  assert.match(mounted.container.textContent ?? "", /Payroll unchanged/);
  const view = mounted.container.querySelector('[aria-label="Cases list visibility"]') as HTMLSelectElement;
  await act(async () => setValue(view, "hidden"));
  assert.match(mounted.container.textContent ?? "", /Individual Worker/);
  assert.match(mounted.container.textContent ?? "", /Hidden historical fixture/);
  assert.doesNotMatch(mounted.container.textContent ?? "", /Payroll unchanged|Example acquisition/);
  await act(async () => (mounted.container.querySelector('input[aria-label="Show HRO-2026-00358 (Onboarding) in working cases"]') as HTMLInputElement).click());
  await eventually(() => assert.equal(writes.length, 2), "restore request");
  await eventually(() => assert.doesNotMatch(mounted.container.textContent ?? "", /Individual Worker/), "restored case removed from hidden view");
  await act(async () => setValue(view, "working"));
  assert.match(mounted.container.textContent ?? "", /Individual Worker/);
  assert.equal(writes[1]?.selection[0].expectedVersion, 1);
});

test("filters cannot toggle unseen cases and tenant switches clear visibility controls", async t => {
  pinOrganizationIdForPage("demo");
  let version = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  installFetch(({ url, init }) => {
    if (url.includes("workforce-transfers")) return jsonResponse([]);
    if (url === "/api/organizations/current") return jsonResponse({ id: "demo", role: "owner" });
    return jsonResponse(new Headers(init?.headers).get("x-organization-id") === "demo"
      ? [{ ...caseFixture, workingListHidden: false, workingListVersion: version, canManageWorkingList: true }] : []);
  });
  const mounted = await mountCases(client);
  t.after(mounted.cleanup);
  await eventually(() => assert.ok(mounted.container.querySelector('input[aria-label^="Show HRO"]')), "selectable Demo fixture");
  await act(async () => setValue(mounted.container.querySelector('[aria-label="Search cases and programs"]') as HTMLInputElement, 'missing'));
  assert.equal(mounted.container.querySelector('input[aria-label^="Show HRO"]'), null);
  await act(async () => setValue(mounted.container.querySelector('[aria-label="Search cases and programs"]') as HTMLInputElement, ''));
  await eventually(() => assert.ok(mounted.container.querySelector('input[aria-label^="Show HRO"]')), "case visible again after clearing search");
  pinOrganizationIdForPage("other");
  await mounted.render();
  assert.doesNotMatch(mounted.container.textContent ?? "", /Individual Worker|Hidden cases/);
});

function fillOrdinaryFields(form: HTMLFormElement): void {
  const values: Record<string, string> = {
    workerName: "Ada Lovelace",
    workerEmail: "ada@example.test",
    workerPhone: "+15551234567",
    role: "Operations Analyst",
    department: "Operations",
    geography: "United Kingdom",
    workCountry: "GB",
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
    workCountry: "GB",
    legalEntity: "Example Holdings Ltd",
    joiningDate: "2030-04-15",
    managerName: "Grace Hopper",
    recruiterName: "Katherine Johnson",
  })) {
    const element = form.elements.namedItem(name) as HTMLInputElement;
    assert.equal(element.value, value, `${name} should remain entered`);
  }
});