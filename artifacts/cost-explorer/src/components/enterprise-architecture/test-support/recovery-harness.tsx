import "./dom";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { setTimeout as tick } from "node:timers/promises";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  getGetEaAssessmentQueryKey,
  type EaAssessment, type EaAssessmentUpdate, type EaRequirement,
} from "@workspace/api-client-react";
import { EditRecoveryProvider } from "../edit-recovery";
import { EMPTY_ASSESSMENT_CONTENT, useAssessmentUpdater, waitForAssessmentUpdates } from "../utils";

export function requirement(id = "new", title = "New requirement"): EaRequirement {
  return {
    id, title, description: "", stakeholder: "", concern: "", priority: "medium",
    status: "proposed", acceptanceCriteria: [],
    traceability: { requirementIds: [], gapIds: [], targetComponentIds: [], workPackageIds: [], governanceReviewIds: [] },
  };
}

export function assessment(requirements: EaRequirement[] = []): EaAssessment {
  return {
    id: 501, name: "Recovery regression", clientName: "Test client",
    currentPhase: "preliminary", status: "active", version: 1, archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    content: { ...structuredClone(EMPTY_ASSESSMENT_CONTENT), requirements },
  };
}

export function conflict() {
  return Response.json({ message: "Assessment changed" }, { status: 409 });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Only the HTTP boundary is replaced. The production updater, per-assessment
// queue, recovery provider, API mutation hook, QueryClient and React effects run.
export async function mountRecovery(t: TestContext, initial = assessment()) {
  const server = {
    saved: structuredClone(initial),
    writes: [] as EaAssessmentUpdate[],
    reads: 0,
    nextWrites: [] as Array<() => Response | Promise<Response>>,
    nextReads: [] as Array<() => Response | Promise<Response>>,
    commit(data: EaAssessmentUpdate) {
      if (data.expectedVersion !== server.saved.version || server.saved.status === "archived") return conflict();
      server.saved = {
        ...server.saved, ...data, version: server.saved.version + 1,
        content: data.content ?? server.saved.content,
      };
      return Response.json(server.saved);
    },
  };
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(url), `/api/enterprise-architecture/assessments/${initial.id}`);
    if (init?.method === "PATCH") {
      const data = JSON.parse(String(init.body)) as EaAssessmentUpdate;
      server.writes.push(data);
      const planned = server.nextWrites.shift();
      if (planned) return planned();
      return server.commit(data);
    }
    assert.equal(init?.method, "GET");
    server.reads++;
    return server.nextReads.shift()?.() ?? Response.json(server.saved);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } },
  });
  const queryKey = getGetEaAssessmentQueryKey(initial.id);
  client.setQueryData(queryKey, structuredClone(initial));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  type Transform = (current: EaRequirement[]) => EaRequirement[];
  let editor!: { save: (transform: Transform) => void; stage: (draft: EaRequirement[]) => void; draft: EaRequirement[] };
  const resolutions: Record<string, EaRequirement[][]> = {};

  function Editor({ instance }: { instance: string }) {
    const [draft, setDraft] = useState<EaRequirement[]>([]);
    const update = useAssessmentUpdater<EaRequirement[]>(initial, "requirements", undefined, latest => {
      (resolutions[instance] ??= []).push(structuredClone(latest));
      setDraft(latest);
    });
    const save = (transform: Transform) => { setDraft(transform); update(transform); };
    editor = { save, stage: setDraft, draft };
    return <div data-editor={instance}>
      {draft.map(item => <input key={item.id} aria-label={`Title ${item.id}`} value={item.title}
        onInput={event => {
          const title = event.currentTarget.value;
          setDraft(current => current.map(row => row.id === item.id ? { ...row, title } : row));
        }}
        onBlur={() => update(current => current.map(row => row.id === item.id ? { ...row, title: item.title } : row))}
      />)}
    </div>;
  }

  const render = async (instance: string) => {
    await act(async () => {
      root.render(<QueryClientProvider client={client}><EditRecoveryProvider>
        <Editor key={instance} instance={instance} />
      </EditRecoveryProvider></QueryClientProvider>);
    });
  };
  t.after(async () => {
    await act(async () => { root.unmount(); });
    client.clear();
    host.remove();
  });
  await render("original");

  const flush = async () => {
    await act(async () => {
      await waitForAssessmentUpdates(initial.id);
      await tick(0); // React Query's notification scheduler, not a network sleep.
    });
  };
  const until = async (predicate: () => boolean, message: string) => {
    for (let i = 0; i < 100 && !predicate(); i++) await act(async () => { await tick(1); });
    assert.ok(predicate(), message);
  };
  const cards = () => Array.from(host.querySelectorAll('[aria-label="Unsaved edits"] h3'))
    .map(heading => heading.parentElement!);
  const button = (label: string, index = 0) => {
    const found = Array.from(cards()[index]?.querySelectorAll("button") ?? [])
      .find(item => item.textContent === label);
    assert.ok(found, `Recovery item ${index} must have ${label}`);
    return found;
  };
  const click = async (label: string, index = 0) => {
    assert.equal(button(label, index).disabled, false, `${label} should be enabled`);
    await act(async () => { button(label, index).click(); });
    await flush();
    await until(() => client.isFetching() === 0, "recovery refresh must finish");
  };
  return {
    server, client, queryKey, host, resolutions, flush, until, cards, button, click,
    get editor() { return editor; },
    remount: render,
    draft: (index = 0) => JSON.parse(cards()[index].querySelectorAll("pre")[0].textContent!) as EaRequirement[],
    latest: (index = 0) => JSON.parse(cards()[index].querySelectorAll("pre")[1].textContent!) as EaRequirement[],
    async save(transform: Transform) { await act(async () => { editor.save(transform); }); },
    async blur(id: string) {
      const input = host.querySelector<HTMLInputElement>(`[aria-label="Title ${id}"]`);
      assert.ok(input);
      await act(async () => { input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })); });
    },
    async title(id: string, title: string) {
      const input = host.querySelector<HTMLInputElement>(`[aria-label="Title ${id}"]`);
      assert.ok(input);
      await act(async () => {
        input.value = title;
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    },
  };
}