import { createHash } from "node:crypto";

/** sha256 hex over a string's UTF-8 bytes (or a Buffer). */
export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Short form used in markers/logs. */
export function shortHash(full: string): string {
  return full.slice(0, 12);
}
