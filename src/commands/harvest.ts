// Reverse-direction enrichment: scan Codex's generated memories
// (~/.codex/memories) and stage them as PROPOSED Claude memory files for review.
// Nothing lands in the live ~/.claude memory dir without explicit --accept.

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { harvestedDir, resolveWorkspace } from "../core/config.js";
import { resolveProject, resolveMemoryDir } from "../core/resolver.js";
import { loadProjectsMap } from "../core/config.js";
import { homeDir, toPosix } from "../core/paths.js";
import { ensureDir, readText, writeTextAtomic } from "../core/fsx.js";
import { shortHash, sha256 } from "../core/hash.js";
import { log } from "../util/logger.js";

export interface HarvestOptions {
  project?: string;
  workspace?: string;
  accept?: boolean;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = `${dir}/${name}`;
    try {
      const st = statSync(full);
      if (st.isDirectory()) out.push(...walk(full));
      else if (st.isFile()) out.push(toPosix(full));
    } catch {
      /* ignore */
    }
  }
  return out;
}

function proposeFrontmatter(sourceFile: string, body: string): string {
  const base = path.basename(sourceFile);
  const id = shortHash(sha256(sourceFile));
  return [
    "---",
    `name: codex-harvest-${id}`,
    `description: Harvested from Codex memory (${base}) — review before accepting`,
    "metadata:",
    "  type: reference",
    "  source: codex-memories",
    `  sourceFile: ${sourceFile}`,
    "---",
    "",
    body.endsWith("\n") ? body : body + "\n",
  ].join("\n");
}

export function runHarvest(opts: HarvestOptions): void {
  const codexMemDir = `${homeDir()}/.codex/memories`;
  const files = existsSync(codexMemDir) ? walk(codexMemDir) : [];

  if (files.length === 0) {
    log.warn("No Codex memories found in ~/.codex/memories.");
    log.info(log.dim("  Codex memory is off by default. Enable it with [features] memories = true in ~/.codex/config.toml,"));
    log.info(log.dim("  then re-run after Codex has generated some. Durable guidance still rides in AGENTS.md regardless."));
    return;
  }

  const workspace = resolveWorkspace(opts.workspace);
  const projectName = opts.project ?? "global";
  const stageDir = `${harvestedDir()}/${projectName}`;
  ensureDir(stageDir);

  log.step(`Harvesting ${files.length} Codex memory file(s) → ${stageDir}`);
  const staged: string[] = [];
  for (const f of files) {
    const body = readText(f) ?? "";
    const rel = f.replace(codexMemDir + "/", "").replace(/[\\/]/g, "__");
    const outName = `codex_${rel.replace(/\.[^.]+$/, "")}.md`;
    const outPath = `${stageDir}/${outName}`;
    writeTextAtomic(outPath, proposeFrontmatter(f, body));
    staged.push(outPath);
    log.info(`  staged ${outName}`);
  }

  if (!opts.accept) {
    log.info("");
    log.ok(`Staged ${staged.length} proposal(s). Review them, then accept into a project with:`);
    log.info(log.dim(`  cricket harvest ${opts.project ?? "<project>"} --accept`));
    return;
  }

  if (!opts.project) {
    log.error("--accept requires a project so the proposals have a memory dir to land in.");
    return;
  }
  const project = resolveProject(opts.project, workspace);
  const resolution = resolveMemoryDir(project, loadProjectsMap(), homeDir());
  const target = resolution.memoryDir ?? `${homeDir()}/.claude/projects/__manual__/memory`;
  ensureDir(target);
  for (const s of staged) {
    const dest = `${target}/${path.basename(s)}`;
    writeTextAtomic(dest, readText(s) ?? "", { backup: true });
    log.ok(`accepted ${path.basename(s)} → ${target}`);
  }
}
