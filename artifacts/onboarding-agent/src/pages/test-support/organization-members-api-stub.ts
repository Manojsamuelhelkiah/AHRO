import { useState } from "react";

type MutationOutcome =
  | { kind: "success"; value?: unknown }
  | { kind: "error"; error: unknown };

type TestState = {
  activeMembers: unknown[];
  removedMembers: unknown[];
  removedHookOptions: Array<{ query?: { enabled?: boolean; staleTime?: number } }>;
  removedRefetches: number;
  reinstateCalls: unknown[];
  reinstateOutcome: MutationOutcome;
};

function getState(): TestState {
  return (globalThis as typeof globalThis & {
    __organizationMembersTestState: TestState;
  }).__organizationMembersTestState;
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
    mutate: () => undefined,
  };
}

export function useRemoveOrganizationMember() {
  return {
    isPending: false,
    mutate: () => undefined,
  };
}