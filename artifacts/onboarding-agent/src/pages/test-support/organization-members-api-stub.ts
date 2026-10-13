import { useState } from "react";

type MutationOutcome =
  | { kind: "success"; value?: unknown }
  | { kind: "error"; error: unknown };

type TestState = {
  activeMembers: unknown[];
  removedMembers: unknown[];
  removedHookOptions: Array<{ query?: { enabled?: boolean; staleTime?: number } }>;
  removedRefetches: number;
  activeRefetches?: number;
  roleCalls?: unknown[];
  removeCalls?: unknown[];
  reinstateCalls: unknown[];
  reinstateOutcome: MutationOutcome;
};

function getState(): TestState {
  return (globalThis as typeof globalThis & {
    __organizationMembersTestState: TestState;
  }).__organizationMembersTestState;
}

export function getPinnedOrganizationIdForPage() {
  return "members-test-org";
}

export function getListOrganizationMembersQueryKey() {
  return ["organization-members"];
}

export function getListRemovedOrganizationMembersQueryKey() {
  return ["organization-removed-members"];
}

export function useListOrganizationMembers() {
  const state = getState();
  return {
    data: state.activeMembers,
    isLoading: false,
    isError: false,
    error: null,
    refetch: async () => { state.activeRefetches = (state.activeRefetches ?? 0) + 1; },
  };
}

export function useListRemovedOrganizationMembers(
  options: { query?: { enabled?: boolean; staleTime?: number } } = {},
) {
  const state = getState();
  state.removedHookOptions.push(options);
  const [, setRefetchCount] = useState(0);

  return {
    data: state.removedMembers,
    isLoading: false,
    isError: false,
    error: null,
    refetch: async () => {
      state.removedRefetches += 1;
      setRefetchCount((count) => count + 1);
    },
  };
}

export function useReinstateOrganizationMember(options: {
  mutation?: {
    onSuccess?: (value?: unknown) => void;
    onError?: (error: unknown) => void;
  };
}) {
  const [isPending, setPending] = useState(false);
  const state = getState();

  return {
    isPending,
    mutate: (payload: unknown) => {
      state.reinstateCalls.push(payload);
      setPending(true);
      Promise.resolve().then(() => {
        setPending(false);
        const outcome = getState().reinstateOutcome;
        if (outcome.kind === "error") {
          options.mutation?.onError?.(outcome.error);
        } else {
          options.mutation?.onSuccess?.(outcome.value);
        }
      });
    },
  };
}

export function useChangeOrganizationMemberRole() {
  return {
    isPending: false,
    mutate: (payload: unknown) => { getState().roleCalls?.push(payload); },
  };
}

export function useRemoveOrganizationMember() {
  return {
    isPending: false,
    mutate: (payload: unknown) => { getState().removeCalls?.push(payload); },
  };
}