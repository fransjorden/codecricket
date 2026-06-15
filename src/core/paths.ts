import os from "node:os";
import path from "node:path";

/** Convert any path to forward-slash form (internal canonical form). */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Absolute, forward-slash path. */
export function normalizeAbs(p: string): string {
  return toPosix(path.resolve(p));
}

/** User home directory, forward-slash form. */
export function homeDir(): string {
  return toPosix(os.homedir());
}

/**
 * Claude Code's project-dir mangling: every `:`, `\`, `/`, and space in the
 * absolute path becomes `-`.
 *
 * Verified against real dirs, e.g.
 *   C:\Users\Frans Jorden\Documents\claude-projects\intimico-platform
 *   -> C--Users-Frans-Jorden-Documents-claude-projects-intimico-platform
 *
 * Slash direction does not matter (both `\` and `/` map to `-`), so callers may
 * pass either form.
 */
export function mangle(absPath: string): string {
  return absPath.replace(/[:\\/ ]/g, "-");
}

/** The Claude memory dir for a project, by deriving the mangled path. */
export function derivedMemoryDir(absProjectPath: string, home = homeDir()): string {
  const key = mangle(toPosix(absProjectPath));
  return `${home}/.claude/projects/${key}/memory`;
}

/** Root of all Claude per-project state dirs. */
export function claudeProjectsRoot(home = homeDir()): string {
  return `${home}/.claude/projects`;
}

/** Reverse the mangle's tail: best-effort last path segment of a mangled key. */
export function mangledTail(mangledKey: string): string {
  const parts = mangledKey.split("-");
  return parts[parts.length - 1] ?? mangledKey;
}
