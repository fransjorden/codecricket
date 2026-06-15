/** @jsxImportSource @opentui/react */
// codecricket — the mascot. An ASCII cricket that hops Claude ⇄ Codex.
//
// Exports:
//   <Cricket variant="idle"|"hop" .../>  — the animated hero sprite
//   <HopTrack direction=... />           — cricket hopping across a Claude⇄Codex track
//
// Run the standalone showcase:   bun src/tui/cricket.tsx
import { useEffect, useState } from "react";

const C = {
  body: "#4ade80", // cricket green
  eye: "#7dd3fc", // cyan
  leg: "#22c55e",
  antenna: "#a3e635",
  flash: "#fbbf24", // landing squash glow
  rail: "#334155",
  railLit: "#7dd3fc",
  claude: "#c084fc",
  codex: "#7dd3fc",
  dim: "#6b7280",
  white: "#e5e7eb",
};

// ---- sprites (each a list of lines; leading spaces are significant) ----

const HERO_A = [
  "     /\\        ,",
  "    /  \\      /",
  "   /    \\   ,/",
  "  /      '--o\\",
  " (  ::::::::  >",
  "  '-.______.-'",
  "    |  |  | \\",
];

// idle twitch: antenna flicks, hind foot taps
const HERO_B = [
  "     /\\         ,",
  "    /  \\       /",
  "   /    \\    ,'",
  "  /      '--o\\",
  " (  ::::::::  >",
  "  '-.______.-'",
  "    |  |  |/",
];

// hop cycle, facing right
const HOP = [
  // crouch
  [
    "   /\\      ,/",
    "  /  '----o\\",
    " ( ::::::: >",
    "  '-.___.-'",
    "   J     L",
  ],
  // launch
  [
    "  /\\        ,/",
    " /  '------o\\",
    "( :::::::::  >",
    " \\   ____.-'",
    "  '-'",
  ],
  // airborne
  [
    "              ,/",
    "       .----o\\",
    "   ___( ::::: >",
    "  /    '-----'",
    " '",
  ],
  // land (squash)
  [
    "   /|        ,/",
    "  / '------o\\",
    " ( ::::::::  >",
    "  '-.____.-'",
    "   |\\    /|",
  ],
];

// mini sprite for the track, facing right / left, ground / air
const MINI = {
  right: { ground: ["\\,", "%>>"], air: [" \\,", "~>>"] },
  left: { ground: [",/", "<<%"], air: [",/ ", "<<~"] },
};

function mirror(lines: string[]): string[] {
  const flip: Record<string, string> = { "/": "\\", "\\": "/", "(": ")", ")": "(", "<": ">", ">": "<", "'": "`", "`": "'" };
  const w = Math.max(...lines.map((l) => l.length));
  return lines.map((l) =>
    l.padEnd(w).split("").reverse().map((ch) => flip[ch] ?? ch).join("").replace(/\s+$/, ""),
  );
}

/** Render a sprite as colored lines, with optional left pad and color overrides per row. */
function Sprite({ lines, fg, x = 0 }: { lines: string[]; fg: string; x?: number }) {
  const pad = " ".repeat(x);
  return (
    <box flexDirection="column">
      {lines.map((l, i) => (
        <text key={i} fg={fg}>{pad + l}</text>
      ))}
    </box>
  );
}

/** The hero cricket: idles (antenna twitch) or runs the hop cycle in place. */
export function Cricket({ variant = "idle", fps = 6 }: { variant?: "idle" | "hop"; fps?: number }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const ms = variant === "idle" ? 520 : Math.round(1000 / fps);
    const id = setInterval(() => setT((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [variant, fps]);

  if (variant === "idle") {
    return <Sprite lines={t % 2 ? HERO_B : HERO_A} fg={C.body} />;
  }
  const frame = HOP[t % HOP.length]!;
  const landing = t % HOP.length === 3;
  return <Sprite lines={frame} fg={landing ? C.flash : C.body} />;
}

/** A tiny single-line cricket that idles (antenna/leg twitch). For the header. */
export function HeaderCricket({ fg = C.body }: { fg?: string }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((x) => x + 1), 600);
    return () => clearInterval(id);
  }, []);
  const frames = ["%>>", "%->", "%>>", "%~>"]; // subtle midsection shimmer
  return <text fg={fg}>{frames[t % frames.length]! + " "}</text>;
}

type Dir = "push" | "pull" | "both";

/** A cricket hopping across a Claude ⇄ Codex rail. Shows sync direction. */
export function HopTrack({ direction = "push", width = 30 }: { direction?: Dir; width?: number }) {
  const peak = 3; // max air height in rows
  const hopLen = 5; // columns per hop
  const fph = 5; // frames per hop
  const hops = Math.ceil(width / hopLen);
  const span = hops * fph;
  const hold = 6; // pause at each end
  const cycle = span + hold;

  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((x) => x + 1), 110);
    return () => clearInterval(id);
  }, []);

  // for "both", alternate direction each full cycle
  const leg = Math.floor(t / cycle);
  const local = t % cycle;
  let goingRight = direction === "push" ? true : direction === "pull" ? false : leg % 2 === 0;

  const moving = local < span;
  const tt = Math.min(local, span - 1);
  const hopIndex = Math.floor(tt / fph);
  const phase = (tt % fph) / fph;
  const dist = Math.min(width, Math.round((hopIndex + phase) * hopLen));
  const x = goingRight ? dist : width - dist;
  const height = moving ? Math.round(peak * Math.sin(Math.PI * phase)) : 0;
  const air = height > 0;

  const facing = goingRight ? "right" : "left";
  const sprite = MINI[facing][air ? "air" : "ground"];

  // build the air zone: peak+2 rows, sprite placed at (peak-height)
  const rows = peak + 2;
  const top = peak - height;
  const zone: string[] = [];
  for (let r = 0; r < rows; r++) {
    const si = r - top;
    if (si >= 0 && si < sprite.length) zone.push(" ".repeat(x + 2) + sprite[si]);
    else zone.push("");
  }

  // rail with a lit trail behind the cricket
  const lit = Math.max(0, Math.min(width, dist));
  const railLeft = goingRight ? "━".repeat(lit) + "─".repeat(width - lit) : "─".repeat(width - lit) + "━".repeat(lit);

  return (
    <box flexDirection="column">
      {zone.map((l, i) => (
        <text key={i} fg={air ? C.antenna : C.body}>{l || " "}</text>
      ))}
      <text>
        <span fg={C.claude}>{" Claude "}</span>
        <span fg={C.claude}>◉</span>
        <span fg={C.railLit}>{railLeft}</span>
        <span fg={C.codex}>◉</span>
        <span fg={C.codex}>{" Codex"}</span>
      </text>
    </box>
  );
}

// --------------------------------------------------------------------------
// Standalone showcase — `bun src/tui/cricket.tsx`
// --------------------------------------------------------------------------
// @ts-ignore — import.meta.main is Bun-specific
if (typeof import.meta !== "undefined" && (import.meta as any).main) {
  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot, useKeyboard, useRenderer } = await import("@opentui/react");

  function Showcase() {
    const renderer = useRenderer();
    useKeyboard((k: any) => {
      if (k.name === "q" || (k.ctrl && k.name === "c")) {
        renderer.destroy();
        process.exit(0);
      }
    });
    return (
      <box flexDirection="column" padding={1}>
        <text fg={C.eye} attributes={1}>codecricket</text>
        <text fg={C.dim}>the mascot — hops your context Claude ⇄ Codex</text>

        <text fg={C.white} attributes={1} marginTop={1}>idle</text>
        <Cricket variant="idle" />

        <text fg={C.white} attributes={1} marginTop={1}>hopping in place</text>
        <Cricket variant="hop" />

        <text fg={C.white} attributes={1} marginTop={1}>push  ·  Claude → Codex</text>
        <HopTrack direction="push" />

        <text fg={C.white} attributes={1} marginTop={1}>two-way</text>
        <HopTrack direction="both" />

        <text fg={C.dim} marginTop={1}>press q to quit</text>
      </box>
    );
  }

  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  // @ts-ignore react jsx runtime
  createRoot(renderer).render(<Showcase />);
}

// keep mirror() referenced (used if you flip the hero for codex→claude)
void mirror;
