import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { agentInvocationAudit, db } from "@workspace/db";
import { evaluateAgentInvocation } from "./agent-invocation";

const base = {
  trustedOrganizationId: "tenant-a",
  requestedAgentId: "agent-1",
  registeredAgentId: "agent-1",
  agentActive: true,
  agentOwnerUserId: "human-1",
  initiatingUserId: "human-1",
  caseBelongsToTenant: true,
  toolKey: "tool.case.read",
  effectiveAccess: ["tool.case.read", "data.case.readiness.read"],
};

describe("durable agent invocation boundary", () => {
  test("spoofed client agent identity cannot substitute for server registration", () => {
    const result = evaluateAgentInvocation({
      ...base,
      requestedAgentId: "agent-victim",
      registeredAgentId: "agent-1",
    });
    assert.deepEqual(result, { allowed: false, reasonCode: "AGENT_NOT_ACTIVE" });
  });

  test("revoked registered agent is denied", () => {
    const result = evaluateAgentInvocation({ ...base, agentActive: false });
    assert.deepEqual(result, { allowed: false, reasonCode: "AGENT_NOT_ACTIVE" });
  });

  test("delegation is limited to the agent and initiator's effective intersection", () => {
    const result = evaluateAgentInvocation({ ...base, effectiveAccess: ["tool.case.read"] });
    assert.deepEqual(result, { allowed: false, reasonCode: "TOOL_ACCESS_DENIED" });
  });

  test("unknown tool keys fail closed", () => {
    const result = evaluateAgentInvocation({ ...base, toolKey: "tool.case.delete" });
    assert.deepEqual(result, { allowed: false, reasonCode: "UNKNOWN_TOOL" });
  });

  test("tenant mismatch and cross-tenant case scope are denied", () => {
    assert.deepEqual(
      evaluateAgentInvocation({ ...base, requestedOrganizationId: "tenant-b" }),
      { allowed: false, reasonCode: "TENANT_MISMATCH" },
    );
    assert.deepEqual(
      evaluateAgentInvocation({ ...base, caseBelongsToTenant: false }),
      { allowed: false, reasonCode: "CASE_OUT_OF_SCOPE" },
    );
  });

  test("only the registered owner may initiate the agent", () => {
    assert.deepEqual(
      evaluateAgentInvocation({ ...base, initiatingUserId: "different-human" }),
      { allowed: false, reasonCode: "AGENT_OWNER_MISMATCH" },
    );
  });

  test("a tenant run/tool/case key cannot commit two successful invocations", async () => {
    const organizationId = `agent-invocation-replay-test-${randomUUID()}`;
    const runId = randomUUID();
    await assert.rejects(db.transaction(async (tx) => {
      const entry = {
        organizationId,
        agentId: null,
        agentVersion: null,
        initiatingUserId: "replay-test-human",
        runId,
        correlationId: randomUUID(),
        delegatedScope: ["tool.case.read", "data.case.readiness.read"],
        caseId: 1,
        purpose: "case-read-replay-test",
        toolKey: "tool.case.read",
        action: "case.metadata.read",
        outcome: "success" as const,
      };
      await tx.insert(agentInvocationAudit).values(entry);
      await tx.insert(agentInvocationAudit).values({ ...entry, correlationId: randomUUID() });
    }));
  });
});