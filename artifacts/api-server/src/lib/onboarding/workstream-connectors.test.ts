import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { db } from "@workspace/db";
import { DEMO_ORGANIZATION_ID, onbCases, onbDocuments, onbSystemChecks } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  BANK_CHANGE_APPROVAL_RULE,
  PRIVILEGED_ACCESS_APPROVAL_RULE,
  hashApprovalProposal,
  type ApprovalDecision,
} from "./compound-action-contract";
import type { ConnectorMutation } from "./connector-adapters";
import {
  dispatchCaseConnectorMutation,
  dispatchWorkstreamConnectorMutations,
  type WorkstreamConnectorCase,
} from "./workstream-connectors";
import { recoverUntrackedCaseSystems } from "./system-watcher";

const createdCaseIds: number[] = [];

after(async () => {
  for (const id of createdCaseIds) {
    await db.delete(onbCases).where(eq(onbCases.id, id));
  }
});

async function createDatabaseCase(lifecycleStage: string) {
  const [created] = await db
    .insert(onbCases)
    .values({
      organizationId: DEMO_ORGANIZATION_ID,
      workerName: `Connector Gate ${Date.now()}`,
      workerEmail: `connector-gate-${Date.now()}@example.test`,
      hireType: "external-fte",
      workerCategory: "employee",
      role: "Engineer",
      department: "Technology",
      geography: "United Kingdom",
      legalEntity: "Example Ltd",
      managerName: "Manager",
      recruiterName: "Recruiter",
      joiningDate: "2026-10-01",
      lifecycleStage,
      orchestrationStatus: "running",
      readiness: [],
      workstreams: [],
    })
    .returning();
  createdCaseIds.push(created.id);
  return created;
}

function caseRow(
  patch: Partial<WorkstreamConnectorCase> = {},
): WorkstreamConnectorCase {
  return {
    id: 42,
    organizationId: "test-organization",
    workerEmail: "worker@example.com",
    workerCategory: "employee",
    hireType: "external-fte",
    geography: "United Kingdom",
    legalEntity: "Example Ltd",
    lifecycleStage: "plan-generated",
    recruiterName: "Recruiter",
    updatedAt: new Date("2026-09-08T00:00:00Z"),
    workstreams: [],
    ...patch,
  };
}

describe("workstream connector runtime enforcement", () => {
  test("the default writers seed the intended case then register every downstream system", async () => {
    const c = await createDatabaseCase("plan-generated");
    await dispatchWorkstreamConnectorMutations(c);

    const documents = await db
      .select()
      .from(onbDocuments)
      .where(eq(onbDocuments.caseId, c.id));
    const checks = await db
      .select()
      .from(onbSystemChecks)
      .where(eq(onbSystemChecks.caseId, c.id));

    assert.ok(documents.length > 0);
    assert.ok(documents.every((document) => document.caseId === c.id));
    assert.deepEqual(
      checks.map((check) => check.system).sort(),
      ["bgv", "itsm", "payroll"],
    );
  });

  test("restart recovery uses the guarded default writers for an untracked case", async () => {
    const c = await createDatabaseCase("preboarding");
    await recoverUntrackedCaseSystems(c.id);

    const documents = await db
      .select()
      .from(onbDocuments)
      .where(eq(onbDocuments.caseId, c.id));
    const checks = await db
      .select()
      .from(onbSystemChecks)
      .where(eq(onbSystemChecks.caseId, c.id));

    assert.ok(documents.length > 0);
    assert.deepEqual(
      checks.map((check) => check.system).sort(),
      ["bgv", "itsm", "payroll"],
    );
  });

  test("the real simulated workflow routes documents, BGV, IAM, and payroll through the gate", async () => {
    const writes: ConnectorMutation[] = [];
    await dispatchWorkstreamConnectorMutations(caseRow(), {
      write: async (mutation) => {
        writes.push(mutation as ConnectorMutation);
      },
      now: () => new Date("2026-09-08T01:00:00Z"),
    });
    assert.deepEqual(
      writes.map(({ connector, operation }) => `${connector}:${operation}`),
      [
        "documents:send-envelope",
        "background-verification:open-check",
        "iam:provision-account",
        "payroll:enrol-worker",
      ],
    );
  });

  test("a mismatched persisted binding prevents the workflow writer", async () => {
    let writes = 0;
    await assert.rejects(
      dispatchWorkstreamConnectorMutations(caseRow(), {
        authorize: () => ({
          binding: { proposalHash: "stale-plan-binding" },
          decisions: [],
        }),
        write: async () => {
          writes += 1;
        },
      }),
      /unbound_proposal/,
    );
    assert.equal(writes, 0);
  });

  test("expired or rejected stored decisions prevent the workflow writer", async () => {
    for (const state of ["expired", "rejected"] as const) {
      let writes = 0;
      await assert.rejects(
        dispatchWorkstreamConnectorMutations(caseRow(), {
          authorize: (proposal) => ({
            binding: { proposalHash: hashApprovalProposal(proposal) },
            decisions: [
              {
                proposalHash: hashApprovalProposal(proposal),
                authorityId: "reviewer-1",
                authorityRole: "reviewer",
                decision: state === "rejected" ? "rejected" : "approved",
                expiresAt:
                  state === "expired"
                    ? new Date("2026-09-07T00:00:00Z")
                    : new Date("2026-09-09T00:00:00Z"),
              },
            ],
          }),
          write: async () => {
            writes += 1;
          },
          now: () => new Date("2026-09-08T00:00:00Z"),
        }),
        state === "expired" ? /expired_approval/ : /rejected/,
      );
      assert.equal(writes, 0);
    }
  });

  test("under-approved bank and privileged mutations cannot reach workflow writers", async () => {
    const sensitive: Array<{
      mutation: ConnectorMutation;
      role: string;
      authorityId: string;
    }> = [
      {
        mutation: {
          connector: "payroll",
          operation: "bank-change",
          payload: { accountToken: "vault-ref" },
        },
        role: BANK_CHANGE_APPROVAL_RULE.allOf[0],
        authorityId: "fraud-1",
      },
      {
        mutation: {
          connector: "iam",
          operation: "privileged-access",
          payload: { role: "administrator" },
        },
        role: PRIVILEGED_ACCESS_APPROVAL_RULE.allOf[0],
        authorityId: "manager-1",
      },
    ];
    for (const { mutation, role, authorityId } of sensitive) {
      let writes = 0;
      await assert.rejects(
        dispatchCaseConnectorMutation({
          c: caseRow(),
          mutation,
          dependencies: {
            authorize: (proposal) => ({
              binding: { proposalHash: hashApprovalProposal(proposal) },
              decisions: [
                {
                  proposalHash: hashApprovalProposal(proposal),
                  authorityId,
                  authorityRole: role,
                  decision: "approved",
                  expiresAt: new Date("2026-09-09T00:00:00Z"),
                } satisfies ApprovalDecision,
              ],
            }),
            write: async () => {
              writes += 1;
            },
            now: () => new Date("2026-09-08T00:00:00Z"),
          },
        }),
        /missing_authority/,
      );
      assert.equal(writes, 0);
    }
  });

  test("a fully approved sensitive mutation reaches the exact workflow writer", async () => {
    const mutation: ConnectorMutation = {
      connector: "payroll",
      operation: "bank-change",
      payload: { accountToken: "vault-ref" },
    };
    const writes: ConnectorMutation[] = [];
    await dispatchCaseConnectorMutation({
      c: caseRow(),
      mutation,
      dependencies: {
        authorize: (proposal) => ({
          binding: { proposalHash: hashApprovalProposal(proposal) },
          decisions: BANK_CHANGE_APPROVAL_RULE.allOf.map(
            (authorityRole, index) => ({
              proposalHash: hashApprovalProposal(proposal),
              authorityId: `authority-${index}`,
              authorityRole,
              decision: "approved",
              expiresAt: new Date("2026-09-09T00:00:00Z"),
            }),
          ),
        }),
        write: async (boundMutation) => {
          writes.push(boundMutation as ConnectorMutation);
        },
        now: () => new Date("2026-09-08T00:00:00Z"),
      },
    });
    assert.deepEqual(writes, [mutation]);
  });

  test("non-employee applicability omits payroll but still dispatches documents", async () => {
    const writes: ConnectorMutation[] = [];
    await dispatchWorkstreamConnectorMutations(
      caseRow({
        workerCategory: "contractor",
        hireType: "contractor",
      }),
      {
        write: async (mutation) => {
          writes.push(mutation as ConnectorMutation);
        },
      },
    );
    assert.ok(writes.some((mutation) => mutation.connector === "documents"));
    assert.ok(!writes.some((mutation) => mutation.connector === "payroll"));
  });
});