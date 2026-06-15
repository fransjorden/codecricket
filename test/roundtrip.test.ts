import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseFactContent } from "../src/core/frontmatter.js";
import {
  parseMemoryRegionBody,
  renderMemoryRegionBody,
  upsertRegion,
  getRegionInner,
  findRegion,
} from "../src/core/fence.js";
import { renderAgentsFromClaude } from "../src/core/memoryRender.js";
import { parseAgentsRegions } from "../src/core/codexReader.js";
import { readClaudeSide } from "../src/core/claudeReader.js";
import type { ClaudeSide } from "../src/types.js";

const toPosix = (p: string) => p.replace(/\\/g, "/");

/** Round-trip a single fact's raw content through render+parse. */
function factRoundtrip(filename: string, raw: string): string {
  const fact = parseFactContent(filename, raw);
  const body = renderMemoryRegionBody(null, [fact]);
  const parsed = parseMemoryRegionBody(body);
  expect(parsed.facts).toHaveLength(1);
  return parsed.facts[0]!.content;
}

describe("fact byte-exact round-trip (synthetic fixtures)", () => {
  it("flat frontmatter", () => {
    const raw = "---\nname: x\ntype: feedback\n---\nHello body.\n";
    expect(factRoundtrip("feedback_x.md", raw)).toBe(raw);
    expect(parseFactContent("feedback_x.md", raw).shape).toBe("flat");
  });

  it("nested frontmatter with trailing space after `metadata:`", () => {
    const raw =
      "---\nname: ref\ndescription: a desc\nmetadata: \n  node_type: memory\n  type: reference\n---\nBody with `TOKEN=abc`.\n";
    expect(factRoundtrip("reference_x.md", raw)).toBe(raw);
    expect(parseFactContent("reference_x.md", raw).shape).toBe("nested");
  });

  it("no frontmatter (clickup.md style)", () => {
    const raw = "# ClickUp\n\nlist ID: 901521651750\n";
    expect(factRoundtrip("clickup.md", raw)).toBe(raw);
    expect(parseFactContent("clickup.md", raw).shape).toBe("none");
  });

  it("no trailing newline", () => {
    const raw = "---\nname: x\n---\nNo final newline";
    expect(factRoundtrip("x.md", raw)).toBe(raw);
  });

  it("CRLF endings are restored", () => {
    const raw = "---\r\nname: x\r\n---\r\nWindows body\r\n";
    expect(factRoundtrip("x.md", raw)).toBe(raw);
  });

  it("escaped quotes in description survive", () => {
    const raw = '---\nname: x\ndescription: only [data-brand="autoblow"] block\n---\nBody.\n';
    expect(factRoundtrip("x.md", raw)).toBe(raw);
  });

  it("content containing a literal ccsync marker falls back to base64", () => {
    const raw = "---\nname: x\n---\nThis mentions <!-- ccsync:fact-end --> inline.\n";
    expect(factRoundtrip("x.md", raw)).toBe(raw);
  });

  it("body containing markdown horizontal rules and code fences", () => {
    const raw = "---\nname: x\n---\nIntro\n\n---\n\n```js\nconst a = 1;\n```\n\n[[wikilink]]\n";
    expect(factRoundtrip("x.md", raw)).toBe(raw);
  });
});

describe("instructions region round-trip", () => {
  it("preserves a CLAUDE.md with no trailing newline", () => {
    const side: ClaudeSide = {
      projectDir: "/p",
      instructionsFilename: "CLAUDE.md",
      instructions: "# Title\n\nNo final newline here",
      instructionsEol: "lf",
      instructionsFinalNewline: false,
      memoryDir: null,
      index: null,
      facts: [],
    };
    const agents = renderAgentsFromClaude("", side);
    const back = parseAgentsRegions(agents);
    expect(back.instructions).toBe(side.instructions);
  });
});

describe("foreign-block preservation", () => {
  it("upserting regions leaves a foreign machine block byte-identical", () => {
    const foreign =
      "<!-- BEGIN:nextjs-agent-rules -->\n# This is NOT the Next.js you know\nRead the guide.\n<!-- END:nextjs-agent-rules -->\n";
    const out = upsertRegion(foreign, "instructions", "# Project\n", { eol: "lf", finalnl: "1" });
    expect(out).toContain(foreign.trimEnd());
    // The foreign block survives verbatim.
    expect(out.includes("<!-- BEGIN:nextjs-agent-rules -->\n# This is NOT the Next.js you know\nRead the guide.\n<!-- END:nextjs-agent-rules -->")).toBe(true);
    // And the managed region is now present and reconstructs.
    expect(getRegionInner(out, "instructions")).toBe("# Project\n");
  });

  it("idempotent upsert: second render equals first", () => {
    const side: ClaudeSide = {
      projectDir: "/p",
      instructionsFilename: "CLAUDE.md",
      instructions: "# A\nbody\n",
      instructionsEol: "lf",
      instructionsFinalNewline: true,
      memoryDir: null,
      index: null,
      facts: [],
    };
    const once = renderAgentsFromClaude("", side);
    const twice = renderAgentsFromClaude(once, side);
    expect(twice).toBe(once);
  });
});

// ---- Real-case verification (guarded; skipped if the machine differs) ----

const HOME = toPosix(os.homedir());
const WORKSPACE = toPosix(path.resolve(process.cwd(), ".."));
const MEETING_MEM = `${HOME}/.claude/projects/C--Users-Frans-Jorden-Documents-claude-projects-meeting-tool/memory`;
const TYPE_MACHINE = `${WORKSPACE}/type-machine`;
const IVOSW_AGENTS = `${WORKSPACE}/ivosw/AGENTS.md`;

const realMemory = existsSync(MEETING_MEM);

describe.runIf(realMemory)("REAL: type-machine/meeting-tool memory round-trip", () => {
  it("every memory file + CLAUDE.md returns byte-for-byte", () => {
    const side = readClaudeSide(TYPE_MACHINE, MEETING_MEM);
    const agents = renderAgentsFromClaude("", side);
    const back = parseAgentsRegions(agents);

    // instructions
    if (side.instructions !== null) {
      expect(back.instructions).toBe(side.instructions);
    }
    // index
    if (side.index) {
      expect(back.index?.content).toBe(side.index.content);
    }
    // every fact, by filename
    const backByName = new Map(back.facts.map((f) => [f.filename, f.content]));
    for (const f of side.facts) {
      expect(backByName.get(f.filename), `fact ${f.filename}`).toBe(f.content);
    }
    expect(back.facts.length).toBe(side.facts.length);
  });

  it("the Slack webhook and ClickUp token survive verbatim", () => {
    const side = readClaudeSide(TYPE_MACHINE, MEETING_MEM);
    const agents = renderAgentsFromClaude("", side);
    // Reconstruct and confirm the exact secret strings reappear after a round-trip.
    const back = parseAgentsRegions(agents);
    const all = [back.index?.content ?? "", ...back.facts.map((f) => f.content)].join("\n");
    expect(all).toContain("https://hooks.slack.com/services/");
    expect(all).toMatch(/pk_\d+_[A-Z0-9]+/);
  });
});

describe.runIf(existsSync(IVOSW_AGENTS))("REAL: ivosw foreign block preserved", () => {
  it("nextjs-agent-rules block is byte-identical after inserting managed regions", () => {
    const raw = readFileSync(IVOSW_AGENTS, "utf8");
    const begin = raw.indexOf("<!-- BEGIN:nextjs-agent-rules -->");
    const end = raw.indexOf("<!-- END:nextjs-agent-rules -->");
    expect(begin).toBeGreaterThanOrEqual(0);
    const foreignBlock = raw.slice(begin, end + "<!-- END:nextjs-agent-rules -->".length);

    const out = upsertRegion(raw, "instructions", "# IVOSW project\n", { eol: "lf", finalnl: "1" });
    expect(out).toContain(foreignBlock);
    // Region inserted, foreign intact, and no ccsync marker landed inside the foreign block.
    expect(findRegion(out, "instructions")).not.toBeNull();
  });
});
