import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { ClaudeSide, MemoryIndex, ParsedFact } from "../types.js";
import { analyzeRaw, readFact, readIndex } from "./frontmatter.js";
import { toPosix } from "./paths.js";

/** Find CLAUDE.md / claude.md (case-insensitive); return the on-disk name + path. */
export function findInstructionsFile(projectDir: string): { filename: string; path: string } | null {
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return null;
  }
  const hit = entries.find((e) => e.toLowerCase() === "claude.md");
  if (!hit) return null;
  return { filename: hit, path: `${toPosix(projectDir)}/${hit}` };
}

const FACT_IGNORE = new Set(["MEMORY.md"]);

export function readMemoryDir(memoryDir: string): { index: MemoryIndex | null; facts: ParsedFact[] } {
  if (!memoryDir || !existsSync(memoryDir)) return { index: null, facts: [] };
  let entries: string[];
  try {
    entries = readdirSync(memoryDir);
  } catch {
    return { index: null, facts: [] };
  }
  let index: MemoryIndex | null = null;
  const facts: ParsedFact[] = [];
  for (const name of entries) {
    const full = `${toPosix(memoryDir)}/${name}`;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile() || !name.toLowerCase().endsWith(".md")) continue;
    if (name === "MEMORY.md") {
      index = readIndex(full);
    } else if (!FACT_IGNORE.has(name)) {
      facts.push(readFact(full));
    }
  }
  return { index, facts };
}

export function readClaudeSide(projectDir: string, memoryDir: string | null): ClaudeSide {
  const proj = toPosix(projectDir);
  const instr = findInstructionsFile(proj);
  let instructions: string | null = null;
  let instructionsEol: ClaudeSide["instructionsEol"] = "lf";
  let instructionsFinalNewline = true;
  if (instr) {
    const raw = readFileSync(instr.path, "utf8");
    instructions = raw;
    const a = analyzeRaw(raw);
    instructionsEol = a.eol;
    instructionsFinalNewline = a.finalNewline;
  }
  const { index, facts } = memoryDir ? readMemoryDir(memoryDir) : { index: null, facts: [] };
  return {
    projectDir: proj,
    instructionsFilename: instr?.filename ?? null,
    instructions,
    instructionsEol,
    instructionsFinalNewline,
    memoryDir: memoryDir ? toPosix(memoryDir) : null,
    index,
    facts,
  };
}
