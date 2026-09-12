import { dkimVerify, type DNSResolver } from "mailauth";

/**
 * This symbol is intentionally private. A remote-email decision can only carry
 * this value after this module has verified the raw RFC822 message; callers
 * cannot substitute a boolean or a parsed Gmail header for that proof.
 */
const verifiedGmailDkimBrand = Symbol("verifiedGmailDkim");

export type VerifiedGmailDkimTransport = Readonly<{
  readonly fromAddress: string;
  readonly signingDomain: string;
  readonly sourceMessageId: string;
  /** The signed body token this proof is bound to. */
  readonly approvalReference: string;
  /** The parsed decision whose source text was verified in that signed body. */
  readonly decision: "approved" | "rejected";
  readonly [verifiedGmailDkimBrand]: true;
}>;

type Header = { name: string; value: string };

function normalizedAddress(value: string): string | null {
  const trimmed = value.trim();
  const bracketed = trimmed.match(/^(?:[^<>,]*\s)?<([^<>\s@]+@[^<>\s@]+)>$/);
  const address = (bracketed?.[1] ?? (/^[^<>,\s@]+@[^<>,\s@]+$/.test(trimmed) ? trimmed : ""))
    .toLowerCase();
  return /^[^@]+@[^@]+\.[^@]+$/.test(address) ? address : null;
}

function rawHeaders(rawMessage: string): Header[] | null {
  const separator = rawMessage.match(/\r?\n\r?\n/);
  if (!separator || separator.index === undefined) return null;
  const source = rawMessage.slice(0, separator.index).replace(/\r?\n[ \t]+/g, " ");
  const headers: Header[] = [];
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([^:\s]+):\s*(.*)$/);
    if (!match) return null;
    headers.push({ name: match[1], value: match[2] });
  }
  return headers;
}

function rawBody(rawMessage: string): string | null {
  const separator = rawMessage.match(/\r?\n\r?\n/);
  if (!separator || separator.index === undefined) return null;
  return rawMessage.slice(separator.index + separator[0].length);
}

function tagValue(value: string, name: string): string | null {
  const match = value.match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*([^;]+)`, "i"));
  return match?.[1]?.trim() ?? null;
}

function signatureCoversFromSubjectAndFullBody(value: string, domain: string, selector: string | undefined): boolean {
  const signingDomain = tagValue(value, "d")?.toLowerCase();
  const signingSelector = tagValue(value, "s");
  const signedHeaders = tagValue(value, "h")?.toLowerCase().split(":").map((name) => name.trim());
  // `l=` permits only a prefix of the body to be authenticated. It is never
  // acceptable for an authorization-bearing decision.
  const hasBodyLength = /(?:^|;)\s*l\s*=/i.test(value);
  return signingDomain === domain &&
    (!selector || signingSelector === selector) &&
    !hasBodyLength &&
    signedHeaders?.includes("from") === true &&
    signedHeaders?.includes("subject") === true;
}

function signatureBytes(value: string): string | null {
  const signature = tagValue(value, "b");
  return signature ? signature.replace(/\s/g, "") : null;
}

function verifiedDkimSignature(
  rawMessage: string,
  headers: Header[],
  expectedDomain: string,
  result: Awaited<ReturnType<typeof dkimVerify>>,
): { signingDomain: string } | null {
  const dkimHeaders = headers.filter((entry) => entry.name.toLowerCase() === "dkim-signature");
  for (const signature of result.results) {
    const domain = signature.signingDomain?.toLowerCase();
    // mailauth exposes the parsed b= value at runtime, though the package's
    // older declaration omits it. Match it to the specific raw header so an
    // injected, invalid DKIM-Signature with the same d=/s= cannot lend its h=
    // policy to a different passing signature.
    const signatureValue = (signature as typeof signature & { signature?: string }).signature
      ?.replace(/\s/g, "");
    if (
      signature.status.result !== "pass" ||
      domain !== expectedDomain ||
      !signature.status.aligned ||
      !signatureValue
    ) continue;
    if (dkimHeaders.some((entry) =>
      signatureBytes(entry.value) === signatureValue &&
      signatureCoversFromSubjectAndFullBody(entry.value, expectedDomain, signature.selector),
    )) {
      return { signingDomain: domain };
    }
  }
  return null;
}

/**
 * Verify Gmail's raw RFC822 source using DNS-published DKIM key material.
 *
 * Authentication-Results is deliberately not parsed: it is only a received
 * header and an attacker can inject it. The decision text and AP reference
 * must both occur in the fully DKIM-signed body, and From/Subject must be in
 * the signature's h= list. `resolver` exists only for deterministic tests;
 * production uses mailauth's DNS resolver.
 */
export async function verifyGmailApprovalTransport(input: {
  rawMessage: string;
  sourceMessageId: string;
  expectedFromAddress: string;
  expectedReference: string;
  expectedDecisionText: string;
  expectedDecision: "approved" | "rejected";
  resolver?: DNSResolver;
}): Promise<VerifiedGmailDkimTransport | null> {
  const expectedAddress = normalizedAddress(input.expectedFromAddress);
  const expectedDomain = expectedAddress?.split("@")[1];
  const headers = rawHeaders(input.rawMessage);
  const body = rawBody(input.rawMessage);
  if (
    !expectedAddress ||
    !expectedDomain ||
    !headers ||
    !body ||
    !input.expectedReference ||
    !input.expectedDecisionText.trim()
  ) return null;

  const fromHeaders = headers.filter((entry) => entry.name.toLowerCase() === "from");
  const subjectHeaders = headers.filter((entry) => entry.name.toLowerCase() === "subject");
  // RFC 5322 permits one From field for this workflow. Reject multiple
  // mailboxes/fields rather than attempting to choose an identity. Subject is
  // also singleton, so Gmail's parsed decision reference cannot select an
  // unsigned duplicate while a different Subject was signed.
  if (
    fromHeaders.length !== 1 ||
    subjectHeaders.length !== 1 ||
    normalizedAddress(fromHeaders[0].value) !== expectedAddress
  ) return null;

  const normalizedBody = body.replace(/\r\n/g, "\n");
  const expectedText = input.expectedDecisionText.trim().replace(/\r\n/g, "\n");
  if (!normalizedBody.includes(input.expectedReference) || !normalizedBody.includes(expectedText)) return null;

  try {
    const result = await dkimVerify(input.rawMessage, {
      minBitLength: 2048,
      ...(input.resolver ? { resolver: input.resolver } : {}),
    });
    const verified = verifiedDkimSignature(input.rawMessage, headers, expectedDomain, result);
    if (!verified) return null;
    return Object.freeze({
      fromAddress: expectedAddress,
      signingDomain: verified.signingDomain,
      sourceMessageId: input.sourceMessageId,
      approvalReference: input.expectedReference,
      decision: input.expectedDecision,
      [verifiedGmailDkimBrand]: true as const,
    });
  } catch {
    // DNS, signature, and parser errors are all authorization failures.
    return null;
  }
}

/** Runtime guard used at the write boundary as well as at email intake. */
export function isVerifiedGmailDkimTransport(
  value: unknown,
  input: {
    fromAddress: string;
    sourceMessageId: string;
    approvalReference: string;
    decision: "approved" | "rejected";
  },
): value is VerifiedGmailDkimTransport {
  const expectedAddress = normalizedAddress(input.fromAddress);
  return Boolean(
    expectedAddress &&
    value &&
    typeof value === "object" &&
    (value as VerifiedGmailDkimTransport)[verifiedGmailDkimBrand] === true &&
    (value as VerifiedGmailDkimTransport).fromAddress === expectedAddress &&
    (value as VerifiedGmailDkimTransport).sourceMessageId === input.sourceMessageId &&
    (value as VerifiedGmailDkimTransport).approvalReference === input.approvalReference &&
    (value as VerifiedGmailDkimTransport).decision === input.decision,
  );
}