import { existsSync, readFileSync } from "node:fs";
import type { CodexSide, ManagedRegions } from "../types.js";
import { findRegion, parseMemoryRegionBody, reconstructRegionContent } from "./fence.js";
import { toPosix } from "./paths.js";

export function parseAgentsRegions(raw: string): ManagedRegions {
  const instr = findRegion(raw, "instructions");
  const mem = findRegion(raw, "memory");

  let instructions: string | null = null;
  let instructionsEol: ManagedRegions["instructionsEol"] = "lf";
  let instructionsFinalNewline = true;
  if (instr) {
    const rec = reconstructRegionContent(instr.inner, instr.beginAttrs);
    instructions = rec.content;
    instructionsEol = rec.eol;
    instructionsFinalNewline = rec.finalNewline;
  }

  let index = null;
  let facts: ManagedRegions["facts"] = [];
  if (mem) {
    const parsed = parseMemoryRegionBody(mem.inner);
    index = parsed.index;
    facts = parsed.facts;
  }

  return {
    instructions,
    instructionsEol,
    instructionsFinalNewline,
    index,
    facts,
    hasInstructionsRegion: !!instr,
    hasMemoryRegion: !!mem,
  };
}

export function readCodexSide(agentsPath: string): CodexSide {
  const p = toPosix(agentsPath);
  if (!existsSync(p)) {
    return {
      agentsPath: p,
      exists: false,
      raw: null,
      regions: {
        instructions: null,
        instructionsEol: "lf",
        instructionsFinalNewline: true,
        index: null,
        facts: [],
        hasInstructionsRegion: false,
        hasMemoryRegion: false,
      },
    };
  }
  const raw = readFileSync(p, "utf8");
  return { agentsPath: p, exists: true, raw, regions: parseAgentsRegions(raw) };
}

export function agentsPathFor(projectDir: string): string {
  return `${toPosix(projectDir)}/AGENTS.md`;
}
