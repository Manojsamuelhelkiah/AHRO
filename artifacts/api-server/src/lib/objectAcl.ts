import type { File } from "@google-cloud/storage";

const ACL_POLICY_METADATA_KEY = "custom:aclPolicy";

export interface ObjectAclPolicy {
  owner: string;
  visibility: "private";
}

export async function setObjectAclPolicy(
  objectFile: File,
  policy: ObjectAclPolicy,
): Promise<void> {
  const [exists] = await objectFile.exists();
  if (!exists) throw new Error("Object not found");
  await objectFile.setMetadata({
    metadata: { [ACL_POLICY_METADATA_KEY]: JSON.stringify(policy) },
  });
}

export async function isObjectOwner(objectFile: File, userId: string): Promise<boolean> {
  const [metadata] = await objectFile.getMetadata();
  const encoded = metadata.metadata?.[ACL_POLICY_METADATA_KEY];
  if (typeof encoded !== "string") return false;
  try {
    const policy = JSON.parse(encoded) as Partial<ObjectAclPolicy>;
    return policy.visibility === "private" && policy.owner === userId;
  } catch {
    return false;
  }
}