import { readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { Eol, FrontmatterShape, ParsedFact, MemoryIndex } from "../types.js";
import { sha256 } from "./hash.js";

// ---- EOL / newline helpers (byte-exact reconstruction relies on these) ----

export function detectEol(raw: string): Eol {
  return raw.includes("\r\n") ? "crlf" : "lf";
}

export function toLf(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

export function fromLf(s: string, eol: Eol): string {
  return eol === "crlf" ? s.replace(/\n/g, "\r\n") : s;
}

export interface RawAnalysis {
  eol: Eol;
  finalNewline: boolean;
  /** LF-normalized content (canonical form carried in markers). */
  lf: string;
}

export function analyzeRaw(raw: string): RawAnalysis {
  const eol = detectEol(raw);
  const lf = toLf(raw);
  return { eol, finalNewline: lf.endsWith("\n"), lf };
}

/**
 * Reassemble original bytes from a carried (LF) payload + recorded metadata.
 * This is the inverse of analyzeRaw for well-formed input, and is what makes
 * round-trips survive editor EOL munging of AGENTS.md.
 */
export function assemble(payloadLf: string, eol: Eol): string {
  return fromLf(payloadLf, eol);
}

// ---- frontmatter shape detection (informational / routing only) ----

/**
 * Returns the [start, end) char range of the leading `---` frontmatter block in
 * LF-normalized text, or null when there is none. `end` points just past the
 * newline that follows the closing `---`.
 */
function frontmatterRange(lf: string): [number, number] | null {
  if (!lf.startsWith("---\n") && lf !== "---") return null;
  // Closing delimiter: a line that is exactly `---` after the opening line.
  const search = lf.indexOf("\n---", 3);
  if (search === -1) return null;
  // Ensure the closing `---` is a full line (followed by \n or EOF).
  const afterClose = search + 4; // position just after "\n---"
  const next = lf[afterClose];
  if (next !== undefined && next !== "\n") return null;
  const end = next === "\n" ? afterClose + 1 : afterClose;
  return [0, end];
}

export function detectShape(lf: string): FrontmatterShape {
  const range = frontmatterRange(lf);
  if (!range) return "none";
  const block = lf.slice(range[0], range[1]);
  // A top-level `metadata:` key => nested shape.
  if (/^metadata:\s*$/m.test(block) || /^metadata:\s+/m.test(block)) return "nested";
  return "flat";
}

export function parseFields(lf: string): ParsedFact["parsed"] {
  try {
    const { data } = matter(lf);
    const md = (data as Record<string, unknown>) ?? {};
    const meta = (md.metadata as Record<string, unknown>) ?? {};
    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = md[k] ?? meta[k];
        if (typeof v === "string") return v;
      }
      return undefined;
    };
    return {
      name: pick("name"),
      description: pick("description"),
      type: pick("type"),
      nodeType: typeof meta.node_type === "string" ? meta.node_type : undefined,
      originSessionId: pick("originSessionId"),
    };
  } catch {
    return {};
  }
}

// ---- readers ----

export function parseFactContent(filename: string, raw: string): ParsedFact {
  const { eol, finalNewline, lf } = analyzeRaw(raw);
  return {
    filename,
    shape: detectShape(lf),
    content: raw,
    eol,
    finalNewline,
    parsed: parseFields(lf),
    hash: sha256(raw),
    secrets: [],
  };
}

export function readFact(filePath: string): ParsedFact {
  const raw = readFileSync(filePath, "utf8");
  return parseFactContent(path.basename(filePath), raw);
}

export function readIndex(filePath: string): MemoryIndex {
  const raw = readFileSync(filePath, "utf8");
  const { eol, finalNewline } = analyzeRaw(raw);
  return {
    filename: "MEMORY.md",
    content: raw,
    eol,
    finalNewline,
    hash: sha256(raw),
    secrets: [],
  };
}
