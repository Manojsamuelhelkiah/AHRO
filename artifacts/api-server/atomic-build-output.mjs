import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Stage complete files before replacing any live output; publish the entry last. */
export async function publishBuildOutputs(outputFiles, entryPath) {
  const entry = path.resolve(entryPath);
  if (!outputFiles.some(file => path.resolve(file.path) === entry)) {
    throw new Error("API build did not produce its server entry point");
  }
  const staged = [];
  try {
    for (const file of outputFiles) {
      const target = path.resolve(file.path);
      const temporary = `${target}.${randomUUID()}.pending`;
      await mkdir(path.dirname(target), { recursive: true });
      staged.push({ target, temporary });
      await writeFile(temporary, file.contents);
    }
    staged.sort((a, b) => Number(a.target === entry) - Number(b.target === entry));
    for (const file of staged) await rename(file.temporary, file.target);
  } finally {
    await Promise.all(staged.map(file => rm(file.temporary, { force: true })));
  }
}
