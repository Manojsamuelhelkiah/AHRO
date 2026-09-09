import type { ScenarioFile } from "@workspace/api-client-react";

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  json: "application/json",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  bpmn: "application/xml",
  xml: "application/xml",
};

export function processFileContentType(name: string): string | null {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? null;
}

export type ProcessFileMutation =
  | { kind: "add"; file: ScenarioFile }
  | { kind: "replace"; id: number; file: ScenarioFile }
  | { kind: "remove"; id: number };

export function applyProcessFileMutation(
  current: ScenarioFile[],
  mutation: ProcessFileMutation,
): ScenarioFile[] {
  if (mutation.kind === "remove") {
    return current.filter((file) => file.id !== mutation.id);
  }
  if (mutation.kind === "replace") {
    return current.map((file) => file.id === mutation.id ? mutation.file : file);
  }
  return current.some((file) => file.id === mutation.file.id)
    ? current
    : [...current, mutation.file];
}