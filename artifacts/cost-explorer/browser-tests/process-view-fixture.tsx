import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FlowStep } from "@workspace/api-client-react";
import { createRoot } from "react-dom/client";
import { FlowDiagram } from "../src/components/flow-diagram";
import IntentDetail from "../src/pages/intent-detail";
import "../src/index.css";

declare global {
  interface Window {
    __PROCESS_VIEW_READY__?: boolean;
  }
}

const steps: FlowStep[] = [
  {
    id: "receive",
    stage: "intake",
    label: "Receive employee request",
    human: false,
    agents: ["Experience Layer"],
    systems: [],
    componentRefs: ["1"],
    costs: [],
    benefits: [],
  },
  {
    id: "update",
    stage: "act",
    label: "Update payroll record",
    human: true,
    agents: ["Payroll Specialist"],
    systems: [
      {
        systemKey: "payroll",
        actions: ["put"],
        scalesWithLandscape: false,
      },
    ],
    componentRefs: ["6", "7"],
    costs: [],
    benefits: [
      {
        type: "cycle-time",
        label: "Faster resolution",
        dollarized: false,
        unitBenefitUsd: 0,
        qualitative: "",
        assumption: "",
      },
    ],
  },
];

window.history.replaceState({}, "", "/intents/payroll-change");

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const requestUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const path = new URL(requestUrl, window.location.href).pathname;
  if (path.endsWith("/api/intents")) {
    return Response.json({
      intents: [
        {
          id: 1,
          key: "payroll-change",
          name: "Payroll change",
          domain: "pay",
          flowClass: "fc1-deterministic",
          description: "Change payroll details",
          source: { name: "test", confidence: "measured" },
          asIsHandlingMin: 10,
          toBeHumanMin: 2,
          baseWeight: 1,
          actGetActions: 1,
          actPutActions: 1,
          systemsTouchedBase: 1,
          tags: [],
          isCustom: false,
        },
      ],
      customIntentsAvailable: true,
    });
  }
  if (path.endsWith("/api/flow-classes")) {
    return Response.json([
      {
        key: "fc1-deterministic",
        name: "Original",
        steps: [{ ...steps[0], label: "Original deterministic step" }],
      },
      {
        key: "fc3-multiagent",
        name: "Approved process",
        steps: [{ ...steps[1], label: "Approved multi-agent process" }],
      },
    ]);
  }
  if (path.endsWith("/api/flow-overrides")) {
    return Response.json([
      {
        id: 1,
        intentKey: "payroll-change",
        version: 1,
        flowClass: "fc1-deterministic",
        status: "approved",
        author: "A",
        rationale: "old",
      },
      {
        id: 2,
        intentKey: "payroll-change",
        version: 2,
        flowClass: "fc3-multiagent",
        status: "approved",
        author: "B",
        rationale: "current",
      },
    ]);
  }
  if (path.endsWith("/api/systems")) return Response.json([]);
  return originalFetch(input, init);
};

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});

function Fixture() {
  return (
    <main className="mx-auto max-w-6xl space-y-12 p-4 md:p-8">
      <section id="direct-flow" className="min-w-0 rounded-lg border bg-white p-3 md:p-6">
        <h1 className="mb-4 text-xl font-bold">Scenario process view</h1>
        <FlowDiagram
          steps={steps}
          annotations={{
            adoptionFraction: 0.72,
            containmentFraction: 0.81,
            hitlSamplingFraction: 0.27,
            annualTransactions: 12_345,
            usingDefaults: false,
          }}
        />
      </section>
      <section id="intent-detail" className="min-w-0">
        <QueryClientProvider client={client}>
          <IntentDetail />
        </QueryClientProvider>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Browser fixture root is missing");
createRoot(root).render(<Fixture />);
requestAnimationFrame(() => {
  window.__PROCESS_VIEW_READY__ = true;
});