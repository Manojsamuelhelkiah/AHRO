import { z } from 'zod';

export const personaSchema = z.object({
  role: z.string().min(1, 'Role is required'),
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Enter a valid business email'),
});

export const systemSchema = z.object({
  key: z.string().min(1, 'System type is required'),
  name: z.string().min(1, 'System name is required'),
  vendor: z.string().min(1, 'Vendor is required'),
  mode: z.enum(['direct-integration', 'email-watch', 'file-transfer', 'webhook', 'manual']),
  ownerEmail: z.string().email('Enter a valid system owner email').or(z.literal('')),
});

export const processFileSchema = z.object({
  id: z.number().int().positive(),
  scenarioId: z.number().int().positive().nullable().optional(),
  originalName: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  createdAt: z.string().min(1),
});

const clientSetupFieldsSchema = z.object({
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
  selectedDomains: z.array(z.string()).min(1, 'Select at least one process domain'),
  processFiles: z.array(processFileSchema).default([]),
  personas: z.array(personaSchema).min(1, 'Add at least one accountable contact'),
  systems: z.array(systemSchema).min(1, 'Map at least one source system'),
  notes: z.string().default(''),
});

export const clientSetupDataSchema = clientSetupFieldsSchema.omit({ processFiles: true });

export const clientSetupSchema = clientSetupFieldsSchema.superRefine((draft, ctx) => {
  const seenSystems = new Set<string>();
  draft.systems.forEach((system, index) => {
    if (seenSystems.has(system.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['systems', index, 'key'],
        message: 'Each system type can be mapped only once',
      });
    }
    seenSystems.add(system.key);
  });
  if (draft.processMode !== 'recommended' && draft.processFiles.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['processFiles'],
      message: 'Upload at least one client flow for hybrid or custom adoption',
    });
  }
});

export type ClientSetupDraft = z.infer<typeof clientSetupSchema>;

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
    { key: 'ats', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
    { key: 'hris', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
    { key: 'identity', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
    { key: 'lms', name: '', vendor: '', mode: 'file-transfer', ownerEmail: '' },
    { key: 'itsm', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
    { key: 'payroll', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
    { key: 'leave', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
    { key: 'compliance', name: '', vendor: '', mode: 'file-transfer', ownerEmail: '' },
    { key: 'esignature', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
    { key: 'communications', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
    { key: 'bgv', name: '', vendor: '', mode: 'direct-integration', ownerEmail: '' },
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
    { key: 'ats', name: 'Greenhouse Recruiting', vendor: 'Greenhouse', mode: 'direct-integration', ownerEmail: 'recruiting.ops@example.com' },
    { key: 'hris', name: 'Workday HCM', vendor: 'Workday', mode: 'direct-integration', ownerEmail: 'hris@example.com' },
    { key: 'identity', name: 'Microsoft Entra ID', vendor: 'Microsoft', mode: 'direct-integration', ownerEmail: 'identity@example.com' },
    { key: 'lms', name: 'Cornerstone Learning Export', vendor: 'Cornerstone', mode: 'file-transfer', ownerEmail: 'learning@example.com' },
    { key: 'itsm', name: 'ServiceNow ITSM', vendor: 'ServiceNow', mode: 'direct-integration', ownerEmail: 'it.operations@example.com' },
    { key: 'payroll', name: 'SAP SuccessFactors Payroll', vendor: 'SAP', mode: 'direct-integration', ownerEmail: 'payroll@example.com' },
    { key: 'leave', name: 'Workday Absence', vendor: 'Workday', mode: 'direct-integration', ownerEmail: 'leave.admin@example.com' },
    { key: 'compliance', name: 'Northstar Policy Export', vendor: 'Internal', mode: 'file-transfer', ownerEmail: 'compliance@example.com' },
    { key: 'esignature', name: 'DocuSign', vendor: 'DocuSign', mode: 'direct-integration', ownerEmail: 'records@example.com' },
    { key: 'communications', name: 'Microsoft Teams', vendor: 'Microsoft', mode: 'direct-integration', ownerEmail: 'people.comms@example.com' },
    { key: 'bgv', name: 'HireRight', vendor: 'HireRight', mode: 'email-watch', ownerEmail: 'screening@example.com' },
  ],
  notes: 'Synthetic demonstration profile. Every person, address, volume, and system mapping is fictional and can be edited.',
};

export function resolveInitialDraft(
  savedDraft: Partial<ClientSetupDraft> | null,
  useSyntheticDemo: boolean,
): ClientSetupDraft {
  const baseline = useSyntheticDemo ? demoDraft : initialDraft;
  const candidate = { ...baseline, ...(savedDraft ?? {}) };
  if (useSyntheticDemo && !clientSetupSchema.safeParse(candidate).success) {
    return demoDraft;
  }
  return candidate;
}
