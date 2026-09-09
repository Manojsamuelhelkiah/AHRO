import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SCENARIO_FILE_BYTES,
  validateDeclaredScenarioFile,
  validateScenarioFileContent,
} from "./scenario-file-safety";

test("declared files require an exact supported extension and MIME pair", () => {
  assert.equal(validateDeclaredScenarioFile("evidence.PDF", "application/pdf", 12).extension, ".pdf");
  assert.equal(validateDeclaredScenarioFile("flow.bpmn", "application/xml", 12).extension, ".bpmn");
  assert.equal(validateDeclaredScenarioFile("readme.md", "text/markdown", 12).extension, ".md");
  assert.equal(validateDeclaredScenarioFile("process.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 12).extension, ".docx");
  assert.throws(() => validateDeclaredScenarioFile("evidence.exe", "application/pdf", 12));
  assert.throws(() => validateDeclaredScenarioFile("evidence.pdf", "text/plain", 12));
  assert.throws(() => validateDeclaredScenarioFile("evidence.pdf", "application/pdf", MAX_SCENARIO_FILE_BYTES + 1));
});

test("content validation rejects disguised or unsafe content", () => {
  assert.doesNotThrow(() => validateScenarioFileContent(".pdf", Buffer.from("%PDF-1.7")));
  assert.throws(() => validateScenarioFileContent(".pdf", Buffer.from("MZ executable")));
  assert.doesNotThrow(() => validateScenarioFileContent(".docx", Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from("[Content_Types].xml word/document.xml"),
  ])));
  assert.throws(() => validateScenarioFileContent(".docx", Buffer.from([0x50, 0x4b, 0x03, 0x04])));
  assert.throws(() => validateScenarioFileContent(".csv", Buffer.from("<script>alert(1)</script>")));
  assert.throws(() => validateScenarioFileContent(".csv", Buffer.from([0, 1, 2])));
  assert.throws(() => validateScenarioFileContent(".csv", Buffer.from("name,value\nbad,=HYPERLINK(\"x\")")));
  assert.throws(() => validateScenarioFileContent(".csv", Buffer.from("name,value\nbad,-2+3")));
  assert.doesNotThrow(() => validateScenarioFileContent(".csv", Buffer.from("employee,adjustment\nA,-125.50\nB,+42\nC,-1.2e3")));
  assert.throws(() => validateScenarioFileContent(".pdf", Buffer.from("%PDF-1.7 /JavaScript")));
  assert.doesNotThrow(() => validateScenarioFileContent(".json", Buffer.from("{\"process\":\"hire\"}")));
  assert.throws(() => validateScenarioFileContent(".json", Buffer.from("{not-json}")));
  assert.doesNotThrow(() => validateScenarioFileContent(".bpmn", Buffer.from("<?xml version=\"1.0\"?><definitions />")));
  assert.doesNotThrow(() => validateScenarioFileContent(".bpmn", Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><definitions condition="approved" />')));
  assert.doesNotThrow(() => validateScenarioFileContent(".txt", Buffer.from("Continue when condition=approved and owner=HR.")));
  assert.throws(() => validateScenarioFileContent(".xml", Buffer.from("<!DOCTYPE a [<!ENTITY x SYSTEM \"file:///etc/passwd\">]><a>&x;</a>")));
  assert.throws(() => validateScenarioFileContent(".xml", Buffer.from('<process onload="steal()" />')));
});