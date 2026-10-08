import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import {
  useReserveVaultDocument, useUploadVaultDocument, getGetVaultDashboardQueryKey,
  type VaultDocument, type VaultDocumentInputContentType,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ACCEPTED, MAX_BYTES, errMsg, fmtSize } from '@/lib/vault';

export function UploadDialog({ documents, privacyNotice, policyRevision, policyJurisdiction }: { documents: VaultDocument[]; privacyNotice: string | null; policyRevision: number | null; policyJurisdiction: string | null }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const reserve = useReserveVaultDocument();
  const upload = useUploadVaultDocument();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [replaces, setReplaces] = useState('none');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const busy = reserve.isPending || upload.isPending;

  const reset = () => { setFile(null); setName(''); setReplaces('none'); setAccepted(false); setError(''); };

  const pick = (f: File | null) => {
    setError('');
    if (!f) return setFile(null);
    if (!(ACCEPTED as readonly string[]).includes(f.type)) { setFile(null); return setError('Only PDF, JPEG or PNG files are accepted.'); }
    if (f.size > MAX_BYTES) { setFile(null); return setError(`That file is ${fmtSize(f.size)}. The limit is 10 MB.`); }
    if (f.size === 0) { setFile(null); return setError('That file is empty.'); }
    setFile(f);
    if (!name) setName(f.name.slice(0, 200));
  };

  const submit = async () => {
    if (!file || !accepted || !name.trim() || !policyRevision || !policyJurisdiction) return;
    setError('');
    try {
      const doc = await reserve.mutateAsync({
        data: {
          name: name.trim().slice(0, 200),
          contentType: file.type as VaultDocumentInputContentType,
          sizeBytes: file.size,
          policyAccepted: true,
          policyRevision,
          jurisdiction: policyJurisdiction,
          ...(replaces !== 'none' ? { replacesId: replaces } : {}),
        },
      });
      try {
        await upload.mutateAsync({ id: doc.id, data: file });
      } catch (e) {
        qc.invalidateQueries({ queryKey: getGetVaultDashboardQueryKey() });
        setError(`The document was reserved but its contents did not upload: ${errMsg(e)} Delete the empty entry and try again.`);
        return;
      }
      await qc.invalidateQueries({ queryKey: getGetVaultDashboardQueryKey() });
      toast({ title: 'Document uploaded', description: 'It will be scanned before it can be downloaded or used in a check.' });
      reset(); setOpen(false);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) { setOpen(v); if (!v) reset(); } }}>
      <DialogTrigger asChild><Button data-testid="button-upload-open"><Upload className="mr-2 h-4 w-4" />Add document</Button></DialogTrigger>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Add a document</DialogTitle>
          <p className="text-sm text-muted-foreground">Approved processing jurisdiction: {policyJurisdiction ?? "Unavailable"}. Checks and employer reuse must remain within this jurisdiction.</p>
          <DialogDescription>PDF, JPEG or PNG, up to 10 MB. Storing a document does not verify it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <button type="button" onClick={() => input.current?.click()} data-testid="button-choose-file"
            className="w-full rounded-2xl border-2 border-dashed p-6 text-center transition-colors hover:border-primary hover:bg-secondary/60">
            <Upload className="mx-auto mb-2 h-6 w-6 text-primary" />
            <p className="font-medium">{file ? file.name : 'Choose a file'}</p>
            <p className="text-sm text-muted-foreground">{file ? `${fmtSize(file.size)} · ${file.type}` : 'Nothing is sent until you confirm'}</p>
          </button>
          <input ref={input} type="file" hidden accept={ACCEPTED.join(',')} onChange={(e) => pick(e.target.files?.[0] ?? null)} data-testid="input-file" />
          <div className="space-y-2">
            <Label htmlFor="doc-name">Name</Label>
            <Input id="doc-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} data-testid="input-doc-name" />
          </div>
          <div className="space-y-2">
            <Label>Replaces an existing document</Label>
            <Select value={replaces} onValueChange={setReplaces}>
              <SelectTrigger data-testid="select-replaces"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nothing, this is new</SelectItem>
                {documents.map((d) => <SelectItem key={d.id} value={d.id}>{d.name} (rev {d.revision})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <label className="flex cursor-pointer gap-3 rounded-xl bg-secondary/70 p-4 text-sm leading-relaxed">
            <Checkbox checked={accepted} onCheckedChange={(v) => setAccepted(v === true)} className="mt-0.5" data-testid="checkbox-policy" />
            <span>I own this document or am entitled to store it. I understand it will be scanned for malware and that uploading it does not make it verified.</span>
          </label>
          <div className="rounded-xl border p-4 text-sm whitespace-pre-wrap">
            <strong>Processing notice{policyRevision ? ` · revision ${policyRevision}` : ""}</strong>
            <p className="mt-2">{privacyNotice ?? "Uploads are unavailable until the Vault's privacy, retention, jurisdiction and storage configuration is approved."}</p>
          </div>
          {error && <p role="alert" className="text-sm font-medium text-destructive" data-testid="text-upload-error">{error}</p>}
          <Button className="w-full" disabled={!file || !accepted || !name.trim() || !policyRevision || busy} onClick={submit} data-testid="button-upload-submit">
            {busy ? (reserve.isPending ? 'Reserving…' : 'Uploading…') : 'Upload to vault'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
