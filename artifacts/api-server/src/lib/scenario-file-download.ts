import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function streamScenarioFileDownload(
  source: Readable,
  destination: Writable,
): Promise<void> {
  await pipeline(source, destination);
}