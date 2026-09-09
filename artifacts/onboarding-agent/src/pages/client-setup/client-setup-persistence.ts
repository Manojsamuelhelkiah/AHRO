export function canNavigateOrCommit(fileOperationPending: boolean): boolean {
  return !fileOperationPending;
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type ClientSetupDraftSession<TDraft extends object> = {
  storageKey: string;
  clear: () => void;
  load: () => Partial<TDraft> | null;
  save: (draft: Partial<TDraft>) => void;
};

const LEGACY_DRAFT_KEY = 'clientSetupDraft';
const LEGACY_DRAFT_QUARANTINE_KEY = 'clientSetupDraft:legacy-unscoped';
const SCOPED_DRAFT_PREFIX = 'clientSetupDraft:v2';

export function createClientSetupDraftSession<TDraft extends object>(
  storage: DraftStorage,
  userId: string | null | undefined,
  organizationId: string | null | undefined,
): ClientSetupDraftSession<TDraft> | null {
  const normalizedUserId = userId?.trim();
  const normalizedOrganizationId = organizationId?.trim();
  if (!normalizedUserId || !normalizedOrganizationId) return null;

  try {
    const legacyDraft = storage.getItem(LEGACY_DRAFT_KEY);
    if (
      legacyDraft !== null
      && storage.getItem(LEGACY_DRAFT_QUARANTINE_KEY) === null
    ) {
      storage.setItem(LEGACY_DRAFT_QUARANTINE_KEY, legacyDraft);
      storage.removeItem(LEGACY_DRAFT_KEY);
    }
  } catch {
    // Draft persistence is optional; storage restrictions must not block setup.
  }

  const storageKey = [
    SCOPED_DRAFT_PREFIX,
    encodeURIComponent(normalizedUserId),
    encodeURIComponent(normalizedOrganizationId),
  ].join(':');

  return {
    storageKey,
    clear: () => {
      try {
        storage.removeItem(storageKey);
      } catch {
        // Draft persistence is optional.
      }
    },
    load: () => {
      try {
        const value = storage.getItem(storageKey);
        if (!value) return null;
        const parsed: unknown = JSON.parse(value);
        return parsed !== null
          && typeof parsed === 'object'
          && !Array.isArray(parsed)
          ? parsed as Partial<TDraft>
          : null;
      } catch {
        return null;
      }
    },
    save: (draft) => {
      try {
        storage.setItem(storageKey, JSON.stringify(draft));
      } catch {
        // Draft persistence is optional.
      }
    },
  };
}

export type ScenarioHydrationPlan<TFile> = {
  shouldHydrateSetup: boolean;
  processFiles: TFile[];
};

export function planScenarioHydration<TFile>(
  activeScenarioId: number | null,
  currentProcessFiles: TFile[],
): ScenarioHydrationPlan<TFile> {
  if (activeScenarioId !== null) {
    return {
      shouldHydrateSetup: false,
      processFiles: currentProcessFiles,
    };
  }

  return {
    shouldHydrateSetup: true,
    processFiles: [],
  };
}