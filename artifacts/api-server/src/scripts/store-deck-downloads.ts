import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { getPrivateFile } from "../lib/objectStorage";

// Explicit maintenance command, never an application startup side effect.
// Only public application-authored deck bytes are eligible for these fixed paths.
for (const format of ["pdf", "pptx"] as const) {
  const input = process.argv[format === "pdf" ? 2 : 3];
  if (!input) throw new Error("Provide the reviewed PDF and PPTX export paths.");
  const bytes = await readFile(input);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const objectPath = `/objects/public-downloads/hro-architecture/${hash}.${format}`;
  await getPrivateFile(objectPath).save(bytes, {
    resumable: false,
    metadata: { contentType: format === "pdf" ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
    preconditionOpts: { ifGenerationMatch: 0 },
  });
  process.stdout.write(JSON.stringify({ format, objectPath, bytes: bytes.length }) + "\n");
}
