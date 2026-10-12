import { EvidenceDownload } from '@/components/evidence-download';

export default function FairnessProgrammePage() {
  return <section className="mx-auto max-w-5xl space-y-4">
    <h1 className="text-2xl font-bold">Historical evaluation evidence</h1>
    <p>Evaluation execution has been retired. Retained evidence is restricted and does not certify fairness, accuracy, authority, or readiness.</p>
    <EvidenceDownload path="/api/onboarding/uat/fairness/evidence-report" filename="historical-evaluation-evidence.json" label="Read authorized historical evidence" />
  </section>;
}
