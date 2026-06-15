import { describe, expect, it } from "vitest";
import { sha256 } from "../src/core/hash.js";
import { planUnit, type UnitInput, type MergeOptions } from "../src/core/merge.js";

function unit(partial: Partial<UnitInput>): UnitInput {
  return {
    kind: "fact",
    key: "x.md",
    claudeContent: null,
    codexContent: null,
    syncedHash: null,
    claudeMtimeMs: 0,
    codexMtimeMs: 0,
    ...partial,
  };
}

const both: MergeOptions = { direction: "both", applyDeletions: false };

describe("planUnit", () => {
  it("equal content is a no-op", () => {
    const c = "same";
    const p = planUnit(unit({ claudeContent: c, codexContent: c, syncedHash: sha256(c) }), both);
    expect(p.decision).toBe("noop");
  });

  it("only claude changed → to-codex", () => {
    const synced = sha256("old");
    const p = planUnit(unit({ claudeContent: "new", codexContent: "old", syncedHash: synced }), both);
    expect(p.decision).toBe("to-codex");
    expect(p.content).toBe("new");
  });

  it("only codex changed → to-claude", () => {
    const synced = sha256("old");
    const p = planUnit(unit({ claudeContent: "old", codexContent: "new", syncedHash: synced }), both);
    expect(p.decision).toBe("to-claude");
    expect(p.content).toBe("new");
  });

  it("both changed → newest mtime wins (claude)", () => {
    const synced = sha256("base");
    const p = planUnit(
      unit({ claudeContent: "cc", codexContent: "xx", syncedHash: synced, claudeMtimeMs: 200, codexMtimeMs: 100 }),
      both,
    );
    expect(p.decision).toBe("to-codex");
    expect(p.conflict).toBe(true);
  });

  it("both changed → --prefer codex overrides mtime", () => {
    const synced = sha256("base");
    const p = planUnit(
      unit({ claudeContent: "cc", codexContent: "xx", syncedHash: synced, claudeMtimeMs: 999, codexMtimeMs: 1 }),
      { ...both, prefer: "codex" },
    );
    expect(p.decision).toBe("to-claude");
    expect(p.conflict).toBe(true);
  });

  it("new on claude (no synced, codex absent) → to-codex", () => {
    const p = planUnit(unit({ claudeContent: "fresh", codexContent: null, syncedHash: null }), both);
    expect(p.decision).toBe("to-codex");
  });

  it("new on codex (no synced, claude absent) → to-claude", () => {
    const p = planUnit(unit({ claudeContent: null, codexContent: "fresh", syncedHash: null }), both);
    expect(p.decision).toBe("to-claude");
  });

  it("deleted on codex (was synced) is pending without --apply-deletions", () => {
    const synced = sha256("v");
    const p = planUnit(unit({ claudeContent: "v", codexContent: null, syncedHash: synced }), both);
    expect(p.decision).toBe("delete-pending");
  });

  it("deleted on codex with --apply-deletions → delete-claude", () => {
    const synced = sha256("v");
    const p = planUnit(unit({ claudeContent: "v", codexContent: null, syncedHash: synced }), { ...both, applyDeletions: true });
    expect(p.decision).toBe("delete-claude");
  });

  it("direction claude-to-codex suppresses a codex→claude write", () => {
    const synced = sha256("old");
    const p = planUnit(
      unit({ claudeContent: "old", codexContent: "new", syncedHash: synced }),
      { direction: "claude-to-codex", applyDeletions: false },
    );
    expect(p.decision).toBe("noop");
    expect(p.note).toMatch(/skipped/);
  });

  it("direction codex-to-claude suppresses a claude→codex write", () => {
    const synced = sha256("old");
    const p = planUnit(
      unit({ claudeContent: "new", codexContent: "old", syncedHash: synced }),
      { direction: "codex-to-claude", applyDeletions: false },
    );
    expect(p.decision).toBe("noop");
  });
});
