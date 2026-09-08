import React, { useState, useEffect, useRef } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { clientSetupSchema, ClientSetupDraft, initialDraft } from './schema';
import { StepScope, StepLandscape, StepProcess, StepReview } from './wizard-steps';
import { Button, PageHeader } from '@/components/ui-shared';
import { useCreateScenario, useComputeRollup, useListIntents } from '@workspace/api-client-react';
import type { Rollup, Scenario, ScenarioInputs } from '@workspace/api-client-react';
import { Check, ChevronRight } from 'lucide-react';

const STEPS = [
  { id: 'scope', label: 'Scope & Scale' },
  { id: 'landscape', label: 'Landscape' },
  { id: 'process', label: 'Process Adoption' },
  { id: 'review', label: 'Readiness & Rollup' },
];

function loadInitialDraft(): ClientSetupDraft {
  try {
    const stored = localStorage.getItem('clientSetupDraft');
    if (stored) {
      return { ...initialDraft, ...JSON.parse(stored) };
    }
  } catch {
    // Ignore a corrupt or unavailable browser draft and start cleanly.
  }
  return initialDraft;
}

export function ClientSetupPage() {
  const [currentStep, setCurrentStep] = useState(0);
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const draftPersistenceEnabled = useRef(true);
  
  const form = useForm<ClientSetupDraft>({
    resolver: zodResolver(clientSetupSchema),
    defaultValues: loadInitialDraft(),
  });

  useEffect(() => {
    const sub = form.watch((value) => {
      if (!draftPersistenceEnabled.current) return;
      localStorage.setItem('clientSetupDraft', JSON.stringify(value));
    });
    return () => sub.unsubscribe();
  }, [form]);

  const handleNext = async () => {
    let fieldsToValidate: (keyof ClientSetupDraft)[] = [];
    if (currentStep === 0) fieldsToValidate = ['clientName', 'sector', 'employees', 'countries', 'annualTransactions', 'hrHourlyCostUsd', 'hitlHourlyCostUsd'];
    if (currentStep === 1) fieldsToValidate = ['companyType', 'isolationTier', 'landscapeMaturity', 'systems'];
    if (currentStep === 2) fieldsToValidate = ['processMode', 'selectedDomains', 'uploadedFlowNames', 'personas'];
    
    const isValid = await form.trigger(fieldsToValidate);
    if (isValid) setCurrentStep(c => Math.min(STEPS.length - 1, c + 1));
  };

  const handlePrev = () => setCurrentStep(c => Math.max(0, c - 1));
  
  const computeRollup = useComputeRollup();
  const createScenario = useCreateScenario();
  const { data: intentCorpus, isLoading: intentsLoading } = useListIntents();

  const buildInputs = (values: ClientSetupDraft): ScenarioInputs => {
    const domainKeys: Record<string, string> = {
      Hire: 'hire',
      Pay: 'pay',
      Leave: 'leave',
      Benefits: 'benefits',
      Time: 'time',
      Mobility: 'mobility',
      Develop: 'develop',
      Retire: 'retire',
      'Data/Admin': 'data-admin',
      Policy: 'policy',
    };
    const selected = new Set(values.selectedDomains.map((domain) => domainKeys[domain]).filter(Boolean));
    const includedIntents = (intentCorpus?.intents ?? []).filter((intent) => selected.has(intent.domain));
    const totalWeight = includedIntents.reduce((sum, intent) => sum + intent.baseWeight, 0);
    const manualSystemKey: Record<string, string> = {
      Intake: 'ats',
      'Employee Master': 'sf-ec',
      'IAM/Access': 'idp',
      Learning: 'lms',
      'IT Assets': 'ticketing',
      'Payroll/Benefits': 'sf-ecp',
      Leave: 'time-system',
      Compliance: 'knowledge-base',
      Documents: 'doc-store',
      Communications: 'ticketing',
    };

    return {
      numSystems: Math.max(1, values.systems.length),
      annualTransactions: values.annualTransactions,
      employees: values.employees,
      sector: values.sector.toLowerCase(),
      companyType: values.companyType,
      isolationTier: values.isolationTier,
      hrHourlyCostUsd: values.hrHourlyCostUsd,
      hitlHourlyCostUsd: values.hitlHourlyCostUsd,
      countries: values.countries,
      landscapeMaturity: values.landscapeMaturity,
      contractYears: 3,
      nonIntegratedSystems: Array.from(new Set(
        values.systems
          .filter((system) => system.mode === 'Manual')
          .map((system) => manualSystemKey[system.domain])
          .filter(Boolean),
      )),
      ...(totalWeight > 0
        ? {
            intentShareOverrides: Object.fromEntries(
              includedIntents.map((intent) => [intent.key, intent.baseWeight / totalWeight]),
            ),
          }
        : {}),
    };
  };

  const handleSimulate = () => {
    const values = form.getValues();
    if (!intentCorpus) {
      setOperationError('The intent catalog is still loading. Please wait a moment and run the estimate again.');
      return;
    }
    const inputs = buildInputs(values);
    setOperationError(null);
    computeRollup.mutate({ data: { inputs } }, {
      onSuccess: (data) => setRollup(data),
      onError: (error: any) => setOperationError(error?.response?.data?.message || error?.message || 'The implementation estimate could not be generated.'),
    });
  }

  const handleCommit = () => {
    const values = form.getValues();
    const inputs = buildInputs(values);
    setOperationError(null);
    createScenario.mutate({ data: { name: `${values.clientName} — ${values.processMode} implementation`, inputs } }, {
      onSuccess: (data) => {
        draftPersistenceEnabled.current = false;
        localStorage.removeItem('clientSetupDraft');
        setScenario(data);
      },
      onError: (error: any) => setOperationError(error?.response?.data?.message || error?.message || 'The implementation scenario could not be saved.'),
    });
  }

  const isSimulating = computeRollup.isPending || (computeRollup as any).isLoading;
  const isCommitting = createScenario.isPending || (createScenario as any).isLoading;

  return (
     <div className="max-w-5xl mx-auto pb-12">
        <PageHeader 
          title="Implementation Cockpit" 
          subtitle="Rigorous parameter capture and integration planning." 
        />
        
        <div className="bg-[var(--surface)] rounded-[var(--radius-xl)] shadow-xl overflow-hidden border border-[var(--border)] mt-2">
          {/* Header */}
          <div className="bg-[var(--midnight)] text-[var(--dark-text)] p-6 relative overflow-hidden">
             {/* Decorative background element */}
             <div className="absolute -top-24 -right-24 w-64 h-64 bg-[var(--primary-dark)] opacity-20 rounded-full blur-3xl pointer-events-none" />
             
             {/* Progress */}
             <div className="flex items-center justify-between relative z-10">
                {STEPS.map((s, i) => {
                  const isActive = currentStep === i;
                  const isCompleted = currentStep > i;
                  return (
                    <div key={s.id} className="relative flex flex-col items-center flex-1 transition-opacity duration-300" style={{ opacity: isActive || isCompleted ? 1 : 0.4 }}>
                      <div className={`relative z-10 w-10 h-10 rounded-full border-2 flex items-center justify-center text-sm font-bold mb-3 transition-colors ${
                        isCompleted ? 'bg-[var(--status-green)] border-[var(--status-green)] text-[var(--midnight)]' :
                        isActive ? 'bg-[var(--primary)] border-[var(--primary)] text-white' :
                        'bg-[var(--dark-raised)] border-[var(--dark-border)] text-[var(--dark-text-muted)]'
                      }`}>
                         {isCompleted ? <Check className="w-5 h-5" /> : (i + 1)}
                      </div>
                      <div className={`hidden sm:block text-[11px] uppercase tracking-wider font-semibold transition-colors ${
                        isActive ? 'text-white' : 'text-[var(--dark-text-muted)]'
                      }`}>{s.label}</div>
                      
                      {/* Connector Line */}
                      {i < STEPS.length - 1 && (
                        <div className={`absolute h-0.5 top-5 left-[calc(50%+1.25rem)] w-[calc(100%-2.5rem)] transition-colors ${
                          isCompleted ? 'bg-[var(--status-green)]' : 'bg-[var(--dark-border)]'
                        }`} />
                      )}
                    </div>
                  );
                })}
             </div>
          </div>
          
          <FormProvider {...form}>
            <div className="p-4 sm:p-8">
               {currentStep === 0 && <StepScope />}
               {currentStep === 1 && <StepLandscape />}
               {currentStep === 2 && <StepProcess />}
               {currentStep === 3 && <StepReview 
                 onSimulate={handleSimulate} 
                 onCommit={handleCommit} 
                 rollup={rollup} 
                 scenario={scenario} 
                 isSimulating={isSimulating} 
                 isCommitting={isCommitting} 
                 operationError={operationError}
                  intentsLoading={intentsLoading}
               />}
            </div>
            
             <div className="bg-[var(--surface-alt)] p-4 sm:p-6 border-t border-[var(--border)] flex justify-between items-center gap-3">
               <Button type="button" variant="outline" onClick={handlePrev} disabled={currentStep === 0 || scenario !== null}>
                 Previous
               </Button>
               {currentStep < 3 ? (
                 <Button type="button" onClick={handleNext} className="px-6 bg-[var(--primary)] text-white">
                   Next Step <ChevronRight className="w-4 h-4 ml-1" />
                 </Button>
               ) : (
                 <div />
               )}
            </div>
          </FormProvider>
        </div>
     </div>
  );
}