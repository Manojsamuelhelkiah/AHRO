import * as React from 'react';
import { useFormContext, useFieldArray } from 'react-hook-form';
import { ClientSetupDraft } from './schema';
import { Input, Button, SectionHeading } from '@/components/ui-shared';
import { Plus, Trash2, Check } from 'lucide-react';
import { Select, Textarea, FormField } from './ui-form';
import type { Rollup, Scenario } from '@workspace/api-client-react';
import { ProcessFileManager } from '@/components/process-file-manager';

const systemDomains = ['Intake', 'Employee Master', 'IAM/Access', 'Learning', 'IT Assets', 'Payroll/Benefits', 'Leave', 'Compliance', 'Documents', 'Communications'];
const processDomains = ['Hire', 'Pay', 'Leave', 'Benefits', 'Time', 'Mobility', 'Develop', 'Retire', 'Data/Admin', 'Policy'];

export function StepScope() {
  const { register, formState: { errors } } = useFormContext<ClientSetupDraft>();

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
       <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <FormField label="Client Name" error={errors.clientName?.message}>
             <Input {...register('clientName')} placeholder="e.g. Acme Corp" />
          </FormField>
          <FormField label="Sector" error={errors.sector?.message}>
             <Select {...register('sector')}>
                <option value="Technology">Technology</option>
                <option value="Healthcare">Healthcare</option>
                <option value="Finance">Finance</option>
                <option value="Manufacturing">Manufacturing</option>
                <option value="Retail">Retail</option>
                <option value="Services">Services</option>
                <option value="Other">Other</option>
             </Select>
          </FormField>
       </div>

       <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <FormField label="Total Employees" error={errors.employees?.message}>
             <Input type="number" min={10} {...register('employees', { valueAsNumber: true })} />
          </FormField>
          <FormField label="Operating Countries" error={errors.countries?.message}>
             <Input type="number" min={1} {...register('countries', { valueAsNumber: true })} />
          </FormField>
          <FormField label="Annual HR Transactions" error={errors.annualTransactions?.message}>
             <Input type="number" min={100} {...register('annualTransactions', { valueAsNumber: true })} />
          </FormField>
       </div>

       <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <FormField label="Blended HR Cost/Hr (USD)" error={errors.hrHourlyCostUsd?.message}>
             <Input type="number" min={1} step="0.01" {...register('hrHourlyCostUsd', { valueAsNumber: true })} />
          </FormField>
          <FormField label="HITL Exception Cost/Hr (USD)" error={errors.hitlHourlyCostUsd?.message}>
             <Input type="number" min={1} step="0.01" {...register('hitlHourlyCostUsd', { valueAsNumber: true })} />
          </FormField>
       </div>
    </div>
  );
}

export function StepLandscape() {
  const { control, register, formState: { errors } } = useFormContext<ClientSetupDraft>();
  const { fields, append, remove } = useFieldArray({ control, name: 'systems' });

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
       <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
           <FormField label="Operating Footprint" error={errors.companyType?.message}>
             <Select {...register('companyType')}>
                 <option value="single-country">Single country</option>
                 <option value="multi-country">Multi-country</option>
                 <option value="global">Global</option>
             </Select>
          </FormField>
          <FormField label="Isolation Tier" error={errors.isolationTier?.message}>
             <Select {...register('isolationTier')}>
                 <option value="pooled">Pooled tenant</option>
                 <option value="siloed">Siloed tenant</option>
                 <option value="dedicated">Dedicated tenant</option>
             </Select>
          </FormField>
          <FormField label="Landscape Maturity" error={errors.landscapeMaturity?.message}>
             <Select {...register('landscapeMaturity')}>
                 <option value="clean">Clean — modern APIs</option>
                 <option value="mixed">Mixed — APIs and legacy</option>
                 <option value="legacy">Legacy — file/manual heavy</option>
             </Select>
          </FormField>
       </div>

       <div className="space-y-4">
          <SectionHeading title="Source Systems Integration" description="Map the client's system landscape for data intake and action execution." />
          
          <div className="border border-[var(--border)] rounded-[var(--radius-lg)] overflow-hidden">
              <div>
                <table className="block w-full text-left border-collapse md:table">
                   <thead className="hidden bg-[var(--surface-alt)] border-b border-[var(--border)] text-[var(--text-xs)] uppercase tracking-wider font-semibold text-[var(--text-muted)] md:table-header-group">
                     <tr>
                        <th className="p-3 font-semibold">Domain</th>
                        <th className="p-3 font-semibold">System Name</th>
                        <th className="p-3 font-semibold">Vendor</th>
                        <th className="p-3 font-semibold">Mode</th>
                        <th className="p-3 font-semibold">Owner Email</th>
                        <th className="p-3 w-10"></th>
                     </tr>
                  </thead>
                   <tbody className="block divide-y divide-[var(--border)] md:table-row-group">
                     {fields.map((f, i) => (
                         <tr key={f.id} className="block bg-[var(--surface)] p-3 hover:bg-[var(--surface-soft)] transition-colors md:table-row md:p-0">
                            <td className="block p-1.5 md:table-cell md:p-2">
                              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] md:hidden">Domain</span>
                             <Select {...register(`systems.${i}.domain` as const)}>
                               <option value="">Select...</option>
                               {systemDomains.map(d => <option key={d} value={d}>{d}</option>)}
                             </Select>
                           </td>
                            <td className="block p-1.5 md:table-cell md:p-2">
                              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] md:hidden">System Name</span>
                              <Input {...register(`systems.${i}.name` as const)} placeholder="e.g. Workday" />
                            </td>
                            <td className="block p-1.5 md:table-cell md:p-2">
                              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] md:hidden">Vendor</span>
                              <Input {...register(`systems.${i}.vendor` as const)} placeholder="Vendor" />
                            </td>
                            <td className="block p-1.5 md:table-cell md:p-2">
                              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] md:hidden">Mode</span>
                             <Select {...register(`systems.${i}.mode` as const)}>
                               <option value="API">API</option>
                               <option value="Webhook">Webhook</option>
                               <option value="Flat File">Flat File</option>
                               <option value="Manual">Manual</option>
                             </Select>
                           </td>
                            <td className="block p-1.5 md:table-cell md:p-2">
                              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] md:hidden">Owner Email</span>
                              <Input {...register(`systems.${i}.ownerEmail` as const)} placeholder="admin@..." />
                            </td>
                            <td className="block p-1.5 text-right md:table-cell md:p-2 md:text-center">
                             <Button type="button" variant="ghost" size="icon" onClick={() => remove(i)} className="text-[var(--text-muted)] hover:text-[var(--status-red)] h-8 w-8">
                                <span className="sr-only">Remove system</span>
                               <Trash2 className="w-4 h-4" />
                             </Button>
                           </td>
                        </tr>
                     ))}
                     {fields.length === 0 && (
                       <tr>
                         <td colSpan={6} className="p-6 text-center text-[var(--text-muted)] text-[var(--text-sm)] bg-[var(--surface-alt)]">
                           No systems mapped yet.
                         </td>
                       </tr>
                     )}
                  </tbody>
               </table>
             </div>
             <div className="p-2 bg-[var(--surface-alt)] border-t border-[var(--border)]">
                <Button type="button" variant="secondary" size="sm" onClick={() => append({ domain: '', name: '', vendor: '', mode: 'API', ownerEmail: '' })}>
                   <Plus className="w-4 h-4 mr-1" /> Add System
                </Button>
             </div>
          </div>
       </div>
    </div>
  );
}

export function StepProcess({
  onFileOperationPendingChange,
}: {
  onFileOperationPendingChange: (pending: boolean) => void;
}) {
  const { control, register, setValue, watch, formState: { errors } } = useFormContext<ClientSetupDraft>();
  const { fields, append, remove } = useFieldArray({ control, name: 'personas' });
  const updateProcessFiles = React.useCallback(
    (files: ClientSetupDraft['processFiles']) => setValue('processFiles', files, { shouldDirty: true, shouldValidate: true }),
    [setValue],
  );
  
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
       <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <FormField label="Process Adoption Mode" error={errors.processMode?.message}>
             <Select {...register('processMode')}>
                <option value="recommended">Recommended (Standard Flows)</option>
                <option value="hybrid">Hybrid (Mix)</option>
                <option value="custom">Custom (Bring Your Own)</option>
             </Select>
          </FormField>
            <FormField label="Client Flow Definitions" error={errors.processFiles?.message}>
               <ProcessFileManager
                 files={watch('processFiles')}
                 onFilesChange={updateProcessFiles}
                  onPendingChange={onFileOperationPendingChange}
               />
          </FormField>
       </div>

       <div className="space-y-4">
          <SectionHeading title="In-Scope Domains" description="Select the HR domains targeted for agentic automation." />
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
             {processDomains.map(d => (
                <label key={d} className="flex items-center gap-2 p-3 rounded-[var(--radius-md)] border border-[var(--border)] hover:bg-[var(--surface-alt)] transition-colors cursor-pointer text-[var(--text-sm)] font-medium select-none">
                   <input type="checkbox" value={d} {...register('selectedDomains')} className="w-4 h-4 text-[var(--primary)] rounded border-[var(--border)]" />
                   {d}
                </label>
             ))}
          </div>
       </div>

       <div className="space-y-4">
          <SectionHeading title="Accountable Personas" description="Key stakeholders and business owners for governance." />
          <div className="border border-[var(--border)] rounded-[var(--radius-lg)] overflow-hidden">
              <div>
                <table className="block w-full text-left border-collapse md:table">
                   <thead className="hidden bg-[var(--surface-alt)] border-b border-[var(--border)] text-[var(--text-xs)] uppercase tracking-wider font-semibold text-[var(--text-muted)] md:table-header-group">
                     <tr>
                        <th className="p-3 font-semibold w-1/3">Role</th>
                        <th className="p-3 font-semibold w-1/3">Name</th>
                        <th className="p-3 font-semibold w-1/3">Email</th>
                        <th className="p-3 w-10"></th>
                     </tr>
                  </thead>
                   <tbody className="block divide-y divide-[var(--border)] md:table-row-group">
                     {fields.map((f, i) => (
                         <tr key={f.id} className="block bg-[var(--surface)] p-3 hover:bg-[var(--surface-soft)] transition-colors md:table-row md:p-0">
                            <td className="block p-1.5 md:table-cell md:p-2">
                              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] md:hidden">Role</span>
                              <Input {...register(`personas.${i}.role` as const)} placeholder="e.g. Global Process Owner" />
                            </td>
                            <td className="block p-1.5 md:table-cell md:p-2">
                              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] md:hidden">Name</span>
                              <Input {...register(`personas.${i}.name` as const)} placeholder="Name" />
                            </td>
                            <td className="block p-1.5 md:table-cell md:p-2">
                              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] md:hidden">Email</span>
                              <Input {...register(`personas.${i}.email` as const)} placeholder="Email" type="email" />
                            </td>
                            <td className="block p-1.5 text-right md:table-cell md:p-2 md:text-center">
                             <Button type="button" variant="ghost" size="icon" onClick={() => remove(i)} className="text-[var(--text-muted)] hover:text-[var(--status-red)] h-8 w-8">
                                <span className="sr-only">Remove persona</span>
                               <Trash2 className="w-4 h-4" />
                             </Button>
                           </td>
                        </tr>
                     ))}
                     {fields.length === 0 && (
                       <tr>
                         <td colSpan={4} className="p-6 text-center text-[var(--text-muted)] text-[var(--text-sm)] bg-[var(--surface-alt)]">
                           No personas added yet.
                         </td>
                       </tr>
                     )}
                  </tbody>
               </table>
             </div>
             <div className="p-2 bg-[var(--surface-alt)] border-t border-[var(--border)]">
                <Button type="button" variant="secondary" size="sm" onClick={() => append({ role: '', name: '', email: '' })}>
                   <Plus className="w-4 h-4 mr-1" /> Add Persona
                </Button>
             </div>
          </div>
       </div>
    </div>
  );
}

export function StepReview({ onSimulate, onCommit, rollup, scenario, isSimulating, isCommitting, isFileOperationPending, onFileOperationPendingChange, operationError, intentsLoading }: {
  onSimulate: () => void, 
  onCommit: () => void, 
  rollup: Rollup | null | undefined, 
  scenario: Scenario | null | undefined, 
  isSimulating: boolean, 
  isCommitting: boolean,
  isFileOperationPending: boolean,
  onFileOperationPendingChange: (pending: boolean) => void,
  operationError: string | null,
  intentsLoading: boolean,
}) {
  const { watch, register, setValue } = useFormContext<ClientSetupDraft>();
  const draft = watch();
  const updateProcessFiles = React.useCallback(
    (files: ClientSetupDraft['processFiles']) => setValue('processFiles', files, { shouldDirty: true, shouldValidate: true }),
    [setValue],
  );

  if (scenario) {
    return (
      <div className="py-12 text-center animate-in zoom-in-95 duration-500">
         <div className="w-16 h-16 bg-[var(--status-green-bg)] text-[var(--status-green-fg)] rounded-full flex items-center justify-center mx-auto mb-6">
            <Check className="w-8 h-8" />
         </div>
         <h2 className="text-2xl font-bold text-[var(--text-primary)] mb-2">Implementation Committed</h2>
         <p className="text-[var(--text-muted)] max-w-md mx-auto mb-8">
            Scenario <strong className="text-[var(--text-primary)]">{scenario.name}</strong> has been saved and locked into the implementation pipeline.
         </p>
         <div className="inline-flex bg-[var(--surface-alt)] border border-[var(--border)] rounded-[var(--radius-lg)] p-6 text-left shadow-sm">
            <div className="space-y-3 text-sm min-w-[280px]">
               <div className="flex justify-between gap-8"><span className="text-[var(--text-muted)]">Scenario ID:</span> <span className="font-mono font-semibold text-[var(--primary)]">{scenario.id}</span></div>
               <div className="flex justify-between gap-8"><span className="text-[var(--text-muted)]">Systems Mapped:</span> <span>{draft.systems.length}</span></div>
                <div className="flex justify-between gap-8"><span className="text-[var(--text-muted)]">Target ROI:</span> <span className="text-[var(--status-green-fg)] font-bold">{rollup ? (rollup.totals.roi * 100).toFixed(1) + '%' : 'N/A'}</span></div>
            </div>
         </div>
         <div className="mx-auto mt-6 max-w-xl text-left">
           <ProcessFileManager
             scenarioId={scenario.id}
             files={draft.processFiles}
             onFilesChange={updateProcessFiles}
              onPendingChange={onFileOperationPendingChange}
           />
         </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
       <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div>
            <SectionHeading title="Configuration Summary" />
            <dl className="mt-4 space-y-3 text-[var(--text-sm)]">
              <div className="flex justify-between border-b border-[var(--border)] pb-2"><dt className="text-[var(--text-muted)]">Client:</dt><dd className="font-medium">{draft.clientName || 'Unspecified'}</dd></div>
              <div className="flex justify-between border-b border-[var(--border)] pb-2"><dt className="text-[var(--text-muted)]">Scale:</dt><dd className="font-medium">{draft.employees} employees, {draft.countries} countries</dd></div>
              <div className="flex justify-between border-b border-[var(--border)] pb-2"><dt className="text-[var(--text-muted)]">Volume:</dt><dd className="font-medium">{draft.annualTransactions.toLocaleString()} tx/yr</dd></div>
              <div className="flex justify-between border-b border-[var(--border)] pb-2"><dt className="text-[var(--text-muted)]">Systems:</dt><dd className="font-medium">{draft.systems.length} mapped</dd></div>
              <div className="flex justify-between border-b border-[var(--border)] pb-2"><dt className="text-[var(--text-muted)]">Process Mode:</dt><dd className="font-medium capitalize">{draft.processMode}</dd></div>
              <div className="flex justify-between border-b border-[var(--border)] pb-2"><dt className="text-[var(--text-muted)]">Domains Scope:</dt><dd className="font-medium">{draft.selectedDomains.length} domains</dd></div>
              <div className="flex justify-between pb-2"><dt className="text-[var(--text-muted)]">Accountable Contacts:</dt><dd className="font-medium">{draft.personas.length} mapped</dd></div>
            </dl>
          </div>
          <div>
            <SectionHeading title="Implementation Notes" />
            <Textarea {...register('notes')} placeholder="Add any specific context or constraints..." className="mt-4 h-[216px]" />
          </div>
       </div>

        <div className="bg-[var(--surface-alt)] border border-[var(--border)] rounded-[var(--radius-lg)] p-4 sm:p-6 text-center shadow-inner">
           {operationError && (
             <div role="alert" className="mb-4 rounded-[var(--radius-md)] border px-4 py-3 text-left text-sm" style={{ borderColor: 'var(--status-red)', backgroundColor: 'var(--status-red-bg)', color: 'var(--status-red-fg)' }}>
               {operationError}
             </div>
           )}
          {!rollup ? (
             <div className="space-y-4 py-4">
                <h3 className="text-[var(--text-lg)] font-semibold text-[var(--text-primary)]">Readiness Rollup</h3>
                <p className="text-[var(--text-sm)] text-[var(--text-muted)] max-w-lg mx-auto leading-relaxed">
                   Run the simulation engine to generate the baseline ROI, net benefit, and cost structure for this implementation configuration.
                </p>
                <div className="pt-2">
                    <Button onClick={onSimulate} disabled={isSimulating || intentsLoading} size="lg" className="px-8 bg-[var(--primary)] text-white font-semibold">
                       {intentsLoading ? 'Loading intent catalog…' : isSimulating ? 'Computing...' : 'Run Readiness Rollup'}
                   </Button>
                </div>
             </div>
          ) : (
             <div className="text-left animate-in fade-in zoom-in-95 duration-500">
                <div className="flex items-center justify-between mb-6 pb-4 border-b border-[var(--border)]">
                  <h3 className="text-[var(--text-lg)] font-semibold text-[var(--text-primary)]">Rollup Complete</h3>
                  <Button variant="outline" size="sm" onClick={onSimulate} disabled={isSimulating}>Recalculate</Button>
                </div>
                
                 <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                   <div className="p-5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-sm transition-transform hover:-translate-y-0.5">
                      <div className="text-[var(--text-xs)] text-[var(--text-muted)] uppercase tracking-wider font-semibold mb-1">Total Cost</div>
                       <div className="text-[var(--text-2xl)] font-bold text-[var(--text-primary)]">${rollup.commercialSummary.clientImplementationCostUsd.toLocaleString(undefined, {maximumFractionDigits: 0})}</div>
                   </div>
                   <div className="p-5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-sm transition-transform hover:-translate-y-0.5 relative overflow-hidden">
                      <div className="absolute top-0 right-0 w-16 h-16 bg-[var(--status-green)] opacity-5 rounded-bl-full pointer-events-none" />
                      <div className="text-[var(--text-xs)] text-[var(--text-muted)] uppercase tracking-wider font-semibold mb-1">Net Benefit</div>
                       <div className="text-[var(--text-2xl)] font-bold text-[var(--status-green-fg)]">${rollup.totals.netUsd.toLocaleString(undefined, {maximumFractionDigits: 0})}</div>
                   </div>
                   <div className="p-5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-sm transition-transform hover:-translate-y-0.5">
                      <div className="text-[var(--text-xs)] text-[var(--text-muted)] uppercase tracking-wider font-semibold mb-1">Target ROI</div>
                       <div className="text-[var(--text-2xl)] font-bold text-[var(--text-primary)]">{(rollup.totals.roi * 100).toFixed(1)}%</div>
                   </div>
                   <div className="p-5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-sm transition-transform hover:-translate-y-0.5">
                      <div className="text-[var(--text-xs)] text-[var(--text-muted)] uppercase tracking-wider font-semibold mb-1">Payback</div>
                       <div className="text-[var(--text-2xl)] font-bold text-[var(--text-primary)]">{rollup.commercialSummary.plannedPaybackMonths.toFixed(1)} mo</div>
                   </div>
                </div>

                <div className="mt-8 flex justify-end">
                   <Button size="lg" onClick={onCommit} disabled={isCommitting || isFileOperationPending} className="bg-[var(--primary)] hover:bg-[var(--primary-dark)] text-white shadow-md font-semibold px-8 h-12 text-base">
                      {isFileOperationPending ? 'Waiting for file upload…' : isCommitting ? 'Committing...' : 'Commit Implementation Scenario'}
                   </Button>
                </div>
             </div>
          )}
       </div>
    </div>
  );
}