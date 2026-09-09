import assert from "node:assert/strict";
import test from "node:test";
import type { File } from "@google-cloud/storage";
import { isObjectOwner, setObjectAclPolicy } from "./objectAcl";

function fakeFile() {
  let metadata: Record<string, string> = {};
  const file = {
    exists: async () => [true],
    setMetadata: async (update: { metadata: Record<string, string> }) => {
      metadata = update.metadata;
      return [];
    },
    getMetadata: async () => [{ metadata }],
  } as unknown as File;
  return file;
}

test("private object ACL grants access only to its exact owner", async () => {
  const file = fakeFile();
  await setObjectAclPolicy(file, { owner: "tenant-a", visibility: "private" });
  assert.equal(await isObjectOwner(file, "tenant-a"), true);
  assert.equal(await isObjectOwner(file, "tenant-b"), false);
});

test("objects without a valid private ACL fail closed", async () => {
  assert.equal(await isObjectOwner(fakeFile(), "tenant-a"), false);
});