// The ccsync marker grammar for AGENTS.md.
//
// AGENTS.md = [leading foreign] + managed regions + [trailing foreign].
// Anything that is not a `ccsync:` marker is FOREIGN and passed through
// byte-for-byte (this is what protects e.g. ivosw's nextjs-agent-rules block).
//
// Region:
//   <!-- ccsync:begin region=NAME v=1 ...attrs... -->\n  <inner ending in \n>  <!-- ccsync:end region=NAME -->\n
// Inside the memory region, ordered carried blocks:
//   <!-- ccsync:index file="MEMORY.md" eol=lf finalnl=1 body=md hash=sha256:.. -->\n <payload> <!-- ccsync:index-end -->\n
//   <!-- ccsync:fact  file="x.md" shape=nested eol=lf finalnl=1 body=md hash=sha256:.. -->\n <payload> <!-- ccsync:fact-end -->\n

import type { Eol, FrontmatterShape, ParsedFact, MemoryIndex } from "../types.js";
import { sha256 } from "./hash.js";
import { fromLf, toLf } from "./frontmatter.js";

export type Attrs = Record<string, string>;

export function renderAttrs(attrs: Attrs): string {
  return Object.entries(attrs)
    .map(([k, v]) => {
      const needsQuote = /[\s"']/.test(v) || v === "";
      const safe = v.replace(/"/g, '\\"');
      return needsQuote ? `${k}="${safe}"` : `${k}=${v}`;
    })
    .join(" ");
}

export function parseAttrs(s: string): Attrs {
  const out: Attrs = {};
  const re = /(\w+)=(?:"((?:[^"\\]|\\.)*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const key = m[1]!;
    const val = m[2] !== undefined ? m[2].replace(/\\"/g, '"') : m[3]!;
    out[key] = val;
  }
  return out;
}

function needsBase64(content: string): boolean {
  // Any literal ccsync marker text in the payload would break parsing.
  return content.includes("ccsync:");
}

// ---- carried blocks (index + fact share one shape) ----

interface CarriedInput {
  kind: "fact" | "index";
  filename: string;
  content: string;
  eol: Eol;
  finalNewline: boolean;
  hash: string;
  extra?: Attrs; // e.g. shape for facts
}

function renderCarried(c: CarriedInput): string {
  const b64 = needsBase64(c.content);
  const attrs: Attrs = {
    file: c.filename,
    ...(c.extra ?? {}),
    body: b64 ? "base64" : "md",
    eol: c.eol,
    finalnl: c.finalNewline ? "1" : "0",
    hash: `sha256:${c.hash}`,
  };
  const open = `<!-- ccsync:${c.kind} ${renderAttrs(attrs)} -->`;
  const end = `<!-- ccsync:${c.kind}-end -->`;
  if (b64) {
    const payload = Buffer.from(c.content, "utf8").toString("base64");
    return `${open}\n${payload}\n${end}\n`;
  }
  const lf = toLf(c.content);
  const payload = lf.endsWith("\n") ? lf : `${lf}\n`;
  return `${open}\n${payload}${end}\n`;
}

export function renderFactBlock(fact: ParsedFact): string {
  return renderCarried({
    kind: "fact",
    filename: fact.filename,
    content: fact.content,
    eol: fact.eol,
    finalNewline: fact.finalNewline,
    hash: fact.hash,
    extra: { shape: fact.shape },
  });
}

export function renderIndexBlock(index: MemoryIndex): string {
  return renderCarried({
    kind: "index",
    filename: index.filename,
    content: index.content,
    eol: index.eol,
    finalNewline: index.finalNewline,
    hash: index.hash,
  });
}

export class FidelityError extends Error {}

/**
 * Reconstruct content from a carried block's payload + attrs. The recorded
 * `hash` is diagnostic only (`edited` tells the caller whether the on-disk
 * content diverged from what ccsync last rendered) — we must NOT reject a
 * legitimately hand/Codex-edited fact body, which is the whole point of the
 * reverse direction.
 */
function reconstructCarried(extracted: string, attrs: Attrs): { content: string; eol: Eol; finalNewline: boolean; edited: boolean } {
  const eol = (attrs.eol === "crlf" ? "crlf" : "lf") as Eol;
  const finalNewline = attrs.finalnl !== "0";
  let content: string;
  if (attrs.body === "base64") {
    const b64 = extracted.replace(/\n$/, "");
    content = Buffer.from(b64, "base64").toString("utf8");
  } else {
    let payloadLf = extracted;
    if (!finalNewline && payloadLf.endsWith("\n")) payloadLf = payloadLf.slice(0, -1);
    content = fromLf(payloadLf, eol);
  }
  const want = (attrs.hash ?? "").replace(/^sha256:/, "");
  const edited = want !== "" && sha256(content) !== want;
  return { content, eol, finalNewline, edited };
}

// ---- memory region body: ordered index + fact blocks ----

export function renderMemoryRegionBody(index: MemoryIndex | null, facts: ParsedFact[]): string {
  const parts: string[] = [];
  if (index) parts.push(renderIndexBlock(index));
  for (const f of sortFacts(facts)) parts.push(renderFactBlock(f));
  return parts.join("");
}

export function sortFacts(facts: ParsedFact[]): ParsedFact[] {
  return [...facts].sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
}

export interface ParsedMemoryRegion {
  index: MemoryIndex | null;
  facts: ParsedFact[];
}

export function parseMemoryRegionBody(body: string): ParsedMemoryRegion {
  let index: MemoryIndex | null = null;
  const facts: ParsedFact[] = [];
  const openRe = /<!-- ccsync:(fact|index) ([^\n]*?) -->\n/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(body)) !== null) {
    const kind = m[1] as "fact" | "index";
    const attrs = parseAttrs(m[2]!);
    const payloadStart = openRe.lastIndex;
    const endMarker = `<!-- ccsync:${kind}-end -->`;
    const endIdx = body.indexOf(endMarker, payloadStart);
    if (endIdx === -1) throw new FidelityError(`unterminated ccsync:${kind} block for ${attrs.file ?? "?"}`);
    const extracted = body.slice(payloadStart, endIdx);
    const { content, eol, finalNewline } = reconstructCarried(extracted, attrs);
    if (kind === "index") {
      index = {
        filename: "MEMORY.md",
        content,
        eol,
        finalNewline,
        hash: sha256(content),
        secrets: [],
      };
    } else {
      facts.push({
        filename: attrs.file!,
        shape: (attrs.shape as FrontmatterShape) ?? "none",
        content,
        eol,
        finalNewline,
        parsed: {},
        hash: sha256(content),
        secrets: [],
      });
    }
    openRe.lastIndex = endIdx + endMarker.length;
  }
  return { index, facts };
}

// ---- region-level operations on a whole AGENTS.md ----

export interface RegionMatch {
  name: string;
  /** index of the begin marker. */
  start: number;
  /** index just past the end marker (+ its trailing newline if present). */
  end: number;
  beginAttrs: Attrs;
  inner: string;
}

export function findRegion(raw: string, name: string): RegionMatch | null {
  const beginRe = new RegExp(`<!-- ccsync:begin region=${name}([^\\n]*?) -->\\n`);
  const bm = beginRe.exec(raw);
  if (!bm) return null;
  const beginAttrs = parseAttrs(bm[1]!);
  const innerStart = bm.index + bm[0].length;
  const endMarker = `<!-- ccsync:end region=${name} -->`;
  const endIdx = raw.indexOf(endMarker, innerStart);
  if (endIdx === -1) return null;
  let end = endIdx + endMarker.length;
  if (raw[end] === "\n") end += 1;
  return { name, start: bm.index, end, beginAttrs, inner: raw.slice(innerStart, endIdx) };
}

export function getRegionInner(raw: string, name: string): string | null {
  return findRegion(raw, name)?.inner ?? null;
}

function renderRegion(name: string, inner: string, extraAttrs: Attrs): string {
  const body = inner.endsWith("\n") || inner === "" ? inner : `${inner}\n`;
  // `region=NAME` is emitted as a fixed prefix so findRegion's regex matches;
  // remaining attrs follow.
  const rest = renderAttrs({ v: "1", ...extraAttrs, hash: `sha256:${sha256(body)}` });
  return `<!-- ccsync:begin region=${name} ${rest} -->\n${body}<!-- ccsync:end region=${name} -->\n`;
}

/** Insert or replace a managed region, preserving all foreign content/order. */
export function upsertRegion(raw: string, name: string, inner: string, extraAttrs: Attrs = {}): string {
  const block = renderRegion(name, inner, extraAttrs);
  const existing = findRegion(raw, name);
  if (existing) {
    return raw.slice(0, existing.start) + block + raw.slice(existing.end);
  }
  // Append; ensure a blank line separates from prior foreign content.
  if (raw === "") return block;
  const sep = raw.endsWith("\n\n") ? "" : raw.endsWith("\n") ? "\n" : "\n\n";
  return raw + sep + block;
}

/** Reconstruct original text from a region's inner body + its begin-marker attrs. */
export function reconstructRegionContent(inner: string, attrs: Attrs): { content: string; eol: Eol; finalNewline: boolean } {
  const eol = (attrs.eol === "crlf" ? "crlf" : "lf") as Eol;
  const finalNewline = attrs.finalnl !== "0";
  let payloadLf = inner;
  if (!finalNewline && payloadLf.endsWith("\n")) payloadLf = payloadLf.slice(0, -1);
  return { content: fromLf(payloadLf, eol), eol, finalNewline };
}

/** Remove a managed region entirely (used by tests/cleanup). */
export function removeRegion(raw: string, name: string): string {
  const existing = findRegion(raw, name);
  if (!existing) return raw;
  return raw.slice(0, existing.start) + raw.slice(existing.end);
}
