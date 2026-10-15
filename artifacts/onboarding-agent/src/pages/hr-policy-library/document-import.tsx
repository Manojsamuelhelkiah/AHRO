import { useEffect, useRef, useState } from "react";
import { customFetch, type HrPolicyImportPreview, type HrPolicyImportProvenance } from "@workspace/api-client-react";

const mediaTypes: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
};

export function PolicyDocumentImport({ onExtracted, onBusy, onClear, onBlocked }: {
  onExtracted: (text: string, importId: string, filename: string) => void;
  onBusy: (busy: boolean) => void;
  onClear: () => void;
  onBlocked: () => void;
}) {
  const [preview, setPreview] = useState<HrPolicyImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function upload(file?: File) {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!mediaTypes[extension] || file.size === 0 || file.size > 10 * 1024 * 1024) {
      setError("Select a PDF, DOCX or DOC file up to 10 MiB."); return;
    }
    setBusy(true); onBusy(true); setError("");
    try {
      const body = new FormData();
      // Browsers sometimes omit a DOC MIME type. The server verifies bytes
      // and extension independently; never trust this browser declaration.
      body.append("file", new Blob([file], { type: mediaTypes[extension] }), file.name);
      const result = await customFetch<HrPolicyImportPreview>("/api/policies/imports", {
        method: "POST", body, credentials: "include", responseType: "json",
      });
      if (!alive.current) return;
      setPreview(result);
      if (result.status === "ready" && result.text) onExtracted(result.text, result.importId, result.filename);
      else onBlocked();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      if (alive.current) { setBusy(false); onBusy(false); }
    }
  }
  async function discard() {
    if (!preview) return;
    setBusy(true); onBusy(true); setError("");
    try {
      await customFetch(`/api/policies/imports/${preview.importId}`, { method: "DELETE", credentials: "include", responseType: "json" });
      if (alive.current) { setPreview(null); onClear(); }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "Unable to discard source.");
    } finally {
      if (alive.current) { setBusy(false); onBusy(false); }
    }
  }
  return <section className="rounded-lg border bg-slate-50 p-3 space-y-2" aria-label="Import policy document">
    <label className="block text-sm font-semibold">
       Choose PDF or Word policy
      <input className="block mt-2 text-sm w-full" type="file" accept=".pdf,.docx,.doc"
        disabled={busy || Boolean(preview)} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
    </label>
    <p className="text-xs text-slate-600">Maximum 10 MiB / 200 PDF pages / 40,000 extracted characters. Text-based documents only; no OCR. Check the title, dates and audience before uploading.</p>
    {busy && <p role="status" className="text-sm">Processing private document…</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {preview && <div className="text-xs space-y-1">
      <p className="font-semibold">{preview.filename} · {preview.byteSize.toLocaleString()} bytes · {preview.status}</p>
      <p>Uploaded {new Date(preview.uploadedAt).toLocaleString()} · Malware result: {preview.malwareVerdict}</p>
      <p className="break-all">SHA-256: {preview.sha256}</p>
      {preview.extractor && <p>Extractor: {preview.extractor}</p>}
      <p className="font-semibold">{preview.status === 'ready' ? 'File checks complete. Client Setup determines whether saving this upload approves it immediately or sends it for a separate review.' : 'File checks have not completed successfully.'}</p>
      {preview.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
      {preview.status === "quarantined" && <p role="alert" className="text-red-700">
        Source quarantined: unsafe, unavailable scanner, or extraction failure. No source text can be used. Discard it before continuing with pasted text.
      </p>}
      <button type="button" disabled={busy} className="underline font-semibold"
        onClick={() => void discard()}>Discard unattached source and extracted text</button>
    </div>}
  </section>;
}

export function PolicySourceProvenance({ provenance }: { provenance?: HrPolicyImportProvenance | null }) {
  if (!provenance) return null;
  return <section aria-label="Imported source provenance" className="rounded-lg border bg-slate-50 p-3 text-xs space-y-1 mb-4">
    <h3 className="font-semibold text-sm">Imported source provenance</h3>
    <p>{provenance.filename} · {provenance.mediaType} · {provenance.byteSize.toLocaleString()} bytes</p>
    <p>Uploaded {new Date(provenance.uploadedAt).toLocaleString()} · {provenance.extractor}</p>
    <p className="break-all">Source SHA-256: {provenance.sha256}</p>
    <p className="break-all">Original extraction SHA-256: {provenance.extractedTextSha256}</p>
    <p>File safety check: {provenance.malware}. Original source and uploader are recorded.</p>
    {provenance.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
    <p>Source bytes remain private. Uploaded versions follow this client's configured approval process.</p>
  </section>;
}
