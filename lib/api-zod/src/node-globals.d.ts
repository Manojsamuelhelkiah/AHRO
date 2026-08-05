/**
 * Ambient declarations for Node.js 20+ globals that are not part of the
 * es2022 lib but ARE available at runtime (and needed by orval-generated Zod
 * schemas that validate multipart/form-data fields).
 *
 * Do NOT pull in the full DOM lib — only declare the subset we need.
 * These match the Node.js built-in definitions introduced in v15 (Blob) and
 * v20 (File).
 */

type BlobPart = ArrayBuffer | ArrayBufferView | Blob | string;

interface BlobPropertyBag {
  type?: string;
  endings?: "transparent" | "native";
}

declare class Blob {
  readonly size: number;
  readonly type: string;
  constructor(blobParts?: BlobPart[], options?: BlobPropertyBag): Blob;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  slice(start?: number, end?: number, contentType?: string): Blob;
  text(): Promise<string>;
}

interface FilePropertyBag extends BlobPropertyBag {
  lastModified?: number;
}

declare class File extends Blob {
  readonly lastModified: number;
  readonly name: string;
  readonly webkitRelativePath: string;
  constructor(fileBits: BlobPart[], fileName: string, options?: FilePropertyBag): File;
}
