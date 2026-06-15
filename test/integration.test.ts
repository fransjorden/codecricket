import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSync } from "../src/commands/sync.js";
import { saveProjectsMap } from "../src/core/config.js";
import { findRegion, parseMemoryRegionBody, renderMemoryRegionBody, upsertRegion } from "../src/core/fence.js";
import { parseFactContent } from "../src/core/frontmatter.js";
import { setVerbosity } from "../src/util/logger.js";

const toPosix = (p: string) => p.replace(/\\/g, "/");
const read = (p: string) => readFileSync(p, "utf8");

let tmp: string;
let home: string;
let ws: string;
let proj: string;
let mem: string;

// Fake, non-Slack host (real hooks.slack.com URLs trip GitHub push protection).
// Still detected by ccsync via the `SLACK_WEBHOOK_URL=` assignment in the fact body.
const SECRET_WEBHOOK = "https://hooks.example.test/services/T00000000/B00000000/EXAMPLE0000000000";
const SECRET_TOKEN = "pk_000000000_EXAMPLETOKEN0000000000000000";

// Real fragile fact bodies, including the trailing space after `metadata:`.
const FACT_FLAT = "---\nname: flat\ntype: feedback\n---\nFlat body.\n";
const FACT_NESTED = `---\nname: ref\ndescription: webhook ref\nmetadata: \n  node_type: memory\n  type: reference\n---\nUse \`SLACK_WEBHOOK_URL=${SECRET_WEBHOOK}\` here.\n`;
const FACT_NONE = "# notes\n\nno frontmatter here\n";
const MEMORY_INDEX = `# Proj memory\n\n- ClickUp token: \`${SECRET_TOKEN}\`\n`;
const CLAUDE_MD = "# Proj\n\nProject guidance.\n";

beforeAll(() => {
  setVerbosity({ quiet: true });
  tmp = mkdtempSync(path.join(os.tmpdir(), "ccsync-it-"));
  home = toPosix(path.join(tmp, "home"));
  ws = toPosix(path.join(tmp, "ws"));
  proj = toPosix(path.join(ws, "proj"));
  mem = toPosix(path.join(tmp, "mem"));
  for (const d of [home, ws, proj, mem]) mkdirSync(d, { recursive: true });
  process.env.CCSYNC_HOME = home;

  writeFileSync(`${proj}/CLAUDE.md`, CLAUDE_MD);
  writeFileSync(`${mem}/MEMORY.md`, MEMORY_INDEX);
  writeFileSync(`${mem}/feedback_flat.md`, FACT_FLAT);
  writeFileSync(`${mem}/reference_secret.md`, FACT_NESTED);
  writeFileSync(`${mem}/notes.md`, FACT_NONE);

  saveProjectsMap({ version: 1, projects: { proj: { projectDir: proj, memoryDir: mem } } });

  execFileSync("git", ["init", "-q"], { cwd: proj });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: proj });
  execFileSync("git", ["config", "user.name", "t"], { cwd: proj });
});

afterAll(() => {
  delete process.env.CCSYNC_HOME;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("integration: full bidirectional sync", () => {
  it("forward (claude→codex) scaffolds AGENTS.md, renders secrets, and gitignores it", () => {
    const res = runSync({ project: proj, workspace: ws, direction: "claude-to-codex", apply: true, secretMode: "gitignore-guard" });
    expect(res.blocked).toBe(0);

    const agents = read(`${proj}/AGENTS.md`);
    expect(agents).toContain("<!-- ccsync:begin region=instructions");
    expect(agents).toContain("<!-- ccsync:begin region=memory");
    // Secrets render verbatim so Codex can use them.
    expect(agents).toContain(SECRET_WEBHOOK);
    expect(agents).toContain(SECRET_TOKEN);
    // ...but AGENTS.md is kept out of git.
    expect(read(`${proj}/.gitignore`)).toContain("AGENTS.md");
  });

  it("reverse (codex→claude) propagates an edited fact and a new fact, byte-exact", () => {
    // Simulate a month in Codex: edit one fact body, add a brand-new fact.
    let agents = read(`${proj}/AGENTS.md`);
    agents = agents.replace("Flat body.", "Flat body EDITED in Codex.");
    const region = findRegion(agents, "memory")!;
    const parsed = parseMemoryRegionBody(region.inner);
    const newFact = parseFactContent("project_new.md", "---\nname: new\ntype: project\n---\nBuilt in Codex.\n");
    const body = renderMemoryRegionBody(parsed.index, [...parsed.facts, newFact]);
    agents = upsertRegion(agents, "memory", body);
    writeFileSync(`${proj}/AGENTS.md`, agents);

    const res = runSync({ project: proj, workspace: ws, direction: "codex-to-claude", apply: true });
    expect(res.blocked).toBe(0);

    // Edited fact flowed back to the Claude memory file, exactly.
    expect(read(`${mem}/feedback_flat.md`)).toBe("---\nname: flat\ntype: feedback\n---\nFlat body EDITED in Codex.\n");
    // New Codex fact materialized as a Claude memory file, exactly.
    expect(read(`${mem}/project_new.md`)).toBe("---\nname: new\ntype: project\n---\nBuilt in Codex.\n");
    // Untouched facts unchanged (trailing-space frontmatter preserved).
    expect(read(`${mem}/reference_secret.md`)).toBe(FACT_NESTED);
    expect(read(`${mem}/notes.md`)).toBe(FACT_NONE);
  });

  it("is idempotent: a second 'both' sync writes nothing", () => {
    const agentsBefore = read(`${proj}/AGENTS.md`);
    const res = runSync({ project: proj, workspace: ws, direction: "both", apply: true });
    expect(res.changed).toBe(0);
    expect(read(`${proj}/AGENTS.md`)).toBe(agentsBefore);
  });

  it("blocks writing secrets into a git-tracked AGENTS.md", () => {
    // Force-track AGENTS.md (it's gitignored), then change a secret-bearing fact on Claude.
    execFileSync("git", ["add", "-f", "AGENTS.md"], { cwd: proj });
    execFileSync("git", ["commit", "-q", "-m", "track agents"], { cwd: proj });
    writeFileSync(`${mem}/reference_secret.md`, FACT_NESTED.replace("here.", "here, updated."));

    const agentsBefore = read(`${proj}/AGENTS.md`);
    const res = runSync({ project: proj, workspace: ws, direction: "claude-to-codex", apply: true, secretMode: "gitignore-guard" });
    expect(res.blocked).toBeGreaterThanOrEqual(1);
    // The tracked file was NOT modified.
    expect(read(`${proj}/AGENTS.md`)).toBe(agentsBefore);
  });

  it("--secrets allow-tracked lets the tracked write through", () => {
    const res = runSync({ project: proj, workspace: ws, direction: "claude-to-codex", apply: true, secretMode: "allow-tracked" });
    expect(res.blocked).toBe(0);
    expect(read(`${proj}/AGENTS.md`)).toContain("here, updated.");
  });
});
