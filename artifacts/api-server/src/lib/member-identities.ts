import { clerkClient } from "@clerk/express";
import { INTERNAL_SMOKE_USER_ID } from "../middlewares/require-auth";

export type MemberIdentity = {
  name?: string | null;
  email?: string | null;
  identityResolution: "resolved" | "missing" | "unavailable" | "internal";
  accountKind: "human" | "internal";
};
export type DirectoryLabel = { id: string; name: string | null; email: string | null };

export function isInternalAccount(userId: string): boolean {
  // Trusted exact identity only. ID formats and profile names are not evidence.
  return userId === INTERNAL_SMOKE_USER_ID;
}

async function loadDirectoryLabels(ids: string[]): Promise<DirectoryLabel[]> {
  const users = await clerkClient.users.getUserList({ userId: ids, limit: 100 });
  return users.data.map((user) => ({
    id: user.id,
    name: [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || null,
    email: user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)?.emailAddress ?? null,
  }));
}

/**
 * Enrich only records selected by an already-authorized, tenant-scoped caller.
 * Request-local maps deliberately avoid caching personal data across tenants or
 * authorization changes. Directory metadata is display-only, never authority.
 */
export async function enrichMemberIdentities<T extends { clerkUserId: string }>(
  members: T[],
  loadLabels: (ids: string[]) => Promise<DirectoryLabel[]> = loadDirectoryLabels,
): Promise<Array<T & MemberIdentity>> {
  const identities = new Map<string, MemberIdentity>();
  const ids = [...new Set(members.map((member) => member.clerkUserId))];
  const humanIds = ids.filter((id) => !isInternalAccount(id));
  for (let offset = 0; offset < humanIds.length; offset += 100) {
    const batch = humanIds.slice(offset, offset + 100);
    try {
      const labels = await loadLabels(batch);
      const scoped = new Map(labels.filter((label) => batch.includes(label.id)).map((label) => [label.id, label]));
      for (const id of batch) {
        const label = scoped.get(id);
        identities.set(id, {
          accountKind: "human", identityResolution: label ? "resolved" : "missing",
          name: label?.name ?? null, email: label?.email ?? null,
        });
      }
    } catch {
      for (const id of batch) identities.set(id, {
        accountKind: "human", identityResolution: "unavailable", name: null, email: null,
      });
    }
  }
  return members.map((member) => ({
    ...member,
    ...(isInternalAccount(member.clerkUserId)
      ? { accountKind: "internal" as const, identityResolution: "internal" as const, name: null, email: null }
      : identities.get(member.clerkUserId)!),
  }));
}
