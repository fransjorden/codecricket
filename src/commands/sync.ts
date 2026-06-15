import { statSync } from "node:fs";
import path from "node:path";
import type { ClaudeSide, MemoryIndex, ParsedFact, SecretFinding, SecretPolicy, SyncState } from "../types.js";
import { defaultSecretPolicy, loadProjectsMap, resolveWorkspace } from "../core/config.js";
import {
  derivedMemoryDir,
  homeDir,
  toPosix,
} from "../core/paths.js";
import {
  listProjectFolders,
  resolveMemoryDir,
  resolveProject,
  suggestStrandingMappings,
  type ResolvedProject,
} from "../core/resolver.js";
import { readClaudeSide } from "../core/claudeReader.js";
import { agentsPathFor } from "../core/codexReader.js";
import { parseAgentsRegions } from "../core/codexReader.js";
import { parseFactContent } from "../core/frontmatter.js";
import { removeRegion, renderMemoryRegionBody, upsertRegion } from "../core/fence.js";
import { planUnit, type Direction, type UnitInput, type UnitPlan } from "../core/merge.js";
import { sha256 } from "../core/hash.js";
import { readText, removeFile, writeTextAtomic } from "../core/fsx.js";
import { applyGitignore, isTracked, planGitignore, type GitignorePlan } from "../core/gitAware.js";
import {
  applyRedaction,
  expandRedaction,
  parseSidecar,
  scanContent,
  serializeSidecar,
} from "../core/secretGuard.js";
import { loadState, saveState } from "../core/state.js";
import { unifiedDiff } from "../util/diffPreview.js";
import { log } from "../util/logger.js";
import type { SecretMode } from "../types.js";

export interface SyncOptions {
  project?: string;
  all?: boolean;
  workspace?: string;
  direction?: Direction;
  prefer?: "claude" | "codex";
  dryRun?: boolean;
  apply?: boolean;
  noMemory?: boolean;
  applyDeletions?: boolean;
  secretMode?: SecretMode;
}

interface CodexView {
  rawOnDisk: string;
  exists: boolean;
  regions: ReturnType<typeof parseAgentsRegions>;
}

function mtimeOf(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function readCodexView(agentsPath: string, sidecarPath: string): CodexView {
  const raw = readText(agentsPath);
  if (raw === null) {
    return { rawOnDisk: "", exists: false, regions: parseAgentsRegions("") };
  }
  const mapping = parseSidecar(readText(sidecarPath));
  const expanded = Object.keys(mapping).length ? expandRedaction(raw, mapping) : raw;
  return { rawOnDisk: raw, exists: true, regions: parseAgentsRegions(expanded) };
}

interface ClaudeWrite {
  path: string;
  content: string;
  label: string;
}

export interface ProjectPlan {
  name: string;
  projectDir: string;
  agentsPath: string;
  memoryRead: string | null;
  memoryWrite: string;
  memorySource: string;
  plans: UnitPlan[];
  agentsBefore: string;
  agentsAfter: string | null; // null => no codex change
  claudeWrites: ClaudeWrite[];
  claudeDeletes: string[];
  secretFindings: SecretFinding[];
  gitPlan: GitignorePlan | null;
  tracked: boolean;
  blocked: boolean;
  blockReason: string | null;
  sidecar: { path: string; content: string } | null;
  stateMutations: { key: string; hash: string | null; commit: boolean }[];
  noMemoryResolution: boolean;
}

function factMap(facts: ParsedFact[]): Map<string, ParsedFact> {
  return new Map(facts.map((f) => [f.filename, f]));
}

export function planProject(
  project: ResolvedProject,
  opts: SyncOptions,
  state: SyncState,
  policy: SecretPolicy,
  strandingTargets?: Set<string>,
): ProjectPlan {
  const direction: Direction = opts.direction ?? "both";
  const home = homeDir();
  const resolution = resolveMemoryDir(project, loadProjectsMap(), home);
  const memoryRead = resolution.memoryDir;
  const memoryWrite = resolution.memoryDir ?? toPosix(derivedMemoryDir(project.projectDir, home));
  const agentsPath = agentsPathFor(project.projectDir);
  const sidecarPath = `${toPosix(project.projectDir)}/${policy.sidecarFilename}`;

  const claude: ClaudeSide = readClaudeSide(project.projectDir, memoryRead);
  const codex = readCodexView(agentsPath, sidecarPath);

  const prev = state.projects[toPosix(project.projectDir)];
  const synced = (key: string): string | null => prev?.units[key] ?? null;

  const codexMtime = mtimeOf(agentsPath);
  const claudeFacts = factMap(claude.facts);
  const codexFacts = factMap(codex.regions.facts);

  // ---- build units ----
  const units: UnitInput[] = [];
  units.push({
    kind: "instructions",
    key: "instructions",
    claudeContent: claude.instructions,
    codexContent: codex.regions.instructions,
    syncedHash: synced("instructions"),
    claudeMtimeMs: claude.instructionsFilename ? mtimeOf(`${toPosix(project.projectDir)}/${claude.instructionsFilename}`) : 0,
    codexMtimeMs: codexMtime,
  });

  if (!opts.noMemory) {
    units.push({
      kind: "index",
      key: "MEMORY.md",
      claudeContent: claude.index?.content ?? null,
      codexContent: codex.regions.index?.content ?? null,
      syncedHash: synced("MEMORY.md"),
      claudeMtimeMs: memoryRead ? mtimeOf(`${memoryRead}/MEMORY.md`) : 0,
      codexMtimeMs: codexMtime,
    });
    const factKeys = new Set<string>([...claudeFacts.keys(), ...codexFacts.keys()]);
    for (const key of [...factKeys].sort()) {
      units.push({
        kind: "fact",
        key,
        claudeContent: claudeFacts.get(key)?.content ?? null,
        codexContent: codexFacts.get(key)?.content ?? null,
        syncedHash: synced(key),
        claudeMtimeMs: memoryRead ? mtimeOf(`${memoryRead}/${key}`) : 0,
        codexMtimeMs: codexMtime,
      });
    }
  }

  const plans = units.map((u) => planUnit(u, { prefer: opts.prefer, direction, applyDeletions: !!opts.applyDeletions }));

  // ---- materialize targets ----
  const claudeWrites: ClaudeWrite[] = [];
  const claudeDeletes: string[] = [];
  const stateMutations: RawMutation[] = [];

  // Codex side: start from existing facts (attr-correct ParsedFacts), mutate.
  const agentsFactObjs = new Map<string, ParsedFact>(codex.regions.facts.map((f) => [f.filename, f]));
  let agentsIndex: MemoryIndex | null = codex.regions.index;
  let touchMemory = false;

  // Instructions handling
  let agentsRaw = codex.rawOnDisk;
  let touchInstructions = false;
  let instrContent: string | null = null;
  let instrEol = codex.regions.instructionsEol;
  let instrFinalNl = codex.regions.instructionsFinalNewline;

  for (const p of plans) {
    if (p.kind === "instructions") {
      if (p.decision === "to-codex") {
        touchInstructions = true;
        instrContent = claude.instructions;
        instrEol = claude.instructionsEol;
        instrFinalNl = claude.instructionsFinalNewline;
      } else if (p.decision === "to-claude") {
        const file = `${toPosix(project.projectDir)}/${claude.instructionsFilename ?? "CLAUDE.md"}`;
        claudeWrites.push({ path: file, content: p.content ?? "", label: claude.instructionsFilename ?? "CLAUDE.md" });
      }
      stateMutations.push(mutationFor(p, codex.exists));
      continue;
    }
    if (p.kind === "index") {
      if (p.decision === "to-codex") {
        touchMemory = true;
        agentsIndex = claude.index;
      } else if (p.decision === "delete-codex") {
        touchMemory = true;
        agentsIndex = null;
      } else if (p.decision === "to-claude") {
        claudeWrites.push({ path: `${memoryWrite}/MEMORY.md`, content: p.content ?? "", label: "MEMORY.md" });
      } else if (p.decision === "delete-claude") {
        claudeDeletes.push(`${memoryRead ?? memoryWrite}/MEMORY.md`);
      }
      stateMutations.push(mutationFor(p, codex.exists));
      continue;
    }
    // fact
    if (p.decision === "to-codex") {
      touchMemory = true;
      const f = claudeFacts.get(p.key)!;
      agentsFactObjs.set(p.key, f);
    } else if (p.decision === "delete-codex") {
      touchMemory = true;
      agentsFactObjs.delete(p.key);
    } else if (p.decision === "to-claude") {
      claudeWrites.push({ path: `${memoryWrite}/${p.key}`, content: p.content ?? "", label: p.key });
    } else if (p.decision === "delete-claude") {
      claudeDeletes.push(`${memoryRead ?? memoryWrite}/${p.key}`);
    }
    stateMutations.push(mutationFor(p, codex.exists));
  }

  // Build new AGENTS.md
  if (touchInstructions && instrContent !== null) {
    agentsRaw = upsertRegion(agentsRaw, "instructions", instrContent, {
      eol: instrEol,
      finalnl: instrFinalNl ? "1" : "0",
    });
  }
  if (!opts.noMemory && touchMemory) {
    const facts = [...agentsFactObjs.values()];
    if (!agentsIndex && facts.length === 0) {
      agentsRaw = removeRegion(agentsRaw, "memory");
    } else {
      const body = renderMemoryRegionBody(agentsIndex, facts);
      agentsRaw = upsertRegion(agentsRaw, "memory", body);
    }
  }

  const agentsChanged = agentsRaw !== codex.rawOnDisk || (!codex.exists && agentsRaw !== "");

  // ---- secret guard on what we'd write into the repo ----
  const findings = scanIntroduced(claude, claudeFacts, plans, policy);
  let agentsToWrite: string | null = agentsChanged ? agentsRaw : null;
  let sidecar: ProjectPlan["sidecar"] = null;
  let blocked = false;
  let blockReason: string | null = null;
  let gitPlan: GitignorePlan | null = null;
  const tracked = codex.exists || agentsToWrite !== null ? isTracked(agentsPath) : false;

  if (agentsToWrite !== null && findings.length > 0) {
    const mode = opts.secretMode ?? policy.mode;
    if (mode === "redact" || mode === "sidecar") {
      const { redacted, mapping } = applyRedaction(agentsToWrite, policy);
      agentsToWrite = redacted;
      if (Object.keys(mapping).length) {
        sidecar = { path: `${toPosix(project.projectDir)}/${policy.sidecarFilename}`, content: serializeSidecar(mapping) };
      }
    } else {
      // gitignore-guard / allow-tracked / allow
      gitPlan = planGitignore(agentsPath);
      if (mode !== "allow") {
        // attempt to keep AGENTS.md out of git
      }
      if (tracked && policy.blockOnTracked && mode === "gitignore-guard") {
        blocked = true;
        blockReason =
          `AGENTS.md is git-tracked and would commit ${findings.length} secret(s). ` +
          `Re-run with --secrets allow-tracked (accept), or --secrets redact (mask).`;
      }
    }
  }

  // Compute final state mutations (commit depends on whether codex write happened/blocked).
  const finalMutations = stateMutations.map((m) => {
    if (!m.commitDependsOnCodex) return { key: m.key, hash: m.hash, commit: m.commit };
    return { key: m.key, hash: m.hash, commit: m.commit && !blocked };
  });

  return {
    name: project.name,
    projectDir: toPosix(project.projectDir),
    agentsPath,
    memoryRead,
    memoryWrite,
    memorySource: resolution.source,
    plans,
    agentsBefore: codex.rawOnDisk,
    agentsAfter: blocked ? null : agentsToWrite,
    claudeWrites,
    claudeDeletes,
    secretFindings: findings,
    gitPlan,
    tracked,
    blocked,
    blockReason,
    sidecar,
    stateMutations: finalMutations,
    noMemoryResolution:
      resolution.source === "none" && !opts.noMemory && (strandingTargets?.has(project.name) ?? false),
  };
}

interface RawMutation {
  key: string;
  hash: string | null;
  commit: boolean;
  commitDependsOnCodex: boolean;
}

function mutationFor(p: UnitPlan, _codexExists: boolean): RawMutation {
  switch (p.decision) {
    case "noop":
      return { key: p.key, hash: p.content === null ? null : sha256(p.content), commit: true, commitDependsOnCodex: false };
    case "to-codex":
      return { key: p.key, hash: sha256(p.content ?? ""), commit: true, commitDependsOnCodex: true };
    case "to-claude":
      return { key: p.key, hash: sha256(p.content ?? ""), commit: true, commitDependsOnCodex: false };
    case "delete-codex":
      return { key: p.key, hash: null, commit: true, commitDependsOnCodex: true };
    case "delete-claude":
      return { key: p.key, hash: null, commit: true, commitDependsOnCodex: false };
    case "delete-pending":
    default:
      return { key: p.key, hash: null, commit: false, commitDependsOnCodex: false };
  }
}

/** Scan the contents we'd introduce into the repo (claude-origin units headed to codex). */
function scanIntroduced(
  claude: ClaudeSide,
  claudeFacts: Map<string, ParsedFact>,
  plans: UnitPlan[],
  policy: SecretPolicy,
): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const p of plans) {
    if (p.decision !== "to-codex" && p.decision !== "noop") continue;
    if (p.kind === "instructions" && claude.instructions) {
      out.push(...scanContent(claude.instructions, "CLAUDE.md", policy));
    } else if (p.kind === "index" && claude.index) {
      out.push(...scanContent(claude.index.content, "MEMORY.md", policy));
    } else if (p.kind === "fact") {
      const f = claudeFacts.get(p.key);
      if (f) out.push(...scanContent(f.content, p.key, policy));
    }
  }
  // de-dup by match+file
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = `${f.file}:${f.match}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---- printing ----

function printPlan(pp: ProjectPlan, opts: SyncOptions, willWrite: boolean): void {
  const changed = pp.plans.filter((p) => p.decision !== "noop");
  log.info("");
  log.info(log.bold(`▶ ${pp.name}`) + log.dim(`  (${pp.memorySource} memory)`));
  if (pp.noMemoryResolution) {
    log.warn(`No memory found at the derived path. If this project was renamed, map it: cricket init --map ${pp.name}=<old-name>`);
  }
  if (changed.length === 0) {
    log.ok("in sync — nothing to do");
  } else {
    for (const p of changed) {
      const arrow =
        p.decision === "to-codex" ? "claude → codex" :
        p.decision === "to-claude" ? "codex → claude" :
        p.decision === "delete-codex" ? "delete on codex" :
        p.decision === "delete-claude" ? "delete on claude" :
        "pending deletion";
      const flag = p.conflict ? log.dim(" [conflict]") : "";
      log.info(`  ${p.kind === "fact" ? p.key : p.kind}`.padEnd(38) + ` ${arrow}  ${log.dim(p.note)}${flag}`);
    }
  }

  if (pp.secretFindings.length) {
    log.danger(`${pp.secretFindings.length} secret(s) in content headed to AGENTS.md:`);
    for (const f of pp.secretFindings) log.info(`    ${f.file}:${f.line}  ${f.rule}  ${f.preview}`);
    if (pp.sidecar) log.info(log.dim(`    → redacted; real values in ${path.basename(pp.sidecar.path)} (gitignored)`));
    else if (pp.gitPlan?.inRepo && !pp.tracked) log.info(log.dim(`    → AGENTS.md will be added to .gitignore`));
    else if (!pp.gitPlan?.inRepo) log.info(log.dim(`    → not a git repo; rendered as-is`));
  }
  if (pp.blocked) {
    log.error(`BLOCKED: ${pp.blockReason}`);
  }

  if (opts.dryRun || !willWrite) {
    if (pp.agentsAfter !== null && pp.agentsAfter !== pp.agentsBefore) {
      const diff = unifiedDiff("AGENTS.md", pp.agentsBefore, pp.agentsAfter);
      if (diff) log.info(diff);
    }
    for (const w of pp.claudeWrites) {
      const before = readText(w.path) ?? "";
      const diff = unifiedDiff(w.label, before, w.content);
      if (diff) log.info(diff);
    }
    for (const d of pp.claudeDeletes) log.info(log.dim(`  would delete ${d}`));
  }
}

// ---- execution ----

export function executeProject(pp: ProjectPlan, state: SyncState): void {
  // Codex side
  if (!pp.blocked && pp.agentsAfter !== null && pp.agentsAfter !== pp.agentsBefore) {
    writeTextAtomic(pp.agentsPath, pp.agentsAfter, { backup: true });
    if (pp.gitPlan && !pp.gitPlan.alreadyIgnored && !pp.tracked) {
      if (applyGitignore(pp.gitPlan)) log.ok(`added ${pp.gitPlan.relPath} to .gitignore`);
    }
    if (pp.sidecar) {
      writeTextAtomic(pp.sidecar.path, pp.sidecar.content, { backup: true });
      const giSidecar = planGitignore(pp.sidecar.path);
      if (giSidecar.inRepo && !giSidecar.alreadyIgnored) applyGitignore(giSidecar);
    }
    log.ok(`wrote ${path.basename(pp.agentsPath)}`);
  }
  // Claude side
  for (const w of pp.claudeWrites) {
    writeTextAtomic(w.path, w.content, { backup: true });
    log.ok(`wrote ${w.label}`);
  }
  for (const d of pp.claudeDeletes) {
    removeFile(d, { backup: true });
    log.ok(`deleted ${path.basename(d)}`);
  }

  // State
  const ps = state.projects[pp.projectDir] ?? { lastSyncAt: "", memoryDir: pp.memoryRead, units: {} };
  ps.memoryDir = pp.memoryRead;
  for (const m of pp.stateMutations) {
    if (!m.commit) continue;
    if (m.hash === null) delete ps.units[m.key];
    else ps.units[m.key] = m.hash;
  }
  state.projects[pp.projectDir] = ps;
}

// ---- entry ----

export interface RunResult {
  changed: number;
  blocked: number;
}

/** Project names that some stranded memory dir suggests — the only ones worth a "map it?" nudge. */
export function strandingTargetSet(workspace: string): Set<string> {
  const targets = new Set<string>();
  for (const s of suggestStrandingMappings(workspace, loadProjectsMap(), homeDir())) {
    if (s.suggestedProject) targets.add(s.suggestedProject);
  }
  return targets;
}

export function runSync(opts: SyncOptions): RunResult {
  const workspace = resolveWorkspace(opts.workspace);
  const policy = defaultSecretPolicy(opts.secretMode ? { mode: opts.secretMode } : {});
  const state = loadState();

  let projects: ResolvedProject[];
  if (opts.all) {
    projects = listProjectFolders(workspace);
  } else {
    const target = opts.project ?? process.cwd();
    projects = [resolveProject(target, workspace)];
  }

  const strandingTargets = strandingTargetSet(workspace);

  let changed = 0;
  let blocked = 0;
  let anyWrite = false;

  for (const project of projects) {
    const pp = planProject(project, opts, state, policy, strandingTargets);
    const hasChanges =
      pp.plans.some((p) => p.decision !== "noop") ||
      (pp.agentsAfter !== null && pp.agentsAfter !== pp.agentsBefore);

    // First-ever sync of a project defaults to dry-run unless --apply given.
    const firstRun = !state.projects[pp.projectDir];
    const dryRun = opts.dryRun ?? (opts.apply ? false : firstRun);
    const willWrite = !dryRun && !pp.blocked;

    printPlan(pp, { ...opts, dryRun }, willWrite);

    if (hasChanges) changed++;
    if (pp.blocked) blocked++;

    if (willWrite) {
      executeProject(pp, state);
      anyWrite = true;
    } else if (dryRun && hasChanges && firstRun) {
      log.info(log.dim(`  (first sync of ${pp.name} — dry-run by default; re-run with --apply to write)`));
    }
  }

  if (anyWrite) {
    for (const psKey of Object.keys(state.projects)) {
      state.projects[psKey]!.lastSyncAt = new Date().toISOString();
    }
    saveState(state);
  }

  log.info("");
  log.info(log.bold(`Done. ${changed} project(s) with changes, ${blocked} blocked.`));
  return { changed, blocked };
}
