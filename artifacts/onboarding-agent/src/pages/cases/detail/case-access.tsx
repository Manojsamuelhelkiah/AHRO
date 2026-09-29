import React, { createContext, useContext } from 'react';

export type CaseAccessPermissions = {
  caseId: number;
  access: {
    flowRead: boolean;
    profileRead: boolean;
    profileEdit: boolean;
    notesRead: boolean;
    notesEdit: boolean;
    flowEdit: boolean;
  };
  sensitive: Record<'identity' | 'medical' | 'payroll' | 'bgv', {
    read: boolean;
    edit: boolean;
  }>;
};

const CaseAccessContext = createContext<CaseAccessPermissions | null>(null);

export function CaseAccessProvider({
  value,
  children,
}: {
  value: CaseAccessPermissions;
  children: React.ReactNode;
}) {
  return <CaseAccessContext.Provider value={value}>{children}</CaseAccessContext.Provider>;
}

export function useCaseAccess() {
  return useContext(CaseAccessContext);
}

export function RestrictedActionNotice({ children = 'This action is restricted by your current case permissions.' }: { children?: React.ReactNode }) {
  return (
    <p role="status" className="rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] px-3 py-2 text-xs text-[var(--status-amber-fg)]">
      {children}
    </p>
  );
}