import type { ClientSetupDraft } from './schema';

const ASSUMPTION_SYSTEM_KEY: Record<string, string> = {
  ats: 'ats',
  hris: 'sf-ec',
  identity: 'idp',
  lms: 'lms',
  itsm: 'ticketing',
  payroll: 'sf-ecp',
  leave: 'time-system',
  compliance: 'knowledge-base',
  esignature: 'doc-store',
  communications: 'ticketing',
  bgv: 'bgv',
};

export function countMappedEstates(systems: ClientSetupDraft['systems']): number {
  return Math.max(1, systems.length);
}

export function nonIntegratedSystemKeys(systems: ClientSetupDraft['systems']): string[] {
  return Array.from(new Set(
    systems
      .filter((system) => system.mode === 'manual' || system.mode === 'file-transfer')
      .map((system) => ASSUMPTION_SYSTEM_KEY[system.key])
      .filter(Boolean),
  ));
}