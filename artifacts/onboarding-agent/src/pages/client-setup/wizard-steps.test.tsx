import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FormProvider, useForm } from "react-hook-form";
import type { ScenarioSystemCapability } from "@workspace/api-client-react";
import { demoDraft } from "./schema";
import { StepLandscape, FlowBasisSummary } from "./wizard-steps";

const capabilities: ScenarioSystemCapability[] = [
  {
    key: "bgv",
    label: "Background Verification",
    description: "Background verification status and exceptions.",
    watcherSystem: "bgv",
    modes: [
      { mode: "direct-integration", label: "Direct integration", description: "Connect through the provider adapter." },
      { mode: "email-watch", label: "Email watch", description: "Track status emails sent to the watched mailbox." },
      { mode: "manual", label: "Manual", description: "No monitoring is activated." },
    ],
  },
  {
    key: "hris",
    label: "HRIS / Core HR",
    description: "Worker records.",
    modes: [
      { mode: "direct-integration", label: "Direct integration", description: "Connect through the provider adapter." },
      { mode: "manual", label: "Manual", description: "No monitoring is activated." },
    ],
  },
  {
    key: "payroll",
    label: "Payroll & Benefits",
    description: "Payroll readiness.",
    allowMultipleInstances: true,
    watcherSystem: "payroll",
    modes: [
      { mode: "direct-integration", label: "Direct integration", description: "Connect through the provider adapter." },
      { mode: "email-watch", label: "Email watch", description: "Track mailbox updates." },
      { mode: "manual", label: "Manual", description: "No monitoring is activated." },
    ],
  },
];

function LandscapeFixture() {
  const form = useForm({ defaultValues: { ...demoDraft, systems: [
    { id: "bgv-1", key: "bgv", name: "HireRight", vendor: "HireRight", mode: "email-watch" as const, ownerEmail: "", needsReview: true },
    { id: "hris-1", key: "hris", name: "Workday", vendor: "Workday", mode: "direct-integration" as const, ownerEmail: "" },
  ] } });
  return <FormProvider {...form}><StepLandscape capabilities={capabilities} /></FormProvider>;
}

test("responsive setup rows render server-provided choices without unsupported email watch", () => {
  const html = renderToStaticMarkup(<LandscapeFixture />);
  assert.match(html, /Background Verification/);
  assert.match(html, /Email watch/);
  assert.match(html, /Track status emails sent to the watched mailbox/);
  assert.match(html, /System type/);
  assert.equal(html.match(/value="email-watch"/g)?.length, 1);
  assert.match(html, /previously saved connection choice is no longer supported/);
  assert.match(html, /Payroll and ticketing support multiple estates/);
});

test("flow review distinguishes planned adoption, current overrides and private documents", () => {
  const basis = { source: "product-base-with-overrides" as const, fingerprint: "abc123",
    selectedDomains: ["Hire", "Pay"], intentWeights: { onboarding: 0.5, payroll: 0.5 }, overrideRefs: ["onboarding:v2"] };
  const pending = renderToStaticMarkup(<FlowBasisSummary basis={basis} mode="custom" saved attachmentCount={2} />);
  for (const copy of ["Base product flows with existing approved client overrides", "Hire, Pay", "2 intents", "abc123", "onboarding:v2", "Pending review", "not a pinned executable version", "Private document references: 2"]) {
    assert.ok(pending.includes(copy), copy);
  }
  const legacy = renderToStaticMarkup(<FlowBasisSummary mode="custom" saved />);
  assert.match(legacy, /Legacy source not recorded/);
  assert.match(legacy, /no product-default reset/);
  const uploaded = renderToStaticMarkup(<FlowBasisSummary basis={basis} mode="recommended" attachmentCount={1} />);
  assert.match(uploaded, /Documents attached, pending review; effective flows unchanged/);
});