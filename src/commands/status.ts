import { defaultSecretPolicy, resolveWorkspace } from "../core/config.js";
import { listProjectFolders, resolveProject, type ResolvedProject } from "../core/resolver.js";
import { loadState } from "../core/state.js";
import { planProject, strandingTargetSet, type SyncOptions } from "./sync.js";
import { log } from "../util/logger.js";

export interface StatusOptions {
  project?: string;
  all?: boolean;
  workspace?: string;
  noMemory?: boolean;
}

export function runStatus(opts: StatusOptions): void {
  const workspace = resolveWorkspace(opts.workspace);
  const policy = defaultSecretPolicy();
  const state = loadState();

  let projects: ResolvedProject[];
  if (opts.all || !opts.project) {
    projects = listProjectFolders(workspace);
  } else {
    projects = [resolveProject(opts.project, workspace)];
  }

  const syncOpts: SyncOptions = { direction: "both", noMemory: opts.noMemory };
  const strandingTargets = strandingTargetSet(workspace);

  for (const project of projects) {
    const pp = planProject(project, syncOpts, state, policy, strandingTargets);
    const changed = pp.plans.filter((p) => p.decision !== "noop");
    const toCodex = changed.filter((p) => p.decision === "to-codex").length;
    const toClaude = changed.filter((p) => p.decision === "to-claude").length;
    const conflicts = changed.filter((p) => p.conflict).length;
    const pending = changed.filter((p) => p.decision === "delete-pending").length;

    if (changed.length === 0 && pp.secretFindings.length === 0 && !pp.noMemoryResolution) {
      log.info(`${log.dim("·")} ${project.name.padEnd(26)} in sync`);
      continue;
    }
    const bits: string[] = [];
    if (toCodex) bits.push(`${toCodex}→codex`);
    if (toClaude) bits.push(`${toClaude}→claude`);
    if (conflicts) bits.push(`${conflicts} conflict`);
    if (pending) bits.push(`${pending} pending-del`);
    if (pp.secretFindings.length) bits.push(`${pp.secretFindings.length} secret`);
    if (pp.tracked && pp.secretFindings.length) bits.push("git-tracked!");
    if (pp.noMemoryResolution) bits.push("no-memory(map?)");
    log.info(`${log.bold("•")} ${project.name.padEnd(26)} ${bits.join("  ")}`);
  }
}
