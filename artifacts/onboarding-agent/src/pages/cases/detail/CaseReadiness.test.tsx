import "../../cases/test-support/cases-dom";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import {
  disposeCasesDom,
  eventually,
  jsonResponse,
  testWindow,
} from "../../cases/test-support/cases-dom";

const [{ createRoot }, { QueryClient, QueryClientProvider }, { CaseReadiness }] =
  await Promise.all([
    import("react-dom/client"),
    import("@tanstack/react-query"),
    import("./CaseReadiness"),
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

const restrictedCase = {
  id: 274,
  updatedAt: "2030-04-01T12:00:00.000Z",
  workforceContext: {
    workEnvironment: "office",
    workCountry: "United Kingdom",
    accessibilityNeeds: "existing restricted legacy context",
  },
  readiness: [],
  checklistSnapshot: [],
  checklistProfileName: "Default",
  checklistTemplateVersion: 1,
  checklistProfileVersion: 1,
  checklistMatchedCriteria: {},
  orchestrationStatus: "idle",
  lifecycleStage: "trigger-received",
};

const benignCase = {
  id: 275,
  updatedAt: "2030-04-01T12:00:00.000Z",
  workforceContext: {
    workEnvironment: "office",
    workCountry: "United Kingdom",
    site: "London",
  },
  readiness: [],
  checklistSnapshot: [],
  checklistProfileName: "Default",
  checklistTemplateVersion: 1,
  checklistProfileVersion: 1,
  checklistMatchedCriteria: {},
  orchestrationStatus: "idle",
  lifecycleStage: "trigger-received",
};

async function mountReadiness(
  c: { id: number; [key: string]: unknown } = restrictedCase,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <CaseReadiness c={c as never} setTab={() => {}} />
      </QueryClientProvider>,
    );
  });

  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      queryClient.clear();
      document.body
        .querySelectorAll('[data-radix-portal]')
        .forEach((portal) => portal.remove());
    },
  };
}

function setTextValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    element instanceof testWindow.HTMLTextAreaElement
      ? testWindow.HTMLTextAreaElement.prototype
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

test("CaseReadiness has no accessibility input and blocks correction of restricted existing context", async (t) => {
  const calls: FetchCall[] = [];
  installFetch((call) => {
    calls.push(call);
    if (
      call.url ===
      "/api/onboarding/cases/274/governance-impact"
    ) {
      return jsonResponse({ snapshot: null, impacts: [] });
    }
    return jsonResponse({ id: 274 });
  });

  const mounted = await mountReadiness();
  t.after(mounted.cleanup);
  const correctButton = Array.from(
    mounted.container.querySelectorAll("button"),
  ).find((button) => button.textContent?.includes("Correct context"));
  assert.ok(correctButton, "expected the context-correction button");

  await act(async () => {
    (correctButton as HTMLButtonElement).click();
    await Promise.resolve();
  });

  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog, "expected the context-correction dialog");
  assert.match(
    dialog.textContent ?? "",
    /Accessibility and medical details cannot be saved through general context corrections/i,
  );
  assert.match(
    dialog.textContent ?? "",
    /No specialist handoff is available from this form/i,
  );
  assert.match(
    dialog.textContent ?? "",
    /This existing context contains restricted accessibility information/i,
  );
  assert.equal(
    Array.from(dialog.querySelectorAll("input")).some(
      (input) => input.getAttribute("name") === "accessibilityNeeds",
    ),
    false,
  );
  assert.doesNotMatch(dialog.textContent ?? "", /Accessibility needs/i);

  const reason = dialog.querySelector("textarea");
  assert.ok(reason, "expected a correction reason field");
  await act(async () => {
    setTextValue(
      reason as HTMLTextAreaElement,
      "Verified by the worker profile source.",
    );
  });
  await eventually(
    () =>
      assert.equal(
        (Array.from(dialog.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Save correction"),
        ) as HTMLButtonElement).disabled,
        false,
      ),
    "correction reason should enable saving",
  );

  const saveButton = Array.from(dialog.querySelectorAll("button")).find(
    (button) => button.textContent?.includes("Save correction"),
  );
  assert.ok(saveButton, "expected save correction button");
  await act(async () => {
    (saveButton as HTMLButtonElement).click();
    await Promise.resolve();
  });
  await eventually(
    () =>
      assert.match(
        dialog.textContent ?? "",
        /Nothing has been removed or submitted/,
      ),
    "restricted context rejection should be visible",
  );

  assert.equal(
    calls.some(
      (call) =>
        call.url === "/api/onboarding/cases/274/workforce-context" &&
        call.init?.method === "PUT",
    ),
    false,
  );
  assert.equal(document.querySelector('[role="dialog"]'), dialog);
  assert.equal(
    (restrictedCase.workforceContext as Record<string, unknown>)
      .accessibilityNeeds,
    "existing restricted legacy context",
  );
});

test("CaseReadiness keeps visible correction values after an API 409", async (t) => {
  const calls: FetchCall[] = [];
  installFetch((call) => {
    calls.push(call);
    if (call.url === "/api/onboarding/cases/275/governance-impact") {
      return jsonResponse({ snapshot: null, impacts: [] });
    }
    if (
      call.url === "/api/onboarding/cases/275/workforce-context" &&
      call.init?.method === "PUT"
    ) {
      return jsonResponse(
        { message: "A restricted context requires an authorized refresh." },
        409,
      );
    }
    return jsonResponse({ id: 275 });
  });

  assert.equal(
    Object.hasOwn(benignCase.workforceContext, "accessibilityNeeds"),
    false,
  );
  const mounted = await mountReadiness(benignCase);
  t.after(mounted.cleanup);
  const correctButton = Array.from(
    mounted.container.querySelectorAll("button"),
  ).find((button) => button.textContent?.includes("Correct context"));
  assert.ok(correctButton, "expected the context-correction button");

  await act(async () => {
    (correctButton as HTMLButtonElement).click();
    await Promise.resolve();
  });
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog, "expected the context-correction dialog");

  const siteField = Array.from(dialog.querySelectorAll("div")).find(
    (candidate) =>
      candidate.children.length === 2 &&
      candidate.firstElementChild?.textContent === "Site / facility",
  );
  assert.ok(siteField, "expected the visible site field");
  const siteInput = siteField.querySelector("input");
  assert.ok(siteInput, "expected the visible site input");
  const reason = dialog.querySelector("textarea");
  assert.ok(reason, "expected a correction reason field");
  const editedSite = "London HQ";
  const editedReason = "Verified against the current worker profile.";
  await act(async () => {
    setTextValue(siteInput as HTMLInputElement, editedSite);
    setTextValue(reason as HTMLTextAreaElement, editedReason);
  });

  const saveButton = Array.from(dialog.querySelectorAll("button")).find(
    (button) => button.textContent?.includes("Save correction"),
  );
  assert.ok(saveButton, "expected save correction button");
  await eventually(
    () => assert.equal((saveButton as HTMLButtonElement).disabled, false),
    "correction reason should enable saving",
  );
  await act(async () => {
    (saveButton as HTMLButtonElement).click();
    await Promise.resolve();
  });

  await eventually(
    () =>
      assert.match(
        dialog.textContent ?? "",
        /A restricted context requires an authorized refresh/,
      ),
    "the API restriction should be visible",
  );
  const correctionCall = calls.find(
    (call) =>
      call.url === "/api/onboarding/cases/275/workforce-context" &&
      call.init?.method === "PUT",
  );
  assert.ok(correctionCall, "expected the correction API request");
  const correctionPayload = JSON.parse(
    correctionCall.init?.body as string,
  ) as {
    workforceContext: Record<string, unknown>;
    reason: string;
  };
  assert.equal(correctionPayload.workforceContext.site, editedSite);
  assert.equal(correctionPayload.reason, editedReason);
  assert.equal(document.querySelector('[role="dialog"]'), dialog);
  assert.equal((siteInput as HTMLInputElement).value, editedSite);
  assert.equal((reason as HTMLTextAreaElement).value, editedReason);
});
