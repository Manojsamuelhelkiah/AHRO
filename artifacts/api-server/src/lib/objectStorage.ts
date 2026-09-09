import { createHash } from "node:crypto";
import type { File } from "@google-cloud/storage";
import { Storage } from "@google-cloud/storage";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

function privateDir(): string {
  const value = process.env.PRIVATE_OBJECT_DIR;
  if (!value) throw new Error("PRIVATE_OBJECT_DIR is not configured");
  return value.replace(/\/+$/, "");
}

function splitPath(path: string): { bucketName: string; objectName: string } {
  const parts = path.replace(/^\/+/, "").split("/");
  if (parts.length < 2) throw new Error("Invalid object path");
  return { bucketName: parts[0]!, objectName: parts.slice(1).join("/") };
}

export function ownerStorageKey(ownerUserId: string): string {
  return createHash("sha256").update(ownerUserId).digest("hex").slice(0, 32);
}

export function isOwnedUploadPath(objectPath: string, ownerUserId: string): boolean {
  return new RegExp(`^/objects/scenario-files/${ownerStorageKey(ownerUserId)}/[0-9a-f-]{36}$`).test(objectPath);
}

export function scenarioUploadObjectPath(ownerUserId: string, intentId: string): string {
  return `/objects/scenario-files/${ownerStorageKey(ownerUserId)}/${intentId}`;
}

export function scenarioFinalObjectPath(ownerUserId: string, intentId: string): string {
  return `/objects/scenario-files/final/${ownerStorageKey(ownerUserId)}/${intentId}`;
}

export function getPrivateFile(objectPath: string): File {
  if (!objectPath.startsWith("/objects/")) throw new Error("Invalid object path");
  const relative = objectPath.slice("/objects/".length);
  if (!relative || relative.includes("..")) throw new Error("Invalid object path");
  const { bucketName, objectName } = splitPath(`${privateDir()}/${relative}`);
  return objectStorageClient.bucket(bucketName).file(objectName);
}

export async function promoteScenarioFile(
  stagingFile: File,
  finalObjectPath: string,
): Promise<{ file: File; objectPath: string }> {
  const destination = getPrivateFile(finalObjectPath);
  await stagingFile.move(destination);
  return { file: destination, objectPath: finalObjectPath };
}