type TestRole = "owner" | "admin" | null;

export function useOrganizationRole() {
  const role = (globalThis as typeof globalThis & {
    __organizationMembersTestRole: TestRole;
  }).__organizationMembersTestRole;

  return {
    role,
    loading: false,
    organizationId: "org-test",
    isHR: role === "owner" || role === "admin",
  };
}