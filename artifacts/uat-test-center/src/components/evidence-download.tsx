import { useState } from "react";
import { customFetch } from "@workspace/api-client-react";

/** Uses current admission/tenant headers, unlike a navigation to a raw API URL. */
export function EvidenceDownload({ path, filename, label = "Restricted evidence" }: {
  path: string; filename: string; label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function download() {
    setBusy(true); setError(null);
    try {
      const blob = await customFetch<Blob>(path, { responseType: "blob" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = filename; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError("Evidence is unavailable. Current workspace admission and record access are required."); }
    finally { setBusy(false); }
  }
  return <span className="ml-3 inline-block">
    <button type="button" className="underline disabled:opacity-50" disabled={busy} onClick={download}>
      {busy ? "Loading evidence…" : label}
    </button>
    {error && <span role="alert" className="block text-sm">{error}</span>}
  </span>;
}
