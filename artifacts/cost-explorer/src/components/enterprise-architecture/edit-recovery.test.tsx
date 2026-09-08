import { disposeDom } from "./test-support/dom";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { assessment, conflict, deferred, mountRecovery, requirement } from "./test-support/recovery-harness";

after(disposeDom);

test("rejected create retains its queued title edit and explicit ordered retries save exactly one record", { timeout: 5000 }, async t => {
  const h = await mountRecovery(t);
  const rejected = deferred<Response>();
  h.server.nextWrites.push(() => rejected.promise);
  const created = requirement();
  await h.save(current => [...current, created]);
  await h.until(() => h.server.writes.length === 1, "create must reach the server");
  await h.title(created.id, "Edited before create settled");
  await h.blur(created.id);
  h.server.saved.version = 2;
  rejected.resolve(conflict());
  await h.flush();

  assert.equal(h.server.writes.length, 1, "dependent edit cannot autosave after a conflict");
  assert.equal(h.cards().length, 2);
  assert.deepEqual(h.draft(0), [created]);
  assert.equal(h.draft(1)[0].title, "Edited before create settled");
  assert.deepEqual(h.latest(0), []);
  assert.deepEqual(h.latest(1), []);
  assert.ok(h.host.querySelector("[inert]"), "editor must be paused");
  assert.equal(h.button("Retry draft", 1).disabled, true);
  assert.equal(h.button("Discard draft", 1).disabled, true);
  await act(async () => { h.button("Retry draft", 1).click(); });
  assert.equal(h.server.writes.length, 1);

  await h.click("Retry draft");
  assert.equal(h.cards().length, 1, "only the creation is resolved");
  assert.deepEqual(h.server.saved.content.requirements, [created]);
  assert.deepEqual(h.latest(), [created], "dependent draft comparison must refresh");
  assert.equal(h.button("Retry draft").disabled, false);
  assert.ok(h.host.querySelector("[inert]"), "autosaves remain paused until both drafts resolve");
  await h.click("Retry draft");
  assert.deepEqual(h.server.writes.map(write => write.expectedVersion), [1, 2, 3]);
  assert.deepEqual(h.server.saved.content.requirements, [{ ...created, title: "Edited before create settled" }]);
  assert.deepEqual(h.editor.draft, h.server.saved.content.requirements);
  assert.equal(h.cards().length, 0);
  assert.equal(h.host.querySelector("[inert]"), null);
});

test("identical blur events while a save is in flight create only one recoverable draft", { timeout: 5000 }, async t => {
  const h = await mountRecovery(t, assessment([requirement()]));
  const rejected = deferred<Response>();
  h.server.nextWrites.push(() => rejected.promise);
  await h.title("new", "Same rejected title");
  await h.blur("new");
  await h.until(() => h.server.writes.length === 1, "blur must start saving");
  await h.blur("new");
  await h.blur("new");
  rejected.resolve(conflict());
  await h.flush();
  assert.equal(h.server.writes.length, 1);
  assert.equal(h.cards().length, 1);
  assert.equal(h.draft()[0].title, "Same rejected title");
  await h.click("Retry draft");
  assert.equal(h.server.writes.length, 2);
  assert.equal(h.server.saved.content.requirements.length, 1);
  assert.equal(h.server.saved.content.requirements[0].title, "Same rejected title");
});

test("pending recovery retains later automatic edits without writing or resuming them after reload", { timeout: 5000 }, async t => {
  const h = await mountRecovery(t, assessment([requirement()]));
  h.server.nextWrites.push(conflict);
  await h.save(current => current.map(row => ({ ...row, title: "Rejected title" })));
  await h.flush();
  await h.save(current => current.map(row => ({ ...row, description: "Queued autosave" })));
  await h.flush();
  assert.equal(h.cards().length, 2);
  assert.equal(h.server.writes.length, 1);
  assert.equal(h.draft(0)[0].title, "Rejected title");
  assert.equal(h.draft(1)[0].description, "Queued autosave");
  await h.click("Reload latest");
  assert.equal(h.cards().length, 2);
  assert.equal(h.server.writes.length, 1, "refresh is not permission to retry");
  await h.click("Discard draft");
  assert.equal(h.cards().length, 1);
  assert.ok(h.host.querySelector("[inert]"));
  assert.equal(h.server.writes.length, 1, "resolving the first draft must not autosave the next");
  await h.click("Discard draft");
  assert.equal(h.cards().length, 0);
  assert.equal(h.server.writes.length, 1);
});

test("discard resets the currently mounted editor, not the unmounted draft owner, without a mutation", { timeout: 5000 }, async t => {
  const h = await mountRecovery(t, assessment([requirement()]));
  h.server.saved = assessment([{ ...requirement(), title: "Latest saved by another writer" }]);
  h.server.saved.version = 2;
  await h.title("new", "Rejected title");
  await h.blur("new");
  await h.flush();
  const oldResolutions = h.resolutions.original.length;
  await h.remount("replacement");
  await act(async () => { h.editor.stage([{ ...requirement(), title: "Staged in replacement editor" }]); });
  assert.equal(h.editor.draft[0].title, "Staged in replacement editor");
  assert.equal(h.cards().length, 1, "recovery survives editor unmount");
  await h.click("Discard draft");
  assert.equal(h.server.writes.length, 1, "discard must never PATCH");
  assert.equal(h.resolutions.original.length, oldResolutions, "obsolete setter is not called");
  assert.deepEqual(h.resolutions.replacement.at(-1), h.server.saved.content.requirements);
  assert.deepEqual(h.editor.draft, h.server.saved.content.requirements);
  assert.equal(h.host.querySelector<HTMLInputElement>('[aria-label="Title new"]')?.value, "Latest saved by another writer");
  assert.equal(h.cards().length, 0);
  assert.equal(h.host.querySelector("[inert]"), null);
});

test("a second conflict keeps the original draft and a later retry preserves concurrent unrelated changes", { timeout: 5000 }, async t => {
  const h = await mountRecovery(t, assessment([requirement()]));
  h.server.saved.version = 2;
  await h.title("new", "My title");
  await h.blur("new");
  await h.flush();
  const originalDraft = h.draft();
  h.server.saved.version = 3;
  h.server.saved.content.requirements[0].description = "Concurrent description";
  await h.click("Retry draft");
  assert.equal(h.cards().length, 1);
  assert.deepEqual(h.draft(), originalDraft);
  assert.equal(h.latest()[0].description, "Concurrent description");
  assert.equal(h.button("Retry draft").disabled, false, "busy state clears after retry conflicts");
  assert.ok(h.host.querySelector("[inert]"));
  await h.click("Retry draft");
  assert.deepEqual(h.server.writes.map(write => write.expectedVersion), [1, 2, 3]);
  assert.equal(h.server.saved.content.requirements[0].title, "My title");
  assert.equal(h.server.saved.content.requirements[0].description, "Concurrent description");
  assert.equal(h.cards().length, 0);
});

test("failed initial and manual refreshes retain the draft and prohibit retry until reload succeeds", { timeout: 5000 }, async t => {
  const h = await mountRecovery(t, assessment([requirement()]));
  h.server.saved.version = 2;
  h.server.nextReads.push(() => { throw new TypeError("Network unavailable"); });
  await h.title("new", "Recover me");
  await h.blur("new");
  await h.flush();
  assert.equal(h.cards().length, 1);
  assert.equal(h.draft()[0].title, "Recover me");
  assert.match(h.host.querySelector('[role="alert"]')!.textContent!, /draft is still preserved/);
  assert.equal(h.button("Retry draft").disabled, true);
  await act(async () => { h.button("Retry draft").click(); });
  assert.equal(h.server.writes.length, 1);
  h.server.nextReads.push(() => Response.json({ message: "Unavailable" }, { status: 503 }));
  await h.click("Reload latest");
  assert.equal(h.server.writes.length, 1);
  assert.equal(h.cards().length, 1);
  assert.equal(h.draft()[0].title, "Recover me");
  assert.equal(h.button("Retry draft").disabled, true);
  await h.click("Reload latest");
  assert.equal(h.host.querySelector('[role="alert"]'), null);
  assert.equal(h.button("Retry draft").disabled, false);
  assert.equal(h.server.writes.length, 1, "successful reload must not silently resubmit");
  await h.click("Retry draft");
  assert.equal(h.server.saved.content.requirements[0].title, "Recover me");
  assert.equal(h.cards().length, 0);
});

test("archived refresh keeps a reviewable draft with no retry write", { timeout: 5000 }, async t => {
  const h = await mountRecovery(t, assessment([requirement()]));
  h.server.saved.status = "archived";
  h.server.saved.version = 2;
  await h.title("new", "Review only");
  await h.blur("new");
  await h.flush();
  assert.equal(h.draft()[0].title, "Review only");
  assert.match(h.cards()[0].textContent!, /assessment is archived/);
  assert.equal(h.button("Retry draft").disabled, true);
  await act(async () => { h.button("Retry draft").click(); });
  assert.equal(h.server.writes.length, 1);
  await h.click("Discard draft");
  assert.equal(h.server.writes.length, 1);
  assert.equal(h.cards().length, 0);
});

test("retry checks the latest archived cache even when its previously rendered button was enabled", { timeout: 5000 }, async t => {
  const h = await mountRecovery(t, assessment([requirement()]));
  h.server.nextWrites.push(conflict);
  await h.title("new", "Must not reach archived assessment");
  await h.blur("new");
  await h.flush();
  assert.equal(h.button("Retry draft").disabled, false);
  const archived = { ...h.server.saved, status: "archived" as const, version: 2 };
  await act(async () => { h.client.setQueryData(h.queryKey, archived); });
  await h.click("Retry draft");
  assert.equal(h.server.writes.length, 1, "updater guard must stop PATCH, not just the button");
  assert.equal(h.cards().length, 1);
  assert.equal(h.draft()[0].title, "Must not reach archived assessment");
  assert.equal(h.button("Retry draft").disabled, true);
});