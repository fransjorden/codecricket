// Node-side launcher: the OpenTUI dashboard runs under Bun (it bridges to a
// native Zig core via Bun's FFI), so this spawns `bun src/tui/main.tsx` with the
// real terminal attached. The rest of the CLI stays on Node.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Direction } from "../core/merge.js";
import type { SecretMode } from "../types.js";

export interface TuiOptions {
  project?: string;
  workspace?: string;
  direction?: Direction;
  secretMode?: SecretMode;
}

function findMainEntry(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url)); // src/commands or dist/commands
  const candidates = [
    path.resolve(here, "../tui/main.tsx"), // running from src (tsx)
    path.resolve(here, "../../src/tui/main.tsx"), // running from dist (built)
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function hasBun(): boolean {
  try {
    return spawnSync("bun --version", { shell: true, stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

export function runTui(opts: TuiOptions): void {
  const entry = findMainEntry();
  if (!entry) {
    console.error("Could not locate the TUI entry (src/tui/main.tsx). Is the repo intact?");
    process.exitCode = 1;
    return;
  }
  if (!hasBun()) {
    console.error("The dashboard needs Bun — the OpenTUI engine runs under it.");
    console.error("Install it once:  npm install -g bun   then run `cricket` again.");
    console.error("In the meantime, `cricket status --all` and `cricket sync …` work under Node.");
    process.exitCode = 1;
    return;
  }
  const parts = ["bun", q(entry.replace(/\\/g, "/"))];
  if (opts.project) parts.push("--project", q(opts.project));
  if (opts.workspace) parts.push("--workspace", q(opts.workspace));
  if (opts.direction) parts.push("--direction", opts.direction);
  if (opts.secretMode) parts.push("--secrets", opts.secretMode);
  const r = spawnSync(parts.join(" "), { shell: true, stdio: "inherit" });
  if (typeof r.status === "number" && r.status !== 0) process.exitCode = r.status;
}
