import { useEffect, useState } from "react";
import { useUser } from "@clerk/react";
import {
  completeDemoControllerSetup,
  getDemoControllerSetupStatus,
  getPinnedOrganizationIdForPage,
  requestDemoControllerSetup,
  type DemoControllerSetupResponse,
} from "@workspace/api-client-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Label } from "@/components/ui-shared";

export function DemoControllerAccessSetup() {
  const { user } = useUser();
  const organizationId = getPinnedOrganizationIdForPage();
  const queryClient = useQueryClient();
  const queryKey = ["demo-controller-setup", user?.id, organizationId];
  const [confirmed, setConfirmed] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const status = useQuery({
    queryKey,
    queryFn: ({ signal }) => getDemoControllerSetupStatus({ signal, cache: "no-store" }),
    enabled: !!user && organizationId === "demo",
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: 15_000,
  });
  useEffect(() => {
    setConfirmed(false);
    setCopyMessage("");
  }, [user?.id, organizationId, status.data?.request?.requestId]);
  const request = useMutation({
    mutationFn: () => requestDemoControllerSetup(),
    onSuccess: (data) => {
      setConfirmed(false);
      setCopyMessage("");
      queryClient.setQueryData(queryKey, data);
    },
  });
  const complete = useMutation({
    mutationFn: (requestId: string) => completeDemoControllerSetup({ requestId }),
    onSuccess: () => {
      // Role hooks and organization bootstrap also need the new membership.
      // Reload only after the server commits; never optimistically elevate.
      queryClient.clear();
      window.location.reload();
    },
    onError: () => { void status.refetch(); },
  });

  if (organizationId !== "demo") {
    return <Card className="p-6 text-sm">
      Select Demo Organization in the workspace selector to request Demo Controller access.
      An Owner or Admin role in another workspace does not grant Demo access.
    </Card>;
  }

  const error = request.error || complete.error;
  return (
    <Card className="p-6 space-y-4">
      <h3 className="text-lg font-semibold">First Demo administrator setup</h3>
      <p className="text-sm text-[var(--text-secondary)]">
        Demo members can run presentations. Administrator access is separate:
        signing in or joining Demo Organization does not grant it.
        Use your own signed-in account, not the shared reviewer login.
        If Demo already has an Owner or Admin, contact them or the project operator.
        This one-time setup is only available when Demo has no administrator.
      </p>
      {status.isLoading && <p role="status" className="text-sm">Checking setup availability…</p>}
      {status.isError && <div role="alert" className="space-y-2 text-sm">
        <p>{status.error.message || "Could not check setup access."}</p>
        <Button variant="outline" onClick={() => void status.refetch()}>Retry access check</Button>
      </div>}
      {status.data && !status.data.eligible && (
        <p role="status" className="text-sm">{status.data.reason || "Setup is not available. Contact the project operator."}</p>
      )}
      {status.data?.eligible && (
        <>
          <p className="text-sm">
            Your request is bound to this signed-in account
            {user?.primaryEmailAddress?.emailAddress ? <> ({user.primaryEmailAddress.emailAddress})</> : null}.
            The project operator must explicitly approve this account; an email address alone is not approval.
          </p>
          {!status.data.request ? (
            <Button disabled={request.isPending} onClick={() => request.mutate()}>
              {request.isPending ? "Creating request…" : "Create private setup request"}
            </Button>
          ) : (
            <SetupRequestInstructions
              state={status.data}
              confirmed={confirmed}
              setConfirmed={setConfirmed}
              copyMessage={copyMessage}
              onCopy={async () => {
                try {
                  await navigator.clipboard.writeText(status.data!.request!.approvalValue);
                  setCopyMessage("Approval value copied. Share it only with the project operator through a private channel.");
                } catch {
                  setCopyMessage("Copy was blocked by the browser. Select the approval value below and copy it manually.");
                }
              }}
              checking={status.isFetching}
              onCheck={() => void status.refetch()}
              completing={complete.isPending}
              onComplete={() => {
                if (confirmed && status.data?.request) complete.mutate(status.data.request.requestId);
              }}
            />
          )}
        </>
      )}
      {error && <p role="alert" className="text-sm text-[var(--status-red-fg)]">{error.message}</p>}
    </Card>
  );
}

export function SetupRequestInstructions({
  state, confirmed, setConfirmed, copyMessage, onCopy, checking, onCheck, completing, onComplete,
}: {
  state: DemoControllerSetupResponse;
  confirmed: boolean;
  setConfirmed: (value: boolean) => void;
  copyMessage: string;
  onCopy: () => void;
  checking: boolean;
  onCheck: () => void;
  completing: boolean;
  onComplete: () => void;
}) {
  const request = state.request!;
  const expired = new Date(request.expiresAt).getTime() <= Date.now();
  return <div className="space-y-4 text-sm">
    <ol className="list-decimal pl-5 space-y-2 text-[var(--text-secondary)]">
      <li>Privately ask the project operator to verify that you are the intended Demo administrator. Do not send passwords, internal user IDs, or this approval value in Agent chat.</li>
      <li>
        After verifying your account and request, the operator sets the server-side secret{" "}
        <code className="break-all">DEMO_CONTROLLER_SETUP_APPROVAL</code> to the approval value below
        in Publishing → Adjust settings → Deployment secrets, then republishes the app to apply it.
        For a development preview, set it in development and restart the API instead.
        Do not use a frontend/VITE variable.
      </li>
      <li>Return here while signed in to this same account, check approval, and confirm the grant. The operator should remove the approval secret after completion.</li>
    </ol>
    <div className="space-y-2">
      <Label htmlFor="demo-setup-approval">Private approval value</Label>
      <textarea id="demo-setup-approval" readOnly value={request.approvalValue}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-alt)] p-3 font-mono text-xs break-all"
        rows={3} spellCheck={false} />
      <Button variant="outline" onClick={onCopy}>Copy approval value</Button>
      {copyMessage && <p role="status">{copyMessage}</p>}
    </div>
    <p>Expires: {new Date(request.expiresAt).toLocaleString()}. Expired requests need a new operator approval.</p>
    <p role="status" className="font-semibold">
      {expired ? "This request has expired. Check approval to refresh its status."
        : request.approved ? "Operator approval received. Your membership has not changed yet."
          : "Waiting for explicit project operator approval."}
    </p>
    <Button variant="outline" disabled={checking || completing} onClick={onCheck}>
      {checking ? "Checking…" : "Check approval"}
    </Button>
    {request.approved && !expired && <div className="space-y-3 border-t border-[var(--border)] pt-4">
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={confirmed} disabled={completing}
          onChange={(event) => setConfirmed(event.target.checked)} className="mt-1" />
        <span>I authorize making this account a Demo Organization Admin. This grants Demo administrative permissions, not access to any other organization. Completion is recorded and cannot be repeated.</span>
      </label>
      <Button disabled={!confirmed || completing} onClick={onComplete}>
        {completing ? "Completing setup…" : "Confirm and enable Demo access"}
      </Button>
    </div>}
  </div>;
}