import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { createWorkforceTransferProgram, type WorkforceTransferProgramInput } from '@/lib/workforce-transfers-api';
import { PageHeader, Card, Button, Input, Label, cn } from '@/components/ui-shared';
import { ArrowLeft, Building2, User, Globe, FileText, Calendar } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export function WorkforceTransfersCreatePage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [formData, setFormData] = useState<WorkforceTransferProgramInput>({
    name: '',
    sourceLegalEntity: '',
    destinationLegalEntity: '',
    countries: [],
    proposedBasis: 'automatic-transfer',
    legalDay1: '',
    owners: {
      hrIntegration: '',
      legal: '',
      payroll: '',
      it: '',
    },
  });

  const [countryInput, setCountryInput] = useState('');

  const createMutation = useMutation({
    mutationFn: (data: WorkforceTransferProgramInput) => createWorkforceTransferProgram(data),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['workforce-transfers', 'programs'] });
      toast({ title: 'Program created', description: 'Workforce transfer program initialized.' });
      setLocation(`/workforce-transfers/${res.id}`);
    },
    onError: (err: any) => {
      toast({ title: 'Creation failed', description: err.message || 'An error occurred.', variant: 'destructive' });
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.countries.length === 0) {
      toast({ title: 'Validation Error', description: 'At least one country is required.', variant: 'destructive' });
      return;
    }
    createMutation.mutate(formData);
  };

  const handleAddCountry = () => {
    const val = countryInput.trim().toUpperCase();
    if (val && !formData.countries.includes(val)) {
      setFormData(prev => ({ ...prev, countries: [...prev.countries, val] }));
      setCountryInput('');
    }
  };

  const removeCountry = (c: string) => {
    setFormData(prev => ({ ...prev, countries: prev.countries.filter(x => x !== c) }));
  };

  const isSubmitting = createMutation.isPending;

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => setLocation('/workforce-transfers')} className="rounded-full">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <PageHeader 
          title="New Transfer Program" 
          subtitle="Initialize a planning-only program before data population."
        />
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card className="p-6 space-y-6">
          <div className="space-y-4">
            <h3 className="text-sm font-semibold border-b border-[var(--border)] pb-2 flex items-center gap-2">
              <Building2 className="w-4 h-4 text-[var(--text-muted)]" /> Entities & Planning
            </h3>
            <div className="space-y-1">
              <Label htmlFor="name">Program Name</Label>
              <Input id="name" required value={formData.name} onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))} placeholder="e.g. Project Apollo Integration" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="source">Source Legal Entity</Label>
                <Input id="source" required value={formData.sourceLegalEntity} onChange={e => setFormData(prev => ({ ...prev, sourceLegalEntity: e.target.value }))} placeholder="e.g. Acme Corp LLC" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="destination">Destination Legal Entity</Label>
                <Input id="destination" required value={formData.destinationLegalEntity} onChange={e => setFormData(prev => ({ ...prev, destinationLegalEntity: e.target.value }))} placeholder="e.g. Global Tech Inc." />
              </div>
            </div>
          </div>

          <div className="space-y-4 pt-2">
            <h3 className="text-sm font-semibold border-b border-[var(--border)] pb-2 flex items-center gap-2">
              <Globe className="w-4 h-4 text-[var(--text-muted)]" /> Geography & Legal Pathway
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Countries</Label>
                <div className="flex gap-2">
                  <Input 
                    value={countryInput} 
                    onChange={e => setCountryInput(e.target.value)} 
                    placeholder="e.g. US, UK, IN" 
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); handleAddCountry(); }
                    }} 
                  />
                  <Button type="button" variant="outline" onClick={handleAddCountry}>Add</Button>
                </div>
                {formData.countries.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {formData.countries.map(c => (
                      <span key={c} className="inline-flex items-center gap-1 bg-[var(--surface-soft)] border border-[var(--border)] px-2 py-1 rounded text-xs font-medium">
                        {c}
                        <button type="button" onClick={() => removeCountry(c)} className="text-[var(--text-muted)] hover:text-[var(--status-red)]">×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="proposedBasis">Proposed Basis</Label>
                <select 
                  id="proposedBasis"
                  required
                  className="flex h-[36px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-[var(--text-sm)] shadow-sm transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
                  value={formData.proposedBasis} 
                  onChange={e => setFormData(prev => ({ ...prev, proposedBasis: e.target.value as any }))}
                >
                  <option value="automatic-transfer">Automatic Transfer (TUPE/ARD)</option>
                  <option value="share-purchase">Share Purchase (SPA)</option>
                  <option value="asset-purchase">Asset Purchase</option>
                  <option value="cross-border">Cross-border Relocation</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="legalDay1">Legal Day 1 (Effective Date)</Label>
                <Input id="legalDay1" type="date" required value={formData.legalDay1} onChange={e => setFormData(prev => ({ ...prev, legalDay1: e.target.value }))} />
              </div>
            </div>
          </div>

          <div className="space-y-4 pt-2">
            <h3 className="text-sm font-semibold border-b border-[var(--border)] pb-2 flex items-center gap-2">
              <User className="w-4 h-4 text-[var(--text-muted)]" /> Day 1 Accountable Owners
            </h3>
            <p className="text-xs text-[var(--text-muted)]">Assign internal system user IDs for each required functional area.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="owner-hr">HR Integration</Label>
                <Input id="owner-hr" required value={formData.owners.hrIntegration} onChange={e => setFormData(prev => ({ ...prev, owners: { ...prev.owners, hrIntegration: e.target.value } }))} placeholder="user@domain.com" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="owner-legal">Legal / Employment</Label>
                <Input id="owner-legal" required value={formData.owners.legal} onChange={e => setFormData(prev => ({ ...prev, owners: { ...prev.owners, legal: e.target.value } }))} placeholder="user@domain.com" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="owner-payroll">Payroll</Label>
                <Input id="owner-payroll" required value={formData.owners.payroll} onChange={e => setFormData(prev => ({ ...prev, owners: { ...prev.owners, payroll: e.target.value } }))} placeholder="user@domain.com" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="owner-it">IT / Security</Label>
                <Input id="owner-it" required value={formData.owners.it} onChange={e => setFormData(prev => ({ ...prev, owners: { ...prev.owners, it: e.target.value } }))} placeholder="user@domain.com" />
              </div>
            </div>
          </div>
        </Card>
        
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => setLocation('/workforce-transfers')}>Cancel</Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Creating...' : 'Initialize Program'}
          </Button>
        </div>
      </form>
    </div>
  );
}
