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
