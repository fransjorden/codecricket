import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProjectsMap, SecretPolicy } from "../types.js";
import { homeDir, toPosix } from "./paths.js";

/**
 * Where codecricket keeps its own state (projects.json, sync-state.json, harvested/).
 * Env: CODECRICKET_HOME (CCSYNC_HOME is still honored for backward compatibility).
 * If no env is set and only the legacy ~/.cc-codex-sync dir exists, keep using it
 * so the rename never strands an existing projects.json / sync-state.
 */
export function stateHome(): string {
  const env = process.env.CODECRICKET_HOME ?? process.env.CCSYNC_HOME;
  if (env) return toPosix(path.resolve(env));
  const preferred = `${homeDir()}/.codecricket`;
  const legacy = `${homeDir()}/.cc-codex-sync`;
  if (!existsSync(preferred) && existsSync(legacy)) return toPosix(legacy);
  return toPosix(preferred);
}

export function ensureHome(): string {
  const home = stateHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  return home;
}

export function projectsMapPath(): string {
  return `${stateHome()}/projects.json`;
}

export function statePath(): string {
  return `${stateHome()}/sync-state.json`;
}

export function harvestedDir(): string {
  return `${stateHome()}/harvested`;
}

/**
 * The workspace that holds the project folders. Resolution order:
 *   explicit --workspace > CODECRICKET_WORKSPACE (or legacy CCSYNC_WORKSPACE) > parent of cwd.
 * The tool lives at <workspace>/codecricket, so the parent of cwd is the
 * workspace when run from the tool dir.
 */
export function resolveWorkspace(explicit?: string): string {
  if (explicit) return toPosix(path.resolve(explicit));
  const wsEnv = process.env.CODECRICKET_WORKSPACE ?? process.env.CCSYNC_WORKSPACE;
  if (wsEnv) return toPosix(path.resolve(wsEnv));
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
