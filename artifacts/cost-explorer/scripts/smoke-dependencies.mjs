import { spawn } from "node:child_process";

export function createDependencyOrchestrator({
  workspaceRoot,
  startupTimeoutMs,
  probe,
  retryDelayMs = 500,
  spawnProcess = spawn,
  logger = console,
}) {
  const spawnedDependencies = [];

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function startDependency({ name, command, env, executable = "pnpm" }) {
    const output = [];
    let spawnError;
    const child = spawnProcess(executable, command, {
      cwd: workspaceRoot,
      env: { ...process.env, ...env },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const rememberOutput = (chunk) => {
      output.push(chunk.toString());
      if (output.join("").length > 8_000) output.shift();
    };
    child.stdout.on("data", rememberOutput);
    child.stderr.on("data", rememberOutput);
    child.on("error", (error) => {
      spawnError = error;
    });

    const dependency = {
      name,
      child,
      output,
      get spawnError() {
        return spawnError;
      },
    };
    spawnedDependencies.push(dependency);
    return dependency;
  }

  async function waitForDependency({
    name,
    urls,
    expectedContentType,
    start,
    remoteHeaders,
    localHeaders,
  }) {
    for (const url of urls) {
      const headers =
        url.origin === urls.at(-1).origin ? localHeaders : remoteHeaders;
      if (await probe(url, expectedContentType, headers)) {
        logger.log(`Reusing running ${name} at ${url.origin}`);
        return url;
      }
    }

    const dependency = startDependency(start);
    const deadline = Date.now() + startupTimeoutMs;
    const localUrl = urls.at(-1);

    while (Date.now() < deadline) {
      if (dependency.spawnError) {
        throw new Error(
          `Could not start ${name}: ${dependency.spawnError.message}`,
        );
      }
      if (dependency.child.exitCode !== null) {
        throw new Error(
          `${name} exited with code ${dependency.child.exitCode} before becoming ready at ${localUrl}.\n${dependency.output.join("").slice(-4_000)}`,
        );
      }
      if (await probe(localUrl, expectedContentType, localHeaders)) {
        logger.log(`Started ${name} at ${localUrl.origin}`);
        return localUrl;
      }
      await delay(retryDelayMs);
    }

    throw new Error(
      `Timed out after ${startupTimeoutMs}ms waiting for ${name} at ${localUrl}.\n${dependency.output.join("").slice(-4_000)}`,
    );
  }

  function stopSpawnedDependencies() {
    for (const { child } of spawnedDependencies) {
      if (child.exitCode !== null) continue;
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }

  return {
    spawnedDependencies,
    waitForDependency,
    stopSpawnedDependencies,
  };
}