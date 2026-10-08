import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getHrPolicyDriftNotifications, updateHrPolicyDriftNotifications, type HrPolicyDriftNoticeInput } from "@workspace/api-client-react";
import { usePolicyScope } from "./use-policies";

export function useDriftNotifications() {
  const scope = usePolicyScope();
  const client = useQueryClient();
  const key = ["policy-drift-inbox", scope.organizationId, scope.userId];
  const query = useQuery({
    queryKey: key, queryFn: ({ signal }) => getHrPolicyDriftNotifications({ signal }),
    enabled: Boolean(scope.organizationId && scope.userId),
    staleTime: 0, refetchInterval: 15000,
  });
  async function update(input: HrPolicyDriftNoticeInput) {
    await updateHrPolicyDriftNotifications(input);
    // Never apply a response to a different user's scope.
    await client.invalidateQueries({ queryKey: key });
  }
  return { ...query, update };
}
