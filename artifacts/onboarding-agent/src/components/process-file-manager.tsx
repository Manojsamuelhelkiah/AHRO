import * as React from "react";
import {
  createScenarioFileUploadIntent,
  deleteScenarioFile,
  downloadScenarioFile,
  finalizeScenarioFile,
  getListScenarioFilesQueryKey,
  useListScenarioFiles,
  type ScenarioFile,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Replace, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui-shared";
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@clerk/react";
import {
  applyProcessFileMutation,
  processFileContentType,
  type ProcessFileMutation,
} from "./process-file-utils";

function uploadPut(url: string, file: File, token: string, progress: (value: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => event.lengthComputable && progress(Math.round(event.loaded * 100 / event.total));
    xhr.onerror = () => reject(new Error("Secure storage could not be reached."));
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300
      ? resolve() : reject(new Error(`Secure storage rejected the upload (HTTP ${xhr.status}).`));
    xhr.send(file);
  });
}

function validateFile(file: File): { contentType: string } | { error: string } {
  const contentType = processFileContentType(file.name);
  if (!contentType) return { error: "Choose a JSON, CSV, TXT, MD, PDF, DOCX, BPMN, or XML file." };
  if (file.size < 1 || file.size > 10 * 1024 * 1024) return { error: "Files must be between 1 byte and 10 MB." };
  return { contentType };
}

export function ProcessFileManager({
  scenarioId,
  files,
  onFilesChange,
  onPendingChange,
}: {
  scenarioId?: number;
  files: ScenarioFile[];
  onFilesChange: (files: ScenarioFile[]) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const filesRef = React.useRef(files);
  const onFilesChangeRef = React.useRef(onFilesChange);
  const onPendingChangeRef = React.useRef(onPendingChange);
  const [progress, setProgress] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [replacing, setReplacing] = React.useState<number | null>(null);
  const [mutationPending, setMutationPending] = React.useState(false);
  const { data: persisted } = useListScenarioFiles(scenarioId ?? 0, {
    query: { enabled: Boolean(scenarioId), queryKey: getListScenarioFilesQueryKey(scenarioId ?? 0) },
  });

  filesRef.current = files;
  onFilesChangeRef.current = onFilesChange;
  onPendingChangeRef.current = onPendingChange;
  const setPending = React.useCallback((pending: boolean) => {
    setMutationPending(pending);
    onPendingChangeRef.current?.(pending);
  }, []);
  const replaceFiles = React.useCallback((next: ScenarioFile[]) => {
    filesRef.current = next;
    onFilesChangeRef.current(next);
    if (scenarioId) {
      queryClient.setQueryData(getListScenarioFilesQueryKey(scenarioId), next);
    }
  }, [queryClient, scenarioId]);
  const mutateFiles = React.useCallback((mutation: ProcessFileMutation) => {
    replaceFiles(applyProcessFileMutation(filesRef.current, mutation));
  }, [replaceFiles]);

  React.useEffect(() => {
    if (persisted && !mutationPending) {
      replaceFiles(persisted);
    }
  }, [persisted, mutationPending, replaceFiles]);

  const pick = (replaceId?: number) => {
    setReplacing(replaceId ?? null);
    inputRef.current?.click();
  };
  const upload = async (file: File) => {
    const validation = validateFile(file);
    if ("error" in validation) { setError(validation.error); return; }
    const replaceId = replacing;
    setPending(true); setError(null); setProgress(0);
    try {
      const intent = await createScenarioFileUploadIntent({ name: file.name, contentType: validation.contentType, size: file.size });
      const token = await getToken();
      if (!token) throw new Error("Sign in again before uploading.");
      await uploadPut(intent.uploadUrl, file, token, setProgress);
      const finalized = await finalizeScenarioFile({
        objectPath: intent.objectPath, name: file.name, contentType: validation.contentType, size: file.size,
        ...(scenarioId ? { scenarioId } : {}),
        ...(replaceId ? { replaceFileId: replaceId } : {}),
      });
      mutateFiles(replaceId
        ? { kind: "replace", id: replaceId, file: finalized }
        : { kind: "add", file: finalized });
      setReplacing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed.");
    } finally {
      setPending(false);
      setProgress(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  };
  const remove = async (file: ScenarioFile) => {
    setPending(true);
    try { await deleteScenarioFile(file.id); mutateFiles({ kind: "remove", id: file.id }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not remove the file."); }
    finally { setPending(false); }
  };
  const download = async (file: ScenarioFile) => {
    try {
      const blob = await downloadScenarioFile(file.id, { responseType: "blob" } as RequestInit & { responseType: "blob" });
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
      anchor.href = url; anchor.download = file.originalName; anchor.click(); URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not download the file."); }
  };

  return <div className="space-y-3">
    <div className="flex items-center justify-between gap-3">
      <div><h3 className="text-sm font-semibold text-[var(--text-primary)]">Client flow files</h3><p className="text-[11px] text-[var(--text-muted)]">Private process definitions, up to 10 MB each.</p></div>
      <Button type="button" variant="outline" size="sm" disabled={mutationPending} onClick={() => pick()}><Upload className="mr-1 h-4 w-4" />Add file</Button>
    </div>
    <input ref={inputRef} className="sr-only" type="file" accept=".json,.csv,.txt,.md,.pdf,.docx,.bpmn,.xml" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
    {progress !== null && <><Progress value={progress} aria-label={`Upload ${progress}% complete`} /><p className="text-xs text-[var(--text-muted)]">Uploading {progress}%…</p></>}
    {error && <p role="alert" className="text-xs text-[var(--status-red-fg)]">{error}</p>}
    {files.length > 0 && <div className="divide-y rounded-[var(--radius-md)] border border-[var(--border)]">
      {files.map((file) => <div className="flex items-center gap-2 p-2 text-xs" key={file.id}>
        <FileText className="h-4 w-4 shrink-0 text-[var(--primary)]" /><span className="min-w-0 flex-1 truncate font-medium">{file.originalName}</span>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => void download(file)} aria-label={`Download ${file.originalName}`}><Download className="h-3.5 w-3.5" /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={mutationPending} onClick={() => pick(file.id)} aria-label={`Replace ${file.originalName}`}><Replace className="h-3.5 w-3.5" /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-[var(--status-red-fg)]" disabled={mutationPending} onClick={() => void remove(file)} aria-label={`Remove ${file.originalName}`}><Trash2 className="h-3.5 w-3.5" /></Button>
      </div>)}
    </div>}
    {!scenarioId && files.length === 0 && <p className="text-[11px] text-[var(--text-muted)]">Upload is required for hybrid and custom process adoption.</p>}
  </div>;
}