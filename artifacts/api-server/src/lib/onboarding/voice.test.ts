import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  demoVoiceTurn,
  xmlEscape,
  gatherTwiml,
  hangupTwiml,
  voiceGreeting,
  type Session,
} from "./voice";

describe("xmlEscape", () => {
  test("escapes TwiML-breaking characters", () => {
    assert.equal(xmlEscape(`<Say>&"'`), "&lt;Say&gt;&amp;&quot;&apos;");
    assert.equal(xmlEscape("plain words"), "plain words");
  });
});

describe("TwiML builders", () => {
  test("gather wraps the prompt in Gather+Say with a fallback hangup", () => {
    const xml = gatherTwiml('Hello & welcome, is this "Asha"?', "tok123");
    assert.ok(xml.includes('<Gather input="speech"'));
    assert.ok(xml.includes("token=tok123"));
    assert.ok(xml.includes("Hello &amp; welcome, is this &quot;Asha&quot;?"));
    assert.ok(xml.includes("<Hangup/>"));
    assert.ok(!xml.includes('"Asha"')); // raw quotes must not survive
  });
  test("hangup says the closing line then hangs up", () => {
    const xml = hangupTwiml("Goodbye <all>");
    assert.ok(xml.includes("Goodbye &lt;all&gt;"));
    assert.ok(xml.indexOf("<Say") < xml.indexOf("<Hangup/>"));
  });
});

describe("voiceGreeting", () => {
  test("scenario-specific openings mention the hire by first name", () => {
    const day = voiceGreeting("day-before", "Manoj");
    const sla = voiceGreeting("sla-escalation", "Manoj");
    assert.ok(day.includes("Manoj") && /joining day/i.test(day));
    assert.ok(sla.includes("Manoj") && /time-critical/i.test(sla));
    assert.notEqual(day, sla);
  });
});

describe("isolated DemoController voice script", () => {
  test("retains actual caller speech and never needs a reasoning/provider call", async () => {
    const session: Session = {
      token: "demo-script-test",
      caseId: 42,
      organizationId: "demo",
      scenario: "day-before",
      reason: "[DEMO]",
      turns: [{ role: "agent", text: "[DEMO] Opening" }],
      decisions: [],
      finalized: false,
      simulated: true,
      startedAt: Date.now(),
      callSid: null,
      localCallId: "local-call-42",
      runId: "run-42",
      requestId: "request-42",
      lastSpeech: null,
      lastResponse: null,
    };

    const first = await demoVoiceTurn(session, "The caller's actual answer");
    assert.equal(first.done, false);
    assert.equal(session.turns[1]?.text, "The caller's actual answer");
    const second = await demoVoiceTurn(session, "A second actual answer");
    assert.equal(second.done, true);
    assert.equal(session.turns[3]?.text, "A second actual answer");
    assert.equal(session.decisions.length, 0);
  });
});
