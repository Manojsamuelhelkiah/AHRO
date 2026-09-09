import {
  customFetch,
  pinOrganizationIdForPage,
  type ScenarioInputs,
} from "@workspace/api-client-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { fetchScenarioWorkbook } from "../src/lib/workbook-export";
import { createClientSetupDraftSession } from "../../onboarding-agent/src/pages/client-setup/client-setup-persistence";
import "../src/index.css";

declare global {
  interface Window {
    __LAST_TENANT_REQUEST__?: {
      body: string | null;
      organizationId: string | null;
      url: string;
    };
    __TENANT_TAB_READY__?: boolean;
  }
}

const app = new URLSearchParams(window.location.search).get("app") === "onboarding"
  ? "onboarding"
  : "cost";
const initialOrganizationId =
  localStorage.getItem("activeOrganizationId") ?? "workspace-a";
pinOrganizationIdForPage(initialOrganizationId);
const onboardingDraftSession =
  app === "onboarding"
    ? createClientSetupDraftSession<{ clientName: string }>(
        localStorage,
        "fixture-user",
        initialOrganizationId,
      )
    : null;

window.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  window.__LAST_TENANT_REQUEST__ = {
    body: typeof init?.body === "string" ? init.body : null,
    organizationId: new Headers(init?.headers).get("x-organization-id"),
    url,
  };
  return Response.json({ ok: true });
};

function TenantTabFixture() {
  const [workspace, setWorkspace] = useState(initialOrganizationId);
  const [draft, setDraft] = useState(
    app === "cost"
      ? "Workspace A confidential scenario"
      : onboardingDraftSession?.load()?.clientName
        ?? (initialOrganizationId === "workspace-a"
          ? "Workspace A confidential hire"
          : "Workspace B blank client setup"),
  );

  const switchWorkspace = () => {
    onboardingDraftSession?.save({ clientName: draft });
    localStorage.setItem("activeOrganizationId", "workspace-b");
    window.location.reload();
  };

  const submit = async () => {
    if (app === "cost") {
      await fetchScenarioWorkbook({
        fixtureDraft: draft,
      } as unknown as ScenarioInputs);
    } else {
      await customFetch("/api/onboarding/cases", {
        method: "POST",
        body: JSON.stringify({ draft }),
      });
    }
  };

  return (
    <main className="space-y-4 p-6">
      <h1>{app === "cost" ? "Cost Explorer" : "Onboarding Agent"} tab</h1>
      <p data-testid="workspace-label">Active workspace: {workspace}</p>
      <label className="block">
        Unsaved draft
        <input
          aria-label="Unsaved draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="block border p-2"
        />
      </label>
      {app === "onboarding" && (
        <button type="button" onClick={switchWorkspace}>
          Switch to workspace B
        </button>
      )}
      <button type="button" onClick={submit}>
        Submit {app === "cost" ? "scenario" : "hire"}
      </button>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Tenant fixture root is missing");
createRoot(root).render(<TenantTabFixture />);
requestAnimationFrame(() => {
  window.__TENANT_TAB_READY__ = true;
});