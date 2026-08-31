import { useState } from "react";
import { useLocation } from "wouter";
import { 
  useListEaAssessments, 
  useCreateEaAssessment, 
  useDeleteEaAssessment, 
  useArchiveEaAssessment,
  getEaAssessment,
  getGetEaAssessmentQueryKey,
  getListEaAssessmentsQueryKey,
  type EaAssessment,
  type EaArchiveRequest,
  type EaDeleteRequest,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  Plus, 
  Building, 
  Trash2, 
  Archive, 
  MoreVertical, 
  ArrowRight,
  FolderOpen
} from "lucide-react";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createEmptyAssessment, enqueueAssessmentUpdate, waitForAssessmentUpdates } from "@/components/enterprise-architecture/utils";
import { useToast } from "@/hooks/use-toast";

export function Portfolio() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const { data: assessments, isLoading } = useListEaAssessments();
  const createMutation = useCreateEaAssessment();
  const deleteMutation = useDeleteEaAssessment();
  const archiveMutation = useArchiveEaAssessment();

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [newClient, setNewClient] = useState("");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newClient.trim()) return;

    try {
      const result = await createMutation.mutateAsync({
        data: createEmptyAssessment(newName, newClient)
      });
      await queryClient.invalidateQueries({ queryKey: getListEaAssessmentsQueryKey() });
      setCreateOpen(false);
      setNewName("");
      setNewClient("");
      setLocation(`/enterprise-architecture?id=${result.id}`);
      toast({ title: "Assessment created", description: "Navigating to workspace..." });
    } catch (error) {
      toast({ title: "Error", description: "Failed to create assessment.", variant: "destructive" });
    }
  };

  const handleArchive = async (id: number) => {
    const detailKey = getGetEaAssessmentQueryKey(id);
    const listKey = getListEaAssessmentsQueryKey();
    try {
      await waitForAssessmentUpdates(id);
      await enqueueAssessmentUpdate(id, async () => {
        const latest = queryClient.getQueryData<EaAssessment>(detailKey)
          ?? await queryClient.fetchQuery({
            queryKey: detailKey,
            queryFn: () => getEaAssessment(id),
          });
        if (!latest) throw new Error("Unable to load the latest assessment before archiving.");
        const data: EaArchiveRequest = { expectedVersion: latest.version };
        const archivedAssessment = await archiveMutation.mutateAsync({ id, data });
        queryClient.setQueryData(detailKey, archivedAssessment);
        queryClient.setQueryData<EaAssessment[]>(listKey, (current) =>
          current?.map((item) => item.id === id ? archivedAssessment : item),
        );
      });
      toast({ title: "Assessment archived" });
    } catch (error) {
      const status = typeof error === "object" && error !== null
        ? ("status" in error ? error.status : "response" in error && typeof error.response === "object" && error.response !== null && "status" in error.response ? error.response.status : undefined)
        : undefined;
      if (status === 409) {
        await Promise.all([
          queryClient.refetchQueries({ queryKey: detailKey }),
          queryClient.refetchQueries({ queryKey: listKey }),
        ]);
        toast({
          title: "Archive conflict",
          description: "The assessment changed before it could be archived. Pending edits were preserved and the latest version has been loaded.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Error", description: "Failed to archive assessment. Your pending edits were not discarded.", variant: "destructive" });
      }
    }
  };

  const handleDelete = async () => {
    if (!deleteOpen) return;
    const id = deleteOpen;
    const detailKey = getGetEaAssessmentQueryKey(id);
    const listKey = getListEaAssessmentsQueryKey();
    try {
      await enqueueAssessmentUpdate(id, async () => {
        const latest = queryClient.getQueryData<EaAssessment>(detailKey)
          ?? await queryClient.fetchQuery({
            queryKey: detailKey,
            queryFn: () => getEaAssessment(id),
          });
        if (!latest) throw new Error("Unable to load the latest assessment before deleting.");
        const data: EaDeleteRequest = { expectedVersion: latest.version };
        await deleteMutation.mutateAsync({ id, data });
        queryClient.removeQueries({ queryKey: detailKey, exact: true });
      });
      await queryClient.invalidateQueries({ queryKey: listKey });
      toast({ title: "Assessment deleted" });
      setDeleteOpen(null);
    } catch (error) {
      const status = typeof error === "object" && error !== null
        ? ("status" in error ? error.status : "response" in error && typeof error.response === "object" && error.response !== null && "status" in error.response ? error.response.status : undefined)
        : undefined;
      if (status === 409) {
        await Promise.all([
          queryClient.refetchQueries({ queryKey: detailKey }),
          queryClient.refetchQueries({ queryKey: listKey }),
        ]);
        setDeleteOpen(null);
        toast({
          title: "Delete conflict",
          description: "The assessment changed or was archived before deletion. It was not deleted, and the latest version has been loaded.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Error", description: "Failed to delete assessment.", variant: "destructive" });
      }
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-7xl mx-auto">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between p-8 rounded-2xl bg-slate-900 text-slate-50 shadow-sm border border-slate-800">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Building className="w-8 h-8 text-teal-400" />
            Enterprise Architecture
          </h1>
          <p className="text-slate-300 mt-2">Assess landscapes, model solutions, and govern implementation.</p>
        </div>
        
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-create-assessment" className="bg-teal-500 hover:bg-teal-600 text-teal-950 font-semibold border-none">
              <Plus className="w-4 h-4 mr-2" />
              New Assessment
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={handleCreate}>
              <DialogHeader>
                <DialogTitle>New EA Assessment</DialogTitle>
                <DialogDescription>
                  Create a new architecture workspace for a prospective or existing client.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Assessment Name</Label>
                  <Input 
                    id="name" 
                    placeholder="e.g. Q3 Cloud Migration Strategy" 
                    value={newName} 
                    onChange={e => setNewName(e.target.value)} 
                    data-testid="input-assessment-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="client">Client Name</Label>
                  <Input 
                    id="client" 
                    placeholder="e.g. Acme Corp" 
                    value={newClient} 
                    onChange={e => setNewClient(e.target.value)} 
                    data-testid="input-assessment-client"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={createMutation.isPending || !newName.trim() || !newClient.trim()} data-testid="button-submit-assessment">
                  {createMutation.isPending ? "Creating..." : "Create Workspace"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-48 rounded-xl" />)}
        </div>
      ) : assessments?.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-12 border border-dashed rounded-xl bg-muted/10 text-center">
          <FolderOpen className="w-12 h-12 text-muted-foreground mb-4 opacity-50" />
          <h3 className="text-lg font-medium">No assessments yet</h3>
          <p className="text-sm text-muted-foreground max-w-sm mt-1 mb-6">
            Create your first enterprise architecture assessment to start capturing current state and modeling target solutions.
          </p>
          <Button onClick={() => setCreateOpen(true)} variant="outline">
            <Plus className="w-4 h-4 mr-2" /> Create Assessment
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {assessments?.map(assessment => (
            <Card key={assessment.id} className="group relative overflow-hidden flex flex-col hover:border-primary/50 transition-colors">
              {assessment.status === 'archived' && (
                <div className="absolute top-0 right-0 left-0 bg-muted text-muted-foreground text-[10px] font-semibold uppercase tracking-wider py-1 px-3 flex justify-between items-center z-10 border-b">
                  <span>Archived</span>
                  {assessment.archivedAt && <span>{format(new Date(assessment.archivedAt), 'MMM d, yyyy')}</span>}
                </div>
              )}
              
              <CardHeader className={`pb-3 ${assessment.status === 'archived' ? 'pt-8 opacity-70' : ''}`}>
                <div className="flex justify-between items-start">
                  <div className="space-y-1">
                    <Badge variant="outline" className="text-[10px] bg-background mb-1">
                      {assessment.clientName}
                    </Badge>
                    <CardTitle className="text-lg line-clamp-2 leading-tight">
                      {assessment.name}
                    </CardTitle>
                  </div>
                  
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="-mt-2 -mr-2 h-8 w-8 text-muted-foreground hover:text-foreground">
                        <MoreVertical className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {assessment.status !== 'archived' && (
                        <DropdownMenuItem onClick={() => handleArchive(assessment.id)}>
                          <Archive className="w-4 h-4 mr-2" /> Archive
                        </DropdownMenuItem>
                      )}
                       {assessment.status !== "archived" && (
                         <>
                           <DropdownMenuSeparator />
                           <DropdownMenuItem onClick={() => setDeleteOpen(assessment.id)} className="text-destructive focus:bg-destructive/10 focus:text-destructive" data-testid={`btn-delete-${assessment.id}`}>
                             <Trash2 className="w-4 h-4 mr-2" /> Delete
                           </DropdownMenuItem>
                         </>
                       )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>
              
              <CardContent className={`flex-1 text-sm ${assessment.status === 'archived' ? 'opacity-70' : ''}`}>
                <div className="space-y-3">
                  <div>
                    <div className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Current Phase</div>
                    <div className="capitalize">{assessment.currentPhase.replace(/-/g, ' ')}</div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-muted-foreground mb-0.5">Last Updated</div>
                      <div>{format(new Date(assessment.updatedAt), 'MMM d, yyyy')}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Created</div>
                      <div>{format(new Date(assessment.createdAt), 'MMM d, yyyy')}</div>
                    </div>
                  </div>
                </div>
              </CardContent>
              
              <CardFooter className={`pt-3 border-t bg-muted/20 ${assessment.status === 'archived' ? 'opacity-70' : ''}`}>
                <Button 
                  className="w-full justify-between" 
                  variant={assessment.status === 'archived' ? "secondary" : "default"}
                  onClick={() => setLocation(`/enterprise-architecture?id=${assessment.id}`)}
                  data-testid={`btn-open-workspace-${assessment.id}`}
                >
                  Open Workspace <ArrowRight className="w-4 h-4" />
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={deleteOpen !== null} onOpenChange={(open) => !open && setDeleteOpen(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Permanently delete this assessment?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the assessment and all its architectural models.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="btn-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="btn-confirm-delete">
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
