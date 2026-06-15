import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { writeTextAtomic } from "./fsx.js";
import { toPosix } from "./paths.js";

/** Nearest ancestor dir containing a `.git` entry, or null. */
export function gitRoot(startPath: string): string | null {
  let dir = toPosix(path.resolve(startPath));
  // If startPath is a file, begin at its directory.
  if (existsSync(dir) && !isDirSafe(dir)) dir = toPosix(path.dirname(dir));
  while (true) {
    if (existsSync(`${dir}/.git`)) return dir;
    const parent = toPosix(path.dirname(dir));
    if (parent === dir) return null;
    dir = parent;
  }
}

function isDirSafe(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isInGitRepo(filePath: string): boolean {
  return gitRoot(filePath) !== null;
}

/** True if the file is tracked by git. Returns false on any uncertainty. */
export function isTracked(filePath: string): boolean {
  const root = gitRoot(filePath);
  if (!root) return false;
  const rel = path.relative(root, path.resolve(filePath)).split(path.sep).join("/");
  try {
    execFileSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", rel], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export interface GitignorePlan {
  inRepo: boolean;
  repoRoot: string | null;
  gitignorePath: string | null;
  relPath: string | null;
  alreadyIgnored: boolean;
  line: string | null;
}

/** Determine whether `filePath` is (or needs to be) covered by .gitignore. */
export function planGitignore(filePath: string): GitignorePlan {
  const root = gitRoot(filePath);
  if (!root) {
    return { inRepo: false, repoRoot: null, gitignorePath: null, relPath: null, alreadyIgnored: false, line: null };
  }
  const rel = path.relative(root, path.resolve(filePath)).split(path.sep).join("/");
  const gi = `${root}/.gitignore`;
  const line = `/${rel}`;
  let alreadyIgnored = false;
  if (existsSync(gi)) {
    const lines = readFileSync(gi, "utf8").split(/\r?\n/).map((l) => l.trim());
    alreadyIgnored = lines.includes(line) || lines.includes(rel) || lines.includes(path.basename(rel));
  }
  return { inRepo: true, repoRoot: root, gitignorePath: gi, relPath: rel, alreadyIgnored, line };
}

/** Append the file to .gitignore if not already ignored. Returns true if changed. */
export function applyGitignore(plan: GitignorePlan): boolean {
  if (!plan.inRepo || plan.alreadyIgnored || !plan.gitignorePath || !plan.line) return false;
  const existing = existsSync(plan.gitignorePath) ? readFileSync(plan.gitignorePath, "utf8") : "";
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
  const block = `${existing}${sep}# added by cc-codex-sync (keeps synced secrets out of git)\n${plan.line}\n`;
  writeTextAtomic(plan.gitignorePath, block);
  return true;
}
