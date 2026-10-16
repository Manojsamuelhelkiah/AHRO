import {
  ExplainOnboardingCaseResponse,
} from "@workspace/api-zod";
import {
  redactExplainabilityText,
  type CaseExplainabilityEvidence,
} from "./case-explainability-evidence";
import {
  completeExplainabilityJson,
  ExplainabilityCompletionError,
  type ExplainabilityCompletionMetadata,
  type ExplainabilityCompletionStage,
} from "./case-explainability-completion";
import { classifySensitiveText } from "./sensitive-access";
import { externalProviderDispatchDenied } from "./provider-policy";
import type { ProviderGovernanceCase } from "./governance-provider-boundary";
import {
  EXPLANATION_SYSTEM as SYSTEM_PROMPT, EXPLANATION_CATEGORIES as INTENT_PROMPT,
  explanationTemplate, VERIFICATION_SYSTEM as VERIFIER_SYSTEM_PROMPT, verificationParagraphTemplate,
} from "./inspectable-prompts";

export type ExplainabilityCompletion = (
  system: string,
  user: string,
  maxTokens?: number,
  signal?: AbortSignal,
  stage?: ExplainabilityCompletionStage,
  sourceIds?: readonly string[],
) => Promise<unknown | null>;

export class ExplainabilityUnavailableError extends Error {
  readonly statusCode = 503;
  readonly metadata?: ExplainabilityCompletionMetadata;

  constructor(
    message = "Case explanation is temporarily unavailable. Please retry.",
    metadata?: ExplainabilityCompletionMetadata,
  ) {
    super(message);
    this.name = "ExplainabilityUnavailableError";
    this.metadata = metadata;
  }
}

export function defaultCompletion(caseRow: ProviderGovernanceCase): ExplainabilityCompletion {
  return (
    system,
    user,
    _maxTokens,
    signal,
    stage = "generation",
    sourceIds,
  ) => completeExplainabilityJson(caseRow, stage, system, user, signal, sourceIds);
}

function evidencePrompt(evidence: CaseExplainabilityEvidence): string {
  return evidence.sources.map((item) => [
    `[SOURCE ${item.id}]`,
    `kind=${item.kind}; tab=${item.tab}; occurredAt=${item.occurredAt ?? "not recorded"}`,
    `title=${item.title}`,
    `excerpt=${item.excerpt}`,
  ].join("\n")).join("\n\n");
}

type ExplainabilityIntent =
  | "case-status"
  | "recorded-blockers"
  | "approval-history"
  | "document-status"
  | "execution-confirmation"
  | "case-timeline";

/**
 * User text is intentionally used only locally to select one fixed,
 * server-authored category. Neither the question nor conversation history is
 * provider-bound data: arbitrary opaque text cannot be proved safe by
 * redaction or a keyword classifier.
 */
function intentForQuestion(question: string): ExplainabilityIntent {
  const normalized = question.toLocaleLowerCase();
  if (/\b(?:actually|really|sent|delivered|delivery|verified|verification|consent|executed|transaction|provider confirmation)\b/.test(normalized)) {
    return "execution-confirmation";
  }
  if (/\b(?:block(?:ed|ing|er|ers)?|delay(?:ed|s)?|hold|risk|issue|problem)\b/.test(normalized)) {
    return "recorded-blockers";
  }
  if (/\b(?:approv|decision|why|reason|rationale)\b/.test(normalized)) {
    return "approval-history";
  }
  if (/\b(?:document|file|upload|form|paperwork)\b/.test(normalized)) {
    return "document-status";
  }
  if (/\b(?:when|timeline|history|event|happen|progress)\b/.test(normalized)) {
    return "case-timeline";
  }
  return "case-status";
}

function buildUserPrompt(
  question: string,
  _history: readonly { role: string; content: string }[] | undefined,
  evidence: CaseExplainabilityEvidence,
): string {
  return explanationTemplate(INTENT_PROMPT[intentForQuestion(question)], evidence.caseId, evidencePrompt(evidence));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const known = new Set(keys);
  return Object.keys(value).every((key) => known.has(key)) &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function unavailable(
  stage: ExplainabilityCompletionStage,
  code: string,
): ExplainabilityUnavailableError {
  return new ExplainabilityUnavailableError(undefined, { stage, code });
}

const EXPLAINABILITY_DEADLINE_MS = 45_000;
const NOT_RECORDED_TEXT =
  "This explanation could not be established from the bounded case evidence; the requested fact or reason is not recorded.";
const UNREDACTED_EXTERNAL_IDENTIFIER = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:https?|ftp):\/\/[^\s<>"']+/i,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/i,
  /\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret|authorization|token|sid)\s*[:=]\s*[^\s,;]+/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:\d[ -]?){13,19}\b/,
  /(?:\+\d[\d\s().-]{7,}\d|\(\d{2,4}\)[\s.-]?\d[\d\s.-]{5,}\d|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b)/,
] as const;

/**
 * This is the final firewall before either LLM request. Evidence collection
 * remains responsible for assembling useful operational context, but a bad or
 * newly added source must not turn this external model call into a disclosure
 * path. Safe operational evidence is still eligible; only sensitive classes
 * and identifiers that survived the server redactor fail closed.
 */
function assertExternalLlmDisclosureAllowed(
  stage: ExplainabilityCompletionStage,
  payload: string,
  evidence: CaseExplainabilityEvidence,
  opaqueUserText: readonly string[] = [],
): void {
  if (externalProviderDispatchDenied()) {
    throw unavailable(stage, "provider_dispatch_denied");
  }
  const identifiers = evidence.redactionIdentifiers
    .map((value) => value.trim())
    .filter((value) => value.length >= 2);
  const containsKnownIdentifier = identifiers.some((identifier) =>
    payload.toLocaleLowerCase().includes(identifier.toLocaleLowerCase()),
  );
  // Questions and history are opaque user input, not server-classified
  // evidence. Redaction is necessary but cannot prove arbitrary text is safe.
  // Block recognized sensitive/identifier material before even an injected
  // completion callback, and rely on the concrete OpenAI lifecycle boundary
  // for any remaining opaque text.
  const containsSensitiveUserText = opaqueUserText.some((value) =>
    classifySensitiveText(value).length > 0 ||
    identifiers.some((identifier) => value.toLocaleLowerCase().includes(identifier.toLocaleLowerCase())) ||
    UNREDACTED_EXTERNAL_IDENTIFIER.some((pattern) => pattern.test(value)),
  );
  // Classification applies only to server evidence, not to the user's
  // question or a model's untrusted candidate claim. A generic question about
  // an operational area (or a hallucinated claim the verifier should reject)
  // is not itself a private record disclosure.
  const containsSensitiveEvidence = evidence.sources.some((source) =>
    classifySensitiveText(`${source.title} ${source.excerpt}`).length > 0,
  );
  if (
    containsKnownIdentifier ||
    containsSensitiveUserText ||
    containsSensitiveEvidence ||
    UNREDACTED_EXTERNAL_IDENTIFIER.some((pattern) => pattern.test(payload))
  ) {
    throw unavailable(stage, "sensitive_external_disclosure_blocked");
  }
}

function verifierPrompt(
  paragraphs: readonly { text: string; sourceIds: string[]; kind: string }[],
  evidence: CaseExplainabilityEvidence,
): string {
  const byId = new Map(evidence.sources.map((item) => [item.id, item]));
  return paragraphs.map((paragraph, index) => verificationParagraphTemplate(index, paragraph.text,
    paragraph.sourceIds.flatMap((id) => {
      const item = byId.get(id);
      return item
        ? [`[SOURCE ${item.id}]`, `title=${item.title}`, `excerpt=${item.excerpt}`]
        : [];
    }),
  )).join("\n\n");
}

type ExplainabilityParagraph = {
  text: string;
  sourceIds: string[];
  kind: "supported" | "not-recorded";
};

function parseParagraphs(
  raw: unknown,
  evidence: CaseExplainabilityEvidence,
): ExplainabilityParagraph[] {
  if (!isPlainRecord(raw) || !hasOnlyKeys(raw, ["paragraphs"]) || !Array.isArray(raw.paragraphs)) {
    throw unavailable("generation", "response_schema_invalid");
  }

  const knownSourceIds = new Set(evidence.sources.map((item) => item.id));
  if (raw.paragraphs.length < 1 || raw.paragraphs.length > 12) {
    throw unavailable("generation", "response_schema_invalid");
  }
  return raw.paragraphs.map((candidate) => {
    if (!isPlainRecord(candidate) || !hasOnlyKeys(candidate, ["text", "sourceIds", "kind"])) {
      throw unavailable("generation", "response_schema_invalid");
    }
    const text = typeof candidate.text === "string"
      ? redactExplainabilityText(candidate.text, evidence.redactionIdentifiers).trim()
      : "";
    const sourceIds = candidate.sourceIds;
    const kind = candidate.kind;
    if (
      !text ||
      text.length > 1500 ||
      !Array.isArray(sourceIds) ||
      sourceIds.length > 12 ||
      sourceIds.some((id) => typeof id !== "string" || id.length < 1 || id.length > 160) ||
      !sourceIds.every((id) => knownSourceIds.has(id)) ||
      (kind !== "supported" && kind !== "not-recorded") ||
      (kind === "supported" && sourceIds.length === 0) ||
      (kind === "not-recorded" && sourceIds.length !== 0)
    ) {
      throw unavailable("generation", "response_schema_invalid");
    }
    return { text, sourceIds, kind };
  });
}

async function verifySupportedParagraphs(
  paragraphs: ExplainabilityParagraph[],
  evidence: CaseExplainabilityEvidence,
  complete: ExplainabilityCompletion,
  signal: AbortSignal,
): Promise<ExplainabilityParagraph[]> {
  const supported = paragraphs.filter((paragraph) => paragraph.kind === "supported");
  if (supported.length === 0) return paragraphs;
  if (signal.aborted) throw unavailable("verification", "request_aborted");
  const prompt = verifierPrompt(supported, evidence);
  assertExternalLlmDisclosureAllowed("verification", prompt, evidence);

  let raw: unknown | null;
  try {
    raw = await complete(
      VERIFIER_SYSTEM_PROMPT,
      prompt,
      700,
      signal,
      "verification",
    );
  } catch (error) {
    if (error instanceof ExplainabilityUnavailableError) throw error;
    if (error instanceof ExplainabilityCompletionError) {
      throw new ExplainabilityUnavailableError(undefined, error.metadata);
    }
    throw unavailable("verification", "request_failed");
  }
  if (!isPlainRecord(raw) || !hasOnlyKeys(raw, ["verdicts"]) || !Array.isArray(raw.verdicts)) {
    throw unavailable("verification", "response_schema_invalid");
  }
  if (raw.verdicts.length !== supported.length) {
    throw unavailable("verification", "response_schema_invalid");
  }
  const verdicts = new Map<number, boolean>();
  for (const verdict of raw.verdicts) {
    const index = verdict && typeof verdict === "object" && "index" in verdict
      ? verdict.index
      : undefined;
    const supportedValue = verdict && typeof verdict === "object" && "supported" in verdict
      ? verdict.supported
      : undefined;
    if (
      !isPlainRecord(verdict) ||
      !hasOnlyKeys(verdict, ["index", "supported"]) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= supported.length ||
      typeof supportedValue !== "boolean" ||
      verdicts.has(index)
    ) {
      throw unavailable("verification", "response_schema_invalid");
    }
    verdicts.set(index, supportedValue);
  }
  if (verdicts.size !== supported.length) {
    throw unavailable("verification", "response_schema_invalid");
  }

  let supportedIndex = 0;
  return paragraphs.map((paragraph) => {
    if (paragraph.kind !== "supported") return paragraph;
    const verified = verdicts.get(supportedIndex);
    supportedIndex += 1;
    if (verified) return paragraph;
    return {
      text: NOT_RECORDED_TEXT,
      sourceIds: [],
      kind: "not-recorded",
    };
  });
}

/**
 * Validate model paragraphs, verify each supported claim against only its
 * cited excerpts, then attach only server-owned metadata.
 */
export async function explainCase(
  caseRow: ProviderGovernanceCase,
  question: string,
  history: readonly { role: "user" | "assistant"; content: string }[] | undefined,
  evidence: CaseExplainabilityEvidence,
  complete: ExplainabilityCompletion = defaultCompletion(caseRow),
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPLAINABILITY_DEADLINE_MS);
  try {
    const prompt = buildUserPrompt(question, history, evidence);
    assertExternalLlmDisclosureAllowed(
      "generation",
      prompt,
      evidence,
      [question, ...(history ?? []).map((entry) => entry.content)],
    );
    const raw = await complete(
      SYSTEM_PROMPT,
      prompt,
      1100,
      controller.signal,
      "generation",
      evidence.sources.map((item) => item.id),
    );
    if (controller.signal.aborted || raw === null) {
      throw unavailable("generation", controller.signal.aborted ? "request_aborted" : "empty_response");
    }
    const paragraphs = parseParagraphs(raw, evidence);
    const verifiedParagraphs = await verifySupportedParagraphs(
      paragraphs,
      evidence,
      complete,
      controller.signal,
    );
    if (controller.signal.aborted) {
      throw unavailable("verification", "request_aborted");
    }

    const candidate = {
      asOf: evidence.asOf,
      paragraphs: verifiedParagraphs,
      sources: evidence.sources,
      limitations: evidence.limitations.slice(0, 20),
      truncated: evidence.truncated,
    };
    const parsed = ExplainOnboardingCaseResponse.safeParse(candidate);
    if (!parsed.success) {
      throw unavailable("generation", "response_schema_invalid");
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof ExplainabilityUnavailableError) throw error;
    if (error instanceof ExplainabilityCompletionError) {
      throw new ExplainabilityUnavailableError(undefined, error.metadata);
    }
    throw new ExplainabilityUnavailableError(undefined, {
      stage: "generation",
      code: "request_failed",
    });
  } finally {
    clearTimeout(timer);
  }
}