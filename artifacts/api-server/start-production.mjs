import { pathToFileURL } from "node:url";
import { verifyTenantSafeguards } from "./verify-tenant-safeguards.mjs";

export async function startProduction({
  verify = verifyTenantSafeguards,
  startApi = () => import("./dist/index.mjs"),
} = {}) {
  console.log(
    "Verifying tenant safeguards against the published production database...",
  );
  const result = await verify();

  if (result.failures.length > 0) {
    const details = result.failures.map((failure) => `- ${failure}`).join("\n");
    throw new Error(
      `Tenant safeguard verification failed for schema ${result.schema}. ` +
        "Production is not trusted and the API will not start.\n" +
        details,
    );
  }

  console.log(
    `Tenant safeguard verification passed for schema ${result.schema}. ` +
      "Production is trusted; starting the API.",
  );
  await startApi();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startProduction().catch((error) => {
    console.error(`Production startup blocked: ${error.message}`);
    process.exitCode = 1;
  });
}