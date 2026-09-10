import { openai } from "@workspace/integrations-openai-ai-server";

const MODEL = "gpt-5-nano";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_COMPLETION_TOKENS = 6_000;

export type ExplainabilityCompletionStage = "generation" | "verification";

export type ExplainabilityCompletionMetadata = {
  stage: ExplainabilityCompletionStage;
  finishReason?: string;
  code?: string;
  status?: number;
};

export class ExplainabilityCompletionError extends Error {
  readonly metadata: ExplainabilityCompletionMetadata;

  constructor(message: string, metadata: ExplainabilityCompletionMetadata) {
    super(message);
    this.name = "ExplainabilityCompletionError";
    this.metadata = metadata;
  }
}

const GENERATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["paragraphs"],
  properties: {
    paragraphs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "sourceIds", "kind"],
        properties: {
          text: { type: "string" },
          sourceIds: {
            type: "array",
            items: { type: "string" },
          },
          kind: { type: "string", enum: ["supported", "not-recorded"] },
        },
      },
    },
  },
} as const;

const VERIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "supported"],
        properties: {
          index: { type: "integer" },
          supported: { type: "boolean" },
        },
      },
    },
  },
} as const;

function schemaFor(stage: ExplainabilityCompletionStage, sourceIds: readonly string[] = []) {
  return stage === "generation"
    ? {
      name: "onboarding_case_explanation",
      schema: sourceIds.length > 0
        ? {
          ...GENERATION_SCHEMA,
          properties: {
            paragraphs: {
              ...GENERATION_SCHEMA.properties.paragraphs,
              items: {
                ...GENERATION_SCHEMA.properties.paragraphs.items,
                properties: {
                  ...GENERATION_SCHEMA.properties.paragraphs.items.properties,
                  sourceIds: {
                    type: "array",
                    items: { type: "string", enum: [...sourceIds] },
                  },
                },
              },
            },
          },
        }
        : GENERATION_SCHEMA,
    }
    : {
      name: "onboarding_case_grounding_verdicts",
      schema: VERIFICATION_SCHEMA,
    };
}

function completionError(
  stage: ExplainabilityCompletionStage,
  error: unknown,
  fallbackCode: string,
): ExplainabilityCompletionError {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof record.status === "number" ? record.status : undefined;
  const code = typeof record.code === "string" ? record.code : fallbackCode;
  return new ExplainabilityCompletionError(
    "Explainability model completion failed.",
    { stage, code, status },
  );
}

export async function completeExplainabilityJson(
  stage: ExplainabilityCompletionStage,
  system: string,
  user: string,
  signal?: AbortSignal,
  sourceIds?: readonly string[],
): Promise<unknown> {
  const schema = schemaFor(stage, sourceIds);
  let response;
  try {
    response = await openai.chat.completions.create({
      model: MODEL,
      reasoning_effort: "low",
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schema.name,
          strict: true,
          schema: schema.schema,
        },
      },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }, {
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      signal,
    });
  } catch (error) {
    throw completionError(stage, error, "request_failed");
  }

  const choice = response.choices[0];
  const finishReason = choice?.finish_reason ?? undefined;
  if (!choice) {
    throw new ExplainabilityCompletionError(
      "Explainability model returned no choice.",
      { stage, code: "empty_choice" },
    );
  }
  if (finishReason === "length") {
    throw new ExplainabilityCompletionError(
      "Explainability model completion was truncated.",
      { stage, finishReason, code: "completion_truncated" },
    );
  }
  if (choice.message.refusal) {
    throw new ExplainabilityCompletionError(
      "Explainability model refused the request.",
      { stage, finishReason, code: "model_refusal" },
    );
  }
  const content = choice.message.content?.trim();
  if (!content) {
    throw new ExplainabilityCompletionError(
      "Explainability model returned empty content.",
      { stage, finishReason, code: "empty_content" },
    );
  }
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new ExplainabilityCompletionError(
      "Explainability model returned invalid JSON.",
      { stage, finishReason, code: "invalid_json" },
    );
  }
}