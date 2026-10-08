import { useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import {
  useRevokeVaultShareRequest, getGetVaultDashboardQueryKey, getGetVaultShareRequestQueryKey,
} from '@workspace/api-client-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { errMsg } from '@/lib/vault';

export function RevokeButton({ id, employer }: { id: string; employer: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const revoke = useRevokeVaultShareRequest();
  const run = () =>
    revoke.mutate({ id }, {
      onSuccess: () => {
        toast({ title: 'Access revoked', description: `${employer} can no longer use what you shared.` });
        qc.invalidateQueries({ queryKey: getGetVaultDashboardQueryKey() });
        qc.invalidateQueries({ queryKey: getGetVaultShareRequestQueryKey(id) });
      },
      onError: (e) => toast({ variant: 'destructive', title: 'Could not revoke', description: errMsg(e) }),
    });
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={revoke.isPending} data-testid={`button-revoke-${id}`}><Undo2 className="mr-1.5 h-4 w-4" />Revoke</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke consent for {employer}?</AlertDialogTitle>
          <AlertDialogDescription>They will lose access to what this approval shared. You can't undo this, but they may send a new request.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-revoke-cancel">Keep access</AlertDialogCancel>
          <AlertDialogAction onClick={run} data-testid="button-revoke-confirm">Revoke access</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
