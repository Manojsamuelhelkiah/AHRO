import { PageHeader } from '@/components/ui-shared';
import { PolicyQualityPanel } from '@/components/policy-quality-panel';

export default function PolicyQualityPage() {
  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-16">
      <PageHeader
        title="Policy quality"
        subtitle="Synthetic answer-quality benchmarks for the constrained Policy Assistant. Roadmap assurance evidence, not an accuracy guarantee."
      />
      <PolicyQualityPanel />
    </div>
  );
}
