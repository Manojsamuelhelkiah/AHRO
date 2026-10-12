import { useAdmission } from '@/lib/admission';

/** Identity comes only from the server-validated UAT admission. */
export function usePolicyScope(): { organizationId: string | null; userId: string | null } {
  const admission = useAdmission();
  return { organizationId: admission.organizationId, userId: admission.userId };
}
