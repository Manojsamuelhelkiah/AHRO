import { z } from 'zod';

export const personaSchema = z.object({
  role: z.string().min(1, 'Role is required'),
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Enter a valid business email'),
});

export const systemSchema = z.object({
  domain: z.string().min(1, 'Domain is required'),
  name: z.string().min(1, 'System name is required'),
  vendor: z.string().min(1, 'Vendor is required'),
  mode: z.string().min(1, 'Integration mode is required'),
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
    { domain: 'Intake', name: '', vendor: '', mode: 'API', ownerEmail: '' },
    { domain: 'Employee Master', name: '', vendor: '', mode: 'API', ownerEmail: '' },
    { domain: 'IAM/Access', name: '', vendor: '', mode: 'API', ownerEmail: '' },
    { domain: 'Learning', name: '', vendor: '', mode: 'API', ownerEmail: '' },
    { domain: 'IT Assets', name: '', vendor: '', mode: 'API', ownerEmail: '' },
    { domain: 'Payroll/Benefits', name: '', vendor: '', mode: 'API', ownerEmail: '' },
    { domain: 'Leave', name: '', vendor: '', mode: 'API', ownerEmail: '' },
    { domain: 'Compliance', name: '', vendor: '', mode: 'API', ownerEmail: '' },
    { domain: 'Documents', name: '', vendor: '', mode: 'API', ownerEmail: '' },
    { domain: 'Communications', name: '', vendor: '', mode: 'API', ownerEmail: '' },
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
    { domain: 'Intake', name: 'Greenhouse Recruiting', vendor: 'Greenhouse', mode: 'API', ownerEmail: 'recruiting.ops@example.com' },
    { domain: 'Employee Master', name: 'Workday HCM', vendor: 'Workday', mode: 'API', ownerEmail: 'hris@example.com' },
    { domain: 'IAM/Access', name: 'Microsoft Entra ID', vendor: 'Microsoft', mode: 'API', ownerEmail: 'identity@example.com' },
    { domain: 'Learning', name: 'Cornerstone Learning', vendor: 'Cornerstone', mode: 'API', ownerEmail: 'learning@example.com' },
    { domain: 'IT Assets', name: 'ServiceNow ITSM', vendor: 'ServiceNow', mode: 'API', ownerEmail: 'it.operations@example.com' },
    { domain: 'Payroll/Benefits', name: 'SAP SuccessFactors Payroll', vendor: 'SAP', mode: 'API', ownerEmail: 'payroll@example.com' },
    { domain: 'Leave', name: 'Workday Absence', vendor: 'Workday', mode: 'API', ownerEmail: 'leave.admin@example.com' },
    { domain: 'Compliance', name: 'Northstar Policy Hub', vendor: 'Internal', mode: 'Manual', ownerEmail: 'compliance@example.com' },
    { domain: 'Documents', name: 'SharePoint Records', vendor: 'Microsoft', mode: 'API', ownerEmail: 'records@example.com' },
    { domain: 'Communications', name: 'Microsoft Teams', vendor: 'Microsoft', mode: 'API', ownerEmail: 'people.comms@example.com' },
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
