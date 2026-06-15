/** @jsxImportSource @opentui/react */
import { readdirSync } from "node:fs";
import nodePath from "node:path";
import { useEffect, useMemo, useState } from "react";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { createTwoFilesPatch } from "diff";
import {
  executeProject,
  planProject,
  strandingTargetSet,
  type ProjectPlan,
  type SyncOptions,
} from "../commands/sync.js";
import {
  listProjectFolders,
  recoverProjectName,
  resolveProject,
  strandedMemoryDirs,
  suggestStrandingMappings,
  type ResolvedProject,
} from "../core/resolver.js";
import { loadState, saveState } from "../core/state.js";
import { defaultSecretPolicy, loadProjectsMap, resolveWorkspace, saveProjectsMap } from "../core/config.js";
import { homeDir } from "../core/paths.js";
import { readText } from "../core/fsx.js";
import { diffLines, type DiffLine } from "../util/diffPreview.js";
import { HeaderCricket, HopTrack } from "./cricket.js";
import type { Direction } from "../core/merge.js";
import type { SecretMode } from "../types.js";

export interface TuiOptions {
  project?: string;
  workspace?: string;
  direction?: Direction | string;
  secretMode?: SecretMode | string;
}

const PAL = {
  cyan: "#7dd3fc",
  cyanDim: "#38bdf8",
  green: "#4ade80",
  red: "#f87171",
  yellow: "#fbbf24",
  magenta: "#c084fc",
  gray: "#8b8b8b",
  dim: "#6b7280",
  white: "#e5e7eb",
  border: "#3b3b3b",
  cursorBg: "#1e3a5f",
  headerBg: "#111827",
};

type View = "list" | "detail" | "confirm" | "applying" | "help" | "map";
type ApplyState = "pending" | "writing" | "done" | "skipped";

interface MapCandidate {
  memoryDir: string;
  label: string;
  detail: string;
  suggested: boolean;
}

/** Stranded memory dirs the user could attach to a project, suggestion-first. */
function buildMapCandidates(projectName: string, workspace: string): MapCandidate[] {
  const map = loadProjectsMap();
  const home = homeDir();
  const suggestedDir = suggestStrandingMappings(workspace, map, home).find((s) => s.suggestedProject === projectName)?.memoryDir;
  const cands = strandedMemoryDirs(workspace, map, home).map((dir) => {
    const key = nodePath.basename(nodePath.dirname(dir));
    const label = recoverProjectName(dir, workspace) ?? key.match(/claude-projects-(.+)$/)?.[1] ?? key;
    let files = 0;
    try {
      files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")).length;
    } catch {
      /* ignore */
    }
    const mem = readText(`${dir}/MEMORY.md`);
    const title = mem ? (mem.split("\n")[0] ?? "").replace(/^#+\s*/, "").trim().slice(0, 36) : "";
    return { memoryDir: dir, label, detail: `${files} file(s)${title ? " · " + title : ""}`, suggested: dir === suggestedDir };
  });
  cands.sort((a, b) => (a.suggested === b.suggested ? a.label.localeCompare(b.label) : a.suggested ? -1 : 1));
  return cands;
}

const DIRECTIONS: Direction[] = ["claude-to-codex", "codex-to-claude", "both"];
const SECRET_MODES: SecretMode[] = ["gitignore-guard", "allow-tracked", "redact", "allow"];
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const W = { name: 22, state: 12, push: 6, pull: 6, sec: 5, mem: 10 };

interface Summary {
  changed: number;
  push: number;
  pull: number;
  conflicts: number;
  pending: number;
  secrets: number;
  blocked: boolean;
  stranded: boolean;
}
interface Item {
  project: ResolvedProject;
  plan: ProjectPlan;
  sum: Summary;
  lastSyncAt: string;
}

function pad(s: string, w: number): string {
  if (s.length > w) return s.slice(0, Math.max(0, w - 1)) + "…";
  return s.padEnd(w);
}
function relTime(iso: string): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function summarize(pp: ProjectPlan): Summary {
  const changed = pp.plans.filter((p) => p.decision !== "noop");
  return {
    changed: changed.length,
    push: changed.filter((p) => p.decision === "to-codex").length,
    pull: changed.filter((p) => p.decision === "to-claude").length,
    conflicts: changed.filter((p) => p.conflict).length,
    pending: changed.filter((p) => p.decision === "delete-pending").length,
    secrets: pp.secretFindings.length,
    blocked: pp.blocked,
    stranded: pp.noMemoryResolution,
  };
}
function hasWork(pp: ProjectPlan): boolean {
  return pp.plans.some((p) => p.decision !== "noop") || (pp.agentsAfter !== null && pp.agentsAfter !== pp.agentsBefore);
}
function includable(it: Item): boolean {
  return hasWork(it.plan) && !it.sum.blocked && !it.sum.stranded;
}
function directionLabel(d: Direction): string {
  return d === "claude-to-codex" ? "Pushing Claude → Codex" : d === "codex-to-claude" ? "Pulling Codex → Claude" : "Two-way sync";
}
function hopDir(d: Direction): "push" | "pull" | "both" {
  return d === "claude-to-codex" ? "push" : d === "codex-to-claude" ? "pull" : "both";
}
function secretLabel(m: SecretMode): string {
  return m === "gitignore-guard" ? "secrets kept out of git"
    : m === "allow-tracked" ? "secrets allowed in tracked files"
    : m === "allow" ? "secrets written as-is"
    : m === "redact" ? "secrets masked in AGENTS.md"
    : "secrets in a gitignored sidecar";
}
function stateOf(it: Item): { text: string; color: string } {
  const s = it.sum;
  if (s.blocked) return { text: "✖ blocked", color: PAL.red };
  if (s.stranded) return { text: "? needs map", color: PAL.yellow };
  if (s.conflicts) return { text: "⚠ conflict", color: PAL.yellow };
  if (s.changed === 0) return { text: "✓ in sync", color: PAL.green };
  return { text: "● changes", color: PAL.cyan };
}
function unifiedPatch(pp: ProjectPlan): string {
  const blocks: string[] = [];
  if (pp.agentsAfter !== null && pp.agentsAfter !== pp.agentsBefore) {
    blocks.push(createTwoFilesPatch("AGENTS.md", "AGENTS.md", pp.agentsBefore, pp.agentsAfter, "", "", { context: 3 }));
  }
  for (const w of pp.claudeWrites) {
    blocks.push(createTwoFilesPatch(w.label, w.label, readText(w.path) ?? "", w.content, "", "", { context: 3 }));
  }
  return blocks.join("\n");
}
function detailDiffLines(pp: ProjectPlan): DiffLine[] {
  const lines: DiffLine[] = [];
  if (pp.agentsAfter !== null && pp.agentsAfter !== pp.agentsBefore) {
    lines.push({ kind: "meta", text: "AGENTS.md" });
    lines.push(...diffLines("AGENTS.md", pp.agentsBefore, pp.agentsAfter));
  }
  for (const w of pp.claudeWrites) {
    lines.push({ kind: "meta", text: w.label });
    lines.push(...diffLines(w.label, readText(w.path) ?? "", w.content));
  }
  for (const d of pp.claudeDeletes) lines.push({ kind: "del", text: `would delete ${d}` });
  if (lines.length === 0) lines.push({ kind: "meta", text: "(no changes)" });
  return lines;
}
function diffLineColor(k: DiffLine["kind"]): string {
  return k === "add" ? PAL.green : k === "del" ? PAL.red : k === "hunk" ? PAL.cyanDim : k === "meta" ? PAL.yellow : PAL.dim;
}

export function App({ opts }: { opts: TuiOptions }) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const workspace = useMemo(() => resolveWorkspace(opts.workspace), [opts.workspace]);
  const projects = useMemo<ResolvedProject[]>(
    () => (opts.project ? [resolveProject(opts.project, workspace)] : listProjectFolders(workspace)),
    [opts.project, workspace],
  );

  const [direction, setDirection] = useState<Direction>((opts.direction as Direction) ?? "claude-to-codex");
  const [secretMode, setSecretMode] = useState<SecretMode>((opts.secretMode as SecretMode) ?? "gitignore-guard");
  const [refresh, setRefresh] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [view, setView] = useState<View>("list");
  const [scroll, setScroll] = useState(0);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [scanning, setScanning] = useState(true);
  const [scanned, setScanned] = useState(0);
  const [applyProg, setApplyProg] = useState<Record<string, ApplyState>>({});
  const [applyResult, setApplyResult] = useState("");
  const [tick, setTick] = useState(0);
  const [mapCandidates, setMapCandidates] = useState<MapCandidate[]>([]);
  const [mapCursor, setMapCursor] = useState(0);

  const spinning = scanning || view === "applying";
  useEffect(() => {
    if (!spinning) return;
    const t = setInterval(() => setTick((x) => x + 1), 80);
    return () => clearInterval(t);
  }, [spinning]);
  const spin = SPINNER[tick % SPINNER.length]!;

  const listWindow = Math.max(3, height - 12);
  const detailRows = Math.max(6, height - 10);

  // Animated scan: plan project-by-project, revealing rows as they land.
  useEffect(() => {
    let cancelled = false;
    setScanning(true);
    setItems([]);
    setScanned(0);
    (async () => {
      const state = loadState();
      const policy = defaultSecretPolicy({ mode: secretMode });
      const targets = strandingTargetSet(workspace);
      const acc: Item[] = [];
      for (const project of projects) {
        if (cancelled) return;
        const plan = planProject(project, { direction, secretMode } as SyncOptions, state, policy, targets);
        acc.push({ project, plan, sum: summarize(plan), lastSyncAt: state.projects[plan.projectDir]?.lastSyncAt ?? "" });
        setItems([...acc]);
        setScanned(acc.length);
        await new Promise((r) => setTimeout(r, projects.length > 1 ? 24 : 0));
      }
      if (cancelled) return;
      setIncluded(new Set(acc.filter(includable).map((it) => it.project.name)));
      setCursor((c) => Math.min(c, Math.max(0, acc.length - 1)));
      setScanning(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projects, direction, secretMode, refresh, workspace]);

  const selected = items[cursor];
  const detailLines = useMemo<DiffLine[]>(() => (selected ? detailDiffLines(selected.plan) : []), [selected]);
  const patch = useMemo(() => (selected ? unifiedPatch(selected.plan) : ""), [selected]);

  const apply = useMemo(() => {
    const inc = items.filter((it) => included.has(it.project.name) && includable(it));
    const blocked = items.filter((it) => it.sum.blocked).length;
    const withSecrets = inc.filter((it) => it.sum.secrets > 0).length;
    const claudeWrites = inc.reduce((n, it) => n + it.plan.claudeWrites.length, 0);
    const agentsWrites = inc.filter((it) => it.plan.agentsAfter !== null && it.plan.agentsAfter !== it.plan.agentsBefore).length;
    return { inc, blocked, withSecrets, claudeWrites, agentsWrites };
  }, [items, included]);

  function quit() {
    renderer.destroy();
    process.exit(0);
  }

  function openMap() {
    if (!selected) return;
    const cands = buildMapCandidates(selected.project.name, workspace);
    if (cands.length === 0) {
      setMessage("No stranded memory dirs to map.");
      return;
    }
    setMapCandidates(cands);
    setMapCursor(0);
    setView("map");
  }

  function applyMapping() {
    const c = mapCandidates[mapCursor];
    if (!c || !selected) {
      setView("list");
      return;
    }
    const map = loadProjectsMap();
    map.projects[selected.project.name] = {
      projectDir: selected.project.projectDir,
      memoryDir: c.memoryDir,
      note: `mapped via TUI from stranded "${c.label}"`,
    };
    saveProjectsMap(map);
    setMessage(`Mapped ${selected.project.name} → "${c.label}" memory (${c.detail}).`);
    setView("list");
    setRefresh((r) => r + 1);
  }

  async function runApply() {
    const order = apply.inc;
    if (order.length === 0) return;
    setView("applying");
    setApplyResult("");
    const prog: Record<string, ApplyState> = {};
    for (const it of order) prog[it.project.name] = "pending";
    setApplyProg({ ...prog });
    const state = loadState();
    const policy = defaultSecretPolicy({ mode: secretMode });
    const targets = strandingTargetSet(workspace);
    const now = new Date().toISOString();
    let applied = 0;
    for (const it of order) {
      prog[it.project.name] = "writing";
      setApplyProg({ ...prog });
      await new Promise((r) => setTimeout(r, 90));
      const pp = planProject(it.project, { direction, secretMode } as SyncOptions, state, policy, targets);
      if (pp.blocked || !hasWork(pp)) {
        prog[it.project.name] = "skipped";
      } else {
        executeProject(pp, state);
        const ps = state.projects[pp.projectDir];
        if (ps) ps.lastSyncAt = now;
        prog[it.project.name] = "done";
        applied++;
      }
      setApplyProg({ ...prog });
      await new Promise((r) => setTimeout(r, 55));
    }
    saveState(state);
    setApplyResult(`Applied ${applied} project(s). Press any key to return.`);
  }

  useKeyboard((key) => {
    const n = key.name;
    const isQ = n === "q" || (key.ctrl && n === "c");

    if (view === "applying") {
      if (applyResult) {
        setView("list");
        setRefresh((r) => r + 1);
      }
      return;
    }
    if (view === "help") {
      setView("list");
      return;
    }
    if (view === "confirm") {
      if (n === "return" || n === "y") void runApply();
      else if (n === "escape" || n === "n") setView("list");
      return;
    }
    if (view === "map") {
      if (isQ) return quit();
      if (n === "return") return applyMapping();
      if (n === "escape" || n === "left") return setView("list");
      if (n === "up" || n === "k") setMapCursor((c) => Math.max(0, c - 1));
      else if (n === "down" || n === "j") setMapCursor((c) => Math.min(Math.max(0, mapCandidates.length - 1), c + 1));
      return;
    }
    if (isQ) return quit();
    if (n === "?" || key.sequence === "?") return setView("help");

    if (view === "detail") {
      const max = Math.max(0, detailLines.length - detailRows);
      if (n === "up" || n === "k") setScroll((s) => Math.max(0, s - 1));
      else if (n === "down" || n === "j") setScroll((s) => Math.min(max, s + 1));
      else if (n === "pagedown" || n === "f" || n === "space") setScroll((s) => Math.min(max, s + detailRows));
      else if (n === "pageup" || n === "b") setScroll((s) => Math.max(0, s - detailRows));
      else if (n === "left" || n === "escape") setView("list");
      else if (n === "a") setView("confirm");
      return;
    }

    if (scanning) return;
    if (n === "up" || n === "k") setCursor((c) => Math.max(0, c - 1));
    else if (n === "down" || n === "j") setCursor((c) => Math.min(items.length - 1, c + 1));
    else if (n === "return" || n === "right") {
      if (selected && hasWork(selected.plan)) {
        setScroll(0);
        setView("detail");
      }
    } else if (n === "space") {
      if (selected && includable(selected)) {
        setIncluded((s) => {
          const next = new Set(s);
          next.has(selected.project.name) ? next.delete(selected.project.name) : next.add(selected.project.name);
          return next;
        });
      }
    } else if (n === "a") {
      if (apply.inc.length > 0) setView("confirm");
      else setMessage("Nothing to apply — no projects are included.");
    } else if (n === "d") {
      setDirection((d) => DIRECTIONS[(DIRECTIONS.indexOf(d) + 1) % DIRECTIONS.length]!);
      setMessage("");
    } else if (n === "s") {
      setSecretMode((m) => SECRET_MODES[(SECRET_MODES.indexOf(m) + 1) % SECRET_MODES.length]!);
      setMessage("");
    } else if (n === "m") {
      openMap();
    } else if (n === "r") {
      setRefresh((r) => r + 1);
      setMessage("");
    }
  });

  const Header = (
    <box flexDirection="column">
      <box flexDirection="row" backgroundColor={PAL.headerBg} paddingLeft={1} paddingRight={1}>
        <HeaderCricket fg={PAL.green} />
        <text fg={PAL.cyan} attributes={1}>codecricket</text>
        <text fg={PAL.gray}>{"  ·  "}</text>
        <text fg={PAL.white}>{directionLabel(direction)}</text>
        <text fg={PAL.gray}>{"  ·  " + secretLabel(secretMode)}</text>
      </box>
    </box>
  );

  if (view === "help") {
    return (
      <box flexDirection="column" padding={1}>
        {Header}
        <text fg={PAL.white} attributes={1}>{"\nWhat this does"}</text>
        <text fg={PAL.gray}>  Mirrors each project's CLAUDE.md + memory into Codex's AGENTS.md (and back).</text>
        <text fg={PAL.white} attributes={1}>{"\nThe table"}</text>
        <text fg={PAL.gray}>  State    ✓ in sync · ● changes · ⚠ conflict · ✖ blocked · ? needs map</text>
        <text fg={PAL.gray}>  Push / Pull   items copied Claude→Codex / Codex→Claude</text>
        <text fg={PAL.gray}>  Sec      live tokens/webhooks found    Memory  where memory lives    Synced  last write</text>
        <text fg={PAL.white} attributes={1}>{"\nActions"}</text>
        <text fg={PAL.gray}>  ↑↓ Move   Enter View diff   Space Include/exclude</text>
        <text fg={PAL.gray}>  A Apply (asks first)   D Direction   S Secrets   R Re-scan   Q Quit</text>
        <text fg={PAL.gray}>  M Map memory — attach a renamed project's stranded memory dir (fixes "? needs map")</text>
        <text fg={PAL.white} attributes={1}>{"\nDirection (D)"}</text>
        <text fg={PAL.gray}>  Claude→Codex push in · Codex→Claude pull back · Two-way reconcile (newest wins)</text>
        <text fg={PAL.cyan}>{"\nPress any key to go back."}</text>
      </box>
    );
  }

  if (view === "confirm") {
    return (
      <box flexDirection="column" padding={1}>
        {Header}
        <box border borderColor={PAL.yellow} title="Apply changes?" flexDirection="column" padding={1} marginTop={1}>
          <box marginBottom={1}>
            <HopTrack direction={hopDir(direction)} width={Math.min(34, Math.max(16, width - 30))} />
          </box>
          <text><span fg={PAL.gray}>Direction   </span>{directionLabel(direction)}</text>
          <text><span fg={PAL.gray}>Included    </span>{`${apply.inc.length} project(s)`}</text>
          <text><span fg={PAL.gray}>Will write  </span>{`${apply.agentsWrites} AGENTS.md + ${apply.claudeWrites} Claude file(s) `}<span fg={PAL.gray}>(each backed up to .bak)</span></text>
          {apply.withSecrets > 0 ? <text><span fg={PAL.gray}>Secrets     </span><span fg={PAL.yellow}>{`${apply.withSecrets} with secrets — ${secretLabel(secretMode)}`}</span></text> : <text> </text>}
          {apply.blocked > 0 ? <text><span fg={PAL.gray}>Skipped     </span><span fg={PAL.red}>{`${apply.blocked} blocked (git-tracked AGENTS.md)`}</span></text> : <text> </text>}
          <text>{" "}</text>
          <text><span fg={PAL.cyan} attributes={1}>Enter</span> / <span fg={PAL.cyan} attributes={1}>Y</span>  Apply      <span fg={PAL.cyan} attributes={1}>Esc</span> / <span fg={PAL.cyan} attributes={1}>N</span>  Cancel</text>
        </box>
      </box>
    );
  }

  if (view === "map") {
    return (
      <box flexDirection="column" padding={1}>
        {Header}
        <box border borderColor={PAL.cyan} title={`Map memory → ${selected?.project.name ?? ""}`} flexDirection="column" padding={1} marginTop={1}>
          <text fg={PAL.gray}>A renamed project leaves its memory behind. Pick a stranded dir to attach:</text>
          <text> </text>
          {mapCandidates.map((c, i) => {
            const isCur = i === mapCursor;
            const line = `${pad(c.label, 22)} ${c.detail}${c.suggested ? "  ✓ suggested" : ""}`;
            const max = Math.max(30, width - 12);
            const shown = (isCur ? "❯ " : "  ") + (line.length > max ? line.slice(0, max - 1) + "…" : line);
            return (
              <text key={c.memoryDir} bg={isCur ? PAL.cursorBg : undefined} fg={isCur ? PAL.white : c.suggested ? PAL.green : PAL.gray} attributes={isCur ? 1 : 0}>
                {shown}
              </text>
            );
          })}
          {mapCandidates.length === 0 ? <text fg={PAL.gray}>No stranded memory dirs found.</text> : null}
          <text> </text>
          <text><span fg={PAL.cyan} attributes={1}>Enter</span> Attach this memory      <span fg={PAL.cyan} attributes={1}>Esc</span> Cancel</text>
        </box>
      </box>
    );
  }

  if (view === "applying") {
    return (
      <box flexDirection="column" padding={1}>
        {Header}
        <text fg={PAL.white} attributes={1}>{`\nApplying · ${directionLabel(direction)}`}</text>
        <box marginTop={1}>
          <HopTrack direction={hopDir(direction)} width={Math.min(40, Math.max(18, width - 26))} />
        </box>
        <box flexDirection="column" marginTop={1}>
          {apply.inc.map((it) => {
            const st = applyProg[it.project.name] ?? "pending";
            const icon = st === "done" ? "✓" : st === "skipped" ? "✖" : st === "writing" ? spin : "·";
            const color = st === "done" ? PAL.green : st === "skipped" ? PAL.red : st === "writing" ? PAL.cyan : PAL.dim;
            const label = st === "writing" ? "writing…" : st === "done" ? "done" : st === "skipped" ? "skipped (blocked)" : "queued";
            return (
              <text key={it.project.name}>
                {"  "}<span fg={color}>{icon}</span>{" "}{pad(it.project.name, W.name)}<span fg={PAL.gray}>{label}</span>
              </text>
            );
          })}
        </box>
        <text marginTop={1} fg={applyResult ? PAL.green : PAL.cyan}>{applyResult || `${spin} working…`}</text>
      </box>
    );
  }

  if (view === "detail" && selected) {
    const st = stateOf(selected);
    const visible = detailLines.slice(scroll, scroll + detailRows);
    const maxCol = Math.max(20, width - 8); // truncate so long lines never wrap/overlap
    void patch;
    return (
      <box flexDirection="column" padding={1}>
        {Header}
        <text marginTop={1}>
          <span attributes={1}>{selected.project.name}</span>
          <span fg={PAL.gray}>{"  ·  "}</span>
          <span fg={st.color}>{st.text}</span>
          <span fg={PAL.gray}>{`   (${selected.plan.memorySource} memory)`}</span>
        </text>
        {selected.plan.secretFindings.map((f, i) => (
          <text key={i} fg={selected.sum.blocked ? PAL.red : PAL.yellow}>  ⚠ {`${f.file}:${f.line}  ${f.rule}  ${f.preview}`}</text>
        ))}
        <box flexDirection="column" marginTop={1} border borderColor={PAL.border}>
          {visible.map((line, i) => {
            const t = (line.text || " ").replace(/\t/g, "  ");
            return (
              <text key={scroll + i} fg={diffLineColor(line.kind)}>{t.length > maxCol ? t.slice(0, maxCol - 1) + "…" : t}</text>
            );
          })}
        </box>
        <text fg={PAL.gray}>{`showing ${Math.min(scroll + 1, detailLines.length)}–${Math.min(scroll + detailRows, detailLines.length)} of ${detailLines.length}    `}<span fg={PAL.cyan}>↑↓</span> scroll  <span fg={PAL.cyan}>←</span> back  <span fg={PAL.cyan}>A</span> apply  <span fg={PAL.cyan}>Q</span> quit</text>
      </box>
    );
  }

  // ----- overview table -----
  const inSync = items.filter((it) => !scanning && it.sum.changed === 0 && !it.sum.blocked && !it.sum.stranded).length;
  const withChanges = items.filter((it) => hasWork(it.plan)).length;
  const withSecrets = items.filter((it) => it.sum.secrets > 0).length;
  const offset = Math.max(0, Math.min(cursor - Math.floor(listWindow / 2), Math.max(0, items.length - listWindow)));
  const windowItems = items.slice(offset, offset + listWindow);

  return (
    <box flexDirection="column" padding={1}>
      {Header}
      <box flexDirection="row" marginTop={1}>
        <text fg={PAL.gray} attributes={1}>{"  " + pad("PROJECT", W.name) + pad("STATE", W.state) + pad("PUSH", W.push) + pad("PULL", W.pull) + pad("SEC", W.sec) + pad("MEMORY", W.mem) + "SYNCED"}</text>
      </box>
      {offset > 0 ? <text fg={PAL.gray}>{`  ↑ ${offset} more`}</text> : null}
      {windowItems.map((it, li) => {
        const i = offset + li;
        const isCur = i === cursor;
        const inc = includable(it);
        const isInc = included.has(it.project.name);
        const mark = inc ? (isInc ? "◉" : "○") : it.sum.blocked ? "✖" : " ";
        const markColor = inc ? PAL.green : it.sum.blocked ? PAL.red : PAL.dim;
        const st = stateOf(it);
        return (
          <box key={it.project.name} flexDirection="row" backgroundColor={isCur ? PAL.cursorBg : undefined}>
            <text fg={PAL.cyan}>{isCur ? "❯" : " "}</text>
            <text fg={markColor}>{mark + " "}</text>
            <text fg={isCur ? PAL.white : undefined} attributes={isCur ? 1 : 0}>{pad(it.project.name, W.name)}</text>
            <text fg={st.color}>{pad(st.text, W.state)}</text>
            <text fg={PAL.cyan}>{pad(it.sum.push ? String(it.sum.push) : "·", W.push)}</text>
            <text fg={PAL.magenta}>{pad(it.sum.pull ? String(it.sum.pull) : "·", W.pull)}</text>
            <text fg={it.sum.blocked ? PAL.red : PAL.yellow}>{pad(it.sum.secrets ? String(it.sum.secrets) : "·", W.sec)}</text>
            <text fg={PAL.gray}>{pad(it.plan.memorySource, W.mem)}</text>
            <text fg={PAL.gray}>{relTime(it.lastSyncAt)}</text>
          </box>
        );
      })}
      {!scanning && offset + windowItems.length < items.length ? <text fg={PAL.gray}>{`  ↓ ${items.length - (offset + windowItems.length)} more`}</text> : null}

      <box flexDirection="column" marginTop={1}>
        {scanning ? (
          <box flexDirection="column">
            <HopTrack direction={hopDir(direction)} width={Math.min(40, Math.max(18, width - 26))} />
            <text><span fg={PAL.cyan}>{spin}</span><span fg={PAL.gray}>{` Scanning projects… ${scanned}/${projects.length}`}</span></text>
          </box>
        ) : (
          <text>
            <span fg={PAL.gray}>{`${items.length} projects · `}</span>
            <span fg={PAL.green}>{`${inSync} in sync`}</span>
            <span fg={PAL.gray}>{" · "}</span>
            <span fg={PAL.cyan}>{`${withChanges} with changes`}</span>
            {withSecrets > 0 ? <span fg={PAL.yellow}>{` · ${withSecrets} with secrets`}</span> : <span> </span>}
            <span fg={PAL.gray}>{"    "}</span>
            <span fg={PAL.cyan}>?</span><span fg={PAL.gray}> help</span>
          </text>
        )}
        {message ? (
          <text fg={PAL.green}>{message}</text>
        ) : !scanning && selected?.sum.stranded ? (
          <text fg={PAL.yellow}>{`  ${selected.project.name} has no memory at the expected path — press M to map it`}</text>
        ) : null}
        {!scanning ? (
          <text fg={PAL.gray}>
            <span fg={PAL.cyan}>↑↓</span> Move  <span fg={PAL.cyan}>Enter</span> View  <span fg={PAL.cyan}>Space</span> Include  <span fg={PAL.cyan}>A</span> Apply  <span fg={PAL.cyan}>D</span> Direction  <span fg={PAL.cyan}>S</span> Secrets  <span fg={PAL.cyan}>M</span> Map  <span fg={PAL.cyan}>R</span> Rescan  <span fg={PAL.cyan}>Q</span> Quit
          </text>
        ) : null}
      </box>
    </box>
  );
}
