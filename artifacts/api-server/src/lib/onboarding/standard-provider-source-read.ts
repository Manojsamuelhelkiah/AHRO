import { createHash } from "node:crypto";
import {
  readOracleHcmWorkRelationship,
  readServiceNowRequest,
  type OracleHcmAdapterConfig,
  type ProviderHttpResponse,
  type ProviderHttpTransport,
  type ServiceNowAdapterConfig,
} from "./standard-provider-adapters";
import type { NormalizedSourceObservation } from "./standard-provider-contracts";

export class StandardProviderSourceReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StandardProviderSourceReadError";
  }
}

export type StandardProviderReadSettings =
  | {
      providerKey: "oracle-hcm";
      organizationId: string;
      baseUrl: string;
      bearerToken: string;
      resourceVersion: string;
    }
  | {
      providerKey: "servicenow";
      organizationId: string;
      baseUrl: string;
      bearerToken: string;
      requestTable: string;
      catalogItemSysId: string;
    };

/**
 * Server-only Replit Secrets composition. No base URL, token, or credential is
 * accepted from a route body or stored tenant mapping.
 */
export function readSettingsFromEnvironment(
  providerKey: "oracle-hcm" | "servicenow",
  organizationId: string,
): StandardProviderReadSettings {
  const prefix = providerKey === "oracle-hcm" ? "ORACLE_HCM" : "SERVICENOW";
  const baseUrl = process.env[`${prefix}_BASE_URL`]?.trim();
  const bearerToken = process.env[`${prefix}_BEARER_TOKEN`]?.trim();
  if (!baseUrl || !bearerToken) {
    throw new StandardProviderSourceReadError(
      `${prefix}_BASE_URL and ${prefix}_BEARER_TOKEN must be configured as server-side Replit Secrets before source reads.`,
    );
  }
  const boundOrganizationId = process.env[`${prefix}_ORGANIZATION_ID`]?.trim();
  if (!boundOrganizationId || boundOrganizationId !== organizationId) {
    throw new StandardProviderSourceReadError(
      `${prefix}_ORGANIZATION_ID must exactly match this organization before a tenant-pinned source read is permitted.`,
    );
  }
  if (providerKey === "oracle-hcm") {
    return {
      providerKey,
      organizationId,
      baseUrl,
      bearerToken,
      resourceVersion: process.env.ORACLE_HCM_RESOURCE_VERSION?.trim() || "latest",
    };
  }
  const requestTable = process.env.SERVICENOW_REQUEST_TABLE?.trim();
  const catalogItemSysId = process.env.SERVICENOW_CATALOG_ITEM_SYS_ID?.trim();
  if (!requestTable || !catalogItemSysId) {
    throw new StandardProviderSourceReadError(
      "SERVICENOW_REQUEST_TABLE and SERVICENOW_CATALOG_ITEM_SYS_ID must be configured as server-side Replit Secrets before source reads.",
    );
  }
  return { providerKey, organizationId, baseUrl, bearerToken, requestTable, catalogItemSysId };
}

export function createServerBearerTransport(bearerToken: string): ProviderHttpTransport {
  return {
    async request(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: {
            ...request.headers,
            Authorization: `Bearer ${bearerToken}`,
          },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          redirect: "error",
          signal: controller.signal,
        });
        const raw = await response.text();
        let body: unknown = {};
        if (raw) {
          try { body = JSON.parse(raw); } catch {
            throw new StandardProviderSourceReadError("Provider read response was not valid JSON.");
          }
        }
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of response.headers) headers[key] = value;
        return { status: response.status, headers, body } satisfies ProviderHttpResponse;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

type SourceReadInput =
  | {
      providerKey: "oracle-hcm";
      source: { workersUniqId: string; periodOfServiceId: string };
      settings: Extract<StandardProviderReadSettings, { providerKey: "oracle-hcm" }>;
      fieldMappings: Record<string, string>;
    }
  | {
      providerKey: "servicenow";
      source: { requestSysId: string };
      settings: Extract<StandardProviderReadSettings, { providerKey: "servicenow" }>;
      fieldMappings: Record<string, string>;
    };

/**
 * Read-only source confirmation. The route supplies tenant/case-scoped source
 * identity, and only the server adapter can produce the stored confirmation.
 */
export async function readConfirmedProviderSource(input: SourceReadInput & {
  transport: ProviderHttpTransport;
  organizationId: string;
  caseId: number;
  expectedCaseIdentity: string;
  expectedCaseStartDate: string;
}): Promise<NormalizedSourceObservation> {
  if (input.settings.organizationId !== input.organizationId) {
    throw new StandardProviderSourceReadError("Provider credential deployment is not pinned to the requested organization.");
  }
  const observedAt = new Date();
  const opaqueEvidenceReference = `provider-read:${input.providerKey}:${createHash("sha256")
    .update(`${input.organizationId}:${input.caseId}:${JSON.stringify(input.source)}:${observedAt.toISOString()}`)
    .digest("hex")}`;
  if (input.providerKey === "oracle-hcm") {
    const settings = input.settings as Extract<StandardProviderReadSettings, { providerKey: "oracle-hcm" }>;
    return readOracleHcmWorkRelationship(input.transport, {
      baseUrl: settings.baseUrl,
      resourceVersion: settings.resourceVersion,
      fieldMappings: input.fieldMappings,
      activeStatusValues: (input.fieldMappings.activeStatusValues ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    } satisfies OracleHcmAdapterConfig, {
      ...input.source,
      expectedCaseIdentity: input.expectedCaseIdentity,
      expectedCaseStartDate: input.expectedCaseStartDate,
      sourceObservedAt: observedAt,
      evidenceReference: opaqueEvidenceReference,
    });
  }
  const settings = input.settings as Extract<StandardProviderReadSettings, { providerKey: "servicenow" }>;
  return readServiceNowRequest(input.transport, {
    baseUrl: settings.baseUrl,
    requestTable: settings.requestTable,
    catalogItemSysId: settings.catalogItemSysId,
    fieldMappings: input.fieldMappings,
    submittedStates: (input.fieldMappings.submittedStates ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    inProgressStates: (input.fieldMappings.inProgressStates ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    fulfilledStates: (input.fieldMappings.fulfilledStates ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    failedStates: (input.fieldMappings.failedStates ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  } satisfies ServiceNowAdapterConfig, {
    ...input.source,
    expectedCaseIdentity: input.expectedCaseIdentity,
    sourceObservedAt: observedAt,
    evidenceReference: opaqueEvidenceReference,
  });
}