import { describe, it } from "node:test";
import assert from "node:assert";
import { deriveProcessBranchMetrics, deriveProcessMapping } from "./process-mapping";
import type { FlowStep } from "@workspace/api-client-react";

const mockSteps: FlowStep[] = [
  {
    id: "step-1", stage: "intake", label: "Receive Request", human: false, agents: [], systems: [], componentRefs: [], costs: [], benefits: []
  },
  {
    id: "step-2", stage: "intent", label: "Classify", human: false, agents: ["Intent Classifier"], systems: [], componentRefs: [], costs: [], benefits: []
  },
  {
    id: "step-3", stage: "act", label: "Update Record", human: false, agents: [], systems: [{ systemKey: "HRIS", actions: ["put"], scalesWithLandscape: false }], componentRefs: [], costs: [], benefits: []
  },
  {
    id: "step-4", stage: "act", label: "Manual Review", human: true, agents: [], systems: [], componentRefs: [], costs: [], benefits: []
  }
];

describe("deriveProcessMapping", () => {
  it("generates BPMN and SIPOC structural completeness", () => {
    const { bpmnNodes, sipocRows } = deriveProcessMapping(mockSteps);
    
    assert.strictEqual(bpmnNodes.length, 4);
    assert.strictEqual(sipocRows.length, 4);
    
    // Test Lane Assignments
    assert.strictEqual(bpmnNodes[0].lane, "Digital Service");
    assert.strictEqual(bpmnNodes[1].lane, "Digital Service");
    assert.strictEqual(bpmnNodes[2].lane, "Digital Service");
    assert.strictEqual(bpmnNodes[3].lane, "HR Operations");
    
    // Test Node Types
    assert.strictEqual(bpmnNodes[0].taskType, "receive");
    assert.strictEqual(bpmnNodes[1].taskType, "business-rule");
    assert.strictEqual(bpmnNodes[2].taskType, "service");
    assert.strictEqual(bpmnNodes[3].taskType, "user");

    // Test SIPOC outputs and inputs
    assert.strictEqual(sipocRows[2].input, "Authorized action");
    assert.strictEqual(sipocRows[2].output, "Verified record or transaction");
    assert.strictEqual(sipocRows[2].customer, "HR Operations");
    assert.equal(deriveProcessMapping(mockSteps).validation.valid, true);
  });

  it("fails structural validation transparently when no canonical path exists", () => {
    const mapping = deriveProcessMapping([]);
    assert.equal(mapping.validation.valid, false);
    assert.equal(mapping.validation.triggerCount, 0);
    assert.equal(mapping.validation.outcomeCount, 0);
    assert.equal(mapping.sipocRows.length, 0);
  });

  it("uses explicit business fallbacks for unknown stages", () => {
    const mapping = deriveProcessMapping([{ ...mockSteps[0], id: "unknown", stage: "bespoke", label: "AI" }]);
    assert.equal(mapping.usedFallbacks, true);
    assert.equal(mapping.validation.valid, true);
    assert.equal(mapping.sipocRows[0]?.input, "Process context");
  });

  it("keeps scenario branch volumes exact across all process presentations", () => {
    const metrics = deriveProcessBranchMetrics({
      annualTransactions: 12_345,
      adoptionFraction: 0.72,
      containmentFraction: 0.81,
      hitlSamplingFraction: 0.27,
    });
    assert.equal(metrics.adoptedTransactions, 8_888);
    assert.equal(metrics.manualTransactions, 3_457);
    assert.equal(metrics.containedTransactions, 7_199);
    assert.equal(metrics.fallbackTransactions, 1_689);
    assert.equal(metrics.humanReviewTransactions, 1_944);
    assert.equal(metrics.automatedTransactions, 5_255);
  });

  it("covers every current flow-class shape with complete BPMN and SIPOC structures", () => {
    const shapes = [
      ["intake", "intent", "act", "close"],
      ["intake", "intent", "knowledge", "orchestration", "close"],
      ["intake", "intent", "orchestration", "orchestration", "act", "close"],
      ["intake", "orchestration", "orchestration", "act", "close"],
    ];
    for (const [shapeIndex, stages] of shapes.entries()) {
      const steps = stages.map((stage, index) => ({
        ...mockSteps[Math.min(index, mockSteps.length - 1)]!,
        id: `fc${shapeIndex + 1}-${index}`,
        stage,
        label: `${stage} business activity`,
        human: stage === "orchestration" && index === stages.length - 2,
      }));
      const mapping = deriveProcessMapping(steps);
      assert.equal(mapping.validation.valid, true);
      assert.equal(mapping.bpmnNodes.length, stages.length);
      assert.equal(mapping.sipocRows.length, stages.length);
      assert.deepEqual(mapping.sipocRows.map((row) => row.stageId), mapping.bpmnNodes.map((node) => node.id));
    }
  });
});
