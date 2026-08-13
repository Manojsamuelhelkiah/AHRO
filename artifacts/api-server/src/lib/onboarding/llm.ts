import { openai } from "@workspace/integrations-openai-ai-server";

const MODEL = "gpt-5-nano";

/**
 * Single LLM call used by the reasoning ("LLM engine") agents.
 * Returns the text, or null on failure — callers must degrade gracefully
 * and record the failure in the audit trail instead of silently faking output.
 */
export async function llmComplete(
  system: string,
  user: string,
  maxTokens = 700,
): Promise<string | null> {
  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      // Reasoning models consume tokens thinking before answering; keep a
      // generous completion budget on top of the desired output size.
      max_completion_tokens: maxTokens + 2500,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const text = resp.choices[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch (err) {
    console.error("[onboarding llm] completion failed:", err);
    return null;
  }
}

/**
 * LLM call that must return a JSON object. Returns the parsed object or
 * null on any failure (call error, empty output, unparseable JSON) —
 * callers must treat null as "the AI could not handle this".
 */
export async function llmCompleteJson<T>(
  system: string,
  user: string,
  maxTokens = 700,
): Promise<T | null> {
  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: maxTokens + 2500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const text = resp.choices[0]?.message?.content?.trim();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch (err) {
    console.error("[onboarding llm] json completion failed:", err);
    return null;
  }
}
