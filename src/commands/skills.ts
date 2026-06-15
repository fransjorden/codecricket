// Sync custom *local* skills (real dirs, not symlinks) between Claude Code and
// Codex. Ecosystem skills are symlinks into ~/.agents/skills and already shared,
// so they are skipped. Codex's bundled `.system` skills are never touched.

import { cpSync, existsSync, lstatSync, readdirSync } from "node:fs";
import type { Direction } from "../core/merge.js";
import { homeDir, toPosix } from "../core/paths.js";
import { log } from "../util/logger.js";

export interface SkillsOptions {
  direction?: Direction;
  dryRun?: boolean;
  apply?: boolean;
}

function localSkillDirs(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) return [];
  const out: string[] = [];
  for (const name of readdirSync(skillsRoot)) {
    if (name.startsWith(".")) continue; // skips Codex's .system
    const full = `${skillsRoot}/${name}`;
    try {
      const st = lstatSync(full);
      if (st.isDirectory() && !st.isSymbolicLink()) out.push(name);
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function runSkills(opts: SkillsOptions): void {
  const home = homeDir();
  const claudeSkills = `${home}/.claude/skills`;
  const codexSkills = `${home}/.codex/skills`;
  const direction: Direction = opts.direction ?? "both";
  const dryRun = opts.dryRun ?? !opts.apply;

  const claudeLocal = new Set(localSkillDirs(claudeSkills));
  const codexLocal = new Set(localSkillDirs(codexSkills));

  const toCodex = [...claudeLocal].filter((s) => !codexLocal.has(s));
  const toClaude = [...codexLocal].filter((s) => !claudeLocal.has(s));
  const onBoth = [...claudeLocal].filter((s) => codexLocal.has(s));

  log.step(`Local skills — claude: [${[...claudeLocal].join(", ") || "none"}]  codex: [${[...codexLocal].join(", ") || "none"}]`);

  const copy = (from: string, to: string, name: string, label: string) => {
    if (dryRun) {
      log.info(`  would copy ${name}  (${label})`);
      return;
    }
    cpSync(`${from}/${name}`, `${to}/${name}`, { recursive: true });
    log.ok(`copied ${name}  (${label})`);
  };

  if (direction !== "codex-to-claude") {
    for (const s of toCodex) copy(claudeSkills, codexSkills, s, "claude → codex");
  }
  if (direction !== "claude-to-codex") {
    for (const s of toClaude) copy(codexSkills, claudeSkills, s, "codex → claude");
  }
  for (const s of onBoth) {
    log.warn(`skill "${s}" exists on both sides — left as-is (manual merge if they differ)`);
  }
  if (toCodex.length + toClaude.length === 0) log.ok("skills already in sync");
}
