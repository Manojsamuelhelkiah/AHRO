import { HR_APPROVER_EMAIL_KEY, getSetting, isValidEmail } from "./settings";
import { setDemoAllowlist } from "./channels";

/** Historical volunteer consent is never a live delivery permission. */
export async function refreshDemoAllowlist(organizationId: string): Promise<void> {
  const approver = (await getSetting(organizationId, HR_APPROVER_EMAIL_KEY))?.trim();
  setDemoAllowlist(organizationId, approver && isValidEmail(approver) ? [approver] : []);
}
export const initDemoAllowlist = refreshDemoAllowlist;
