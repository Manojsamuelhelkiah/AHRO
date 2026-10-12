import { useQuery } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';
import { useAdmission } from '@/lib/admission';
import { EvidenceDownload } from '@/components/evidence-download';

export default function UatTestCenterPage() {
  const admission = useAdmission();
  const history = useQuery({
    queryKey: ['uat-history', admission.organizationId, admission.userId],
    queryFn: () => customFetch<{ runs: { runId: string; createdAt: string }[] }>('/api/onboarding/uat', { responseType: 'json' }),
  });
  return <section className="mx-auto max-w-5xl space-y-4">
    <h1 className="text-2xl font-bold">Acceptance history</h1>
    <p>Historical test records are read-only and non-operational. They do not establish approval authority, live readiness, or business outcomes.</p>
    {history.isLoading && <p role="status">Loading authorized history…</p>}
    {history.isError && <p role="alert">History could not be loaded. Current workspace admission and record access are required.</p>}
    <ul className="space-y-2">{history.data?.runs.map(run => <li key={run.runId} className="rounded-lg border p-3 break-all">
      <span className="font-mono">{run.runId}</span> · {run.createdAt} · Historical, non-operational
      <EvidenceDownload path={`/api/onboarding/uat/runs/${encodeURIComponent(run.runId)}/evidence-report`} filename={`historical-acceptance-${run.runId}.json`} />
    </li>)}</ul>
    {history.data?.runs.length === 0 && <p>No authorized historical records.</p>}
  </section>;
}
