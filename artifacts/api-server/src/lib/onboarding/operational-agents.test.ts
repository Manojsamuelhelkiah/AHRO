import assert from "node:assert/strict";
import test from "node:test";
import { listOnboardingAgents, resolveOnboardingAgent } from "./operational-agents";

test("agent business descriptions preserve provenance without granting execution or mutating catalogue snapshots", () => {
  const agents = listOnboardingAgents();
  assert.equal(agents.length, 5);
  for (const agent of agents) {
    assert.equal(agent.simulated, true);
    assert.equal(agent.origin, "internal");
    assert.doesNotMatch(agent.name + agent.description + agent.capabilities.join(" "), /simulat|fictional|synthetic|illustrative/i);
    assert.match(agent.description, /requires?|confirmation/i);
    assert.deepEqual(resolveOnboardingAgent(agent.id), agent);
  }
  agents[0]!.capabilities.push("attempted mutation");
  assert.ok(!listOnboardingAgents()[0]!.capabilities.includes("attempted mutation"));
  assert.equal(resolveOnboardingAgent("unregistered-executor"), null);
});
