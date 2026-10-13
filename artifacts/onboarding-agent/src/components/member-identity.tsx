import type { AccessOrganizationMember } from "@workspace/api-client-react";

export type DisplayMember = Pick<AccessOrganizationMember, "clerkUserId" | "name" | "email" | "identityResolution" | "accountKind">;

function shortId(member: DisplayMember, peers: DisplayMember[]): string {
  const id = member.clerkUserId;
  let length = Math.min(8, id.length);
  while (length < id.length && peers.some((peer) =>
    peer.clerkUserId !== id && peer.clerkUserId.endsWith(id.slice(-length)))) length++;
  return length < id.length ? `…${id.slice(-length)}` : id;
}

export function identityLabel(member: DisplayMember, peers: DisplayMember[] = []): string {
  if (member.accountKind === "internal") return "Internal/test account · Development smoke test";
  const name = member.name?.trim();
  const email = member.email?.trim();
  if (name) {
    const duplicate = email && peers.some((peer) => peer.clerkUserId !== member.clerkUserId &&
      peer.name?.trim() === name && peer.email?.trim() === email);
    return `${name} · ${email || shortId(member, peers)}${duplicate ? ` · ${shortId(member, peers)}` : ""}`;
  }
  if (email) {
    const duplicate = peers.some((peer) => peer.clerkUserId !== member.clerkUserId && peer.email?.trim() === email);
    return duplicate ? `${email} · ${shortId(member, peers)}` : email;
  }
  const status = member.identityResolution === "unavailable"
    ? "Directory unavailable" : member.identityResolution === "resolved"
      ? "Unnamed account" : "Unresolved account";
  return `${status} · ${shortId(member, peers)}`;
}

export function IdentityDetails({ member, peers = [] }: { member: DisplayMember; peers?: DisplayMember[] }) {
  return <div className="min-w-0">
    <p className="break-words font-medium">{identityLabel(member, peers)}</p>
    {member.identityResolution === "missing" && <p className="text-xs text-[var(--text-muted)]">No directory profile found.</p>}
    <details className="mt-1 text-xs text-[var(--text-muted)]">
      <summary className="cursor-pointer">Technical account ID</summary>
      <code className="block select-all break-all py-1">{member.clerkUserId}</code>
    </details>
  </div>;
}

export function DirectoryWarning({ members, retry, busy = false }: {
  members: DisplayMember[]; retry: () => void; busy?: boolean;
}) {
  if (!members.some((member) => member.identityResolution === "unavailable")) return null;
  return <div role="alert" className="rounded-md border border-[var(--border)] p-3 text-xs">
    <p>Some member profiles could not be loaded from the identity directory. Memberships and access controls are still available. Names and emails are display information, not permissions or verified contact addresses.</p>
    <button type="button" className="mt-2 underline disabled:opacity-50" disabled={busy} onClick={retry}>Retry directory lookup</button>
  </div>;
}
