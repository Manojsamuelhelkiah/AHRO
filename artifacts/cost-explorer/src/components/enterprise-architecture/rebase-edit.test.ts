import test from "node:test";
import assert from "node:assert/strict";
import { rebaseEdit } from "./rebase-edit";

test("retry preserves other records and untouched fields within the edited record", () => {
  const base = [{ id: "a", name: "old", status: "draft" }];
  const draft = [{ id: "a", name: "my draft", status: "draft" }];
  const latest = [{ id: "a", name: "their edit", status: "approved" }, { id: "b", name: "new", status: "draft" }];
  assert.deepEqual(rebaseEdit(base, draft, latest), [
    { id: "a", name: "my draft", status: "approved" }, latest[1],
  ]);
  assert.equal(latest[0].name, "their edit");
});

test("repeated retry applies the same draft, not a reversed toggle", () => {
  assert.equal(rebaseEdit(false, true, true), true);
  assert.deepEqual(rebaseEdit(["a"], ["a", "b"], ["a", "b"]), ["a", "b"]);
});

test("create retry does not duplicate the same id", () => {
  const draft = [{ id: "new", value: 1 }];
  assert.deepEqual(rebaseEdit([], draft, draft), draft);
});

test("delete retry removes only the intended record", () => {
  const base = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(rebaseEdit(base, [base[1]], [...base, { id: "c" }]), [{ id: "b" }, { id: "c" }]);
});

test("retry restores a deleted edited record but not an untouched removed record", () => {
  const base = [{ id: "a", value: 0 }, { id: "b", value: 0 }];
  assert.deepEqual(rebaseEdit(base, [{ id: "a", value: 1 }, base[1]], []), [{ id: "a", value: 1 }]);
});

test("nested changes preserve latest unrelated properties", () => {
  assert.deepEqual(rebaseEdit(
    { nested: { first: "old", second: "old" }, remove: true },
    { nested: { first: "mine", second: "old" } },
    { nested: { first: "theirs", second: "updated" }, remove: true, added: true },
  ), { nested: { first: "mine", second: "updated" }, added: true });
});

test("phase-progress retry changes only the intended phase field", () => {
  const base = [{ phase: "preliminary", notes: "old", completionPercent: 0 }, { phase: "business", notes: "old", completionPercent: 0 }];
  const draft = [{ ...base[0], completionPercent: 20 }, base[1]];
  const latest = [{ ...base[0], notes: "other writer" }, { ...base[1], completionPercent: 80 }];
  assert.deepEqual(rebaseEdit(base, draft, latest), [{ ...latest[0], completionPercent: 20 }, latest[1]]);
});

test("traceability retry preserves concurrently added links", () => {
  assert.deepEqual(rebaseEdit(["a", "b"], ["b", "mine"], ["a", "b", "theirs"]), ["b", "theirs", "mine"]);
});