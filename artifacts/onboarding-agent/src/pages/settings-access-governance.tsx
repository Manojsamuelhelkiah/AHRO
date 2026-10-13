import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getPinnedOrganizationIdForPage } from "@workspace/api-client-react";
import { AlertTriangle, Check, History, LockKeyhole, Plus, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { Badge, Button, Card, CardContent, IconTile, LoadingBlock, cn } from "@/components/ui-shared";
import { useOrganizationRole } from "@/hooks/use-organization-role";
import { DirectoryWarning, IdentityDetails, identityLabel } from "@/components/member-identity";
import type { AccessOrganizationMember } from "@workspace/api-client-react";

type PrincipalType = "user" | "agent";
type CatalogItem = { key: string; label: string; sensitivity: string; kind: string };
type Agent = { id: string; name: string; ownerUserId: string; status: string; version: number };
type UserGroup = {
  id: string; name: string; status: string; version: number; ownerUserId: string;
  starterId?: string | null;
  members: Array<{ principalType: string; principalId: string; expiresAt: string | null }>;
  securityGroups: string[];
  securityGroupAttachments: Array<{ securityGroupId: string; expiresAt: string | null }>;
};
type SecurityGroup = {
  id: string; name: string; status: string; version: number;
  allows: string[]; approvalStatus: string;
};
type ExistingGroup = { id: string; name: string; status: string; type: "user-group" | "security-group" };
type ExistingAgent = Pick<Agent, "id" | "name" | "status">;
type Notice = { ok: boolean; message: string; existingGroup?: ExistingGroup; existingAgent?: ExistingAgent };
class AgentNameConflict extends Error {
  constructor(message: string, readonly existingAgent?: ExistingAgent) {
    super(message);
  }
}
class GroupNameConflict extends Error {
  constructor(message: string, readonly existingGroup?: ExistingGroup) {
    super(message);
  }
}
function failureNotice(error: unknown): Notice {
  return { ok: false, message: errorText(error),
    ...(error instanceof GroupNameConflict ? { existingGroup: error.existingGroup } : {}),
    ...(error instanceof AgentNameConflict ? { existingAgent: error.existingAgent } : {}) };
}
type Member = AccessOrganizationMember;
type GovernanceEvent = {
  id?: string; eventType: string; entityType: string; entityId: string;
  actorUserId?: string | null; detail?: Record<string, unknown> | null; createdAt?: string;
};
type AccessSnapshot = {
  catalog: CatalogItem[];
  members: Member[];
  agents: Agent[];
  userGroups: UserGroup[];
  userGroupStarters: Array<{ id: string; name: string }>;
  securityGroups: SecurityGroup[];
  grants: Array<{ principalType: string; principalId: string; securityGroupId: string; expiresAt: string | null }>;
  pendingGrants?: Array<{ principalType: string; principalId: string; securityGroupId: string }>;
  pendingMembers?: PendingMember[];
  history: GovernanceEvent[];
};
type Preview = { allows: string[]; reasons: Record<string, string[]> };
type FieldAccess = { principals: Array<{ principalType: string; principalId: string; reasons: string[] }> };
type PendingGroupLink = { userGroupId: string; securityGroupId: string; policyVersion: number; requestedBy: string | null };
type PendingMember = {
  groupId: string;
  principalType: PrincipalType;
  principalId: string;
  requestedByUserId: string | null;
  expectedVersion: number;
  policyVersions: string;
};
type ProposedPreview = {
  kind: "grant" | "group-link" | "membership";
  title: string;
  principalType?: PrincipalType;
  principalId?: string;
  userGroupId?: string;
  securityGroupId?: string;
  impacts: Array<{ principal: string; current: string[]; additional: string[] }>;
  futureOnly: boolean;
  sensitive: boolean;
  policyApprovalNeeded: boolean;
  expiresAt: string | null;
};

const basePath = "/api/organizations/current/access";
const inputClass = "h-8 min-w-0 max-w-full rounded-md border border-input bg-background px-2 text-xs text-[var(--text-primary)]";

function expiryIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error("Choose a future expiration time.");
  return date.toISOString();
}

function expiryLabel(value: string | null): string {
  return value ? `Expires ${new Date(value).toLocaleString()}` : "No expiration";
}

function localExpiry(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "The access-governance request failed.";
}

function memberLabel(member: Member, peers: Member[] = []): string {
  return `${identityLabel(member, peers)} · ${member.role}`;
}

function principalLabel(type: string, id: string, members: Member[], agents: Agent[]): string {
  if (!id) return type === "user" ? "Unresolved account · ID unavailable" : "Unresolved registered agent · ID unavailable";
  if (type === "user") {
    const member = members.find((item) => item.clerkUserId === id);
    return member ? memberLabel(member, members) : `Unresolved account · ${id.length > 8 ? `…${id.slice(-8)}` : id}`;
  }
  const agent = agents.find((item) => item.id === id);
  return agent ? `${agent.name} · registered agent` : `Registered agent · ${id}`;
}

function isValidOptionalCaseId(caseId: string): boolean {
  if (!caseId.trim()) return true;
  const value = Number(caseId);
  return Number.isSafeInteger(value) && value > 0;
}

function accessContextParams(caseId: string, initiatorUserId?: string): URLSearchParams {
  const params = new URLSearchParams();
  if (caseId.trim()) {
    if (!isValidOptionalCaseId(caseId)) throw new Error("Case ID must be a positive whole number.");
    params.set("caseId", String(Number(caseId)));
  }
  if (initiatorUserId?.trim()) params.set("initiatorUserId", initiatorUserId.trim());
  return params;
}

function previewPath(
  principalType: PrincipalType,
  principalId: string,
  caseId: string,
  initiatorUserId?: string,
): string {
  if (principalType === "agent" && !initiatorUserId?.trim()) {
    throw new Error("Choose an initiator user to preview registered-agent access.");
  }
  const params = accessContextParams(caseId, principalType === "agent" ? initiatorUserId : undefined);
  params.set("principalType", principalType);
  params.set("principalId", principalId);
  return `/preview?${params.toString()}`;
}

function fieldAccessPath(field: string, caseId: string, initiatorUserId: string): string {
  if (!initiatorUserId.trim()) {
    throw new Error("Choose an initiator user to review field access, including registered agents.");
  }
  const params = accessContextParams(caseId, initiatorUserId);
  params.set("field", field);
  return `/field-access?${params.toString()}`;
}

async function accessRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const organizationId = getPinnedOrganizationIdForPage();
  if (!organizationId) throw new Error("Select an organization before managing access governance.");
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("x-organization-id", organizationId);
  const response = await fetch(`${basePath}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 409 && payload.code === "ACCESS_GROUP_NAME_CONFLICT") {
      throw new GroupNameConflict(payload.message, payload.existingGroup);
    }
    if (response.status === 409 && payload.code === "ACCESS_AGENT_NAME_CONFLICT") {
      throw new AgentNameConflict(payload.message, payload.existingAgent);
    }
    throw new Error(payload.message || payload.error || `Request failed (${response.status}).`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function SectionTitle({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mb-3">
      <h4 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h4>
      <p className="mt-1 text-xs text-[var(--text-muted)]">{detail}</p>
    </div>
  );
}

export function AccessGovernanceSettings() {
  const { role, loading: roleLoading } = useOrganizationRole();
  const queryClient = useQueryClient();
  const canRead = role === "owner" || role === "admin";
  const canManage = role === "owner";
  const organizationId = getPinnedOrganizationIdForPage();
  const queryKey = ["organization-access-governance", organizationId];
  const snapshotQuery = useQuery({
    queryKey,
    queryFn: () => accessRequest<AccessSnapshot>(""),
    enabled: canRead && !!organizationId,
    refetchOnMount: "always",
    staleTime: 0,
    refetchInterval: 60_000,
  });
  const snapshot = snapshotQuery.data;
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState<{ group: UserGroup; ownerUserId: string; acknowledged: boolean } | null>(null);
  // The existing access snapshot is the tenant member directory. Stewardship
  // never depends on a specialist appointment directory.
  const ownerDirectory = snapshotQuery;
  const [agentName, setAgentName] = useState("");
  const [agentOwner, setAgentOwner] = useState("");
  const registeringAgent = useRef(false);
  const [userGroupName, setUserGroupName] = useState("");
  const [userGroupChoice, setUserGroupChoice] = useState("");
  const creatingUserGroup = useRef(false);
  const [groupNotice, setGroupNotice] = useState<Notice | null>(null);
  const [renamingUserGroup, setRenamingUserGroup] = useState<string | null>(null);
  const [userGroupDraftName, setUserGroupDraftName] = useState("");
  const [securityGroupName, setSecurityGroupName] = useState("");
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [groupDraftName, setGroupDraftName] = useState("");
  const [groupDraftAllows, setGroupDraftAllows] = useState<string[]>([]);
  const [memberGroupId, setMemberGroupId] = useState("");
  const [memberType, setMemberType] = useState<PrincipalType>("user");
  const [memberId, setMemberId] = useState("");
  const [memberExpiry, setMemberExpiry] = useState("");
  const [attachUserGroupId, setAttachUserGroupId] = useState("");
  const [attachSecurityGroupId, setAttachSecurityGroupId] = useState("");
  const [attachmentExpiry, setAttachmentExpiry] = useState("");
  const [grantType, setGrantType] = useState<PrincipalType>("user");
  const [grantPrincipalId, setGrantPrincipalId] = useState("");
  const [grantSecurityGroupId, setGrantSecurityGroupId] = useState("");
  const [grantExpiry, setGrantExpiry] = useState("");
  const [previewType, setPreviewType] = useState<PrincipalType>("user");
  const [previewPrincipalId, setPreviewPrincipalId] = useState("");
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [caseScopeId, setCaseScopeId] = useState("");
  const [initiatorUserId, setInitiatorUserId] = useState("");
  const [proposedPreview, setProposedPreview] = useState<ProposedPreview | null>(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [fieldKey, setFieldKey] = useState("");
  const [fieldEnabled, setFieldEnabled] = useState(false);

  const principals = useMemo(() => ({
    user: (snapshot?.members ?? []).map((member) => ({ id: member.clerkUserId, label: `${identityLabel(member, snapshot?.members ?? [])} · ${member.role}` })),
    agent: (snapshot?.agents ?? []).filter((agent) => agent.status === "active").map((agent) => ({ id: agent.id, label: `${agent.name} · ${agent.id}` })),
  }), [snapshot]);
  const humanMembers = (snapshot?.members ?? []).filter((member) => member.accountKind !== "internal" && member.role !== "removed");

  useEffect(() => {
    if (!agentOwner || !humanMembers.some((member) => member.clerkUserId === agentOwner)) {
      setAgentOwner(humanMembers.find((member) => member.role === "owner")?.clerkUserId ?? humanMembers[0]?.clerkUserId ?? "");
    }
    if (snapshot && initiatorUserId && !humanMembers.some((member) => member.clerkUserId === initiatorUserId)) {
      setInitiatorUserId("");
      setPreviewEnabled(false);
      setFieldEnabled(false);
    }
  }, [snapshot, agentOwner, initiatorUserId]);
  useEffect(() => {
    if (!memberId && principals[memberType].length) setMemberId(principals[memberType][0].id);
  }, [memberId, memberType, principals]);
  useEffect(() => {
    if (!grantPrincipalId && principals[grantType].length) setGrantPrincipalId(principals[grantType][0].id);
  }, [grantPrincipalId, grantType, principals]);
  useEffect(() => {
    if (!previewPrincipalId && principals[previewType].length) setPreviewPrincipalId(principals[previewType][0].id);
  }, [previewPrincipalId, previewType, principals]);

  const previewQuery = useQuery({
    queryKey: [...queryKey, "preview", previewType, previewPrincipalId, caseScopeId, previewType === "agent" ? initiatorUserId : ""],
    queryFn: () => accessRequest<Preview>(previewPath(previewType, previewPrincipalId, caseScopeId, initiatorUserId)),
    enabled: canRead && previewEnabled && !!previewPrincipalId && isValidOptionalCaseId(caseScopeId) && (previewType !== "agent" || !!initiatorUserId),
  });
  const fieldQuery = useQuery({
    queryKey: [...queryKey, "field-access", fieldKey, caseScopeId, initiatorUserId],
    queryFn: () => accessRequest<FieldAccess>(fieldAccessPath(fieldKey, caseScopeId, initiatorUserId)),
    enabled: canRead && fieldEnabled && !!fieldKey && !!initiatorUserId && isValidOptionalCaseId(caseScopeId),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey });
    await snapshotQuery.refetch({ throwOnError: true });
    await queryClient.invalidateQueries({ queryKey: [...queryKey, "preview"] });
    await queryClient.invalidateQueries({ queryKey: [...queryKey, "field-access"] });
  };

  const perform = async (action: () => Promise<unknown>, message: string | ((result: any) => string)) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      setNotice({ ok: true, message: typeof message === "function" ? message(result) : message });
      await refresh();
      return true;
    } catch (error) {
      setNotice(failureNotice(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const data = snapshot ?? { catalog: [], members: [], agents: [], userGroups: [], userGroupStarters: [], securityGroups: [], grants: [], history: [], pendingMembers: [], pendingGrants: [] };
  const selectedStarter = data.userGroupStarters?.find((starter) => starter.id === userGroupChoice);
  const existingStarter = selectedStarter && data.userGroups.find((group) => group.starterId === selectedStarter.id);
  const activeSecurityGroups = data.securityGroups.filter((group) => group.status === "active");
  const userGroups = data.userGroups.filter((group) => group.status === "active");
  const effectiveMembers = principals[memberType];
  const grantPrincipals = principals[grantType];
  const previewPrincipals = principals[previewType];
  const activeGroupMembers = data.members.filter((member) => member.role !== "removed");
  const pendingDirectGrants = data.pendingGrants ?? [];
  const pendingMembers = data.pendingMembers ?? [];
  const upcomingExpirations = [
    ...data.userGroups.flatMap((group) => [
      ...group.members.map((member) => ({
        key: `member-${group.id}-${member.principalType}-${member.principalId}`,
        label: `${principalLabel(member.principalType, member.principalId, data.members, data.agents)} in ${group.name}`,
        expiresAt: member.expiresAt,
      })),
      ...(group.securityGroupAttachments ?? []).map((link) => ({
        key: `link-${group.id}-${link.securityGroupId}`,
        label: `${group.name} → ${data.securityGroups.find((item) => item.id === link.securityGroupId)?.name ?? link.securityGroupId}`,
        expiresAt: link.expiresAt,
      })),
    ]),
    ...data.grants.map((grant) => ({
      key: `grant-${grant.principalType}-${grant.principalId}-${grant.securityGroupId}`,
      label: `${principalLabel(grant.principalType, grant.principalId, data.members, data.agents)} → ${data.securityGroups.find((item) => item.id === grant.securityGroupId)?.name ?? grant.securityGroupId}`,
      expiresAt: grant.expiresAt,
    })),
  ].filter((item): item is { key: string; label: string; expiresAt: string } =>
    Boolean(item.expiresAt && new Date(item.expiresAt).getTime() > Date.now()),
  ).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  const pendingGroupLinks = useMemo(() => {
    const seen = new Set<string>();
    const pending: PendingGroupLink[] = [];
    for (const event of data.history) {
      if (event.entityType !== "user-group" || typeof event.detail?.securityGroupId !== "string") continue;
      const securityGroupId = event.detail.securityGroupId;
      const key = `${event.entityId}:${securityGroupId}`;
      if (seen.has(key)) continue;
      if (!["user-group.security-group.pending", "user-group.security-group.approved", "user-group.security-group.attached", "user-group.security-group.detached"].includes(event.eventType)) continue;
      seen.add(key);
      if (event.eventType === "user-group.security-group.pending") {
        pending.push({
          userGroupId: event.entityId,
          securityGroupId,
          policyVersion: Number(event.detail.policyVersion ?? 0),
          requestedBy: event.actorUserId ?? null,
        });
      }
    }
    return pending;
  }, [data.history]);

  const startProposalPreview = async (input: {
    kind: ProposedPreview["kind"];
    title: string;
    principalType?: PrincipalType;
    principalId?: string;
    affectedPrincipals?: Array<{ principalType: PrincipalType; principalId: string }>;
    securityGroupIds: string[];
    userGroupId?: string;
    securityGroupId?: string;
    expiry?: string;
  }) => {
    if (!input.principalId && !input.affectedPrincipals?.length && input.kind !== "group-link") return;
    setProposalLoading(true);
    setProposedPreview(null);
    setNotice(null);
    try {
      const existingExpiry = input.kind === "membership"
        ? data.userGroups.find((group) => group.id === input.userGroupId)?.members.find((member) =>
          member.principalType === input.principalType && member.principalId === input.principalId,
        )?.expiresAt
        : input.kind === "group-link"
          ? data.userGroups.find((group) => group.id === input.userGroupId)?.securityGroupAttachments?.find((link) =>
            link.securityGroupId === input.securityGroupId,
          )?.expiresAt
          : data.grants.find((grant) => grant.principalType === input.principalType &&
            grant.principalId === input.principalId && grant.securityGroupId === input.securityGroupId)?.expiresAt;
      const expiresAt = existingExpiry && localExpiry(existingExpiry) === input.expiry
        ? existingExpiry : expiryIso(input.expiry ?? "");
      const policyGroups = input.securityGroupIds
        .map((id) => data.securityGroups.find((group) => group.id === id))
        .filter((group): group is SecurityGroup => Boolean(group));
      const targets = input.affectedPrincipals ?? (input.principalType && input.principalId
        ? [{ principalType: input.principalType, principalId: input.principalId }]
        : []);
      if (targets.some((target) => target.principalType === "agent") && !initiatorUserId) {
        throw new Error("Choose an initiator user before previewing changes that affect registered agents.");
      }
      const impacts = await Promise.all(targets.map(async (target) => {
        const current = await accessRequest<Preview>(previewPath(
          target.principalType,
          target.principalId,
          caseScopeId,
          initiatorUserId,
        ));
        let proposedAllows = [...new Set(policyGroups.flatMap((group) => group.allows))];
        if (target.principalType === "agent") {
          const initiatorAccess = await accessRequest<Preview>(previewPath("user", initiatorUserId, caseScopeId));
          proposedAllows = proposedAllows.filter((key) => initiatorAccess.allows.includes(key) && key !== "tool.approval.decide");
        }
        return {
          principal: principalLabel(target.principalType, target.principalId, data.members, data.agents),
          current: current.allows,
          additional: proposedAllows.filter((key) => !current.allows.includes(key)),
        };
      }));
      const sensitive = policyGroups.some((group) => group.allows.some((key) => {
        const policy = data.catalog.find((item) => item.key === key);
        return policy && /high|critical/i.test(policy.sensitivity);
      }));
      setProposedPreview({
        kind: input.kind,
        title: input.title,
        principalType: input.principalType,
        principalId: input.principalId,
        userGroupId: input.userGroupId,
        securityGroupId: input.securityGroupId,
        impacts,
        futureOnly: targets.length === 0,
        sensitive,
        policyApprovalNeeded: sensitive && policyGroups.some((group) => group.approvalStatus !== "approved"),
        expiresAt,
      });
    } catch (error) {
      setNotice({ ok: false, message: errorText(error) });
    } finally {
      setProposalLoading(false);
    }
  };
  const commitProposal = async () => {
    const proposal = proposedPreview;
    if (!proposal) return;
    let action: () => Promise<unknown>;
    let message: (result: any) => string;
    if (proposal.kind === "grant" && proposal.securityGroupId && proposal.principalType && proposal.principalId) {
      action = () => accessRequest("/grants", { method: "PUT", body: JSON.stringify({
        principalType: proposal.principalType, principalId: proposal.principalId,
        securityGroupId: proposal.securityGroupId, active: true, expiresAt: proposal.expiresAt,
      }) });
      message = (result) => result?.status === "pending"
        ? "Grant request recorded as pending. A different organization owner must approve it."
        : "Grant saved and effective access updated.";
    } else if (proposal.kind === "group-link" && proposal.userGroupId && proposal.securityGroupId) {
      action = () => accessRequest(`/user-groups/${encodeURIComponent(proposal.userGroupId!)}/security-groups`, {
        method: "PUT", body: JSON.stringify({ securityGroupId: proposal.securityGroupId, active: true, expiresAt: proposal.expiresAt }),
      });
      message = (result) => result?.status === "pending"
        ? "Group attachment is pending independent owner review."
        : "Security group attached.";
    } else if (proposal.kind === "membership" && proposal.userGroupId && proposal.principalType && proposal.principalId) {
      action = () => accessRequest(`/user-groups/${encodeURIComponent(proposal.userGroupId!)}/members`, {
        method: "PUT", body: JSON.stringify({ principalType: proposal.principalType, principalId: proposal.principalId, active: true, expiresAt: proposal.expiresAt }),
      });
      message = (result) => result?.status === "pending"
        ? "Membership request is pending independent review. Access remains blocked until an active, different organization owner approves it."
        : "Principal added to user group after reviewing the effective-access impact.";
    } else return;
    const succeeded = await perform(action, message);
    if (succeeded) setProposedPreview(null);
  };
  const createUserGroup = async () => {
    if (!canManage || creatingUserGroup.current || !userGroupChoice ||
      (userGroupChoice === "custom" ? !userGroupName.trim() : !selectedStarter)) return;
    creatingUserGroup.current = true;
    setBusy(true);
    setGroupNotice(null);
    let saved = false;
    try {
      const result = await accessRequest<{
        created: boolean; reusedLegacy: boolean; userGroup: UserGroup;
      }>("/user-groups", { method: "POST", body: JSON.stringify(
        userGroupChoice === "custom" ? { name: userGroupName.trim() } : { starterId: userGroupChoice },
      ) });
      saved = true;
      await refresh();
      const group = result.userGroup;
      setGroupNotice({ ok: true, message: result.created
        ? `${group.name} created. No members or access were added.`
        : group.status === "retired"
          ? `This starter already exists as retired group “${group.name}”. It was not recreated or reactivated.`
          : `Using existing group “${group.name}”${selectedStarter && group.name !== selectedStarter.name ? " (renamed)" : ""}. Its members and access settings were not changed.` });
      if (userGroupChoice === "custom") setUserGroupName("");
    } catch (error) {
      setGroupNotice(saved ? { ok: false, message:
        `The group was saved, but refreshing the list failed. Use Refresh before creating another custom group. ${errorText(error)}`,
      } : failureNotice(error));
    } finally {
      creatingUserGroup.current = false;
      setBusy(false);
    }
  };
  if (roleLoading) return null;

  const beginEdit = (group: SecurityGroup) => {
    setEditingGroup(group.id);
    setGroupDraftName(group.name);
    setGroupDraftAllows(group.allows);
  };
  const toggleAllow = (key: string) => setGroupDraftAllows((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  const saveSecurityGroup = async (group: SecurityGroup) => {
    const saved = await perform(() => accessRequest(`/security-groups/${encodeURIComponent(group.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name: groupDraftName.trim(), allows: groupDraftAllows, expectedVersion: group.version }),
    }), "Security group and policy grants updated.");
    if (saved) setEditingGroup(null);
  };
  const noticeContent = (value: Notice) => <>{value.message}{value.existingGroup && <Button
    size="sm" variant="outline" disabled={busy} className="ml-2"
    onClick={async () => {
      try {
        await refresh();
        const group = value.existingGroup!;
        const row = document.getElementById(`access-${group.type}-${group.id}`);
        row?.scrollIntoView({ behavior: "smooth", block: "center" });
        row?.focus({ preventScroll: true });
      } catch (error) { setNotice(failureNotice(error)); }
    }}
  >View existing group</Button>}{value.existingAgent && <Button
    size="sm" variant="outline" disabled={busy} className="ml-2"
    onClick={async () => {
      try {
        await refresh();
        const row = document.getElementById(`access-agent-${value.existingAgent!.id}`);
        row?.scrollIntoView({ behavior: "smooth", block: "center" });
        row?.focus({ preventScroll: true });
      } catch (error) { setNotice(failureNotice(error)); }
    }}
  >View existing agent</Button>}</>;
  return (
    <Card className="overflow-hidden p-0">
      <CardContent className="p-0">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-alt)] p-4">
          <div className="flex gap-3">
            <IconTile icon={LockKeyhole} className="border-transparent bg-[var(--primary-light)] text-[var(--primary)]" />
            <div>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Access governance</h3>
              <p className="mt-1 text-xs text-[var(--text-muted)]">Manage principals, user groups, security groups, policy grants, effective access, and independent review.</p>
            </div>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" disabled={!canRead || snapshotQuery.isFetching} onClick={() => void snapshotQuery.refetch()}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
        <div className="space-y-6 p-4">
          {!canRead ? (
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface-alt)] p-4 text-xs text-[var(--text-muted)]">
              Access governance is restricted to organization owners and administrators. Ask an organization owner for access.
            </div>
          ) : snapshotQuery.isLoading ? <LoadingBlock>Loading access-governance snapshot...</LoadingBlock>
            : snapshotQuery.isError && !snapshot ? (
              <div role="alert" className="rounded-md border border-[var(--status-red)] bg-[var(--status-red-bg)] p-3 text-xs text-[var(--status-red-fg)]">
                {errorText(snapshotQuery.error)}
                <Button variant="outline" size="sm" className="ml-3" onClick={() => void snapshotQuery.refetch()}>Retry</Button>
              </div>
            ) : (
              <>
                <DirectoryWarning members={data.members} retry={() => void snapshotQuery.refetch()} busy={snapshotQuery.isFetching} />
                <details className="rounded-md border border-[var(--border)] p-3 text-xs">
                  <summary className="cursor-pointer font-medium">Member identity details</summary>
                  <p className="mt-2 text-[var(--text-muted)]">Directory names and emails are display information only, not authority, credentials or verified recipient bindings.</p>
                  <div className="mt-3 space-y-3">
                    {humanMembers.map((member) => <div key={member.clerkUserId}>
                      <IdentityDetails member={member} peers={data.members} />
                      <p className="text-[var(--text-muted)]">{member.role} · Active</p>
                    </div>)}
                  </div>
                  {data.members.some((member) => member.accountKind === "internal") && <section aria-label="Internal/test accounts" className="mt-3 border-t border-[var(--border)] pt-3">
                    <h4 className="font-semibold">Internal/test accounts</h4>
                    <p className="my-2 text-[var(--text-muted)]">Retained for development testing. Not available as accountable human owners or initiating humans.</p>
                    {data.members.filter((member) => member.accountKind === "internal").map((member) => <div key={member.clerkUserId}>
                      <IdentityDetails member={member} /><p>{member.role} · Active</p>
                    </div>)}
                  </section>}
                </details>
                {snapshotQuery.isError && <div role="alert" className="rounded-md border border-[var(--status-red)] bg-[var(--status-red-bg)] p-3 text-xs text-[var(--status-red-fg)]">
                  The list could not be refreshed. Displaying the last loaded groups. {errorText(snapshotQuery.error)}
                  <Button variant="outline" size="sm" className="ml-3" onClick={() => void snapshotQuery.refetch()}>Retry refresh</Button>
                </div>}
                {!canManage && <div className="flex items-start gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-xs text-[var(--text-muted)]"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />Read-only access. Only organization owners can create or change agents, groups, memberships, grants, and approvals.</div>}

                <section className="rounded-md border border-[var(--border)] bg-[var(--surface-alt)] p-3">
                  <SectionTitle title="Upcoming access expirations" detail="Active temporary assignments stop granting access at the listed time. Times are shown in your local timezone." />
                  {upcomingExpirations.length ? <div className="space-y-1 text-xs">{upcomingExpirations.map((item) =>
                    <p key={item.key}><span className="font-medium">{item.label}</span> · {expiryLabel(item.expiresAt)}</p>,
                  )}</div> : <p className="text-xs text-[var(--text-muted)]">No active temporary assignments are scheduled to expire.</p>}
                </section>

                <section className="rounded-md border border-[var(--border)] bg-[var(--surface-alt)] p-3">
                  <SectionTitle title="Access evaluation context" detail="Use the same context for access previews, proposed grant impacts, and sensitive-field reviews." />
                  <div className="flex flex-wrap gap-2">
                    <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
                      Case ID (optional)
                      <input
                        aria-label="Optional case ID scope"
                        data-testid="input-access-case-scope"
                        type="number"
                        min="1"
                        step="1"
                        className={inputClass}
                        placeholder="Organization-wide"
                        value={caseScopeId}
                        onChange={(event) => {
                          setCaseScopeId(event.target.value);
                          setPreviewEnabled(false);
                          setFieldEnabled(false);
                          setProposedPreview(null);
                        }}
                      />
                    </label>
                    <label className="flex min-w-56 flex-col gap-1 text-xs text-[var(--text-secondary)]">
                      Initiator user (required for agent access)
                      <select
                        aria-label="Initiator user for agent access"
                        data-testid="select-access-initiator"
                        className={inputClass}
                        value={initiatorUserId}
                        onChange={(event) => {
                          setInitiatorUserId(event.target.value);
                          setPreviewEnabled(false);
                          setFieldEnabled(false);
                          setProposedPreview(null);
                        }}
                      >
                        <option value="">Choose initiator user</option>
                        {humanMembers.map((member) => (
                          <option key={member.clerkUserId} value={member.clerkUserId}>{memberLabel(member, data.members)}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {!isValidOptionalCaseId(caseScopeId) && <p role="alert" className="mt-2 text-xs text-[var(--status-red-fg)]">Enter a positive whole-number case ID, or leave the case scope empty.</p>}
                  <p className="mt-2 text-xs text-[var(--text-muted)]">
                    Leave Case ID empty to evaluate organization-level access; enter a case ID to include case-scoped grants. Registered-agent access requires an explicitly selected initiator. Agent effective access is evaluated in that initiator’s context and is constrained by the initiator’s effective access—it is not a standalone agent capability and does not implicitly use the registered owner.
                  </p>
                </section>

                <section>
                  <SectionTitle title="Registered agents" detail="Registration records a named access identity and an accountable human owner. It does not create, deploy, connect or run an AI agent. Ownership does not grant permissions or select the initiating human. Effective access depends on current grants and the explicitly chosen initiator. Retiring a registration revokes active participation without deleting history." />
                  {canManage && <form className="mb-3 flex flex-wrap gap-2" onSubmit={(event) => {
                    event.preventDefault();
                    if (registeringAgent.current || !agentName.trim() || !agentOwner) return;
                    registeringAgent.current = true;
                    void perform(() => accessRequest("/agents", { method: "POST", body: JSON.stringify({ name: agentName.trim(), ownerUserId: agentOwner }) }), "Registered agent created.")
                      .then((ok) => { if (ok) setAgentName(""); })
                      .finally(() => { registeringAgent.current = false; });
                  }}>
                    <input aria-label="Agent name" data-testid="input-access-agent-name" className={inputClass} placeholder="Named agent" value={agentName} onChange={(event) => setAgentName(event.target.value)} />
                    <select aria-label="Agent owner" data-testid="select-access-agent-owner" className={inputClass} value={agentOwner} onChange={(event) => setAgentOwner(event.target.value)}>
                      <option value="">Choose accountable human owner</option>
                      {humanMembers.map((member) => <option key={member.clerkUserId} value={member.clerkUserId}>{`${identityLabel(member, data.members)} · ${member.role}`}</option>)}
                    </select>
                    <Button type="submit" size="sm" disabled={busy || !agentName.trim() || !agentOwner}><Plus className="mr-1 h-3.5 w-3.5" />Register agent</Button>
                  </form>}
                  <div className="space-y-2">
                    {data.agents.length ? data.agents.map((agent) => <div key={agent.id} id={`access-agent-${agent.id}`} tabIndex={-1} data-testid={`row-access-agent-${agent.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] p-3 text-xs">
                      <div className="min-w-0 max-w-full break-words">
                        <p className="font-medium text-[var(--text-primary)]">{agent.name}</p>
                        <p className="mt-1 text-[var(--text-muted)]">Accountable owner: {principalLabel("user", agent.ownerUserId, data.members, data.agents)}</p>
                        <details className="mt-1 text-[var(--text-muted)]"><summary className="cursor-pointer">Registered access identity ID</summary><code className="block select-all break-all py-1">{agent.id}</code></details>
                      </div>
                      <div className="flex items-center gap-2"><Badge className={agent.status === "active" ? "bg-[var(--status-green-bg)] text-[var(--status-green-fg)]" : "bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)]"}>{agent.status}</Badge>
                        {canManage && agent.status === "active" && <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(() => accessRequest(`/agents/${encodeURIComponent(agent.id)}`, { method: "PATCH", body: JSON.stringify({ status: "retired", expectedVersion: agent.version }) }), "Agent retired.")}>Retire</Button>}
                      </div>
                    </div>) : <p className="text-xs text-[var(--text-muted)]">No registered agents.</p>}
                  </div>
                </section>

                <section className="border-t border-[var(--border)] pt-5">
                  <SectionTitle title="User groups" detail="Groups organize existing humans and registered agents. Optional starter groups grant no permissions or professional qualifications. Members, agent registration, and security-group access are configured separately." />
                  {canManage && <form className="mb-3 flex flex-wrap items-end gap-2" onSubmit={(event) => {
                    event.preventDefault();
                    void createUserGroup();
                  }}>
                    <label className="flex w-full flex-col gap-1 text-xs sm:w-auto">
                      Predefined user group
                      <select data-testid="select-access-user-group-starter" className={cn(inputClass, "w-full sm:min-w-52")} disabled={busy} value={userGroupChoice} onChange={(event) => { setUserGroupChoice(event.target.value); setGroupNotice(null); }}>
                        <option value="">Choose a starter or custom group</option>
                        {(data.userGroupStarters ?? []).map((starter) => <option key={starter.id} value={starter.id}>{starter.name}</option>)}
                        <option value="custom">Custom group</option>
                      </select>
                    </label>
                    {userGroupChoice === "custom" && <label className="flex w-full flex-col gap-1 text-xs sm:w-auto">
                      Custom group name
                      <input aria-label="New user group name" data-testid="input-access-user-group-name" className={inputClass} placeholder="New user group name" disabled={busy} value={userGroupName} onChange={(event) => setUserGroupName(event.target.value)} />
                    </label>}
                    <Button type="submit" size="sm" disabled={busy || !userGroupChoice || (userGroupChoice === "custom" ? !userGroupName.trim() : !selectedStarter)}><Plus className="mr-1 h-3.5 w-3.5" />{busy ? "Saving..." : existingStarter ? "Use existing group" : "Create user group"}</Button>
                  </form>}
                  {existingStarter && <p className="mb-3 break-words text-xs text-[var(--text-muted)]">This starter already exists as “{existingStarter.name}” ({existingStarter.status}). Choosing it will not recreate, rename, reactivate, or change its access.</p>}
                  {groupNotice && <p role={groupNotice.ok ? "status" : "alert"} data-testid="status-access-user-group" className={cn("mb-3 rounded-md p-3 text-xs", groupNotice.ok ? "bg-[var(--status-green-bg)] text-[var(--status-green-fg)]" : "bg-[var(--status-red-bg)] text-[var(--status-red-fg)]")}>{noticeContent(groupNotice)}</p>}
                  {!data.userGroups.length && <p className="mb-3 text-xs text-[var(--text-muted)]">No user groups yet. An organization owner can create an optional starter or a custom group.</p>}
                  {canManage && <div className="mb-3 flex flex-wrap gap-2 rounded-md bg-[var(--surface-alt)] p-3">
                    <select aria-label="Group for principal" className={inputClass} value={memberGroupId} onChange={(event) => { setMemberGroupId(event.target.value); setMemberExpiry(""); }}><option value="">Choose user group</option>{userGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
                    <select aria-label="Principal type" className={inputClass} value={memberType} onChange={(event) => { setMemberType(event.target.value as PrincipalType); setMemberId(""); setMemberExpiry(""); }}><option value="user">Human</option><option value="agent">Registered agent</option></select>
                    <select aria-label="Existing principal" className={inputClass} value={memberId} onChange={(event) => { setMemberId(event.target.value); setMemberExpiry(localExpiry(data.userGroups.find((group) => group.id === memberGroupId)?.members.find((member) => member.principalType === memberType && member.principalId === event.target.value)?.expiresAt ?? null)); }}><option value="">Choose existing {memberType}</option>{effectiveMembers.map((principal) => <option key={principal.id} value={principal.id}>{principal.label}</option>)}</select>
                    <label className="flex items-center gap-1 text-xs">Expires (optional) <input aria-label="Membership expires at" type="datetime-local" step="1" className={inputClass} value={memberExpiry} onChange={(event) => setMemberExpiry(event.target.value)} /></label>
                    <Button size="sm" variant="secondary" disabled={busy || proposalLoading || !memberGroupId || !memberId} onClick={() => {
                      const group = data.userGroups.find((item) => item.id === memberGroupId);
                      void startProposalPreview({
                        kind: "membership", title: `Add principal to ${group?.name ?? "user group"}`,
                        principalType: memberType, principalId: memberId, userGroupId: memberGroupId,
                        expiry: memberExpiry,
                        securityGroupIds: group?.securityGroups ?? [],
                      });
                    }}><Users className="mr-1 h-3.5 w-3.5" />Preview membership impact</Button>
                  </div>}
                  {canManage && <div className="mb-3 flex flex-wrap gap-2 rounded-md bg-[var(--surface-alt)] p-3">
                    <select aria-label="User group to attach security group" className={inputClass} value={attachUserGroupId} onChange={(event) => { setAttachUserGroupId(event.target.value); setAttachmentExpiry(""); }}><option value="">Choose user group</option>{userGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
                    <select aria-label="Security group to attach" className={inputClass} value={attachSecurityGroupId} onChange={(event) => { setAttachSecurityGroupId(event.target.value); setAttachmentExpiry(localExpiry(data.userGroups.find((group) => group.id === attachUserGroupId)?.securityGroupAttachments?.find((link) => link.securityGroupId === event.target.value)?.expiresAt ?? null)); }}><option value="">Choose security group</option>{activeSecurityGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
                    <label className="flex items-center gap-1 text-xs">Expires (optional) <input aria-label="Group attachment expires at" type="datetime-local" step="1" className={inputClass} value={attachmentExpiry} onChange={(event) => setAttachmentExpiry(event.target.value)} /></label>
                    <Button size="sm" variant="secondary" disabled={busy || proposalLoading || !attachUserGroupId || !attachSecurityGroupId} onClick={() => {
                      const group = data.userGroups.find((item) => item.id === attachUserGroupId);
                      void startProposalPreview({
                        kind: "group-link", title: `Attach ${data.securityGroups.find((item) => item.id === attachSecurityGroupId)?.name ?? "security group"} to ${group?.name ?? "user group"}`,
                        affectedPrincipals: (group?.members ?? []).map((principal) => ({
                          principalType: principal.principalType as PrincipalType,
                          principalId: principal.principalId,
                        })),
                        userGroupId: attachUserGroupId,
                        securityGroupId: attachSecurityGroupId,
                        expiry: attachmentExpiry,
                        securityGroupIds: [attachSecurityGroupId],
                      });
                    }}>{proposalLoading ? "Preparing preview..." : "Preview attachment impact"}</Button>
                  </div>}
                  <div className="space-y-2">
                    {data.userGroups.map((group) => <div key={group.id} id={`access-user-group-${group.id}`} tabIndex={-1} data-testid={`row-access-user-group-${group.id}`} className="rounded-md border border-[var(--border)] p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2"><span className="text-xs font-semibold">{group.name}</span><Badge className="bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)]">{group.status}</Badge><span className="text-xs text-[var(--text-muted)]">{group.members.length} principals · {group.securityGroups.length} security groups</span></div>
                        {canManage && group.status === "active" && <div className="flex gap-2">
                          <Button variant="outline" size="sm" disabled={busy} onClick={() => {
                            setRenamingUserGroup(group.id);
                            setUserGroupDraftName(group.name);
                          }}>Rename</Button>
                          <Button variant="outline" size="sm" disabled={busy} onClick={() => setTransfer({ group, ownerUserId: "", acknowledged: false })}>Transfer stewardship</Button>
                          <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(() => accessRequest(`/user-groups/${encodeURIComponent(group.id)}`, { method: "PATCH", body: JSON.stringify({ status: "retired", expectedVersion: group.version }) }), "User group retired.")}>Retire</Button>
                        </div>}
                        {canManage && renamingUserGroup === group.id && <form className="flex flex-wrap gap-2" onSubmit={async (event) => {
                          event.preventDefault();
                          if (busy || !userGroupDraftName.trim()) return;
                          const saved = await perform(() => accessRequest(`/user-groups/${encodeURIComponent(group.id)}`, {
                            method: "PATCH", body: JSON.stringify({ name: userGroupDraftName.trim(), expectedVersion: group.version }),
                          }), "User group renamed.");
                          if (saved) setRenamingUserGroup(null);
                        }}>
                          <input aria-label={`Rename ${group.name}`} className={inputClass} value={userGroupDraftName} onChange={(event) => setUserGroupDraftName(event.target.value)} disabled={busy} />
                          <Button size="sm" disabled={busy || !userGroupDraftName.trim()}>Save name</Button>
                          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setRenamingUserGroup(null)}>Cancel</Button>
                        </form>}
                      </div>
                      <p className="mt-2 text-xs text-[var(--text-muted)]">Steward: {principalLabel("user", group.ownerUserId, ownerDirectory.data?.members ?? data.members, data.agents)}</p>
                      {transfer?.group.id === group.id && <form className="mt-3 space-y-3 rounded-md border border-[var(--status-amber)] p-3" onSubmit={(event) => {
                        event.preventDefault();
                        if (!transfer.ownerUserId || !transfer.acknowledged || busy || ownerDirectory.isError) return;
                        const reviewed = transfer;
                        void perform(() => accessRequest(`/user-groups/${encodeURIComponent(reviewed.group.id)}/owner`, {
                          method: "POST",
                          body: JSON.stringify({ ownerUserId: reviewed.ownerUserId, expectedVersion: reviewed.group.version, acknowledgeAccessImpact: true }),
                        }), "Stewardship transferred. Retained memberships need fresh review; no access was granted.")
                          .then((ok) => { if (ok) setTransfer(null); });
                      }}>
                        <p className="text-sm font-semibold">Transfer stewardship of {transfer.group.name}</p>
                        <p className="text-xs text-[var(--text-secondary)]">Members, attachments, expiry settings, and starter identity are retained. All current and pending memberships will be put on hold for fresh review by the new owner. Access through this group is suspended until reviewed; other independent access paths are unchanged. This does not appoint a policy maintainer, add the new owner as a member, or grant access.</p>
                        <p className="text-xs text-[var(--text-muted)]">If you transfer stewardship to yourself, another owner must submit fresh membership requests before you can approve them. The new owner cannot approve their own membership.</p>
                        {ownerDirectory.isLoading && <p className="text-xs">Loading active owner names…</p>}
                        {ownerDirectory.isError && <p role="alert" className="text-xs text-[var(--status-red)]">Owner names could not be loaded. <button type="button" onClick={() => void ownerDirectory.refetch()}>Retry</button></p>}
                        <label className="block text-xs">New organization owner
                          <select aria-label="New user-group steward" className={`${inputClass} mt-1 w-full`} disabled={busy || !ownerDirectory.data || ownerDirectory.isError} value={transfer.ownerUserId} onChange={(event) => setTransfer({ ...transfer, ownerUserId: event.target.value, acknowledged: false })}>
                            <option value="">Choose an active owner by name</option>
                            {(ownerDirectory.data?.members ?? []).filter((member) => member.accountKind !== "internal" &&
                              member.role === "owner" && member.clerkUserId !== transfer.group.ownerUserId &&
                              data.members.some((active) => active.role === "owner" && active.clerkUserId === member.clerkUserId),
                            ).map((member) => <option key={member.clerkUserId} value={member.clerkUserId}>{memberLabel(member, data.members)}</option>)}
                          </select>
                        </label>
                        {ownerDirectory.data && !ownerDirectory.data.members.some((member) => member.accountKind !== "internal" && member.role === "owner" && member.clerkUserId !== transfer.group.ownerUserId && data.members.some((active) => active.role === "owner" && active.clerkUserId === member.clerkUserId)) && <p className="text-xs">No other active organization owners are available.</p>}
                        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={transfer.acknowledged} disabled={busy} onChange={(event) => setTransfer({ ...transfer, acknowledged: event.target.checked })} />I understand the access suspension and confirm transfer to {transfer.ownerUserId ? memberLabel(ownerDirectory.data?.members.find((member) => member.clerkUserId === transfer.ownerUserId) ?? { clerkUserId: transfer.ownerUserId, role: "owner" }, data.members) : "the selected owner"}.</label>
                        {group.version !== transfer.group.version && <p role="alert" className="text-xs text-[var(--status-red)]">This group changed. Cancel and reopen the transfer to review its current settings.</p>}
                        <div className="flex gap-2">
                          <Button type="submit" size="sm" disabled={busy || ownerDirectory.isError || !transfer.acknowledged || !ownerDirectory.data?.members.some((member) => member.accountKind !== "internal" && member.role === "owner" && member.clerkUserId === transfer.ownerUserId) || group.version !== transfer.group.version}>Confirm stewardship transfer</Button>
                          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setTransfer(null)}>Cancel</Button>
                        </div>
                      </form>}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {group.members.map((principal) => <span key={`${principal.principalType}-${principal.principalId}`} className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-alt)] px-2 py-1 text-[10px] text-[var(--text-secondary)]">{principalLabel(principal.principalType, principal.principalId, data.members, data.agents)} · {expiryLabel(principal.expiresAt)}{canManage && group.status === "active" && <button type="button" aria-label={`Remove ${principalLabel(principal.principalType, principal.principalId, data.members, data.agents)} from ${group.name}`} disabled={busy} className="font-bold text-[var(--status-red)] disabled:opacity-50" onClick={() => void perform(() => accessRequest(`/user-groups/${encodeURIComponent(group.id)}/members`, { method: "PUT", body: JSON.stringify({ principalType: principal.principalType, principalId: principal.principalId, active: false }) }), "Principal removed from user group.")}>×</button>}</span>)}
                        {group.securityGroups.map((groupId) => <span key={groupId} className="inline-flex items-center gap-1 rounded-full bg-[var(--primary-light)] px-2 py-1 text-[10px] text-[var(--primary)]">{data.securityGroups.find((securityGroup) => securityGroup.id === groupId)?.name ?? groupId} · {expiryLabel(group.securityGroupAttachments?.find((link) => link.securityGroupId === groupId)?.expiresAt ?? null)}{canManage && group.status === "active" && <button type="button" aria-label={`Detach ${groupId} from ${group.name}`} disabled={busy} className="font-bold text-[var(--status-red)] disabled:opacity-50" onClick={() => void perform(() => accessRequest(`/user-groups/${encodeURIComponent(group.id)}/security-groups`, { method: "PUT", body: JSON.stringify({ securityGroupId: groupId, active: false }) }), "Security group detached.")}>×</button>}</span>)}
                      </div>
                    </div>)}
                  </div>
                  {pendingGroupLinks.length > 0 && <div className="mt-4 space-y-2 rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)]/30 p-3">
                    <p className="text-xs font-semibold text-[var(--status-amber-fg)]">Pending security-group attachments</p>
                    {pendingGroupLinks.map((pending) => {
                      const userGroup = data.userGroups.find((group) => group.id === pending.userGroupId);
                      const securityGroup = data.securityGroups.find((group) => group.id === pending.securityGroupId);
                      const policyReady = securityGroup?.approvalStatus === "approved";
                      return <div key={`${pending.userGroupId}-${pending.securityGroupId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs">
                        <div><span className="font-medium">{userGroup?.name ?? pending.userGroupId}</span><span className="mx-1 text-[var(--text-muted)]">→</span><span>{securityGroup?.name ?? pending.securityGroupId}</span><Badge className="ml-2 bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]">pending review</Badge><p className="mt-1 text-[var(--text-muted)]">Requested by {pending.requestedBy ? principalLabel("user", pending.requestedBy, data.members, data.agents) : "unknown owner"}</p></div>
                        {canManage && <Button size="sm" disabled={busy || !policyReady || !userGroup || !securityGroup} title={!policyReady ? "Independently approve the security-group policy first." : "Must be approved by an owner other than the requester."} onClick={() => void perform(
                          () => accessRequest(`/user-groups/${encodeURIComponent(pending.userGroupId)}/security-groups/${encodeURIComponent(pending.securityGroupId)}/approve`, { method: "POST", body: JSON.stringify({ expectedVersion: securityGroup?.version ?? pending.policyVersion }) }),
                          "Security-group attachment approved by an independent owner.",
                        )}><ShieldCheck className="mr-1 h-3.5 w-3.5" />Approve attachment</Button>}
                      </div>;
                    })}
                  </div>}
                  {pendingMembers.length > 0 && <div className="mt-4 space-y-2 rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)]/30 p-3">
                    <p className="text-xs font-semibold text-[var(--status-amber-fg)]">Pending group membership reviews</p>
                    <p className="text-xs text-[var(--text-muted)]">These memberships grant no group access until the current group owner independently approves them. Review can be required by a sensitive policy or a stewardship transfer. The API enforces reviewer separation and version checks.</p>
                    {pendingMembers.map((pending) => {
                      const group = data.userGroups.find((item) => item.id === pending.groupId);
                      return <div key={`${pending.groupId}-${pending.principalType}-${pending.principalId}`} data-testid={`row-pending-membership-${pending.groupId}-${pending.principalId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs">
                        <div>
                          <span className="font-medium">{principalLabel(pending.principalType, pending.principalId, data.members, data.agents)}</span>
                          <span className="mx-1 text-[var(--text-muted)]">→</span>{group?.name ?? pending.groupId}
                          <Badge className="ml-2 bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]">pending approval</Badge>
                          <p className="mt-1 text-[var(--text-muted)]">Requested by {pending.requestedByUserId ? principalLabel("user", pending.requestedByUserId, data.members, data.agents) : "unknown owner"}</p>
                        </div>
                        {canManage && group && <Button size="sm" disabled={busy} title="The API permits approval only by a different active organization owner." onClick={() => void perform(
                          () => accessRequest(`/user-groups/${encodeURIComponent(pending.groupId)}/members/approve`, {
                            method: "POST",
                            body: JSON.stringify({
                              principalType: pending.principalType,
                              principalId: pending.principalId,
                              expectedVersion: pending.expectedVersion,
                            }),
                          }),
                          "Group membership approved by an independent owner.",
                        )}><ShieldCheck className="mr-1 h-3.5 w-3.5" />Approve membership</Button>}
                      </div>;
                    })}
                  </div>}
                </section>

                <section className="border-t border-[var(--border)] pt-5">
                  <SectionTitle title="Security groups and policy catalog" detail="Policies can be read by administrators; owners edit allows. High-sensitivity policies require separate independent review before activation." />
                  <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_auto]">
                    <div className="rounded-md border border-[var(--border)] bg-[var(--surface-alt)] p-3">
                      <p className="mb-2 text-xs font-semibold">Policy catalog</p>
                      {data.catalog.length ? <div className="space-y-1.5">{data.catalog.map((policy) => <div key={policy.key} data-testid={`row-policy-catalog-${policy.key}`} className="flex flex-wrap items-center gap-2 text-xs"><span className="font-medium">{policy.label}</span><code className="text-[var(--text-muted)]">{policy.key}</code><Badge className={/high|critical/i.test(policy.sensitivity) ? "bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]" : "bg-[var(--surface-soft)] text-[var(--text-secondary)]"}>{policy.sensitivity}</Badge><span className="text-[var(--text-muted)]">{policy.kind}</span></div>)}</div> : <p className="text-xs text-[var(--text-muted)]">No catalog policies are available.</p>}
                    </div>
                    {canManage && <form className="flex gap-2 sm:flex-col" onSubmit={async (event) => {
                      event.preventDefault();
                      if (busy || !securityGroupName.trim()) return;
                      const saved = await perform(() => accessRequest("/security-groups", { method: "POST", body: JSON.stringify({ name: securityGroupName.trim(), allows: [] }) }), "Security group created.");
                      if (saved) setSecurityGroupName("");
                    }}>
                      <input aria-label="New security group name" className={inputClass} placeholder="New security group name" value={securityGroupName} onChange={(event) => setSecurityGroupName(event.target.value)} />
                      <Button type="submit" size="sm" disabled={busy || !securityGroupName.trim()}><Plus className="mr-1 h-3.5 w-3.5" />Create</Button>
                    </form>}
                  </div>
                  <div className="space-y-2">
                    {data.securityGroups.map((group) => <div key={group.id} id={`access-security-group-${group.id}`} tabIndex={-1} data-testid={`row-access-security-group-${group.id}`} className="rounded-md border border-[var(--border)] p-3">
                      {editingGroup === group.id ? <div className="space-y-3">
                        <input aria-label="Security group name" className={inputClass} value={groupDraftName} onChange={(event) => setGroupDraftName(event.target.value)} />
                        <div className="grid gap-2 sm:grid-cols-2">{data.catalog.map((policy) => <label key={policy.key} className={cn("flex items-start gap-2 rounded-md border border-[var(--border)] p-2 text-xs", /high|critical/i.test(policy.sensitivity) && "bg-[var(--status-amber-bg)]/40")}>
                          <input type="checkbox" aria-label={`Allow ${policy.label}`} checked={groupDraftAllows.includes(policy.key)} onChange={() => toggleAllow(policy.key)} />
                          <span>{policy.label}<span className="block text-[var(--text-muted)]">{policy.key} · {policy.sensitivity}</span></span>
                        </label>)}</div>
                        <div className="flex gap-2"><Button size="sm" disabled={busy || !groupDraftName.trim()} onClick={() => saveSecurityGroup(group)}><Check className="mr-1 h-3.5 w-3.5" />Save policy</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setEditingGroup(null)}>Cancel</Button></div>
                      </div> : <>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold">{group.name}</span><Badge className={group.status === "active" ? "bg-[var(--status-green-bg)] text-[var(--status-green-fg)]" : "bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)]"}>{group.status}</Badge><Badge className={group.approvalStatus === "approved" ? "bg-[var(--status-green-bg)] text-[var(--status-green-fg)]" : "bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]"}>{group.approvalStatus || "review not recorded"}</Badge></div>
                          {canManage && <div className="flex gap-2">{group.status === "active" && <><Button size="sm" variant="outline" disabled={busy} onClick={() => beginEdit(group)}>Edit policies</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void perform(() => accessRequest(`/security-groups/${encodeURIComponent(group.id)}`, { method: "PATCH", body: JSON.stringify({ status: "retired", expectedVersion: group.version }) }), "Security group retired.")}>Retire</Button></>}
                            {group.status === "active" && group.allows.some((key) => {
                              const item = data.catalog.find((policy) => policy.key === key);
                              return item && /high|critical/i.test(item.sensitivity);
                            }) && group.approvalStatus !== "approved" && <Button size="sm" disabled={busy} onClick={() => void perform(() => accessRequest(`/security-groups/${encodeURIComponent(group.id)}/approve`, { method: "POST", body: JSON.stringify({ expectedVersion: group.version }) }), "Independent approval recorded.")}><ShieldCheck className="mr-1 h-3.5 w-3.5" />Independent review</Button>}
                          </div>}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">{group.allows.map((key) => { const policy = data.catalog.find((item) => item.key === key); return <Badge key={key} className={policy && /high|critical/i.test(policy.sensitivity) ? "bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]" : "bg-[var(--surface-alt)] text-[var(--text-secondary)]"}>{policy?.label ?? key}</Badge>; })}</div>
                        {group.allows.some((key) => { const item = data.catalog.find((policy) => policy.key === key); return item && /high|critical/i.test(item.sensitivity); }) && group.approvalStatus !== "approved" && <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--status-amber-fg)]"><AlertTriangle className="h-3.5 w-3.5" />High-sensitivity access awaits independent review. The reviewer must be separate from the policy editor.</p>}
                      </>}
                    </div>)}
                  </div>
                </section>

                <section className="border-t border-[var(--border)] pt-5">
                  <SectionTitle title="Direct grants" detail="Grant an existing security group directly to a named human or registered agent. Group membership grants remain visible above." />
                  {canManage && <div className="flex flex-wrap gap-2 rounded-md bg-[var(--surface-alt)] p-3">
                    <select aria-label="Grant principal type" className={inputClass} value={grantType} onChange={(event) => { setGrantType(event.target.value as PrincipalType); setGrantPrincipalId(""); setGrantExpiry(""); }}><option value="user">Human</option><option value="agent">Registered agent</option></select>
                    <select aria-label="Grant principal" className={inputClass} value={grantPrincipalId} onChange={(event) => { setGrantPrincipalId(event.target.value); setGrantExpiry(localExpiry(data.grants.find((grant) => grant.principalType === grantType && grant.principalId === event.target.value && grant.securityGroupId === grantSecurityGroupId)?.expiresAt ?? null)); }}><option value="">Choose existing principal</option>{grantPrincipals.map((principal) => <option key={principal.id} value={principal.id}>{principal.label}</option>)}</select>
                    <select aria-label="Grant security group" className={inputClass} value={grantSecurityGroupId} onChange={(event) => { setGrantSecurityGroupId(event.target.value); setGrantExpiry(localExpiry(data.grants.find((grant) => grant.securityGroupId === event.target.value && grant.principalType === grantType && grant.principalId === grantPrincipalId)?.expiresAt ?? null)); }}><option value="">Choose security group</option>{activeSecurityGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
                    <label className="flex items-center gap-1 text-xs">Expires (optional) <input aria-label="Direct grant expires at" type="datetime-local" step="1" className={inputClass} value={grantExpiry} onChange={(event) => setGrantExpiry(event.target.value)} /></label>
                    <Button size="sm" disabled={busy || proposalLoading || !grantPrincipalId || !grantSecurityGroupId} onClick={() => {
                      void startProposalPreview({
                        kind: "grant", title: `Grant ${data.securityGroups.find((group) => group.id === grantSecurityGroupId)?.name ?? "security group"}`,
                        principalType: grantType, principalId: grantPrincipalId,
                        securityGroupId: grantSecurityGroupId, securityGroupIds: [grantSecurityGroupId],
                        expiry: grantExpiry,
                      });
                    }}>{proposalLoading ? "Preparing preview..." : "Preview grant impact"}</Button>
                  </div>}
                  {pendingDirectGrants.length > 0 && <div className="mt-3 space-y-2 rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)]/30 p-3">
                    <p className="text-xs font-semibold text-[var(--status-amber-fg)]">Pending direct grants</p>
                    {pendingDirectGrants.map((grant) => {
                      const group = data.securityGroups.find((item) => item.id === grant.securityGroupId);
                      const policyReady = group?.approvalStatus === "approved";
                      return <div key={`${grant.principalType}-${grant.principalId}-${grant.securityGroupId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs">
                        <div><span className="font-medium">{principalLabel(grant.principalType, grant.principalId, data.members, data.agents)}</span><span className="mx-1 text-[var(--text-muted)]">→</span>{group?.name ?? grant.securityGroupId}<Badge className="ml-2 bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]">pending review</Badge></div>
                        {canManage && <Button size="sm" disabled={busy || !policyReady || !group} title={!policyReady ? "Independently approve the security-group policy first." : "Must be approved by an owner other than the requester."} onClick={() => void perform(
                          () => accessRequest("/grants/approve", { method: "POST", body: JSON.stringify({
                            principalType: grant.principalType,
                            principalId: grant.principalId,
                            securityGroupId: grant.securityGroupId,
                            expectedVersion: group?.version ?? 0,
                          }) }),
                          "Direct grant approved by an independent owner.",
                        )}><ShieldCheck className="mr-1 h-3.5 w-3.5" />Approve grant</Button>}
                      </div>;
                    })}
                  </div>}
                  <div className="mt-3 space-y-1.5">{data.grants.map((grant, index) => <div key={`${grant.principalType}-${grant.principalId}-${grant.securityGroupId}-${index}`} data-testid={`row-access-grant-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-xs"><span>{principalLabel(grant.principalType, grant.principalId, data.members, data.agents)}<span className="mx-2 text-[var(--text-muted)]">→</span>{data.securityGroups.find((group) => group.id === grant.securityGroupId)?.name ?? grant.securityGroupId} · {expiryLabel(grant.expiresAt)}</span>{canManage && <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform(() => accessRequest("/grants", { method: "PUT", body: JSON.stringify({ principalType: grant.principalType, principalId: grant.principalId, securityGroupId: grant.securityGroupId, active: false }) }), "Direct grant revoked.")}>Revoke</Button>}</div>)}</div>
                </section>

                {proposedPreview && <div data-testid="card-access-proposed-preview" className="rounded-md border border-[var(--primary)] bg-[var(--primary-light)]/30 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-semibold text-[var(--text-primary)]">Review proposed access before saving</h4>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">{proposedPreview.title}. Current effective access is compared against the additional permissions from this change.</p>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">Evaluation context: {caseScopeId ? `case ${caseScopeId}` : "organization-wide"}{proposedPreview.impacts.some((impact) => impact.principal.includes("agent")) && initiatorUserId ? ` · initiator ${principalLabel("user", initiatorUserId, data.members, data.agents)}` : ""}. Agent access is evaluated using the selected initiator, not an implicit owner.</p>
                      <p className="mt-1 text-xs font-medium">{expiryLabel(proposedPreview.expiresAt)}. The server denies expired access immediately, without a cleanup job.</p>
                    </div>
                    {proposedPreview.sensitive && <Badge className="bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]">Independent review required</Badge>}
                  </div>
                  {proposedPreview.policyApprovalNeeded && <p className="mt-3 flex items-start gap-2 rounded-md bg-[var(--status-amber-bg)] p-2 text-xs text-[var(--status-amber-fg)]"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />The security-group policy itself is not independently approved. Any high-sensitivity attachment or grant will remain pending until that review is completed.</p>}
                  {proposedPreview.futureOnly ? <p className="mt-3 text-xs text-[var(--text-muted)]">This user group has no current members. The attachment would affect future members; no current principal preview is available.</p> : (
                    <div className="mt-3 space-y-2">{proposedPreview.impacts.map((impact) => <div key={impact.principal} className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 text-xs">
                      <p className="font-medium">{impact.principal}</p>
                      <p className="mt-1 text-[var(--text-muted)]">Currently effective: {impact.current.length ? impact.current.map((key) => data.catalog.find((item) => item.key === key)?.label ?? key).join(", ") : "none"}</p>
                      <p className="mt-1"><span className="font-medium">Additional if approved: </span>{impact.additional.length ? impact.additional.map((key) => data.catalog.find((item) => item.key === key)?.label ?? key).join(", ") : "none beyond current effective access"}</p>
                    </div>)}</div>
                  )}
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" disabled={busy} onClick={() => void commitProposal()}>
                      {proposedPreview.sensitive ? "Submit for independent review" : "Confirm and save"}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setProposedPreview(null)}>Cancel preview</Button>
                  </div>
                  {proposedPreview.sensitive && <p className="mt-2 text-xs text-[var(--text-muted)]">The request will remain pending until a different active organization owner approves it. The API enforces reviewer separation; the requesting owner cannot approve their own request.</p>}
                </div>}

                <section className="border-t border-[var(--border)] pt-5">
                  <SectionTitle title="Effective access preview" detail="Resolve effective access for a selected principal in the evaluation context above, with per-policy explanations." />
                  <div className="flex flex-wrap gap-2">
                    <select aria-label="Preview principal type" className={inputClass} value={previewType} onChange={(event) => { setPreviewType(event.target.value as PrincipalType); setPreviewPrincipalId(""); setPreviewEnabled(false); }}><option value="user">Human</option><option value="agent">Registered agent</option></select>
                    <select aria-label="Preview principal" className={inputClass} value={previewPrincipalId} onChange={(event) => { setPreviewPrincipalId(event.target.value); setPreviewEnabled(false); }}><option value="">Choose principal</option>{previewPrincipals.map((principal) => <option key={principal.id} value={principal.id}>{principal.label}</option>)}</select>
                    <Button size="sm" variant="secondary" disabled={!previewPrincipalId || !isValidOptionalCaseId(caseScopeId) || (previewType === "agent" && !initiatorUserId) || previewQuery.isFetching} onClick={() => setPreviewEnabled(true)}>Preview effective access</Button>
                  </div>
                  {previewType === "agent" && !initiatorUserId && <p className="mt-2 text-xs text-[var(--text-muted)]">Select an initiator user above to evaluate this agent. The registered owner is not assumed.</p>}
                  {previewEnabled && (previewQuery.isLoading ? <LoadingBlock>Resolving access...</LoadingBlock> : previewQuery.isError ? <p role="alert" className="mt-2 text-xs text-[var(--status-red-fg)]">{errorText(previewQuery.error)}</p> : previewQuery.data && <div className="mt-3 rounded-md border border-[var(--border)] p-3">
                    <p className="mb-2 text-xs text-[var(--text-muted)]">Context: {caseScopeId ? `case ${caseScopeId}` : "organization-wide"}{previewType === "agent" ? ` · initiated by ${principalLabel("user", initiatorUserId, data.members, data.agents)}` : ""}.</p>
                    {previewType === "agent" && <p className="mb-2 text-xs text-[var(--text-muted)]">These are the agent’s effective permissions in the selected initiator’s context, not standalone agent capabilities.</p>}
                    {previewQuery.data.allows.length ? <div className="flex flex-wrap gap-1.5">{previewQuery.data.allows.map((key) => <Badge key={key}>{data.catalog.find((item) => item.key === key)?.label ?? key}</Badge>)}</div> : <p className="text-xs text-[var(--text-muted)]">No effective policy allows were resolved.</p>}
                    <div className="mt-3 space-y-1.5">{Object.entries(previewQuery.data.reasons ?? {}).map(([key, reasons]) => <p key={key} className="text-xs"><span className="font-medium">{data.catalog.find((item) => item.key === key)?.label ?? key}:</span> <span className="text-[var(--text-muted)]">{reasons.join(" · ")}</span></p>)}</div>
                  </div>)}
                </section>

                <section className="border-t border-[var(--border)] pt-5">
                  <SectionTitle title="Sensitive field access" detail="Inspect effective field access in the selected case and initiator context above." />
                  <p className="mb-2 text-xs text-[var(--text-muted)]">An initiator is required so registered-agent results can be resolved explicitly rather than against an implicit owner.</p>
                  <div className="flex flex-wrap gap-2"><select aria-label="Sensitive field" className={inputClass} value={fieldKey} onChange={(event) => { setFieldKey(event.target.value); setFieldEnabled(false); }}><option value="">Choose catalog field</option>{data.catalog.map((item) => <option key={item.key} value={item.key}>{item.label} · {item.key}</option>)}</select><Button size="sm" variant="secondary" disabled={!fieldKey || !initiatorUserId || !isValidOptionalCaseId(caseScopeId) || fieldQuery.isFetching} onClick={() => setFieldEnabled(true)}>Review field access</Button></div>
                  {fieldEnabled && (fieldQuery.isLoading ? <LoadingBlock>Checking field access...</LoadingBlock> : fieldQuery.isError ? <p role="alert" className="mt-2 text-xs text-[var(--status-red-fg)]">{errorText(fieldQuery.error)}</p> : fieldQuery.data && <div className="mt-3 space-y-2">
                    <p className="text-xs text-[var(--text-muted)]">Context: {caseScopeId ? `case ${caseScopeId}` : "organization-wide"} · initiator {principalLabel("user", initiatorUserId, data.members, data.agents)}.</p>
                    {fieldQuery.data.principals.length ? fieldQuery.data.principals.map((principal, index) => <div key={`${principal.principalType}-${principal.principalId}-${index}`} className="rounded-md border border-[var(--border)] p-3 text-xs"><p className="font-medium">{principal.principalType}: {principal.principalId}</p><p className="mt-1 text-[var(--text-muted)]">{principal.reasons.join(" · ")}</p></div>) : <p className="text-xs text-[var(--text-muted)]">No principals have effective access to this field.</p>}
                  </div>)}
                </section>

                <section className="border-t border-[var(--border)] pt-5">
                  <SectionTitle title="Governance history" detail="Access changes and independent review records are retained for audit." />
                  {data.history.length ? <div className="space-y-2">{data.history.map((entry, index) => {
                    const readable = {
                      ...entry,
                      actor: entry.actorUserId ? principalLabel("user", entry.actorUserId, data.members, data.agents) : "System",
                      detail: entry.detail ? {
                        ...entry.detail,
                        ...(typeof entry.detail.principalId === "string" && typeof entry.detail.principalType === "string"
                          ? { principal: principalLabel(entry.detail.principalType, entry.detail.principalId, data.members, data.agents) }
                          : {}),
                      } : entry.detail,
                    };
                    return <div key={entry.id ?? index} data-testid={`row-access-history-${index}`} className="flex items-start gap-2 rounded-md border border-[var(--border)] p-3 text-xs"><History className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" /><pre className="m-0 whitespace-pre-wrap break-words font-sans text-[var(--text-secondary)]">{JSON.stringify(readable, null, 2)}</pre></div>;
                  })}</div> : <p className="text-xs text-[var(--text-muted)]">No access-governance history is available.</p>}
                </section>
              </>
            )}
          {notice && <p role={notice.ok ? "status" : "alert"} data-testid="status-access-governance" className={cn("rounded-md p-3 text-xs", notice.ok ? "bg-[var(--status-green-bg)] text-[var(--status-green-fg)]" : "bg-[var(--status-red-bg)] text-[var(--status-red-fg)]")}>{noticeContent(notice)}</p>}
          {canManage && activeGroupMembers.length === 0 && snapshot && <p className="text-xs text-[var(--text-muted)]">No active human members are available for ownership assignments.</p>}
        </div>
      </CardContent>
    </Card>
  );
}
