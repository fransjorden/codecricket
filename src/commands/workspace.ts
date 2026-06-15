// Sync the workspace-root CLAUDE.md (the cross-project index) with Codex's
// global ~/.codex/AGENTS.md, so Codex gets the same orientation. Instructions
// only — no memory.

import type { SyncState } from "../types.js";
import { findRegion, reconstructRegionContent, upsertRegion } from "../core/fence.js";
import { analyzeRaw } from "../core/frontmatter.js";
import { sha256 } from "../core/hash.js";
import { planUnit, type Direction } from "../core/merge.js";
import { homeDir } from "../core/paths.js";
import { mtimeMs, readText, writeTextAtomic } from "../core/fsx.js";
import { loadState, saveState } from "../core/state.js";
import { unifiedDiff } from "../util/diffPreview.js";
import { resolveWorkspace } from "../core/config.js";
import { log } from "../util/logger.js";

export interface WorkspaceOptions {
  workspace?: string;
  direction?: Direction;
  prefer?: "claude" | "codex";
  dryRun?: boolean;
  apply?: boolean;
}

const STATE_KEY = "__workspace__";

export function runWorkspace(opts: WorkspaceOptions): void {
  const workspace = resolveWorkspace(opts.workspace);
  const claudePath = `${workspace}/CLAUDE.md`;
  const agentsPath = `${homeDir()}/.codex/AGENTS.md`;
  const direction: Direction = opts.direction ?? "both";
  const dryRun = opts.dryRun ?? !opts.apply;

  const claudeRaw = readText(claudePath);
  const agentsRaw = readText(agentsPath) ?? "";
  const region = findRegion(agentsRaw, "instructions");
  const codexInstr = region ? reconstructRegionContent(region.inner, region.beginAttrs).content : null;

  const state = loadState();
  const synced = state.projects[STATE_KEY]?.units["instructions"] ?? null;

  const plan = planUnit(
    {
      kind: "instructions",
      key: "instructions",
      claudeContent: claudeRaw,
      codexContent: codexInstr,
      syncedHash: synced,
      claudeMtimeMs: mtimeMs(claudePath),
      codexMtimeMs: mtimeMs(agentsPath),
    },
    { prefer: opts.prefer, direction, applyDeletions: false },
  );

  log.step(`Workspace docs: ${claudePath}  ↔  ~/.codex/AGENTS.md`);
  if (plan.decision === "noop") {
    log.ok("in sync");
    return;
  }

  if (plan.decision === "to-codex") {
    const a = analyzeRaw(claudeRaw ?? "");
    const next = upsertRegion(agentsRaw, "instructions", a.lf, { eol: a.eol, finalnl: a.finalNewline ? "1" : "0" });
    if (dryRun) {
      log.info(`  claude → codex  ${log.dim(plan.note)}`);
      log.info(unifiedDiff("~/.codex/AGENTS.md", agentsRaw, next));
      return;
    }
    writeTextAtomic(agentsPath, next, { backup: true });
    persist(state, plan.content);
    saveState(state);
    log.ok("wrote ~/.codex/AGENTS.md");
    return;
  } else if (plan.decision === "to-claude") {
    if (dryRun) {
      log.info(`  codex → claude  ${log.dim(plan.note)}`);
      log.info(unifiedDiff("CLAUDE.md", claudeRaw ?? "", plan.content ?? ""));
      return;
    }
    writeTextAtomic(claudePath, plan.content ?? "", { backup: true });
    persist(state, plan.content);
    saveState(state);
    log.ok("wrote workspace CLAUDE.md");
  }
}

function persist(state: SyncState, content: string | null): void {
  const ps = state.projects[STATE_KEY] ?? { lastSyncAt: "", memoryDir: null, units: {} };
  if (content === null) delete ps.units["instructions"];
  else ps.units["instructions"] = sha256(content);
  ps.lastSyncAt = new Date().toISOString();
  state.projects[STATE_KEY] = ps;
}
