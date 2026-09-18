import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FormProvider, useForm } from "react-hook-form";
import type { ScenarioSystemCapability } from "@workspace/api-client-react";
import { demoDraft } from "./schema";
import { StepLandscape } from "./wizard-steps";

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
];

function LandscapeFixture() {
  const form = useForm({ defaultValues: { ...demoDraft, systems: [
    { key: "bgv", name: "HireRight", vendor: "HireRight", mode: "email-watch" as const, ownerEmail: "" },
    { key: "hris", name: "Workday", vendor: "Workday", mode: "direct-integration" as const, ownerEmail: "" },
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
});