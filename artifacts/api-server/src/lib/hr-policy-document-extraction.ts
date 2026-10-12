import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const POLICY_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const POLICY_DOCUMENT_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
} as const;
export type PolicyDocumentFormat = keyof typeof POLICY_DOCUMENT_TYPES;

export function policyDocumentFormat(filename: string, mediaType: string, bytes: Buffer): PolicyDocumentFormat {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (!extension || !(extension in POLICY_DOCUMENT_TYPES) || !bytes.length || bytes.length > POLICY_IMPORT_MAX_BYTES) {
    throw new Error("Choose a PDF, DOCX or DOC file up to 10 MiB.");
  }
  const format = extension as PolicyDocumentFormat;
  if (mediaType !== POLICY_DOCUMENT_TYPES[format]) throw new Error("File type does not match its extension.");
  const valid = format === "pdf" ? bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
    : format === "docx" ? bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]))
    : bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"));
  if (!valid) throw new Error("File bytes do not match the declared document type.");
  return format;
}

export function extractPolicyDocument(bytes: Buffer, format: PolicyDocumentFormat): Promise<{ text: string; extractor: string; warnings: string[] }> {
  const sibling = fileURLToPath(new URL("../policy-extract-worker.mjs", import.meta.url));
  const worker = existsSync(sibling) ? sibling : resolve(process.cwd(), "policy-extract-worker.mjs");
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=192", worker, format], {
      stdio: ["pipe", "pipe", "ignore"],
      // Parsers must never inherit app database/provider credentials.
      env: { PATH: process.env.PATH, HOME: "/tmp" },
    });
    let output = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (error) { reject(error); return; }
      try {
        const result = JSON.parse(output.toString("utf8"));
        if (typeof result.text !== "string" || !result.text.trim() || result.text.length > 40000 ||
            typeof result.extractor !== "string" || !Array.isArray(result.warnings)) throw new Error("Invalid extraction");
        resolveResult(result);
      } catch { reject(new Error("Extraction failed")); }
    };
    const timer = setTimeout(() => finish(new Error("Extraction timed out")), 20000);
    child.on("error", () => finish(new Error("Extraction unavailable")));
    child.stdin.on("error", () => finish(new Error("Extraction failed")));
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 256 * 1024) finish(new Error("Extraction exceeds limits"));
      else output = Buffer.concat([output, chunk]);
    });
    child.on("close", (code) => finish(code === 0 ? undefined : new Error("Document is unsupported, unsafe, encrypted, empty, or exceeds extraction limits")));
    child.stdin.end(bytes);
  });
}
