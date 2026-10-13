import { useRef, useState } from "react";
import {
  getGetOnboardingActionCenterQueryKey,
  useAssignOnboardingActionCenterWork,
  useEscalateOnboardingActionCenterWork,
  type OnbActionCenterWorkInputOwner,
} from "@workspace/api-client-react";
import { Button, Label } from "@/components/ui-shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

type WorkKind = "assign" | "escalate";

type ActionCenterCreateWorkProps = {
  caseId: number;
  actionVersion: number;
  reason?: string | null;
  disabled?: boolean;
};

const queues: Array<{ value: OnbActionCenterWorkInputOwner; label: string }> = [
  { value: "hr", label: "HR" },
  { value: "recruiter", label: "Recruiter" },
  { value: "hiring-manager", label: "Hiring manager" },
  { value: "bgv-team", label: "BGV team" },
  { value: "documentation", label: "Documentation" },
  { value: "operations", label: "Operations" },
  { value: "compliance", label: "Compliance" },
];

function requestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isConflict(error: unknown): boolean {
  const candidate = error as {
    status?: number;
    response?: { status?: number };
    message?: string;
  } | null;
  return candidate?.status === 409 ||
    candidate?.response?.status === 409 ||
    /409|changed since|reload before retry|conflict/i.test(candidate?.message ?? "");
}

/**
 * Creates the first durable work item for a case. The request id is retained
 * for an identical retry so a replay is acknowledged by the server rather
 * than creating a second assignment.
 */
export function ActionCenterCreateWork({
  caseId,
  actionVersion,
  reason: initialReason,
  disabled = false,
}: ActionCenterCreateWorkProps) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<WorkKind>("assign");
  const [owner, setOwner] = useState<OnbActionCenterWorkInputOwner | "client-routing">("client-routing");
  const [assignee, setAssignee] = useState("");
  const [reason, setReason] = useState(initialReason ?? "");
  const requestRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const assignMutation = useAssignOnboardingActionCenterWork();
  const escalateMutation = useEscalateOnboardingActionCenterWork();
  const pending = assignMutation.isPending || escalateMutation.isPending;

  const openFor = (nextKind: WorkKind) => {
    setKind(nextKind);
    setOpen(true);
  };

  const invalidateActionCenter = async () => {
    await Promise.all(
      (["active", "completed", "all"] as const).map((scope) =>
        queryClient.invalidateQueries({
          queryKey: getGetOnboardingActionCenterQueryKey({ scope }),
        }),
      ),
    );
  };

  const handleSubmit = async () => {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      toast({
        title: "Reason required",
        description: "Add a reason before creating this work item.",
        variant: "destructive",
      });
      return;
    }

    const payloadWithoutRequestId = {
      caseId,
      owner: owner === "client-routing" ? undefined : owner,
      assignee: assignee.trim() || null,
      reason: trimmedReason,
      expectedVersion: actionVersion,
      kind,
    };
    const fingerprint = JSON.stringify(payloadWithoutRequestId);
    if (requestRef.current?.fingerprint !== fingerprint) {
      requestRef.current = { fingerprint, id: requestId() };
    }
    const data = {
      requestId: requestRef.current.id,
      caseId,
      owner: owner === "client-routing" ? undefined : owner,
      assignee: assignee.trim() || null,
      reason: trimmedReason,
      expectedVersion: actionVersion,
    };

    try {
      if (kind === "assign") {
        await assignMutation.mutateAsync({ data });
      } else {
        await escalateMutation.mutateAsync({ data });
      }
      await invalidateActionCenter();
      toast({
        title: kind === "assign" ? "Work item created" : "Work item escalated",
        description: "The Action Center list has been refreshed.",
      });
      setOpen(false);
    } catch (error) {
      if (isConflict(error)) {
        await queryClient.refetchQueries({
          queryKey: getGetOnboardingActionCenterQueryKey({ scope: "active" }),
        });
        toast({
          title: "Action Center changed",
          description: "The current list was reloaded. Review the preserved form before retrying.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Could not create work item",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || pending}
          onClick={() => openFor("assign")}
        >
          Assign work
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || pending}
          onClick={() => openFor("escalate")}
        >
          Escalate
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {kind === "assign" ? "Create work item" : "Escalate work item"}
            </DialogTitle>
            <DialogDescription>
              This creates a durable human queue item for case #{caseId}. No provider or readiness effect is performed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor={`action-center-owner-${caseId}`}>Owner queue</Label>
              <Select
                value={owner}
                disabled={pending}
                onValueChange={(value) => setOwner(value as OnbActionCenterWorkInputOwner | "client-routing")}
              >
                <SelectTrigger id={`action-center-owner-${caseId}`}>
                  <SelectValue placeholder="Select a queue" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="client-routing">Use client routing</SelectItem>
                  {queues.map((queue) => (
                    <SelectItem key={queue.value} value={queue.value}>
                      {queue.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {owner === "client-routing" && <p className="text-xs text-[var(--text-muted)]">Uses this client's configured routing rule. With no assignee, the configured group label is applied. This is queue responsibility metadata, not an email or access grant.</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor={`action-center-assignee-${caseId}`}>
                Assignee <span className="text-[var(--text-muted)]">(optional)</span>
              </Label>
              <Input
                id={`action-center-assignee-${caseId}`}
                value={assignee}
                onChange={(event) => setAssignee(event.target.value)}
                placeholder="Name or team member"
                disabled={pending}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`action-center-reason-${caseId}`}>Reason</Label>
              <Textarea
                id={`action-center-reason-${caseId}`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Explain the follow-up needed"
                required
                disabled={pending}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={pending || !reason.trim()}>
              {pending
                ? "Saving..."
                : kind === "assign"
                  ? "Create assignment"
                  : "Create escalation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default ActionCenterCreateWork;