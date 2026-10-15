import React, { useEffect, useRef, useState } from 'react';
import { getListOnboardingCasesQueryKey, updateCaseListVisibility, type OnbCase } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { caseListReference, caseTypeOf } from './case-presentation';

export type WorkingListView = 'working' | 'hidden';
export function workingListCases(rows: OnbCase[], view: WorkingListView) {
  return rows.filter(row => (row.workingListHidden === true) === (view === 'hidden'));
}

export function useWorkingList(rows: OnbCase[] | undefined, organizationId: string | null | undefined) {
  const client = useQueryClient();
  const [view, setView] = useState<WorkingListView>('working');
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const scope = useRef(organizationId);
  scope.current = organizationId;
  useEffect(() => { setView('working'); setPendingId(null); setMessage(''); }, [organizationId]);
  useEffect(() => { if (!rows) setMessage(''); }, [rows]);

  const change = async (row: OnbCase) => {
    if (!organizationId || pendingId !== null || !row.canManageWorkingList || !rows?.some(
      current => current.id === row.id && current.workingListVersion === row.workingListVersion &&
        current.workingListHidden === row.workingListHidden && current.canManageWorkingList,
    )) return;
    const submittedOrganization = organizationId;
    setPendingId(row.id); setMessage('');
    try {
      await updateCaseListVisibility({
        hidden: !row.workingListHidden, confirmWorkingListOnly: true,
        selection: [{ caseId: row.id, expectedVersion: row.workingListVersion ?? 0,
          caseFamily: caseTypeOf(row) as 'Onboarding' | 'Offboarding' }],
      }, { headers: { 'x-organization-id': submittedOrganization } });
      await client.invalidateQueries({ queryKey: [...getListOnboardingCasesQueryKey(), submittedOrganization] });
      if (scope.current === submittedOrganization) {
        setMessage(`${caseListReference(row)} ${row.workingListHidden ? 'restored to' : 'hidden from'} the Cases working list.`);
      }
    } catch {
      if (scope.current === submittedOrganization) {
        setMessage('The change could not be confirmed. The list has been refreshed; try again.');
        await client.invalidateQueries({ queryKey: [...getListOnboardingCasesQueryKey(), submittedOrganization] });
      }
    } finally { if (scope.current === submittedOrganization) setPendingId(null); }
  };
  const hiddenCount = rows?.filter(row => row.workingListHidden).length ?? 0;
  const controls = organizationId === 'demo' ? <>
    <label className="flex flex-wrap items-center gap-2 text-xs font-medium">Cases list
      <select aria-label="Cases list visibility" className="min-h-10 rounded-md border bg-[var(--surface)] px-2 text-xs lg:min-h-8" value={view}
        onChange={event => setView(event.target.value as WorkingListView)}>
        <option value="working">Working cases</option>
        <option value="hidden">Hidden cases ({rows ? hiddenCount : 'unavailable'})</option>
      </select>
    </label>
    <details className="basis-full text-xs text-[var(--text-secondary)]">
      <summary className="inline-flex min-h-10 cursor-pointer items-center rounded font-medium lg:min-h-6">How hiding works — list visibility only</summary>
      <p className="pb-2">Uncheck a case to hide it; check it in Hidden cases to restore it. This shared Demo Organization preference changes only the Cases working list. It does not change case status, operations, alerts, evidence, permissions, Action Center or Dashboard/Analytics totals.</p>
    </details>
    {message && <p role="status" className="basis-full text-sm">{message}</p>}
  </> : null;
  const checkbox = (row: OnbCase) => row.canManageWorkingList ? (
    <label className="inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center lg:min-h-0 lg:min-w-0 lg:p-2"
      onClick={event => event.stopPropagation()}>
      <input type="checkbox" className="h-4 w-4" disabled={pendingId !== null || !rows}
        aria-label={`Show ${caseListReference(row)} (${caseTypeOf(row)}) in working cases`}
        checked={!row.workingListHidden} onChange={() => void change(row)} />
    </label>
  ) : null;
  return { view, controls, checkbox };
}
