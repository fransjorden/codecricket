import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProjectsMap, SecretPolicy } from "../types.js";
import { homeDir, toPosix } from "./paths.js";

/** Where ccsync keeps its own state (projects.json, .sync-state.json, harvested/). */
export function ccsyncHome(): string {
  const env = process.env.CCSYNC_HOME;
  return toPosix(env ? path.resolve(env) : `${homeDir()}/.cc-codex-sync`);
}

export function ensureHome(): string {
  const home = ccsyncHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  return home;
}

export function projectsMapPath(): string {
  return `${ccsyncHome()}/projects.json`;
}

export function statePath(): string {
  return `${ccsyncHome()}/sync-state.json`;
}

export function harvestedDir(): string {
  return `${ccsyncHome()}/harvested`;
}

/**
 * The workspace that holds the project folders. Resolution order:
 *   explicit --workspace > CCSYNC_WORKSPACE > parent of cwd.
 * The tool lives at <workspace>/cc-codex-sync, so the parent of cwd is the
 * workspace when run from the tool dir.
 */
export function resolveWorkspace(explicit?: string): string {
  if (explicit) return toPosix(path.resolve(explicit));
  if (process.env.CCSYNC_WORKSPACE) return toPosix(path.resolve(process.env.CCSYNC_WORKSPACE));
  const saved = loadProjectsMap().workspace;
  if (saved) return toPosix(path.resolve(saved));
  return toPosix(path.resolve(process.cwd(), ".."));
}

export function loadProjectsMap(): ProjectsMap {
  const p = projectsMapPath();
  if (!existsSync(p)) return { version: 1, projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as ProjectsMap;
    if (!parsed.projects) parsed.projects = {};
    return parsed;
  } catch {
    return { version: 1, projects: {} };
  }
}

export function saveProjectsMap(map: ProjectsMap): void {
  ensureHome();
  writeFileSync(projectsMapPath(), JSON.stringify(map, null, 2) + "\n", "utf8");
}

export function defaultSecretPolicy(overrides: Partial<SecretPolicy> = {}): SecretPolicy {
  return {
    mode: "gitignore-guard",
    customPatterns: [],
    ignorePatterns: [],
    sidecarFilename: "AGENTS.secrets.md",
    blockOnTracked: true,
    ...overrides,
  };
}
