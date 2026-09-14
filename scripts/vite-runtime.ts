/** Build configuration must not depend on a port used only by Vite servers. */
export function viteRuntime(command: string, defaultBase: string) {
  let port: number | undefined;
  if (command === "serve") {
    const rawPort = process.env.PORT;
    if (rawPort === undefined) {
      throw new Error("PORT environment variable is required but was not provided.");
    }
    port = Number(rawPort);
    if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid PORT value: "${rawPort}"`);
    }
  }
  return { port, basePath: process.env.BASE_PATH || defaultBase };
}