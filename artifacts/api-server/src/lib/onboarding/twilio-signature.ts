import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Validate a Twilio webhook signature: HMAC-SHA1 (base64) of the full
 * request URL concatenated with the POST params sorted by key, keyed with
 * the account auth token. https://www.twilio.com/docs/usage/security
 */
export function twilioSignatureValid(opts: {
  token: string | undefined;
  signature: string | undefined;
  url: string;
  params: Record<string, string>;
}): boolean {
  if (!opts.token || !opts.signature) return false;
  const data =
    opts.url +
    Object.keys(opts.params)
      .sort()
      .map((k) => k + opts.params[k])
      .join("");
  const expected = createHmac("sha1", opts.token).update(data, "utf8").digest("base64");
  const a = Buffer.from(opts.signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
