import { existsSync } from "node:fs";
import type { ProjectsMap } from "../types.js";
import { loadProjectsMap, resolveWorkspace, saveProjectsMap } from "../core/config.js";
import {
  listProjectFolders,
  resolveMemoryDir,
  suggestStrandingMappings,
} from "../core/resolver.js";
import { findInstructionsFile } from "../core/claudeReader.js";
import { agentsPathFor } from "../core/codexReader.js";
import { claudeProjectsRoot, homeDir, mangle, toPosix } from "../core/paths.js";
import { log } from "../util/logger.js";

export interface InitOptions {
  workspace?: string;
  map?: string[]; // "name=oldNameOrPath"
  acceptSuggestions?: boolean;
  suggestionThreshold?: number;
}

/** Turn a `--map` value into an absolute memory dir. */
function memoryDirFromMapValue(value: string, workspace: string): string {
  if (value.includes("/") || value.includes("\\")) return toPosix(value);
  // Treat as an old project-folder name; rebuild the mangled key.
  const key = `${mangle(toPosix(workspace))}-${value}`;
  return `${claudeProjectsRoot(homeDir())}/${key}/memory`;
}

export function runInit(opts: InitOptions): void {
  const workspace = resolveWorkspace(opts.workspace);
  const map: ProjectsMap = loadProjectsMap();
  map.workspace = workspace; // persist so `ccsync` works from any directory
  const threshold = opts.suggestionThreshold ?? 2;

  log.step(`Workspace: ${workspace}`);

  // 1) Apply explicit --map overrides.
  for (const m of opts.map ?? []) {
    const eq = m.indexOf("=");
    if (eq === -1) {
      log.warn(`ignoring --map "${m}" (expected name=value)`);
      continue;
    }
    const name = m.slice(0, eq).trim();
    const value = m.slice(eq + 1).trim();
    const memoryDir = memoryDirFromMapValue(value, workspace);
    const projectDir = `${workspace}/${name}`;
    map.projects[name] = {
      projectDir: toPosix(projectDir),
      memoryDir,
      note: `manual mapping (--map ${name}=${value})`,
    };
    if (existsSync(memoryDir)) log.ok(`mapped ${name} → ${memoryDir}`);
    else log.warn(`mapped ${name} → ${memoryDir} (does not exist yet)`);
  }

  // 2) Report projects + their sides.
  const projects = listProjectFolders(workspace);
  log.info("");
  log.info(log.bold(`Projects (${projects.length}):`));
  for (const p of projects) {
    const hasClaude = !!findInstructionsFile(p.projectDir);
    const hasAgents = existsSync(agentsPathFor(p.projectDir));
    const mem = resolveMemoryDir(p, map, homeDir());
    const bits = [
      hasClaude ? "CLAUDE.md" : "—",
      hasAgents ? "AGENTS.md" : "—",
      mem.memoryDir ? `memory(${mem.source})` : "no-memory",
    ];
    log.info(`  ${p.name.padEnd(26)} ${bits.join("  ")}`);
  }

  // 3) Strandings + suggestions.
  const suggestions = suggestStrandingMappings(workspace, map, homeDir()).filter(
    (s) => !Object.values(map.projects).some((e) => e.memoryDir === s.memoryDir),
  );
  if (suggestions.length) {
    log.info("");
    log.warn(`Stranded memory dirs (no live project owns them):`);
    for (const s of suggestions) {
      const sug = s.suggestedProject ? `→ suggest "${s.suggestedProject}" (score ${s.score})` : "→ no suggestion";
      log.info(`  ${(s.recoveredName ?? "?").padEnd(26)} ${sug}`);
      log.debug(s.memoryDir);
    }

    if (opts.acceptSuggestions) {
      let applied = 0;
      for (const s of suggestions) {
        if (s.suggestedProject && s.score >= threshold) {
          map.projects[s.suggestedProject] = {
            projectDir: `${workspace}/${s.suggestedProject}`,
            memoryDir: s.memoryDir,
            note: `auto-mapped from stranded "${s.recoveredName}" (score ${s.score})`,
          };
          applied++;
          log.ok(`mapped ${s.suggestedProject} → ${s.memoryDir}`);
        }
      }
      log.info(`Applied ${applied} suggestion(s) at threshold ${threshold}.`);
    } else {
      log.info(log.dim(`  (re-run with --accept-suggestions to write these, or --map name=oldName to set explicitly)`));
    }
  }

  saveProjectsMap(map);
  log.info("");
  log.ok(`Saved projects.json (${Object.keys(map.projects).length} override(s)).`);
}
