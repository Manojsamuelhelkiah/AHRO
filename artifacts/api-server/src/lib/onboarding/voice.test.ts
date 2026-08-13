import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { xmlEscape, gatherTwiml, hangupTwiml, voiceGreeting } from "./voice";

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
