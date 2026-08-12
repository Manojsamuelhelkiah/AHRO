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
