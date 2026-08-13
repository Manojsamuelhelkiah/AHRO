import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSharedTick } from "./shared-tick";

test("sequential calls each run the tick and return true", async () => {
  let runs = 0;
  const tick = makeSharedTick(async () => {
    runs += 1;
  });
  assert.equal(await tick(), true);
  assert.equal(await tick(), true);
  assert.equal(runs, 2);
});

test("concurrent caller awaits the in-flight tick instead of skipping early", async () => {
  let runs = 0;
  let finished = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const tick = makeSharedTick(async () => {
    runs += 1;
    await gate;
    finished = true;
  });

  const first = tick(); // starts and blocks on the gate (simulated startup tick)
  const second = tick(); // heartbeat arriving mid-flight

  // The second caller must NOT resolve before the shared tick completes —
  // resolving early would let autoscale freeze the poll mid-flight.
  let secondResolved = false;
  void second.then(() => (secondResolved = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(secondResolved, false);

  release();
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(finished, true);
  assert.equal(runs, 1); // shared: only one underlying run
});

test("a new tick can start after the shared one completes", async () => {
  let runs = 0;
  const tick = makeSharedTick(async () => {
    runs += 1;
  });
  await Promise.all([tick(), tick(), tick()]);
  assert.equal(runs, 1);
  assert.equal(await tick(), true);
  assert.equal(runs, 2);
});

test("a rejecting run surfaces to waiters and releases the lock", async () => {
  let attempts = 0;
  const tick = makeSharedTick(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("boom");
  });
  await assert.rejects(tick(), /boom/);
  // Lock released: the next call runs again instead of deadlocking.
  assert.equal(await tick(), true);
  assert.equal(attempts, 2);
});
