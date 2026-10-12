import * as React from 'react';
import { useFormContext, useFieldArray, useWatch } from 'react-hook-form';
import { ClientSetupDraft } from './schema';
import { Input, Button, SectionHeading } from '@/components/ui-shared';
import { Plus, Trash2, Check } from 'lucide-react';
import { Select, Textarea, FormField } from './ui-form';
import type { Rollup, Scenario, ScenarioSystemCapability, ScenarioFlowBasis } from '@workspace/api-client-react';
import { ProcessFileManager } from '@/components/process-file-manager';

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

export function StepLandscape({ capabilities }: { capabilities: ScenarioSystemCapability[] }) {
  const { control, register, formState: { errors } } = useFormContext<ClientSetupDraft>();
  const { fields, append, remove } = useFieldArray({ control, name: 'systems', keyName: '_fieldId' });
  const systems = useWatch({ control, name: 'systems' });
  const nextCapability = capabilities.find((capability) =>
    capability.allowMultipleInstances || !systems.some((system) => system.key === capability.key));

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
                         <SystemSetupRow key={f._fieldId} index={i} capabilities={capabilities} onRemove={() => remove(i)} />
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
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!nextCapability}
                    onClick={() => nextCapability && append({
                      id: crypto.randomUUID(),
                      key: nextCapability.key,
                      name: '',
                      vendor: '',
                      mode: nextCapability.modes[0]?.mode ?? 'manual',
                      ownerEmail: '',
                    })}
                  >
                   <Plus className="w-4 h-4 mr-1" /> Add System
                </Button>
                 <span className="ml-3 text-xs text-[var(--text-muted)]">Payroll and ticketing support multiple estates.</span>
             </div>
          </div>
       </div>
    </div>
  );
}

function SystemSetupRow({ index, capabilities, onRemove }: { index: number; capabilities: ScenarioSystemCapability[]; onRemove: () => void }) {
  const { control, register, setValue, formState: { errors } } = useFormContext<ClientSetupDraft>();
  const key = useWatch({ control, name: `systems.${index}.key` });
  const mode = useWatch({ control, name: `systems.${index}.mode` });
  const needsReview = useWatch({ control, name: `systems.${index}.needsReview` });
  const capability = capabilities.find((entry) => entry.key === key);
  const modeOption = capability?.modes.find((option) => option.mode === mode);
  const modeField = register(`systems.${index}.mode`);
  const clearReviewIfCurrent = (nextKey: string, nextMode: string) => {
    const nextCapability = capabilities.find((entry) => entry.key === nextKey);
    if (nextCapability?.modes.some((option) => option.mode === nextMode)) {
      setValue(`systems.${index}.needsReview`, false, { shouldDirty: true, shouldValidate: true });
    }
  };
  return (
    <tr className="block bg-[var(--surface)] p-3 hover:bg-[var(--surface-soft)] transition-colors md:table-row md:p-0">
      <input type="hidden" {...register(`systems.${index}.id`)} />
      <td className="block p-1.5 md:table-cell md:p-2">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] md:hidden">System type</span>
        <Select {...register(`systems.${index}.key`)} onChange={(event) => {
          const next = capabilities.find((entry) => entry.key === event.target.value);
          const nextMode = next && (!mode || !next.modes.some((option) => option.mode === mode))
            ? next.modes[0]?.mode ?? ''
            : mode;
          setValue(`systems.${index}.key`, event.target.value, { shouldDirty: true, shouldValidate: true });
          if (next && nextMode !== mode) {
            setValue(`systems.${index}.mode`, nextMode, { shouldDirty: true, shouldValidate: true });
          }
          clearReviewIfCurrent(event.target.value, nextMode);
        }}>
          <option value="" disabled>Choose a system type</option>
          {capabilities.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
        </Select>
        <p className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]">{capability?.description}</p>
      </td>
      <td className="block p-1.5 md:table-cell md:p-2"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] md:hidden">System Name</span><Input {...register(`systems.${index}.name`)} placeholder="e.g. Workday" /></td>
      <td className="block p-1.5 md:table-cell md:p-2"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] md:hidden">Vendor</span><Input {...register(`systems.${index}.vendor`)} placeholder="Vendor" /></td>
      <td className="block p-1.5 md:table-cell md:p-2">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] md:hidden">Connection method</span>
        <Select {...modeField} onChange={(event) => {
          modeField.onChange(event);
          clearReviewIfCurrent(key, event.target.value);
        }}>
          <option value="" disabled>Choose a connection method</option>
          {capability?.modes.map((option) => <option key={option.mode} value={option.mode}>{option.label}</option>)}
        </Select>
        <p className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]">{modeOption?.description}</p>
        {needsReview && (
          <p role="status" className="mt-2 rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] px-2 py-1.5 text-[11px] leading-4 text-[var(--status-amber-fg)]">
            Needs review: the previously saved connection choice is no longer supported. Select a current system type and connection method.
          </p>
        )}
        {errors.systems?.[index]?.mode?.message && (
          <p role="alert" className="mt-1 text-[11px] leading-4 text-[var(--status-red-fg)]">{errors.systems[index]?.mode?.message}</p>
        )}
      </td>
      <td className="block p-1.5 md:table-cell md:p-2"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] md:hidden">Owner Email</span><Input {...register(`systems.${index}.ownerEmail`)} placeholder="admin@..." /></td>
      <td className="block p-1.5 text-right md:table-cell md:p-2 md:text-center"><Button type="button" variant="ghost" size="icon" onClick={onRemove} className="text-[var(--text-muted)] hover:text-[var(--status-red)] h-8 w-8"><span className="sr-only">Remove system</span><Trash2 className="w-4 h-4" /></Button></td>
    </tr>
  );
}

export function StepProcess({
  onFileOperationPendingChange,
  basis, basisError, onReviewBasis, onRetryBasis,
}: {
  onFileOperationPendingChange: (pending: boolean) => void;
  basis?: ScenarioFlowBasis;
  basisError?: string;
  onReviewBasis?: () => void;
  onRetryBasis?: () => void;
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
                 {!['recommended', 'hybrid', 'custom'].includes(watch('processMode')) && <option value={watch('processMode')} disabled>Unsupported saved adoption choice — choose a current mode</option>}
                 <option value="recommended">Base product flows (default)</option>
                 <option value="hybrid">Base flows + planned customization</option>
                 <option value="custom">Planned custom adoption</option>
             </Select>
          </FormField>
             <FormField label="Optional customization documents" error={errors.processFiles?.message}>
               <ProcessFileManager
                 files={watch('processFiles')}
                 onFilesChange={updateProcessFiles}
                  onPendingChange={onFileOperationPendingChange}
               />
          </FormField>
       </div>
       <p className="text-sm text-[var(--text-muted)]">No upload is required. Hybrid or custom adoption remains pending on the reviewed product basis until changes are separately reviewed. Uploads do not change workflows or authorize live execution.</p>
       {watch('processBasisNeedsReview') && <p role="alert" className="text-sm text-[var(--status-amber-fg)]">This older custom arrangement has no recorded flow basis. Review its existing configuration before explicitly confirming the current product basis for planning. Existing overrides and files are retained.</p>}
       <FlowBasisSummary basis={basis} mode={watch('processMode')} attachmentCount={watch('processFiles').length} />
       {basisError && <p role="alert" className="text-sm text-[var(--status-red-fg)]">{basisError} <Button type="button" variant="outline" onClick={onRetryBasis}>Retry base definitions</Button></p>}
       <Button type="button" variant="outline" disabled={!basis} onClick={onReviewBasis}>Confirm reviewed planning basis</Button>
       {watch('flowBasis') && basis && watch('flowBasis')?.fingerprint !== basis.fingerprint && <p role="alert">Definitions changed since your previous review. Confirm the current basis before estimating.</p>}

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

export function StepReview({ onSimulate, onCommit, rollup, scenario, isSimulating, isCommitting, isFileOperationPending, onFileOperationPendingChange, operationError, intentsLoading, capabilities, activationNotice, basis, onOpenWorkspace, canActivateSystemSetup, workspaceName, isSuperAdmin, isEnteringWorkspace }: {
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
  capabilities: ScenarioSystemCapability[],
  activationNotice: string | null,
  basis?: ScenarioFlowBasis,
  onOpenWorkspace?: () => void,
  canActivateSystemSetup?: boolean,
  workspaceName?: string,
  isSuperAdmin?: boolean,
  isEnteringWorkspace?: boolean,
}) {
  const { watch, register, setValue } = useFormContext<ClientSetupDraft>();
  const draft = watch();
  const [showCustomizations, setShowCustomizations] = React.useState(false);
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
             Scenario <strong className="text-[var(--text-primary)]">{scenario.name}</strong> is saved for implementation planning. This is not launch approval or permission for live employment actions.
         </p>
          {activationNotice && (
            <p role="status" className="mx-auto mb-6 max-w-xl rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-3 text-sm text-[var(--text-secondary)]">
              {activationNotice}
            </p>
          )}
          <div className="inline-flex w-full max-w-xl bg-[var(--surface-alt)] border border-[var(--border)] rounded-[var(--radius-lg)] p-4 sm:p-6 text-left shadow-sm">
             <div className="w-full min-w-0 space-y-3 text-sm">
               <div className="flex justify-between gap-8"><span className="text-[var(--text-muted)]">Scenario ID:</span> <span className="font-mono font-semibold text-[var(--primary)]">{scenario.id}</span></div>
               <div className="flex justify-between gap-8"><span className="text-[var(--text-muted)]">Systems Mapped:</span> <span>{draft.systems.length}</span></div>
                <div className="flex justify-between gap-8"><span className="text-[var(--text-muted)]">Target ROI:</span> <span className="text-[var(--status-green-fg)] font-bold">{rollup ? (rollup.totals.roi * 100).toFixed(1) + '%' : 'N/A'}</span></div>
            </div>
         </div>
          <div className="mx-auto mt-6 max-w-xl text-left"><FlowBasisSummary basis={draft.flowBasis} mode={draft.processMode} attachmentCount={draft.processFiles.length} saved /></div>
          {draft.flowBasis && basis && draft.flowBasis.fingerprint !== basis.fingerprint && <p role="status" className="mx-auto mt-3 max-w-xl text-sm">Current definitions differ from the saved planning fingerprint. The saved configuration has not been replaced; review the source changes before using a new estimate.</p>}
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button type="button" disabled={isFileOperationPending || isEnteringWorkspace} onClick={onOpenWorkspace}>{isEnteringWorkspace ? 'Opening client…' : isSuperAdmin ? 'Go to client workspace' : canActivateSystemSetup ? 'Open Workspace' : 'Continue to Workspace'}</Button>
            <Button type="button" variant="outline" disabled={isFileOperationPending} onClick={() => setShowCustomizations(true)}>Upload Customizations Later</Button>
          </div>
          {!canActivateSystemSetup && <p className="mt-3 text-xs text-[var(--text-muted)]">Your existing workspace permissions apply. Only an owner or admin can activate connector choices.</p>}
          {isSuperAdmin && <p className="mt-3 text-xs text-[var(--text-muted)]">This implementation plan is saved in {workspaceName}. Go to client workspace opens the named client, or lets you create it. Plans, policies and approvals are not transferred between workspaces.</p>}
          <p className="mt-3 text-xs text-[var(--text-muted)]">Return to this saved scenario to attach documents at any time.</p>
         <div className="mx-auto mt-6 max-w-xl text-left">
            {/* Keep mounted so late file-list responses and active mutations remain authoritative. */}
            <div hidden={!showCustomizations}>
           <ProcessFileManager
              key={scenario.id}
             scenarioId={scenario.id}
             files={draft.processFiles}
             onFilesChange={updateProcessFiles}
              onPendingChange={onFileOperationPendingChange}
           />
            </div>
         </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
       <FlowBasisSummary basis={draft.flowBasis ?? basis} mode={draft.processMode} attachmentCount={draft.processFiles.length} />
       <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div>
            <SectionHeading title="Configuration Summary" />
            <dl className="mt-4 space-y-3 text-[var(--text-sm)]">
              <div className="flex justify-between border-b border-[var(--border)] pb-2"><dt className="text-[var(--text-muted)]">Client:</dt><dd className="font-medium">{draft.clientName || 'Unspecified'}</dd></div>
              <div className="flex justify-between border-b border-[var(--border)] pb-2"><dt className="text-[var(--text-muted)]">Scale:</dt><dd className="font-medium">{draft.employees} employees, {draft.countries} countries</dd></div>
              <div className="flex justify-between border-b border-[var(--border)] pb-2"><dt className="text-[var(--text-muted)]">Volume:</dt><dd className="font-medium">{draft.annualTransactions.toLocaleString()} tx/yr</dd></div>
              <div className="flex justify-between border-b border-[var(--border)] pb-2"><dt className="text-[var(--text-muted)]">Systems:</dt><dd className="font-medium">{draft.systems.length} mapped</dd></div>
               <div className="border-b border-[var(--border)] pb-2">
                 <dt className="text-[var(--text-muted)]">Connection methods:</dt>
                 <dd className="mt-2 space-y-1 text-right font-medium">
                   {draft.systems.map((system) => {
                     const capability = capabilities.find((entry) => entry.key === system.key);
                      return <div key={system.id}>{system.name || capability?.label || system.key}: {capability?.modes.find((option) => option.mode === system.mode)?.label ?? system.mode}</div>;
                   })}
                 </dd>
               </div>
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
                 <h3 className="text-[var(--text-lg)] font-semibold text-[var(--text-primary)]">Planning Estimate</h3>
                <p className="text-[var(--text-sm)] text-[var(--text-muted)] max-w-lg mx-auto leading-relaxed">
                   Run the simulation engine to generate the baseline ROI, net benefit, and cost structure for this implementation configuration.
                </p>
                <div className="pt-2">
                     <Button onClick={onSimulate} disabled={isSimulating || intentsLoading || isFileOperationPending} size="lg" className="px-8 bg-[var(--primary)] text-white font-semibold">
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

export function FlowBasisSummary({ basis, mode, saved = false, attachmentCount = 0 }: { basis?: ScenarioFlowBasis; mode: ClientSetupDraft['processMode']; saved?: boolean; attachmentCount?: number }) {
  return <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-alt)] p-4 text-left text-sm space-y-2">
    <h3 className="font-semibold">Effective planning flow source</h3>
    {!basis ? <p role="status">{saved ? 'Legacy source not recorded. Review the existing custom arrangement; no product-default reset has been applied.' : 'Resolve and review base product definitions before estimating.'}</p> : <>
      <p>{basis.source === 'product-base-with-overrides' ? 'Base product flows with existing approved client overrides' : 'Base product flows'}</p>
      <p>Scope: {basis.selectedDomains.join(', ')} · {Object.keys(basis.intentWeights).length} intents</p>
      <details><summary>Intent scope and definition fingerprint</summary>
        <p className="break-all font-mono text-xs mt-2">{basis.fingerprint}</p>
        <p className="break-words mt-2">{Object.keys(basis.intentWeights).join(', ')}</p>
        {basis.overrideRefs.length > 0 && <p>Approved override revisions: {basis.overrideRefs.join(', ')}</p>}
      </details>
      <p>Customization: {mode !== 'recommended' ? 'Pending review — planned hybrid/custom adoption continues on this basis.' : attachmentCount ? 'Documents attached, pending review; effective flows unchanged.' : basis.overrideRefs.length ? 'Existing reviewed overrides retained.' : 'None planned; documents may be attached later.'}</p>
      <p>Private document references: {attachmentCount}. Attachments are not reviewed executable changes.</p>
      <p className="text-xs text-[var(--text-muted)]">{saved ? 'Saved provenance is historical planning evidence, not a pinned executable version. ' : ''}Documents are private review attachments only. Country, policy, security, specialist authority and live-effect gates still apply.</p>
    </>}
  </section>;
}
