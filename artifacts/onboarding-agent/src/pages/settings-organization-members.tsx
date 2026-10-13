import { useState } from "react";
import {
  getListOrganizationMembersQueryKey,
  getListRemovedOrganizationMembersQueryKey,
  useListRemovedOrganizationMembers,
  useReinstateOrganizationMember,
  type RemovedOrganizationMember,
  useChangeOrganizationMemberRole,
  useListOrganizationMembers,
  useRemoveOrganizationMember,
  type OrganizationMember,
  type OrganizationMemberRole,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { UserRound, UserRoundCog } from "lucide-react";
import { Badge, Button, Card, CardContent, IconTile, LoadingBlock, cn } from "@/components/ui-shared";
import { useOrganizationRole } from "@/hooks/use-organization-role";

function mutationMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "The membership change failed.";
  const value = error as { message?: unknown; error?: unknown };
  return typeof value.message === "string"
    ? value.message
    : typeof value.error === "string"
      ? value.error
      : "The membership change failed.";
}

export function OrganizationMembersSettings() {
  const { role, loading: roleLoading } = useOrganizationRole();
  const queryClient = useQueryClient();
  const canRead = role === "owner" || role === "admin";
  const canManage = role === "owner";
  const members = useListOrganizationMembers({
    query: { enabled: canRead, queryKey: getListOrganizationMembersQueryKey() },
  });
  const removedMembers = useListRemovedOrganizationMembers({
    query: { enabled: canManage, queryKey: getListRemovedOrganizationMembersQueryKey(), staleTime: 0 },
  });
  const [selected, setSelected] = useState<RemovedOrganizationMember | null>(null);
  const [reason, setReason] = useState("");
  const refreshMemberships = () => {
    void queryClient.invalidateQueries({ queryKey: getListOrganizationMembersQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListRemovedOrganizationMembersQueryKey() });
  };
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const reinstate = useReinstateOrganizationMember({
    mutation: {
      onSuccess: () => {
        setSelected(null);
        setReason("");
        setNotice({ ok: true, message: "Account reinstated as an ordinary member. Specialist grants and historical approval receipts remain revoked." });
        refreshMemberships();
      },
      onError: (error) => {
        setNotice({ ok: false, message: mutationMessage(error) });
        setSelected(null);
        setReason("");
        refreshMemberships();
      },
    },
  });
  const roleChange = useChangeOrganizationMemberRole({
    mutation: {
      onSuccess: () => {
        setNotice({ ok: true, message: "Member role updated." });
        void queryClient.invalidateQueries({ queryKey: getListOrganizationMembersQueryKey() });
      },
      onError: (error) => setNotice({ ok: false, message: mutationMessage(error) }),
    },
  });
  const remove = useRemoveOrganizationMember({
    mutation: {
      onSuccess: () => {
        setNotice({ ok: true, message: "Membership revoked. The member can no longer access this organization." });
        refreshMemberships();
      },
      onError: (error) => setNotice({ ok: false, message: mutationMessage(error) }),
    },
  });

  if (roleLoading || !canRead) return null;
  const rows = members.data ?? [];
  const busy = roleChange.isPending || remove.isPending || reinstate.isPending;

  const changeRole = (member: OrganizationMember, nextRole: OrganizationMemberRole) => {
    if (!canManage || nextRole === "owner" || nextRole === member.role) return;
    setNotice(null);
    roleChange.mutate({
      userId: member.clerkUserId,
      data: { expectedRole: member.role, role: nextRole },
    });
  };

  const revoke = (member: OrganizationMember) => {
    if (!canManage || !window.confirm(
      `Remove ${member.clerkUserId} from this organization?\n\nThis revokes organization access and existing specialist approval authority. Shared join codes cannot restore access. Historical records are retained. Only an owner can explicitly reinstate ordinary membership.`,
    )) return;
    setNotice(null);
    remove.mutate({
      userId: member.clerkUserId,
      data: { expectedRole: member.role },
    });
  };

  return (
    <Card className="p-0 overflow-hidden">
      <CardContent className="p-0">
        <div className="p-4 border-b border-[var(--border)] bg-[var(--surface-alt)] flex items-start justify-between gap-3">
          <div className="flex gap-3">
            <IconTile
              icon={UserRoundCog}
              className="bg-[var(--primary-light)] text-[var(--primary)] border-transparent"
            />
            <div>
              <h3 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">
                Organization members
              </h3>
              <p className="mt-1 text-[var(--text-xs)] text-[var(--text-muted)]">
                Review active membership and manage roles. Removed accounts remain revoked and cannot rejoin with an old code.
              </p>
            </div>
          </div>
          <Badge className="bg-[var(--status-green-bg)] text-[var(--status-green-fg)]">
            {rows.length} active
          </Badge>
        </div>
        <div className="p-4 space-y-3">
          {members.isLoading ? (
            <LoadingBlock>Loading members...</LoadingBlock>
          ) : members.isError ? (
            <p className="text-[var(--text-xs)] text-[var(--status-red-fg)]">
              {mutationMessage(members.error)}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-[var(--text-xs)] text-[var(--text-muted)]">No active members were found.</p>
          ) : (
            rows.map((member) => (
              <div
                key={member.clerkUserId}
                className="flex flex-col gap-3 rounded-md border border-[var(--border)] p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <UserRound className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                  <div className="min-w-0">
                    <p className="truncate text-[var(--text-xs)] font-medium text-[var(--text-primary)]">
                      {member.clerkUserId}
                    </p>
                    <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
                      Joined {new Date(member.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {member.role === "owner" ? (
                    <Badge className="bg-[var(--status-blue-bg)] text-[var(--status-blue-fg)]">owner</Badge>
                  ) : (
                    <select
                      aria-label={`Role for ${member.clerkUserId}`}
                      value={member.role}
                      disabled={!canManage || busy}
                      onChange={(event) => changeRole(member, event.target.value as OrganizationMemberRole)}
                      className={cn(
                        "h-8 rounded-md border border-input bg-background px-2 text-[var(--text-xs)]",
                        !canManage && "opacity-70",
                      )}
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                  )}
                  {member.role !== "owner" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-[var(--status-red)]"
                      disabled={!canManage || busy}
                      onClick={() => revoke(member)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
          {canManage && (
            <section className="space-y-3 border-t border-[var(--border)] pt-4" aria-label="Removed members">
              <h4 className="text-sm font-semibold">Removed members</h4>
              <p className="text-xs text-[var(--text-muted)]">
                Only an owner can reinstate an account, as an ordinary member. Legal, Payroll,
                Occupational Health and all other specialist grants and historical approval receipts
                remain revoked. Fresh verified grants require the existing governed process.
              </p>
              {removedMembers.isLoading ? <LoadingBlock>Loading removed members...</LoadingBlock>
                : removedMembers.isError ? (
                  <div role="alert" className="text-xs text-[var(--status-red-fg)]">
                    {mutationMessage(removedMembers.error)}
                    <Button variant="outline" size="sm" onClick={() => void removedMembers.refetch()}>Retry</Button>
                  </div>
                ) : (removedMembers.data ?? []).length === 0 ? (
                  <p className="text-xs text-[var(--text-muted)]">No removed members were found.</p>
                ) : (removedMembers.data ?? []).map((member) => (
                  <div key={member.clerkUserId} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--border)] p-3">
                    <div className="min-w-0 text-xs">
                      <p className="break-all font-medium">{member.clerkUserId}</p>
                      <p className="text-[var(--text-muted)]">Removed {new Date(member.revokedAt).toLocaleString()}</p>
                    </div>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => {
                      setSelected(member);
                      setReason("");
                      setNotice(null);
                    }}>Review reinstatement</Button>
                  </div>
                ))}
              {selected && (
                <form className="space-y-3 rounded-md border border-[var(--border)] p-3" onSubmit={(event) => {
                  event.preventDefault();
                  if (!canManage || busy || !reason.trim()) return;
                  reinstate.mutate({ userId: selected.clerkUserId, data: { expectedRevokedAt: selected.revokedAt, expectedRevision: selected.revision, reason: reason.trim() } });
                }}>
                  <p className="break-all text-sm font-medium">Reinstate {selected.clerkUserId} as member?</p>
                  <label className="block text-xs">
                    Reason for reinstatement (required)
                    <textarea required maxLength={1000} value={reason} disabled={busy}
                      onChange={(event) => setReason(event.target.value)}
                      className="mt-2 block w-full rounded-md border border-input bg-background p-2"
                    />
                  </label>
                  <p className="text-xs text-[var(--text-muted)]">This reason is retained in the audit record and visible to authorized audit reviewers. Do not include sensitive personal or medical details. Reinstatement does not restore administrative access or previously revoked permissions.</p>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={busy || !reason.trim()}>{reinstate.isPending ? "Reinstating..." : "Reinstate as member"}</Button>
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setSelected(null); setReason(""); }}>Cancel</Button>
                  </div>
                </form>
              )}
            </section>
          )}
          {notice && (
            <p
              role="status"
              className={cn(
                "rounded-md p-3 text-[var(--text-xs)]",
                notice.ok
                  ? "bg-[var(--status-green-bg)] text-[var(--status-green-fg)]"
                  : "bg-[var(--status-red-bg)] text-[var(--status-red-fg)]",
              )}
            >
              {notice.message}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}