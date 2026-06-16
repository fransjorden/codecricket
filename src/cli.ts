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
  .name("cricket")
  .description("CodeCricket keeps Claude Code (CLAUDE.md and memory) and Codex (AGENTS.md) synchronized, in both directions.")
  .version("0.1.0")
  .option("-q, --quiet", "Suppress all non-essential output.")
  .option("-v, --verbose", "Display additional, detailed output.")
  .hook("preAction", (thisCommand) => {
    const o = thisCommand.opts();
    setVerbosity({ verbose: !!o.verbose, quiet: !!o.quiet });
  });

program
  .command("init")
  .description("Scan the workspace, build the projects.json file, and detect any orphaned memory directories.")
  .option("-w, --workspace <dir>", "The workspace directory that holds your project folders.")
  .option("-m, --map <name=value...>", "Set an explicit memory override, for example: type-machine=meeting-tool")
  .option("--accept-suggestions", "Automatically accept the suggested mappings that score above the threshold.")
  .option("--suggestion-threshold <n>", "The minimum score required to accept a suggestion automatically.", (v) => parseInt(v, 10))
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
  throw new Error(`Sorry, "${v}" is not a valid --direction. Please use one of: both | claude-to-codex | codex-to-claude`);
}

function parseSecretMode(v: string): SecretMode {
  const ok: SecretMode[] = ["gitignore-guard", "allow", "allow-tracked", "redact", "sidecar"];
  if (ok.includes(v as SecretMode)) return v as SecretMode;
  throw new Error(`Sorry, "${v}" is not a valid --secrets mode. Please use one of: ${ok.join(" | ")}`);
}

program
  .command("sync")
  .description("Synchronize a single project, or use --all for every project. The first run is a dry run by default.")
  .argument("[project]", "The project name or path (defaults to the current directory).")
  .option("-a, --all", "Synchronize every project in the workspace.")
  .option("-w, --workspace <dir>", "The workspace directory.")
  .option("--dry-run", "Preview the changes without writing anything.")
  .option("--apply", "Write the changes (this overrides the dry-run default on a first run).")
  .option("--direction <dir>", "The direction to copy: both | claude-to-codex | codex-to-claude", parseDirection)
  .option("--prefer <side>", "When there is a conflict, the side that wins: claude | codex")
  .option("--no-memory", "Synchronize the instructions only, and leave the memory untouched.")
  .option("--apply-deletions", "Also propagate deletions from one side to the other.")
  .option("--secrets <mode>", "How secrets are handled: gitignore-guard | allow | allow-tracked | redact | sidecar", parseSecretMode)
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
  .description("Display a read-only report of the differences across your projects.")
  .argument("[project]", "The project name or path.")
  .option("-a, --all", "Report on all projects (the default when no project is given).")
  .option("-w, --workspace <dir>", "The workspace directory.")
  .option("--no-memory", "Ignore any differences in memory.")
  .action((project, opts) => {
    runStatus({ project, all: !!opts.all, workspace: opts.workspace, noMemory: opts.memory === false });
  });

program
  .command("skills")
  .description("Synchronize your custom local skills (for example, nieuwsbrief-skill) between Claude and Codex. Ecosystem symlinks are skipped.")
  .option("--direction <dir>", "The direction to copy: both | claude-to-codex | codex-to-claude", parseDirection)
  .option("--dry-run", "Preview what would be copied.")
  .option("--apply", "Perform the copy.")
  .action((opts) => {
    runSkills({ direction: opts.direction, dryRun: opts.dryRun, apply: !!opts.apply });
  });

program
  .command("workspace")
  .description("Synchronize the workspace CLAUDE.md (your project index) with the global ~/.codex/AGENTS.md file.")
  .option("-w, --workspace <dir>", "The workspace directory.")
  .option("--direction <dir>", "The direction to copy: both | claude-to-codex | codex-to-claude", parseDirection)
  .option("--prefer <side>", "When there is a conflict, the side that wins: claude | codex")
  .option("--dry-run", "Preview the changes without writing anything.")
  .option("--apply", "Write the changes.")
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
  .description("Open the interactive dashboard. This is the default when no command is given.")
  .argument("[project]", "Limit the dashboard to a single project.")
  .option("-w, --workspace <dir>", "The workspace directory.")
  .option("--direction <dir>", "The direction to copy: both | claude-to-codex | codex-to-claude", parseDirection)
  .option("--secrets <mode>", "How secrets are handled: gitignore-guard | allow | allow-tracked | redact | sidecar", parseSecretMode)
  .action((project, opts) => {
    runTui({ project, workspace: opts.workspace, direction: opts.direction, secretMode: opts.secrets });
  });

program
  .command("harvest")
  .description("Collect the memories Codex created (~/.codex/memories) and stage them as Claude memory files for your review.")
  .argument("[project]", "The project to attribute the memories to, or to accept them into.")
  .option("-w, --workspace <dir>", "The workspace directory.")
  .option("--accept", "Copy the staged proposals into the project's live memory directory.")
  .action((project, opts) => {
    runHarvest({ project, workspace: opts.workspace, accept: !!opts.accept });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
