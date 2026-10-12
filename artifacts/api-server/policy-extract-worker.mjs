// Untrusted parsers run in a short-lived process with bounded heap and output.
// No provider calls, remote resources, rendering, or macros are executed.
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import yauzl from "yauzl";

const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 10 * 1024 * 1024) throw new Error("File too large");
  chunks.push(chunk);
}
const bytes = Buffer.concat(chunks);
const format = process.argv[2];
let text;
let extractor;
const warnings = ["Extraction may omit formatting, tables, images, headers or footnotes. Compare with the authoritative source; no OCR or authenticity verification is performed."];
if (format === "pdf") {
  // Structural active-content rejection is an additional precaution, not AV.
  if (/\/(?:JavaScript|JS|Launch|EmbeddedFile|OpenAction|AA)\b/.test(bytes.toString("latin1"))) {
    throw new Error("Active PDF content is not supported");
  }
  const parser = new PDFParse({ data: bytes });
  try {
    const info = await parser.getInfo();
    if (info.total > 200) throw new Error("Too many pages");
    text = (await parser.getText()).text;
    extractor = "pdf-parse/text-v1";
  } finally { await parser.destroy(); }
} else if (format === "docx") {
  // Inspect the central directory BEFORE any decompression. Reject oversized,
  // encrypted, macro/embedded-object and external-relationship containers.
  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error || new Error("Invalid Word container"));
      let count = 0;
      let expanded = 0;
      let hasDocument = false;
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; zip.close(); reject(e); } };
      zip.on("error", fail);
      zip.on("entry", (entry) => {
        expanded += entry.uncompressedSize;
        hasDocument ||= entry.fileName === "word/document.xml";
        if (++count > 2000 || expanded > 30 * 1024 * 1024 || (entry.generalPurposeBitFlag & 1) ||
            /(?:vbaProject|embeddings\/|activeX\/)/i.test(entry.fileName)) {
          fail(new Error("Unsafe or oversized Word container")); return;
        }
        // Relationship and content-type metadata are small, bounded text.
        if (/\.rels$|\[Content_Types\]\.xml$/.test(entry.fileName)) {
          if (entry.uncompressedSize > 512 * 1024) return fail(new Error("Oversized metadata"));
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) return fail(e || new Error("Invalid metadata"));
            const parts = [];
            let length = 0;
            stream.on("error", fail);
            stream.on("data", (chunk) => {
              length += chunk.length;
              if (length > 512 * 1024) { stream.destroy(); fail(new Error("Oversized metadata")); }
              else parts.push(chunk);
            });
            stream.on("end", () => {
              if (settled) return;
              const value = Buffer.concat(parts).toString("utf8");
              if (/TargetMode\s*=\s*["']External|macroEnabled|vbaProject/i.test(value)) return fail(new Error("Active or external Word content"));
              zip.readEntry();
            });
          });
        } else zip.readEntry();
      });
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        hasDocument ? resolve() : reject(new Error("Missing Word document"));
      });
      zip.readEntry();
    });
  });
  const result = await mammoth.extractRawText({ buffer: bytes });
  text = result.value;
  if (result.messages.length) warnings.push("Word parser reported unsupported content; check the original carefully.");
  extractor = "mammoth/raw-text-v1";
} else if (format === "doc") {
  // Legacy binary documents are never rendered or executed.
  text = (await new WordExtractor().extract(bytes)).getBody();
  extractor = "word-extractor/body-v1";
  warnings.push("Legacy Word extraction includes body text only. Convert to DOCX if content is missing.");
} else throw new Error("Unsupported document");
text = text.replace(/\u0000/g, "").trim();
if (!text || text.length > 40000) throw new Error("Empty or oversized extracted text; scanned PDFs require OCR outside this importer");
process.stdout.write(JSON.stringify({ text, extractor, warnings }));
