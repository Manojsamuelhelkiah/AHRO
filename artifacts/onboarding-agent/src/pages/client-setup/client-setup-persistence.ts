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

type StoredDraft<TDraft extends object> = {
  version: number;
  draft: Partial<TDraft>;
};

const LEGACY_DRAFT_KEY = 'clientSetupDraft';
const LEGACY_DRAFT_QUARANTINE_KEY = 'clientSetupDraft:legacy-unscoped';
const SCOPED_DRAFT_PREFIX = 'clientSetupDraft:v2';
export const CLIENT_SETUP_DRAFT_VERSION = 3;

export function createClientSetupDraftSession<TDraft extends object>(
  storage: DraftStorage,
  userId: string | null | undefined,
  organizationId: string | null | undefined,
  migrateLegacyDraft?: (draft: unknown) => Partial<TDraft> | null,
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
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const stored = parsed as Partial<StoredDraft<TDraft>>;
        if (stored.version === CLIENT_SETUP_DRAFT_VERSION) {
          return stored.draft !== null
            && typeof stored.draft === 'object'
            && !Array.isArray(stored.draft)
            ? stored.draft
            : null;
        }
        if (stored.version === 2 && stored.draft && typeof stored.draft === 'object') {
          const migrated = migrateLegacyDraft?.(stored.draft) ?? stored.draft;
          storage.setItem(storageKey, JSON.stringify({ version: CLIENT_SETUP_DRAFT_VERSION, draft: migrated }));
          return migrated;
        }
        if ('version' in stored) return null;
        const migrated = migrateLegacyDraft?.(parsed) ?? parsed as Partial<TDraft>;
        if (migrated) {
          storage.setItem(storageKey, JSON.stringify({
            version: CLIENT_SETUP_DRAFT_VERSION,
            draft: migrated,
          } satisfies StoredDraft<TDraft>));
        }
        return migrated;
      } catch {
        return null;
      }
    },
    save: (draft) => {
      try {
        storage.setItem(storageKey, JSON.stringify({
          version: CLIENT_SETUP_DRAFT_VERSION,
          draft,
        } satisfies StoredDraft<TDraft>));
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
  requestedScenarioId?: number,
): ScenarioHydrationPlan<TFile> {
  if (activeScenarioId !== null && (requestedScenarioId === undefined || activeScenarioId === requestedScenarioId)) {
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