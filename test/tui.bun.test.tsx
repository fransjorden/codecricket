/** @jsxImportSource @opentui/react */
// Runs under Bun (`bun test test/tui.bun.test.tsx`) — OpenTUI needs Bun's FFI.
// Vitest ignores this file (its include is *.test.ts, not .tsx).
import { test, expect } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { App } from "../src/tui/app.js";
import { saveProjectsMap } from "../src/core/config.js";

test("dashboard renders header, table, and a project row", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ccsync-bun-"));
  const ws = path.join(tmp, "ws").replace(/\\/g, "/");
  const mem = path.join(tmp, "mem").replace(/\\/g, "/");
  for (const d of [`${ws}/alpha`, mem]) mkdirSync(d, { recursive: true });
  process.env.CCSYNC_HOME = path.join(tmp, "home");
  writeFileSync(`${ws}/alpha/CLAUDE.md`, "# Alpha\n\nguidance\n");
  writeFileSync(`${mem}/MEMORY.md`, "# mem\n- token pk_000000000_EXAMPLETOKEN0000000000000000\n");
  saveProjectsMap({ version: 1, workspace: ws, projects: { alpha: { projectDir: `${ws}/alpha`, memoryDir: mem } } });

  const t = await testRender(<App opts={{ workspace: ws, direction: "claude-to-codex" }} />, { width: 92, height: 24 });

  // Real-time poll until the scan has settled (the summary line renders only when
  // not scanning). Decoupled from waitForFrame's render-pass counting, which is
  // flaky against the scan animation + React batching.
  let frame = "";
  for (let i = 0; i < 200; i++) {
    await t.flush();
    frame = t.captureCharFrame();
    if (frame.includes("alpha") && frame.includes("with changes")) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(frame).toContain("cc-codex-sync");
  expect(frame).toContain("Pushing Claude → Codex");
  expect(frame).toContain("PROJECT");
  expect(frame).toContain("alpha");
  expect(frame).toContain("● changes");
  expect(frame).toContain("with changes");
});
