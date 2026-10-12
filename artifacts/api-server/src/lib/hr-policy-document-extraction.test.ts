import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPolicyDocument, policyDocumentFormat } from "./hr-policy-document-extraction";

// Small, original, non-personal fixtures. No binary documents checked into Git.
export function policyPdfFixture(text = "Fictional leave policy grants five days.") {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

// ZIP entries are stored rather than compressed, making both size and CRC
// deterministic without introducing another document-generator dependency.
export function policyDocxFixture(external = false, oversized = false) {
  const entries = [
    ["[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ["word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Fictional leave policy grants five days.</w:t></w:r></w:p></w:body></w:document>'],
    ["word/_rels/document.xml.rels", external
      ? '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="x" Target="https://example.invalid" TargetMode="External"/></Relationships>'
      : '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'],
  ];
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name!), data = Buffer.from(value!);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(oversized ? 40 * 1024 * 1024 : data.length, 24);
    directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename); offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test("real isolated PDF and DOCX parsers return plain reviewable text", async () => {
  for (const [format, bytes] of [["pdf", policyPdfFixture()], ["docx", policyDocxFixture()]] as const) {
    const result = await extractPolicyDocument(bytes, format);
    assert.match(result.text, /Fictional leave policy grants five days/);
    assert.ok(result.warnings.length);
  }
});
test("active PDF content, external Word relationships, ZIP bombs and malformed documents fail closed", async () => {
  await assert.rejects(() => extractPolicyDocument(Buffer.concat([policyPdfFixture(), Buffer.from("\n/OpenAction 2 0 R")]), "pdf"));
  await assert.rejects(() => extractPolicyDocument(policyDocxFixture(true), "docx"));
  await assert.rejects(() => extractPolicyDocument(policyDocxFixture(false, true), "docx"));
  await assert.rejects(() => extractPolicyDocument(Buffer.from("%PDF-1.4 broken"), "pdf"));
  await assert.rejects(() => extractPolicyDocument(Buffer.from("d0cf11e0a1b11ae1", "hex"), "doc"));
  assert.equal(policyDocumentFormat("source.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", policyDocxFixture()), "docx");
});
