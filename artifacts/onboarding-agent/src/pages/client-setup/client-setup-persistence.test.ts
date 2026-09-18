import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLIENT_SETUP_DRAFT_VERSION,
  canNavigateOrCommit,
  createClientSetupDraftSession,
  planScenarioHydration,
} from './client-setup-persistence';
import { clientSetupSchema, demoDraft, migrateLegacyClientSetupDraft } from './schema';

test('a delayed upload blocks both step navigation and scenario commit', () => {
  assert.equal(canNavigateOrCommit(true), false);
  assert.equal(canNavigateOrCommit(false), true);
});

test('post-save scenario hydration preserves files when the file list resolves first', () => {
  const files = [{ id: 41, originalName: 'flow.bpmn' }];
  // The committed scenario is already active; then the list request completes.
  const plan = planScenarioHydration(7, files);

  assert.equal(plan.shouldHydrateSetup, false);
  assert.equal(plan.processFiles, files);
});

test('post-save scenario hydration stays inert when the scenario resolves before the file list', () => {
  const files = [{ id: 42, originalName: 'rules.csv' }];
  // The scenario request completes while the list is still empty.
  const plan = planScenarioHydration<typeof files[number]>(7, []);
  // The independent file-list completion remains authoritative afterward.
  const processFiles = files;

  assert.equal(plan.shouldHydrateSetup, false);
  assert.deepEqual(plan.processFiles, []);
  assert.deepEqual(processFiles, files);
});

test('initial reload hydrates saved setup before its file manager is mounted', () => {
  const staleDraftFiles = [{ id: 99, originalName: 'stale.json' }];
  const plan = planScenarioHydration(null, staleDraftFiles);

  assert.equal(plan.shouldHydrateSetup, true);
  assert.deepEqual(plan.processFiles, []);
});

function createMemoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    values,
  };
}

test('workspace reload cannot adopt another workspace client draft', () => {
  const storage = createMemoryStorage();
  const workspaceA = createClientSetupDraftSession<{ clientName: string }>(
    storage,
    'user-1',
    'workspace-a',
  );
  const workspaceB = createClientSetupDraftSession<{ clientName: string }>(
    storage,
    'user-1',
    'workspace-b',
  );
  assert.ok(workspaceA);
  assert.ok(workspaceB);

  workspaceA.save({ clientName: 'Confidential A client' });

  assert.deepEqual(workspaceA.load(), { clientName: 'Confidential A client' });
  assert.equal(workspaceB.load(), null);
  workspaceB.save({ clientName: 'Workspace B client' });
  workspaceB.clear();
  assert.deepEqual(workspaceA.load(), { clientName: 'Confidential A client' });
});

test('legacy scoped drafts migrate system labels and modes into the current validated shape', () => {
  const storageKey = 'clientSetupDraft:v2:user-1:workspace-a';
  const legacyDraft = {
    ...demoDraft,
    systems: [
      { domain: 'Intake', name: 'Greenhouse', vendor: 'Greenhouse', mode: 'API', ownerEmail: 'ats@example.com' },
      { domain: 'Learning', name: 'Cornerstone', vendor: 'Cornerstone', mode: 'Flat File', ownerEmail: 'lms@example.com' },
      { domain: 'Compliance', name: 'Policy Hub', vendor: 'Internal', mode: 'Manual', ownerEmail: 'policy@example.com' },
    ],
  };
  const storage = createMemoryStorage({ [storageKey]: JSON.stringify(legacyDraft) });
  const workspace = createClientSetupDraftSession(
    storage,
    'user-1',
    'workspace-a',
    migrateLegacyClientSetupDraft,
  );
  assert.ok(workspace);

  const migrated = workspace.load();
  assert.ok(migrated);
  assert.equal(clientSetupSchema.safeParse(migrated).success, true);
  assert.deepEqual(migrated.systems?.map(({ key, mode }) => ({ key, mode })), [
    { key: 'ats', mode: 'direct-integration' },
    { key: 'lms', mode: 'file-transfer' },
    { key: 'compliance', mode: 'manual' },
  ]);
  assert.deepEqual(JSON.parse(storage.getItem(storageKey)!), {
    version: CLIENT_SETUP_DRAFT_VERSION,
    draft: migrated,
  });
});

test('unsupported legacy connection choices remain invalid until the user selects replacements', () => {
  const legacyDraft = {
    ...demoDraft,
    systems: [
      { domain: 'Learning', name: 'Cornerstone', vendor: 'Cornerstone', mode: 'API', ownerEmail: 'lms@example.com' },
      { domain: 'Mainframe Mystery', name: 'Legacy', vendor: 'Internal', mode: 'Carrier Pigeon', ownerEmail: '' },
    ],
  };
  const migrated = migrateLegacyClientSetupDraft(legacyDraft);
  assert.ok(migrated);
  assert.equal(migrated.systems?.[0]?.key, 'lms');
  assert.equal(migrated.systems?.[0]?.mode, '');
  assert.equal(migrated.systems?.[1]?.key, '');
  assert.equal(migrated.systems?.[1]?.mode, '');
  assert.equal(clientSetupSchema.safeParse(migrated).success, false);
});

test('future-version drafts are not interpreted with an older reader', () => {
  const storageKey = 'clientSetupDraft:v2:user-1:workspace-a';
  const storage = createMemoryStorage({
    [storageKey]: JSON.stringify({ version: CLIENT_SETUP_DRAFT_VERSION + 1, draft: demoDraft }),
  });
  const workspace = createClientSetupDraftSession(
    storage,
    'user-1',
    'workspace-a',
    migrateLegacyClientSetupDraft,
  );
  assert.ok(workspace);
  assert.equal(workspace.load(), null);
});

test('unscoped legacy client drafts are quarantined instead of adopted', () => {
  const storage = createMemoryStorage({
    clientSetupDraft: JSON.stringify({ clientName: 'Unknown tenant' }),
  });
  const workspace = createClientSetupDraftSession<{ clientName: string }>(
    storage,
    'user-1',
    'workspace-a',
  );
  assert.ok(workspace);

  assert.equal(workspace.load(), null);
  assert.equal(storage.getItem('clientSetupDraft'), null);
  assert.equal(
    storage.getItem('clientSetupDraft:legacy-unscoped'),
    JSON.stringify({ clientName: 'Unknown tenant' }),
  );
});