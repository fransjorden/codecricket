// Unit-level bidirectional 3-way merge. A "unit" is the instructions blob, the
// MEMORY.md index, or a single memory fact. Each is reconciled independently so
// editing fact A in Codex and fact B in Claude never clobber each other.

import { sha256 } from "./hash.js";

export type UnitKind = "instructions" | "index" | "fact";
export type Direction = "both" | "claude-to-codex" | "codex-to-claude";

export interface UnitInput {
  kind: UnitKind;
  key: string; // "instructions" | "MEMORY.md" | fact filename
  claudeContent: string | null;
  codexContent: string | null;
  syncedHash: string | null;
  claudeMtimeMs: number;
  codexMtimeMs: number;
}

export type UnitDecision =
  | "noop"
  | "to-codex"
  | "to-claude"
  | "delete-codex"
  | "delete-claude"
  | "delete-pending";

export interface UnitPlan {
  kind: UnitKind;
  key: string;
  decision: UnitDecision;
  winner: "claude" | "codex" | null;
  conflict: boolean;
  /** The content that wins (for to-codex/to-claude); null otherwise. */
  content: string | null;
  note: string;
}

export interface MergeOptions {
  prefer?: "claude" | "codex";
  direction: Direction;
  applyDeletions: boolean;
}

function hashOf(s: string | null): string | null {
  return s === null ? null : sha256(s);
}

function decide(unit: UnitInput, opts: MergeOptions): UnitPlan {
  const cHash = hashOf(unit.claudeContent);
  const xHash = hashOf(unit.codexContent);
  const synced = unit.syncedHash;
  const base = { kind: unit.kind, key: unit.key };

  // Present on both sides.
  if (cHash !== null && xHash !== null) {
    if (cHash === xHash) {
      return { ...base, decision: "noop", winner: null, conflict: false, content: unit.claudeContent, note: "in sync" };
    }
    const cChanged = cHash !== synced;
    const xChanged = xHash !== synced;
    if (cChanged && !xChanged) {
      return { ...base, decision: "to-codex", winner: "claude", conflict: false, content: unit.claudeContent, note: "claude edited" };
    }
    if (xChanged && !cChanged) {
      return { ...base, decision: "to-claude", winner: "codex", conflict: false, content: unit.codexContent, note: "codex edited" };
    }
    // Both changed (or first-ever sync collision): conflict.
    const winner = opts.prefer ?? (unit.claudeMtimeMs >= unit.codexMtimeMs ? "claude" : "codex");
    return winner === "claude"
      ? { ...base, decision: "to-codex", winner, conflict: true, content: unit.claudeContent, note: `conflict → claude (${opts.prefer ? "prefer" : "newer"})` }
      : { ...base, decision: "to-claude", winner, conflict: true, content: unit.codexContent, note: `conflict → codex (${opts.prefer ? "prefer" : "newer"})` };
  }

  // Claude only.
  if (cHash !== null && xHash === null) {
    if (synced === null) {
      return { ...base, decision: "to-codex", winner: "claude", conflict: false, content: unit.claudeContent, note: "new on claude" };
    }
    // Existed before, now gone on codex → deletion originated on codex.
    return opts.applyDeletions
      ? { ...base, decision: "delete-claude", winner: null, conflict: false, content: null, note: "deleted on codex" }
      : { ...base, decision: "delete-pending", winner: null, conflict: false, content: unit.claudeContent, note: "deleted on codex (pending; use --apply-deletions)" };
  }

  // Codex only.
  if (cHash === null && xHash !== null) {
    if (synced === null) {
      return { ...base, decision: "to-claude", winner: "codex", conflict: false, content: unit.codexContent, note: "new on codex" };
    }
    return opts.applyDeletions
      ? { ...base, decision: "delete-codex", winner: null, conflict: false, content: null, note: "deleted on claude" }
      : { ...base, decision: "delete-pending", winner: null, conflict: false, content: unit.codexContent, note: "deleted on claude (pending; use --apply-deletions)" };
  }

  // Gone from both.
  return { ...base, decision: "noop", winner: null, conflict: false, content: null, note: "absent" };
}

/** Apply the direction filter: suppress writes to the side we're not touching. */
function applyDirection(plan: UnitPlan, direction: Direction): UnitPlan {
  if (direction === "both") return plan;
  const writesClaude = plan.decision === "to-claude" || plan.decision === "delete-claude";
  const writesCodex = plan.decision === "to-codex" || plan.decision === "delete-codex";
  if (direction === "claude-to-codex" && writesClaude) {
    return { ...plan, decision: "noop", note: `${plan.note} (skipped: claude→codex only)` };
  }
  if (direction === "codex-to-claude" && writesCodex) {
    return { ...plan, decision: "noop", note: `${plan.note} (skipped: codex→claude only)` };
  }
  return plan;
}

export function planUnit(unit: UnitInput, opts: MergeOptions): UnitPlan {
  return applyDirection(decide(unit, opts), opts.direction);
}

export function planUnits(units: UnitInput[], opts: MergeOptions): UnitPlan[] {
  return units.map((u) => planUnit(u, opts));
}
