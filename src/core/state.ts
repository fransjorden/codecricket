import { existsSync, readFileSync } from "node:fs";
import type { ProjectState, SyncState } from "../types.js";
import { statePath } from "./config.js";
import { writeTextAtomic } from "./fsx.js";
import { toPosix } from "./paths.js";

export function loadState(): SyncState {
  const p = statePath();
  if (!existsSync(p)) return { version: 1, projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as SyncState;
    if (!parsed.projects) parsed.projects = {};
    return parsed;
  } catch {
    return { version: 1, projects: {} };
  }
}

export function saveState(state: SyncState): void {
  writeTextAtomic(statePath(), JSON.stringify(state, null, 2) + "\n");
}

export function getProjectState(state: SyncState, projectDir: string): ProjectState | undefined {
  return state.projects[toPosix(projectDir)];
}

export function setProjectState(state: SyncState, projectDir: string, ps: ProjectState): void {
  state.projects[toPosix(projectDir)] = ps;
}

export function emptyProjectState(memoryDir: string | null): ProjectState {
  return {
    lastSyncAt: "",
    memoryDir,
    units: {},
  };
}
