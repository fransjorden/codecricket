// The only module that mutates disk. Byte-safe reads, atomic writes, .bak.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { toPosix } from "./paths.js";

export function readText(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** File mtime in ms, or 0 if missing. */
export function mtimeMs(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export interface WriteOptions {
  backup?: boolean;
}

/** Atomic write (temp + rename), optionally snapshotting the prior file to .bak. */
export function writeTextAtomic(p: string, content: string, opts: WriteOptions = {}): void {
  const file = toPosix(p);
  ensureDir(path.dirname(file));
  if (opts.backup && existsSync(file)) {
    copyFileSync(file, `${file}.bak`);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}

export function removeFile(p: string, opts: WriteOptions = {}): void {
  const file = toPosix(p);
  if (!existsSync(file)) return;
  if (opts.backup) copyFileSync(file, `${file}.bak`);
  rmSync(file);
}

export function fileExists(p: string): boolean {
  return existsSync(p);
}
