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

// hop-in-place: ONE consistent silhouette that bobs vertically (via top padding)
// inside a fixed-height frame, with the legs loading/springing/tucking. Keeping the
// body identical across frames reads as a real hop instead of a shape-shift.
const HOP_BODY = [
  "     /\\        ,",
  "    /  \\      /",
  "   /    \\   ,/",
  "  /      '--o\\",
  " (  ::::::::  >",
  "  '-.______.-'",
];

const HOP_LEGS = {
  stand: "    |  |  | \\",
  crouch: "    L  |  J",
  push: "   /   |   \\",
  tuck: "     \\ ' /",
};

const HOP_H = 10; // fixed frame height so the surrounding layout never jumps

function hopFrame(topPad: number, legs: string, dust = false): string[] {
  const lines: string[] = [];
  for (let i = 0; i < topPad; i++) lines.push("");
  lines.push(...HOP_BODY, legs);
  while (lines.length < HOP_H - 1) lines.push("");
  lines.push(dust ? "    .  '  ." : "");
  return lines.slice(0, HOP_H);
}

// stand → crouch (load) → spring → peak (tuck) → fall → land (squash + flash)
const HOP: Array<{ lines: string[]; flash?: boolean }> = [
  { lines: hopFrame(2, HOP_LEGS.stand) },
  { lines: hopFrame(3, HOP_LEGS.crouch) },
  { lines: hopFrame(1, HOP_LEGS.push) },
  { lines: hopFrame(0, HOP_LEGS.tuck, true) },
  { lines: hopFrame(1, HOP_LEGS.push) },
  { lines: hopFrame(2, HOP_LEGS.crouch), flash: true },
];

// mini sprite for the track, facing right / left.
//   ground = standing mid-hop · air = airborne · sit = settled/at rest (shorter)
const MINI = {
  right: { ground: ["\\,", "%>>"], air: [" \\,", "~>>"], sit: ["", "%>."] },
  left: { ground: [",/", "<<%"], air: [",/ ", "<<~"], sit: ["", ".<%"] },
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
        <text key={i} fg={fg}>{pad + l || " "}</text>
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
  return <Sprite lines={frame.lines} fg={frame.flash ? C.flash : C.body} />;
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

/**
 * A cricket on a Claude ⇄ Codex rail.
 *   • Uncontrolled (no `progress`): loops back and forth forever — used in the demo.
 *   • Controlled (`progress` 0..1): the cricket SITS at the start while 0, hops across as
 *     progress climbs, then sits down at the destination once it hits 1. `direction` picks
 *     which end is the start — push starts at Claude (left), pull starts at Codex (right).
 */
export function HopTrack({
  direction = "push",
  width = 30,
  progress,
}: {
  direction?: Dir;
  width?: number;
  progress?: number;
}) {
  const peak = 3; // max air height in rows
  const controlled = progress !== undefined;

  // uncontrolled (demo) timing
  const hopLen = 5; // columns per hop
  const fph = 5; // frames per hop
  const hops = Math.ceil(width / hopLen);
  const span = hops * fph;
  const hold = 6; // pause at each end
  const cycle = span + hold;

  const [t, setT] = useState(0);
  const [disp, setDisp] = useState(progress ?? 0); // eased position for the controlled mode
  const [bob, setBob] = useState(0);

  // demo loop
  useEffect(() => {
    if (controlled) return;
    const id = setInterval(() => setT((x) => x + 1), 110);
    return () => clearInterval(id);
  }, [controlled]);

  // controlled: ease toward the target and bob while travelling; snap + rest at the ends
  useEffect(() => {
    if (!controlled) return;
    const target = Math.max(0, Math.min(1, progress ?? 0));
    if (target <= 0.001 || target >= 0.999) {
      setDisp(target); // settle instantly at an endpoint — the cricket just sits
      return;
    }
    const id = setInterval(() => {
      setDisp((d) => (Math.abs(target - d) < 0.01 ? target : d + (target - d) * 0.3));
      setBob((b) => b + 1);
    }, 100);
    return () => clearInterval(id);
  }, [controlled, progress]);

  let goingRight: boolean;
  let dist: number;
  let height: number;
  let pose: "ground" | "air" | "sit";

  if (controlled) {
    const p = Math.max(0, Math.min(1, progress ?? 0));
    goingRight = direction !== "pull";
    const arrived = p >= 0.999 && Math.abs(disp - p) < 0.01;
    const waiting = p <= 0.001 && Math.abs(disp - p) < 0.01;
    const active = !arrived && !waiting;
    dist = Math.round(disp * width);
    const HOPCY = [0, 1, 2, 3, 2, 1];
    height = active ? HOPCY[bob % HOPCY.length]! : 0;
    pose = height > 0 ? "air" : active ? "ground" : "sit";
  } else {
    // for "both", alternate direction each full cycle
    const leg = Math.floor(t / cycle);
    const local = t % cycle;
    goingRight = direction === "push" ? true : direction === "pull" ? false : leg % 2 === 0;
    const moving = local < span;
    const tt = Math.min(local, span - 1);
    const hopIndex = Math.floor(tt / fph);
    const phase = (tt % fph) / fph;
    dist = Math.min(width, Math.round((hopIndex + phase) * hopLen));
    height = moving ? Math.round(peak * Math.sin(Math.PI * phase)) : 0;
    pose = height > 0 ? "air" : "ground";
  }

  const x = goingRight ? dist : width - dist;
  const facing = goingRight ? "right" : "left";
  const sprite = MINI[facing][pose];

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
        <text key={i} fg={pose === "air" ? C.antenna : C.body}>{l || " "}</text>
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

// ---- splash: big cricket + a shimmering "codecricket" wordmark --------------

// figlet "Standard" (wide) and "Small" (narrow) — baked in so there's no runtime dep.
const BANNER_STD = [
  "                _                _      _        _   ",
  "   ___ ___   __| | ___  ___ _ __(_) ___| | _____| |_ ",
  "  / __/ _ \\ / _` |/ _ \\/ __| '__| |/ __| |/ / _ \\ __|",
  " | (_| (_) | (_| |  __/ (__| |  | | (__|   <  __/ |_ ",
  "  \\___\\___/ \\__,_|\\___|\\___|_|  |_|\\___|_|\\_\\___|\\__|",
];
const BANNER_SMALL = [
  "             _            _    _       _   ",
  "  __ ___  __| |___ __ _ _(_)__| |_____| |_ ",
  " / _/ _ \\/ _` / -_) _| '_| / _| / / -_)  _|",
  " \\__\\___/\\__,_\\___\\__|_| |_\\__|_\\_\\___|\\__|",
];

// dim → bright green → near-white: the brightness band that sweeps across the wordmark
const SHIM = ["#166534", "#22c55e", "#4ade80", "#86efac", "#ecfdf5"];

/** The "codecricket" wordmark with a highlight that sweeps left → right (the shimmer). */
function Wordmark({ lines }: { lines: string[] }) {
  const [p, setP] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setP((x) => x + 1), 80);
    return () => clearInterval(id);
  }, []);
  const w = lines[0]?.length ?? 0;
  const band = 7; // half-width of the bright band
  const cycle = w + band * 2 + 10; // sweep across, then a short pause before repeating
  const center = ((p * 2) % cycle) - band;

  return (
    <box flexDirection="column">
      {lines.map((line, r) => {
        // colour each cell by its distance from the moving band, then merge equal-colour runs
        const runs: { text: string; color: string }[] = [];
        for (let c = 0; c < line.length; c++) {
          const d = Math.abs(c - center);
          const t = d < band ? 1 - d / band : 0;
          const color = SHIM[Math.min(SHIM.length - 1, Math.round(t * (SHIM.length - 1)))]!;
          const last = runs[runs.length - 1];
          if (last && last.color === color) last.text += line[c]!;
          else runs.push({ text: line[c]!, color });
        }
        return (
          <text key={r}>
            {runs.map((run, i) => (
              <span key={i} fg={run.color}>{run.text}</span>
            ))}
          </text>
        );
      })}
    </box>
  );
}

/** Full splash screen: the hero cricket above a shimmering wordmark + tagline. */
export function Splash({ width = 80, variant = "idle" }: { width?: number; variant?: "idle" | "hop" }) {
  const banner = width >= 56 ? BANNER_STD : width >= 46 ? BANNER_SMALL : null;
  return (
    <box flexDirection="column" alignItems="center">
      <Cricket variant={variant} />
      <box marginTop={1}>
        {banner ? <Wordmark lines={banner} /> : <text fg={C.body} attributes={1}>codecricket</text>}
      </box>
      <text fg={C.dim} marginTop={1}>Version 0.1.0    (C) 2026 Frans Jorden Hoorn</text>
      <text fg={C.dim}>Synchronizes your Claude and Codex context, both ways.</text>
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
        <text fg={C.white} attributes={1}>splash</text>
        <Splash width={70} />

        <text fg={C.white} attributes={1} marginTop={1}>idle</text>
        <Cricket variant="idle" />

        <text fg={C.white} attributes={1} marginTop={1}>hopping in place</text>
        <Cricket variant="hop" fps={8} />

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
