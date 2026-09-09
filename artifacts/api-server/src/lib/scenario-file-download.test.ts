import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { streamScenarioFileDownload } from "./scenario-file-download";

test("download streaming rejects storage read failures instead of emitting them unhandled", async () => {
  const storageFailure = new Error("storage read failed");
  const source = new Readable({
    read() {
      this.destroy(storageFailure);
    },
  });
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  await assert.rejects(
    streamScenarioFileDownload(source, destination),
    storageFailure,
  );
  assert.equal(destination.destroyed, true);
});