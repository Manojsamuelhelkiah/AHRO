import type { z } from "zod";
import { GetIntentCatalogResponse } from "@workspace/api-zod";

export type OperationalIntentCatalog = z.infer<typeof GetIntentCatalogResponse>;
export type OperationalIntentDefinition = OperationalIntentCatalog["definitions"][number];
export type CatalogMapping = OperationalIntentCatalog["mappings"][number];
export type CatalogComposition = OperationalIntentCatalog["compositions"][number];
export type FutureIntentInstanceContract = OperationalIntentCatalog["instanceContract"];
