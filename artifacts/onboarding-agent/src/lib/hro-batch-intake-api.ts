import { customFetch, createHroBatchUpload, validateHroBatchUpload } from '@workspace/api-client-react';
import type { HroBatchCaseInput, HroBatchHistoryItem, HroBatchResult, HroBatchTemplate, HroBatchValidation } from '@workspace/api-client-react';

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 500;
const base = '/api/onboarding/batch-upload';

export const hroBatchTemplatesKey = (scope: string) => ['onboarding', 'hro-batch', scope, 'templates'] as const;
export const hroBatchHistoryKey = (scope: string) => ['onboarding', 'hro-batch', scope, 'history'] as const;
export const hroBatchHistoryPrefix = (scope: string) => ['onboarding', 'hro-batch', scope] as const;

export const listHroBatchTemplates = (options?: RequestInit) =>
  customFetch<HroBatchTemplate[]>(`${base}/templates`, { ...options, method: 'GET', responseType: 'json' });
export const listHroBatchHistory = (options?: RequestInit) =>
  customFetch<HroBatchHistoryItem[]>(`${base}/history`, { ...options, method: 'GET', responseType: 'json' });
export function downloadHroBatchTemplate(templateId: string, format: 'csv' | 'xlsx') {
  return customFetch<Blob>(`${base}/templates/${encodeURIComponent(templateId)}/download?format=${format}`, { method: 'GET', responseType: 'blob' });
}
export const validateHroBatchFile = (file: File, template: HroBatchTemplate, signal?: AbortSignal): Promise<HroBatchValidation> =>
  validateHroBatchUpload({ file, templateId: template.id, templateVersion: template.version }, { signal });
export const createHroBatch = (input: HroBatchCaseInput, signal?: AbortSignal): Promise<HroBatchResult> =>
  createHroBatchUpload(input, { signal });

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV cell with formula-injection neutralisation. */
function cell(value: string | number) {
  let s = String(value);
  if (/^\s*[=+\-@]|^[\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export function issuesToCsv(issues: HroBatchValidation['issues']) {
  return ['row,column,message', ...issues.map((i) => [i.row, i.column, i.message].map(cell).join(','))].join('\r\n');
}
