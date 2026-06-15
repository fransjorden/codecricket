import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ProjectsMap } from "../types.js";
import { claudeProjectsRoot, derivedMemoryDir, homeDir, mangle, toPosix } from "./paths.js";
import { findInstructionsFile } from "./claudeReader.js";

export interface ResolvedProject {
  name: string;
  projectDir: string;
}

export interface MemoryResolution {
  memoryDir: string | null;
  source: "override" | "derived" | "none";
  /** When source==="none", possible stranded dirs that might belong here. */
  candidates: string[];
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function hasMarkdown(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.toLowerCase().endsWith(".md"));
  } catch {
    return false;
  }
}

/** A folder counts as a project if it has CLAUDE.md/claude.md or AGENTS.md. */
export function isProjectFolder(dir: string): boolean {
  if (!isDir(dir)) return false;
  if (findInstructionsFile(dir)) return true;
  return existsSync(`${toPosix(dir)}/AGENTS.md`);
}

export function listProjectFolders(workspace: string): ResolvedProject[] {
  const ws = toPosix(workspace);
  let entries: string[];
  try {
    entries = readdirSync(ws);
  } catch {
    return [];
  }
  const out: ResolvedProject[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const dir = `${ws}/${name}`;
    if (isProjectFolder(dir)) out.push({ name, projectDir: dir });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Every subfolder in the workspace (regardless of whether it has CLAUDE.md). */
export function listAllFolders(workspace: string): ResolvedProject[] {
  const ws = toPosix(workspace);
  let entries: string[];
  try {
    entries = readdirSync(ws);
  } catch {
    return [];
  }
  const out: ResolvedProject[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const dir = `${ws}/${name}`;
    if (isDir(dir)) out.push({ name, projectDir: dir });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Resolve a project by bare name (under workspace) or by path. */
export function resolveProject(nameOrPath: string, workspace: string): ResolvedProject {
  const ws = toPosix(workspace);
  // A path (absolute or containing a slash) is used directly.
  if (nameOrPath.includes("/") || nameOrPath.includes("\\") || path.isAbsolute(nameOrPath)) {
    const dir = toPosix(path.resolve(nameOrPath));
    return { name: path.basename(dir), projectDir: dir };
  }
  return { name: nameOrPath, projectDir: `${ws}/${nameOrPath}` };
}

/** All existing, non-empty Claude memory dirs on this machine. */
export function existingMemoryDirs(home = homeDir()): string[] {
  const root = claudeProjectsRoot(home);
  let keys: string[];
  try {
    keys = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const key of keys) {
    const mem = `${root}/${key}/memory`;
    if (isDir(mem) && hasMarkdown(mem)) out.push(toPosix(mem));
  }
  return out;
}

export function resolveMemoryDir(
  project: ResolvedProject,
  map: ProjectsMap,
  home = homeDir(),
): MemoryResolution {
  const entry = map.projects[project.name];
  if (entry?.memoryDir) {
    return { memoryDir: toPosix(entry.memoryDir), source: "override", candidates: [] };
  }
  const derived = derivedMemoryDir(project.projectDir, home);
  if (isDir(derived) && hasMarkdown(derived)) {
    return { memoryDir: toPosix(derived), source: "derived", candidates: [] };
  }
  // No memory at the derived path: surface stranding candidates so we never
  // silently sync nothing for a renamed project.
  const candidates = strandedMemoryDirs(workspaceOf(project.projectDir), map, home);
  return { memoryDir: null, source: "none", candidates };
}

function workspaceOf(projectDir: string): string {
  return toPosix(path.resolve(projectDir, ".."));
}

/** The original project-folder name encoded in a memory dir path, if recoverable. */
export function recoverProjectName(memoryDir: string, workspace: string): string | null {
  const key = path.basename(path.dirname(toPosix(memoryDir))); // the mangled dir name
  const prefix = mangle(toPosix(workspace)) + "-";
  if (key.startsWith(prefix)) return key.slice(prefix.length);
  return null;
}

/**
 * Memory dirs that no longer correspond to any workspace folder (true rename
 * strandings, like meeting-tool→type-machine), nor to an explicit override.
 * A folder that merely lacks a CLAUDE.md still "claims" its derived memory dir,
 * so it is NOT reported as stranded.
 */
export function strandedMemoryDirs(workspace: string, map: ProjectsMap, home = homeDir()): string[] {
  const claimed = new Set<string>();
  for (const proj of listAllFolders(workspace)) {
    claimed.add(toPosix(derivedMemoryDir(proj.projectDir, home)));
  }
  for (const entry of Object.values(map.projects)) {
    if (entry.memoryDir) claimed.add(toPosix(entry.memoryDir));
  }
  return existingMemoryDirs(home).filter((d) => !claimed.has(d));
}

// ---- stranding -> project suggestion (token-overlap heuristic) ----

function tokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((t) => !STOPWORDS.has(t)),
  );
}

const STOPWORDS = new Set([
  "this", "that", "with", "from", "your", "project", "memory", "tool", "file",
  "code", "claude", "https", "http", "documents", "users", "frans", "jorden",
]);

function readHead(file: string, max = 4000): string {
  try {
    return readFileSync(file, "utf8").slice(0, max);
  } catch {
    return "";
  }
}

export interface StrandingSuggestion {
  memoryDir: string;
  recoveredName: string | null;
  suggestedProject: string | null;
  score: number;
}

export function suggestStrandingMappings(
  workspace: string,
  map: ProjectsMap,
  home = homeDir(),
): StrandingSuggestion[] {
  const ws = toPosix(workspace);
  const stranded = strandedMemoryDirs(ws, map, home);
  const live = listProjectFolders(ws);

  // Precompute signal tokens per live project (name + CLAUDE.md head).
  const projSignals = live.map((p) => {
    const instr = findInstructionsFile(p.projectDir);
    const head = instr ? readHead(instr.path) : "";
    return { project: p, sig: tokens(`${p.name} ${head}`) };
  });

  return stranded.map((memoryDir) => {
    const recoveredName = recoverProjectName(memoryDir, ws);
    const memIndex = readHead(`${memoryDir}/MEMORY.md`);
    const strandSig = tokens(`${recoveredName ?? ""} ${memIndex}`);

    let best: { name: string; score: number } | null = null;
    for (const { project, sig } of projSignals) {
      let score = 0;
      for (const t of strandSig) if (sig.has(t)) score += 1;
      // Exact recovered-name match is decisive.
      if (recoveredName && project.name === recoveredName) score += 100;
      if (!best || score > best.score) best = { name: project.name, score };
    }
    return {
      memoryDir,
      recoveredName,
      suggestedProject: best && best.score > 0 ? best.name : null,
      score: best?.score ?? 0,
    };
  });
}
