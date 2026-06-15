#!/usr/bin/env node
import { Command } from "commander";
import { setVerbosity } from "./util/logger.js";
import { runInit } from "./commands/init.js";
import { runSync } from "./commands/sync.js";
import { runStatus } from "./commands/status.js";
import { runSkills } from "./commands/skills.js";
import { runWorkspace } from "./commands/workspace.js";
import { runHarvest } from "./commands/harvest.js";
import { runTui } from "./commands/tui.js";
import type { Direction } from "./core/merge.js";
import type { SecretMode } from "./types.js";

const program = new Command();

program
  .name("ccsync")
  .description("Bidirectional sync between Claude Code (CLAUDE.md + memory) and Codex (AGENTS.md).")
  .version("0.1.0")
  .option("-q, --quiet", "suppress non-essential output")
  .option("-v, --verbose", "verbose output")
  .hook("preAction", (thisCommand) => {
    const o = thisCommand.opts();
    setVerbosity({ verbose: !!o.verbose, quiet: !!o.quiet });
  });

program
  .command("init")
  .description("Scan the workspace, build projects.json, detect stranded memory dirs.")
  .option("-w, --workspace <dir>", "workspace dir holding the project folders")
  .option("-m, --map <name=value...>", "explicit memory override(s), e.g. type-machine=meeting-tool")
  .option("--accept-suggestions", "write suggested stranding mappings above the threshold")
  .option("--suggestion-threshold <n>", "min score to auto-accept", (v) => parseInt(v, 10))
  .action((opts) => {
    runInit({
      workspace: opts.workspace,
      map: opts.map,
      acceptSuggestions: !!opts.acceptSuggestions,
      suggestionThreshold: opts.suggestionThreshold,
    });
  });

function parseDirection(v: string): Direction {
  if (v === "claude-to-codex" || v === "codex-to-claude" || v === "both") return v;
  throw new Error(`invalid --direction "${v}" (use both | claude-to-codex | codex-to-claude)`);
}

function parseSecretMode(v: string): SecretMode {
  const ok: SecretMode[] = ["gitignore-guard", "allow", "allow-tracked", "redact", "sidecar"];
  if (ok.includes(v as SecretMode)) return v as SecretMode;
  throw new Error(`invalid --secrets "${v}" (use ${ok.join(" | ")})`);
}

program
  .command("sync")
  .description("Sync a project (or --all). Dry-run by default on a project's first sync.")
  .argument("[project]", "project name or path (defaults to current dir)")
  .option("-a, --all", "sync every project in the workspace")
  .option("-w, --workspace <dir>", "workspace dir")
  .option("--dry-run", "show changes without writing")
  .option("--apply", "write changes (overrides first-run dry-run default)")
  .option("--direction <dir>", "both | claude-to-codex | codex-to-claude", parseDirection)
  .option("--prefer <side>", "conflict winner: claude | codex")
  .option("--no-memory", "sync instructions only, skip memory")
  .option("--apply-deletions", "propagate deletions across sides")
  .option("--secrets <mode>", "gitignore-guard | allow | allow-tracked | redact | sidecar", parseSecretMode)
  .action((project, opts) => {
    runSync({
      project,
      all: !!opts.all,
      workspace: opts.workspace,
      dryRun: opts.dryRun,
      apply: !!opts.apply,
      direction: opts.direction,
      prefer: opts.prefer,
      noMemory: opts.memory === false,
      applyDeletions: !!opts.applyDeletions,
      secretMode: opts.secrets,
    });
  });

program
  .command("status")
  .description("Read-only drift report across projects.")
  .argument("[project]", "project name or path")
  .option("-a, --all", "all projects (default when no project given)")
  .option("-w, --workspace <dir>", "workspace dir")
  .option("--no-memory", "ignore memory drift")
  .action((project, opts) => {
    runStatus({ project, all: !!opts.all, workspace: opts.workspace, noMemory: opts.memory === false });
  });

program
  .command("skills")
  .description("Sync custom local skills (e.g. nieuwsbrief-skill) between Claude and Codex. Ecosystem symlinks are skipped.")
  .option("--direction <dir>", "both | claude-to-codex | codex-to-claude", parseDirection)
  .option("--dry-run", "show what would copy")
  .option("--apply", "actually copy")
  .action((opts) => {
    runSkills({ direction: opts.direction, dryRun: opts.dryRun, apply: !!opts.apply });
  });

program
  .command("workspace")
  .description("Sync the workspace-root CLAUDE.md (project index) with global ~/.codex/AGENTS.md.")
  .option("-w, --workspace <dir>", "workspace dir")
  .option("--direction <dir>", "both | claude-to-codex | codex-to-claude", parseDirection)
  .option("--prefer <side>", "conflict winner: claude | codex")
  .option("--dry-run", "show changes without writing")
  .option("--apply", "write changes")
  .action((opts) => {
    runWorkspace({
      workspace: opts.workspace,
      direction: opts.direction,
      prefer: opts.prefer,
      dryRun: opts.dryRun,
      apply: !!opts.apply,
    });
  });

program
  .command("tui", { isDefault: true })
  .aliases(["ui"])
  .description("Interactive terminal dashboard (default when no command is given).")
  .argument("[project]", "limit to one project")
  .option("-w, --workspace <dir>", "workspace dir")
  .option("--direction <dir>", "both | claude-to-codex | codex-to-claude", parseDirection)
  .option("--secrets <mode>", "gitignore-guard | allow | allow-tracked | redact | sidecar", parseSecretMode)
  .action((project, opts) => {
    runTui({ project, workspace: opts.workspace, direction: opts.direction, secretMode: opts.secrets });
  });

program
  .command("harvest")
  .description("Stage Codex-generated memories (~/.codex/memories) as proposed Claude memory files for review.")
  .argument("[project]", "project to attribute / accept into")
  .option("-w, --workspace <dir>", "workspace dir")
  .option("--accept", "copy staged proposals into the project's live memory dir")
  .action((project, opts) => {
    runHarvest({ project, workspace: opts.workspace, accept: !!opts.accept });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
