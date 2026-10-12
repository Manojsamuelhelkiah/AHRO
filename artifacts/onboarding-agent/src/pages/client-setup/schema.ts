import { z } from 'zod';

export const personaSchema = z.object({
  role: z.string().min(1, 'Role is required'),
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Enter a valid business email'),
});

export const systemSchema = z.object({
  id: z.string().min(1, 'System instance ID is required'),
  key: z.string().min(1, 'System type is required'),
  name: z.string().min(1, 'System name is required'),
  vendor: z.string().min(1, 'Vendor is required'),
  mode: z.enum(['direct-integration', 'email-watch', 'file-transfer', 'webhook', 'manual']),
  ownerEmail: z.string().email('Enter a valid system owner email').or(z.literal('')),
  needsReview: z.boolean().optional(),
});

const MULTI_INSTANCE_SYSTEM_KEYS = new Set(['itsm', 'payroll']);

function legacySystemId(system: { key?: unknown }, index: number): string {
  const key = typeof system.key === 'string' && system.key ? system.key : 'system';
  return `legacy-${key}-${index + 1}`;
}

export function upgradeLegacySystemIds<T extends Record<string, unknown>>(draft: T): T {
  if (!Array.isArray(draft.systems)) return draft;
  return {
    ...draft,
    systems: draft.systems.map((system, index) =>
      system && typeof system === 'object' &&
        (!('id' in system) || typeof system.id !== 'string' || !system.id.trim())
        ? { ...system, id: legacySystemId(system, index) }
        : system),
  };
}

export const processFileSchema = z.object({
  id: z.number().int().positive(),
  scenarioId: z.number().int().positive().nullable().optional(),
  originalName: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  createdAt: z.string().min(1),
});

export const flowBasisSchema = z.object({
  source: z.enum(['product-base', 'product-base-with-overrides']),
  fingerprint: z.string().min(1),
  selectedDomains: z.array(z.string()).min(1),
  intentWeights: z.record(z.number().nonnegative()),
  overrideRefs: z.array(z.string()),
});

const clientSetupFieldsObject = z.object({
  clientName: z.string().min(1, 'Client name is required'),
  sector: z.string().min(1, 'Sector is required'),
  employees: z.coerce.number().min(1, 'Must be at least 1'),
  countries: z.coerce.number().min(1, 'Must be at least 1'),
  annualTransactions: z.coerce.number().min(1, 'Must be at least 1'),
  companyType: z.enum(['single-country', 'multi-country', 'global']),
  isolationTier: z.enum(['pooled', 'siloed', 'dedicated']),
  landscapeMaturity: z.enum(['clean', 'mixed', 'legacy']),
  hrHourlyCostUsd: z.coerce.number().min(1, 'Must be at least 1'),
  hitlHourlyCostUsd: z.coerce.number().min(1, 'Must be at least 1'),
  processMode: z.enum(['recommended', 'hybrid', 'custom']),
  flowBasis: flowBasisSchema.optional(),
  customizationStatus: z.enum(['none', 'pending-review', 'reviewed-overrides']).optional(),
  processBasisNeedsReview: z.boolean().optional(),
  selectedDomains: z.array(z.string()).min(1, 'Select at least one process domain'),
  processFiles: z.array(processFileSchema).default([]),
  personas: z.array(personaSchema).min(1, 'Add at least one accountable contact'),
  systems: z.array(systemSchema).min(1, 'Map at least one source system'),
  notes: z.string().default(''),
});

function withLegacySystemIds<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => {
    if (!value || typeof value !== 'object') return value;
    return upgradeLegacySystemIds(value as Record<string, unknown>);
  }, schema);
}

export const clientSetupDataSchema = withLegacySystemIds(
  clientSetupFieldsObject.omit({ processFiles: true, processBasisNeedsReview: true }).transform(({ systems, ...draft }) => ({
    ...draft,
    systems: systems.map(({ needsReview: _needsReview, ...system }) => system),
  })),
);

export const clientSetupSchema = withLegacySystemIds(clientSetupFieldsObject).superRefine((draft, ctx) => {
  const seenSystems = new Set<string>();
  const seenIds = new Set<string>();
  const watcherModes = new Map<string, string>();
  draft.systems.forEach((system, index) => {
    if (seenSystems.has(system.key) && !MULTI_INSTANCE_SYSTEM_KEYS.has(system.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['systems', index, 'key'],
        message: 'This system type can be mapped only once',
      });
    }
    seenSystems.add(system.key);
    if (!SUPPORTED_SETUP_MODES[system.key]?.has(system.mode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['systems', index, 'mode'],
        message: 'Choose a connection method supported by this system type',
      });
    }
    if (seenIds.has(system.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['systems', index, 'id'],
        message: 'Each mapped system instance must have a unique identity',
      });
    }
    seenIds.add(system.id);
    if (MULTI_INSTANCE_SYSTEM_KEYS.has(system.key)) {
      const watcherMode = system.mode === 'direct-integration'
        ? 'connected:api'
        : system.mode === 'email-watch'
          ? 'connected:email'
          : 'disconnected:api';
      const existing = watcherModes.get(system.key);
      if (existing && existing !== watcherMode) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['systems', index, 'mode'],
          message: 'All instances of this type must use the same connector-wide tracking mode',
        });
      }
      watcherModes.set(system.key, watcherMode);
    }
  });
  if (draft.processBasisNeedsReview) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['processMode'],
      message: 'Review the older custom arrangement and explicitly confirm its planning basis before continuing.',
    });
  }
});

export type ClientSetupDraft = z.infer<typeof clientSetupSchema>;

const LEGACY_SYSTEM_KEYS: Record<string, string> = {
  intake: 'ats',
  'employee master': 'hris',
  'iam/access': 'identity',
  learning: 'lms',
  'it assets': 'itsm',
  'payroll/benefits': 'payroll',
  leave: 'leave',
  compliance: 'compliance',
  documents: 'esignature',
  communications: 'communications',
  'applicant tracking system': 'ats',
  'applicant tracking': 'ats',
  'human resources information system': 'hris',
  'human resource information system': 'hris',
  'identity provider': 'identity',
  'learning management system': 'lms',
  'it service management': 'itsm',
  'payroll system': 'payroll',
  'leave management': 'leave',
  'compliance system': 'compliance',
  'electronic signature': 'esignature',
  'communications platform': 'communications',
  'background verification': 'bgv',
  'background check': 'bgv',
};
export const initialDraft: ClientSetupDraft = {
  clientName: '',
  sector: 'Technology',
  employees: 1000,
  countries: 1,
  annualTransactions: 50000,
  companyType: 'multi-country',
  isolationTier: 'siloed',
  landscapeMaturity: 'mixed',
  hrHourlyCostUsd: 50,
  hitlHourlyCostUsd: 65,
  processMode: 'recommended',
  selectedDomains: ['Hire', 'Pay', 'Leave', 'Benefits', 'Time', 'Mobility', 'Develop', 'Retire', 'Data/Admin', 'Policy'],
  processFiles: [],
  personas: [
    { role: 'Implementation lead', name: '', email: '' },
    { role: 'HR process owner', name: '', email: '' },
    { role: 'IAM / security approver', name: '', email: '' },
  ],
  systems: [
    { id: 'default-ats', key: 'ats', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
    { id: 'default-hris', key: 'hris', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
    { id: 'default-identity', key: 'identity', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
    { id: 'default-lms', key: 'lms', name: '', vendor: '', mode: 'file-transfer', ownerEmail: '' },
    { id: 'default-itsm', key: 'itsm', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
    { id: 'default-payroll', key: 'payroll', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
    { id: 'default-leave', key: 'leave', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
    { id: 'default-compliance', key: 'compliance', name: '', vendor: '', mode: 'file-transfer', ownerEmail: '' },
    { id: 'default-esignature', key: 'esignature', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
    { id: 'default-communications', key: 'communications', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
    { id: 'default-bgv', key: 'bgv', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
  ],
  notes: ''
};

export const demoDraft: ClientSetupDraft = {
  clientName: 'Northstar Global Services — Synthetic Demo',
  sector: 'Technology',
  employees: 12500,
  countries: 18,
  annualTransactions: 920000,
  companyType: 'global',
  isolationTier: 'siloed',
  landscapeMaturity: 'mixed',
  hrHourlyCostUsd: 58,
  hitlHourlyCostUsd: 78,
  processMode: 'recommended',
  selectedDomains: ['Hire', 'Pay', 'Leave', 'Benefits', 'Time', 'Mobility', 'Develop', 'Retire', 'Data/Admin', 'Policy'],
  processFiles: [],
  personas: [
    { role: 'Implementation lead', name: 'Avery Chen', email: 'avery.chen@example.com' },
    { role: 'HR process owner', name: 'Priya Raman', email: 'priya.raman@example.com' },
    { role: 'IAM / security approver', name: 'Mateo Silva', email: 'mateo.silva@example.com' },
  ],
  systems: [
    { id: 'demo-ats', key: 'ats', name: 'Greenhouse Recruiting', vendor: 'Greenhouse', mode: 'direct-integration', ownerEmail: 'recruiting.ops@example.com' },
    { id: 'demo-hris', key: 'hris', name: 'Workday HCM', vendor: 'Workday', mode: 'direct-integration', ownerEmail: 'hris@example.com' },
    { id: 'demo-identity', key: 'identity', name: 'Microsoft Entra ID', vendor: 'Microsoft', mode: 'direct-integration', ownerEmail: 'identity@example.com' },
    { id: 'demo-lms', key: 'lms', name: 'Cornerstone Learning Export', vendor: 'Cornerstone', mode: 'file-transfer', ownerEmail: 'learning@example.com' },
    { id: 'demo-itsm', key: 'itsm', name: 'ServiceNow ITSM', vendor: 'ServiceNow', mode: 'direct-integration', ownerEmail: 'it.operations@example.com' },
    { id: 'demo-payroll', key: 'payroll', name: 'SAP SuccessFactors Payroll', vendor: 'SAP', mode: 'direct-integration', ownerEmail: 'payroll@example.com' },
    { id: 'demo-leave', key: 'leave', name: 'Workday Absence', vendor: 'Workday', mode: 'direct-integration', ownerEmail: 'leave.admin@example.com' },
    { id: 'demo-compliance', key: 'compliance', name: 'Northstar Policy Export', vendor: 'Internal', mode: 'file-transfer', ownerEmail: 'compliance@example.com' },
    { id: 'demo-esignature', key: 'esignature', name: 'DocuSign', vendor: 'DocuSign', mode: 'direct-integration', ownerEmail: 'records@example.com' },
    { id: 'demo-communications', key: 'communications', name: 'Microsoft Teams', vendor: 'Microsoft', mode: 'direct-integration', ownerEmail: 'people.comms@example.com' },
    { id: 'demo-bgv', key: 'bgv', name: 'HireRight', vendor: 'HireRight', mode: 'email-watch', ownerEmail: 'screening@example.com' },
  ],
  notes: 'Synthetic demonstration profile. Every person, address, volume, and system mapping is fictional and can be edited.',
};

export function resolveInitialDraft(
  savedDraft: Partial<ClientSetupDraft> | null,
  useSyntheticDemo: boolean,
): ClientSetupDraft {
  const baseline = useSyntheticDemo ? demoDraft : initialDraft;
  const candidate = upgradeLegacySystemIds({
    ...baseline,
    ...(savedDraft ?? {}),
  }) as ClientSetupDraft;
  if (savedDraft && savedDraft.processMode !== undefined && savedDraft.processMode !== 'recommended' && !savedDraft.flowBasis) {
    candidate.processBasisNeedsReview = true;
  }
  const hasUnresolvedSystemChoice = candidate.systems.some(
    (system) => !system.key || !system.mode,
  );
  if (
    useSyntheticDemo
    && !hasUnresolvedSystemChoice
    && !savedDraft
    && !clientSetupSchema.safeParse(candidate).success
  ) {
    return demoDraft;
  }
  return candidate;
}

const CANONICAL_SYSTEM_KEYS = new Set(initialSystemKeys());

export function migrateLegacyClientSetupDraft(
  savedDraft: unknown,
): Partial<ClientSetupDraft> | null {
  if (savedDraft === null || typeof savedDraft !== 'object' || Array.isArray(savedDraft)) {
    return null;
  }

  const draft = { ...(savedDraft as Record<string, unknown>) };
  if (draft.processMode && draft.processMode !== 'recommended' && !draft.flowBasis) {
    draft.processBasisNeedsReview = true;
  }
  if (!Array.isArray(draft.systems)) return draft as Partial<ClientSetupDraft>;

  draft.systems = draft.systems.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const system = { ...(entry as Record<string, unknown>) };
    const normalizedKey = normalizedLegacyValue(system.key ?? system.domain);
    const normalizedMode = normalizedLegacyValue(system.mode);

    const key = CANONICAL_SYSTEM_KEYS.has(normalizedKey)
      ? normalizedKey
      : LEGACY_SYSTEM_KEYS[normalizedKey] ?? '';
    const mode = CANONICAL_SETUP_MODES.has(normalizedMode as SetupMode)
      ? normalizedMode
      : LEGACY_SETUP_MODES[normalizedMode] ?? '';
    system.key = key;
    system.mode = key && SUPPORTED_SETUP_MODES[key]?.has(mode as SetupMode) ? mode : '';
    if (!key || !mode || !SUPPORTED_SETUP_MODES[key]?.has(mode as SetupMode)) {
      system.needsReview = true;
    } else {
      delete system.needsReview;
    }
    delete system.domain;
    return system;
  });

  return draft as Partial<ClientSetupDraft>;
}

const LEGACY_SETUP_MODES: Record<string, ClientSetupDraft['systems'][number]['mode']> = {
  api: 'direct-integration',
  'direct integration': 'direct-integration',
  email: 'email-watch',
  'email watch': 'email-watch',
  'flat file': 'file-transfer',
  'file transfer': 'file-transfer',
  webhook: 'webhook',
  manual: 'manual',
};

function initialSystemKeys(): string[] {
  return ['ats', 'hris', 'identity', 'lms', 'itsm', 'payroll', 'leave', 'compliance', 'esignature', 'communications', 'bgv'];
}

function normalizedLegacyValue(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

const CANONICAL_SETUP_MODES = new Set(systemSchema.shape.mode.options);

type SetupMode = ClientSetupDraft['systems'][number]['mode'];

const SUPPORTED_SETUP_MODES: Record<string, ReadonlySet<SetupMode>> = {
  ats: new Set(['direct-integration', 'webhook', 'file-transfer', 'manual']),
  hris: new Set(['direct-integration', 'file-transfer', 'manual']),
  identity: new Set(['direct-integration', 'manual']),
  lms: new Set(['file-transfer', 'manual']),
  itsm: new Set(['direct-integration', 'email-watch', 'manual']),
  payroll: new Set(['direct-integration', 'email-watch', 'file-transfer', 'manual']),
  leave: new Set(['direct-integration', 'file-transfer', 'manual']),
  compliance: new Set(['file-transfer', 'manual']),
  esignature: new Set(['direct-integration', 'webhook', 'manual']),
  communications: new Set(['direct-integration', 'manual']),
  bgv: new Set(['direct-integration', 'email-watch', 'manual']),
};
