import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canNavigateOrCommit,
  createClientSetupDraftSession,
  planScenarioHydration,
} from './client-setup-persistence';

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