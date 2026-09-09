import React, { useState, useEffect, useRef } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { clientSetupSchema, clientSetupDataSchema, ClientSetupDraft, initialDraft } from './schema';
import { canNavigateOrCommit, planScenarioHydration } from './client-setup-persistence';
import { StepScope, StepLandscape, StepProcess, StepReview } from './wizard-steps';
import { Button, PageHeader } from '@/components/ui-shared';
import { useCreateScenario, useComputeRollup, useListIntents, useGetScenario, getGetScenarioQueryKey } from '@workspace/api-client-react';
import type { Rollup, Scenario, ScenarioInputs } from '@workspace/api-client-react';
import { Building2, Check, ChevronRight, Copy, FlaskConical, Users } from 'lucide-react';

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

type OrganizationSummary = {
  organizationId: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
};
function ClientSetupWizard() {
  const savedScenarioId = Number(new URLSearchParams(window.location.search).get('scenarioId'));
  const [currentStep, setCurrentStep] = useState(0);
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [fileOperationPending, setFileOperationPending] = useState(false);
  const fileOperationPendingRef = useRef(false);
  const activeScenarioIdRef = useRef<number | null>(null);
  const draftPersistenceEnabled = useRef(true);
  
  const form = useForm<ClientSetupDraft>({
    resolver: zodResolver(clientSetupSchema),
    defaultValues: loadInitialDraft(),
  });

  const handleFileOperationPendingChange = React.useCallback((pending: boolean) => {
    fileOperationPendingRef.current = pending;
    setFileOperationPending(pending);
  }, []);

  useEffect(() => {
    const sub = form.watch((value) => {
      if (!draftPersistenceEnabled.current) return;
      localStorage.setItem('clientSetupDraft', JSON.stringify(value));
    });
    return () => sub.unsubscribe();
  }, [form]);

  const handleNext = async () => {
    if (!canNavigateOrCommit(fileOperationPendingRef.current)) return;
    let fieldsToValidate: (keyof ClientSetupDraft)[] = [];
    if (currentStep === 0) fieldsToValidate = ['clientName', 'sector', 'employees', 'countries', 'annualTransactions', 'hrHourlyCostUsd', 'hitlHourlyCostUsd'];
    if (currentStep === 1) fieldsToValidate = ['companyType', 'isolationTier', 'landscapeMaturity', 'systems'];
    if (currentStep === 2) fieldsToValidate = ['processMode', 'selectedDomains', 'processFiles', 'personas'];
    
    const isValid = await form.trigger(fieldsToValidate);
    if (isValid) setCurrentStep(c => Math.min(STEPS.length - 1, c + 1));
  };

  const handlePrev = () => {
    if (!canNavigateOrCommit(fileOperationPendingRef.current)) return;
    setCurrentStep(c => Math.max(0, c - 1));
  };
  
  const computeRollup = useComputeRollup();
  const createScenario = useCreateScenario();
  const { data: reloadedScenario } = useGetScenario(savedScenarioId || 0, {
    query: { enabled: Number.isInteger(savedScenarioId) && savedScenarioId > 0, queryKey: getGetScenarioQueryKey(savedScenarioId || 0) },
  });
  const { data: intentCorpus, isLoading: intentsLoading } = useListIntents();

  useEffect(() => {
    if (reloadedScenario) {
      const hydrationPlan = planScenarioHydration(
        activeScenarioIdRef.current,
        form.getValues('processFiles'),
      );
      if (!hydrationPlan.shouldHydrateSetup) return;
      draftPersistenceEnabled.current = false;
      const parsedSetup = clientSetupDataSchema.safeParse(reloadedScenario.setupData);
      if (!parsedSetup.success) {
        setOperationError('The saved setup details are missing or invalid; stale local defaults were not displayed.');
        setScenario(null);
        return;
      }
      form.reset({ ...parsedSetup.data, processFiles: hydrationPlan.processFiles });
      activeScenarioIdRef.current = reloadedScenario.id;
      setScenario(reloadedScenario);
      setCurrentStep(STEPS.length - 1);
    }
  }, [form, reloadedScenario]);

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
    if (!canNavigateOrCommit(fileOperationPendingRef.current)) {
      setOperationError('Wait for the file upload to finish before committing this scenario.');
      return;
    }
    const values = form.getValues();
    const inputs = buildInputs(values);
    const { processFiles, ...setupData } = values;
    setOperationError(null);
    createScenario.mutate({ data: { name: `${values.clientName} — ${values.processMode} implementation`, inputs, setupData, fileIds: processFiles.map((file) => file.id) } }, {
      onSuccess: (data) => {
        activeScenarioIdRef.current = data.id;
        draftPersistenceEnabled.current = false;
        localStorage.removeItem('clientSetupDraft');
        setScenario(data);
         window.history.replaceState(null, '', `${window.location.pathname}?scenarioId=${data.id}`);
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
               {currentStep === 2 && <StepProcess onFileOperationPendingChange={handleFileOperationPendingChange} />}
               {currentStep === 3 && <StepReview 
                 onSimulate={handleSimulate} 
                 onCommit={handleCommit} 
                 rollup={rollup} 
                 scenario={scenario} 
                 isSimulating={isSimulating} 
                 isCommitting={isCommitting} 
                 isFileOperationPending={fileOperationPending}
                 onFileOperationPendingChange={handleFileOperationPendingChange}
                 operationError={operationError}
                  intentsLoading={intentsLoading}
               />}
            </div>
            
             <div className="bg-[var(--surface-alt)] p-4 sm:p-6 border-t border-[var(--border)] flex justify-between items-center gap-3">
               <Button type="button" variant="outline" onClick={handlePrev} disabled={currentStep === 0 || scenario !== null || fileOperationPending}>
                 Previous
               </Button>
               {currentStep < 3 ? (
                  <Button type="button" onClick={handleNext} disabled={fileOperationPending} className="px-6 bg-[var(--primary)] text-white">
                    {fileOperationPending ? 'Uploading file…' : <>Next Step <ChevronRight className="w-4 h-4 ml-1" /></>}
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
export function ClientSetupPage() {
  const [organization, setOrganization] = useState<OrganizationSummary | null>();
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    organizationRequest('/organizations/current')
      .then((data: CurrentOrganizationResponse) => {
        if (!active) return;
        const selected = data.memberships.find(
          (membership) => membership.organizationId === data.activeOrganizationId,
        ) ?? data.memberships[0];
        if (selected) {
          localStorage.setItem('activeOrganizationId', selected.organizationId);
          setOrganization(selected);
        } else {
          setOrganization(null);
        }
      })
      .catch((caught) => {
        if (active) setLoadError(caught instanceof Error ? caught.message : 'Could not load organization access');
      });
    return () => {
      active = false;
    };
  }, []);

  if (loadError) {
    return <div role="alert" className="mx-auto mt-12 max-w-xl rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">{loadError}</div>;
  }
  if (organization === undefined) {
    return <div className="flex min-h-[60vh] items-center justify-center text-sm text-slate-500">Loading organization…</div>;
  }
  if (organization === null) {
    return <OrganizationSetup onReady={setOrganization} />;
  }
  return <ClientSetupWizard />;
}

function OrganizationSetup({
  onReady,
}: {
  onReady: (organization: OrganizationSummary) => void;
}) {
  const pendingOrganization = loadPendingOrganization();
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [createdOrganization, setCreatedOrganization] = useState<OrganizationSummary | null>(
    pendingOrganization?.organization ?? null,
  );
  const [createdJoinCode, setCreatedJoinCode] = useState(pendingOrganization?.joinCode ?? '');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (kind: 'create' | 'join' | 'demo') => {
    setSaving(true);
    setError(null);
    try {
      const result = await organizationRequest(
        kind === 'create' ? '/organizations' : '/organizations/join',
        {
          method: 'POST',
          body: JSON.stringify(
            kind === 'create'
              ? { name }
              : kind === 'demo'
                ? { demo: true }
                : { joinCode },
          ),
        },
      );
      const organization = {
        organizationId: result.organization.id,
        name: result.organization.name,
        role: result.role,
      } as OrganizationSummary;
      if (kind === 'create') {
        if (typeof result.joinCode !== 'string' || !result.joinCode) {
          throw new Error('The organization was created, but its join code was not returned. Do not create another organization; contact support.');
        }
        try {
          sessionStorage.setItem(
            PENDING_ORGANIZATION_KEY,
            JSON.stringify({ organization, joinCode: result.joinCode }),
          );
        } catch {
          // The visible component state still preserves the code for this visit.
        }
        setCreatedOrganization(organization);
        setCreatedJoinCode(result.joinCode);
        return;
      }
      localStorage.setItem('activeOrganizationId', organization.organizationId);
      onReady(organization);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Organization setup failed');
    } finally {
      setSaving(false);
    }
  };

  const copyJoinCode = async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(createdJoinCode);
      setCopied(true);
    } catch {
      setError('Could not copy automatically. Select the join code and copy it manually.');
    }
  };

  const continueWithOrganization = () => {
    if (!createdOrganization) return;
    localStorage.setItem('activeOrganizationId', createdOrganization.organizationId);
    try {
      sessionStorage.removeItem(PENDING_ORGANIZATION_KEY);
    } catch {
      // Continuing does not depend on session storage being available.
    }
    onReady(createdOrganization);
  };

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-3xl items-center px-4 py-12">
      <div className="w-full rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl sm:p-10">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700">
            <Building2 className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">
            {createdOrganization ? 'Save your workspace join code' : 'Set up your organization'}
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            {createdOrganization
              ? 'This code is shown only once. Save it now so teammates can join your workspace.'
              : 'Client data belongs to an application workspace, separate from your Clerk sign-in.'}
          </p>
        </div>

        {createdOrganization ? (
          <>
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
              <p className="text-sm font-semibold text-slate-800">{createdOrganization.name}</p>
              <label htmlFor="created-organization-join-code" className="mt-3 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                One-time join code
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  id="created-organization-join-code"
                  readOnly
                  value={createdJoinCode}
                  onFocus={(event) => event.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-lg border border-indigo-300 bg-white px-3 py-2.5 font-mono text-base font-bold tracking-wider text-slate-900"
                />
                <button type="button" onClick={copyJoinCode} className="inline-flex items-center justify-center rounded-lg border border-indigo-300 bg-white px-3 text-sm font-semibold text-indigo-700 hover:bg-indigo-100">
                  {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="mt-3 text-xs leading-5 text-slate-600">
                Send this code to teammates you want to invite. They can enter it under “Join workspace.”
              </p>
            </div>
            {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <Button type="button" onClick={continueWithOrganization} className="mt-6 w-full justify-center bg-indigo-600 text-white">
              I’ve saved the code — Continue
            </Button>
          </>
        ) : (
          <>
        <div className="mb-6 grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-1">
          <button type="button" onClick={() => setMode('create')} className={`rounded-md px-3 py-2 text-sm font-semibold ${mode === 'create' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600'}`}>
            Create workspace
          </button>
          <button type="button" onClick={() => setMode('join')} className={`rounded-md px-3 py-2 text-sm font-semibold ${mode === 'join' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600'}`}>
            Join workspace
          </button>
        </div>

        {mode === 'create' ? (
          <label className="block text-sm font-semibold text-slate-700">
            Organization name
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Acme People Operations" className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-indigo-500" />
          </label>
        ) : (
          <label className="block text-sm font-semibold text-slate-700">
            Join code
            <input value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="Enter the code from your workspace owner" className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-mono font-normal uppercase outline-none focus:border-indigo-500" />
          </label>
        )}

        {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <Button type="button" disabled={saving || (mode === 'create' ? name.trim().length < 2 : !joinCode.trim())} onClick={() => submit(mode)} className="mt-6 w-full justify-center bg-indigo-600 text-white">
          {mode === 'create' ? <Building2 className="mr-2 h-4 w-4" /> : <Users className="mr-2 h-4 w-4" />}
          {saving ? 'Setting up…' : mode === 'create' ? 'Create organization' : 'Join organization'}
        </Button>

        <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-wider text-slate-400">
          <span className="h-px flex-1 bg-slate-200" />or<span className="h-px flex-1 bg-slate-200" />
        </div>
        <button type="button" disabled={saving} onClick={() => submit('demo')} className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          <FlaskConical className="h-4 w-4" /> Explore the Demo Organization
        </button>
          </>
        )}
      </div>
    </div>
  );
}

const PENDING_ORGANIZATION_KEY = 'onboardingAgentPendingOrganization';

function loadPendingOrganization(): { organization: OrganizationSummary; joinCode: string } | null {
  try {
    const pending = JSON.parse(sessionStorage.getItem(PENDING_ORGANIZATION_KEY) || 'null');
    if (
      typeof pending?.organization?.organizationId === 'string'
      && typeof pending?.organization?.name === 'string'
      && typeof pending?.joinCode === 'string'
      && pending.joinCode
    ) {
      return pending;
    }
  } catch {
    // Ignore corrupt or unavailable session storage.
  }
  return null;
}

async function organizationRequest(path: string, init?: RequestInit) {
  const organizationId = localStorage.getItem('activeOrganizationId');
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(organizationId ? { 'X-Organization-Id': organizationId } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || 'Organization setup failed');
  }
  return body;
}

type CurrentOrganizationResponse = {
  needsSetup: boolean;
  activeOrganizationId: string | null;
  memberships: OrganizationSummary[];
};
