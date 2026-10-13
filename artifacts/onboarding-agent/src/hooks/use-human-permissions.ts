import { useQuery } from "@tanstack/react-query";
import { customFetch, getPinnedOrganizationIdForPage } from "@workspace/api-client-react";
import { useUser } from "@clerk/react";

/** UI hints only. Every decision is independently checked live by the server. */
export function useHumanPermissions() {
  const { user } = useUser();
  const organizationId = getPinnedOrganizationIdForPage();
  return useQuery({
    queryKey: ["current-human-permissions", organizationId, user?.id],
    enabled: !!user && !!organizationId,
    queryFn: () => customFetch<{ allows: string[] }>("/api/onboarding/human-permissions", {
      headers: { "X-Organization-Id": organizationId ?? "" },
    }),
    staleTime: 0, refetchInterval: 30000,
  });
}
