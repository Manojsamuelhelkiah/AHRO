import { useState } from 'react';
import type { HroEmailReadiness } from '@workspace/api-client-react';
import { CopyButton } from './common';

type RegisteredTemplate = HroEmailReadiness['templates'][number];
export const fictionalNotice = 'Fictional example only. Replace all sample values with supplied, reviewed facts before sending. Leave unknown optional fields blank.';
const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** Only registered keys and static example values; never use request/source data. */
export function templateCopyFormats({ template, example }: RegisteredTemplate) {
  const values = new Map(example.split(/\r?\n/).map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon), line.slice(colon + 1).trim()];
  }));
  const rows = template.columns.map(column => ({ key: column.key, value: values.get(column.key) ?? '' }));
  return {
    rows,
    plain: `${fictionalNotice}\n\n${rows.map(row => `${row.key}: ${row.value}`).join('\n')}`,
    // Two-column key/value layout is supported by the existing inert parser.
    // No generic heading row, links, active elements or unescaped markup.
    html: `<p>${escapeHtml(fictionalNotice)}</p><table><tbody>${rows.map(row => `<tr><th scope="row">${escapeHtml(row.key)}</th><td>${escapeHtml(row.value)}</td></tr>`).join('')}</tbody></table>`,
  };
}

export function TemplateExample({ entry }: { entry: RegisteredTemplate }) {
  const [format, setFormat] = useState('plain');
  const copy = templateCopyFormats(entry);
  return (
    <div className="min-w-0 space-y-2">
      <label className="block text-xs font-semibold" htmlFor={`example-format-${entry.template.id}`}>Complete example format</label>
      <div className="flex flex-wrap items-center gap-2">
        <select id={`example-format-${entry.template.id}`} className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs" value={format} onChange={e => setFormat(e.target.value)}>
          <option value="plain">Plain text</option><option value="table">Header/value table</option>
        </select>
        <CopyButton key={format} value={copy.plain} html={format === 'table' ? copy.html : undefined} label={format === 'table' ? 'table' : 'plain text'} />
      </div>
      <p className="text-xs text-[var(--text-muted)]">{fictionalNotice} Sample choices are illustrations, not recommendations. Keep template ID and version unchanged. Use your own unique request ID.</p>
      {format === 'plain' ? <pre tabIndex={0} className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--surface-alt)] p-3 font-mono text-xs">{copy.plain}</pre> :
        <div tabIndex={0} className="max-h-72 overflow-auto rounded-md bg-[var(--surface-alt)] p-3">
          <table className="w-full text-xs"><caption className="sr-only">Fictional header/value example for {entry.template.name}</caption>
            <tbody>{copy.rows.map(row => <tr key={row.key} className="border-b border-[var(--border)]"><th scope="row" className="p-1 text-left font-mono">{row.key}</th><td className="p-1">{row.value}</td></tr>)}</tbody>
          </table>
        </div>}
      <p className="text-xs text-[var(--text-muted)]">Copying only writes to your clipboard. It does not send mail, create a request, verify facts or change routing. Table copy needs rich clipboard support; plain-text-only destinations receive the colon-separated example. Never include bank, medical or identity details; use approved secure collection references only.</p>
    </div>
  );
}
