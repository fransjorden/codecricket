# cc-codex-sync (`ccsync`)

Bidirectional sync between **Claude Code** and **OpenAI Codex** so you can switch
coding agents inside living projects without losing context.

Claude Code keeps per-project guidance in `CLAUDE.md` and a rich **memory** store
(`~/.claude/projects/<mangled>/memory/`). Codex reads `AGENTS.md`. `ccsync`
mirrors them into delimited, foreign-block-safe regions of `AGENTS.md` and merges
edits back — byte-for-byte, including webhook URLs, API tokens, exact frontmatter
(even a trailing space after `metadata:`), code fences, tables, and `[[wikilinks]]`.

## Why

> "Switch to Codex tomorrow with all my memories and workflows intact; after a
> month of building in Codex, switch back to Claude Code just as frictionlessly."

That round-trip has to be lossless, has to handle renamed projects, and must not
leak the secrets that live in memory into a committed `AGENTS.md`. `ccsync` does
all three.

## Install

```bash
npm install
npm install -g bun  # the interactive dashboard renders via OpenTUI under Bun
npm run build
npm link            # provides the `ccsync` command
# or run without linking:  npm run ccsync -- <args>
```

Bun is only needed for the `ccsync` dashboard; `init`/`status`/`sync` run on Node.

State lives in `~/.cc-codex-sync/` (override with `CCSYNC_HOME`). The workspace
holding your project folders defaults to the parent of the current dir
(override with `--workspace` or `CCSYNC_WORKSPACE`).

## Quick start

```bash
ccsync init           # scan workspace, build projects.json, flag stranded memory
ccsync                # launch the interactive TUI (default command)
```

The **TUI** is the easiest way to drive it: a dashboard table of all projects
with state, push/pull counts, secret flags, memory source, and last-synced —
expand any project to a scrollable diff, include/exclude with `space`, flip
direction with `d`, cycle the secret policy with `s`, and apply with `a` (it asks
for confirmation first).

```
cc-codex-sync  ·  Pushing Claude → Codex  ·  secrets kept out of git

  PROJECT               STATE       PUSH  PULL  SEC  MEMORY    SYNCED
❯◉ type-machine          ● changes   5     ·     3    override  never
  ◉ intimico-platform    ● changes   52    ·     ·    derived   never
  ◉ openclaw             ● changes   9     ·     1    derived   never
  · ivosw                ✓ in sync   ·     ·     ·    derived   2m ago

2 projects with changes · 1 with secrets
↑↓ Move  Enter View  Space Include  A Apply  D Direction  S Secrets  M Map  Q Quit
```

A project showing `? needs map` (renamed, so its memory is stranded under the old
name) can be fixed inline: press **`M`** to pick the stranded memory dir and
attach it — it writes the override to `projects.json` and re-scans, no CLI trip.

> **The dashboard runs on [OpenTUI](https://opentui.com) under [Bun](https://bun.sh)**
> (native Zig rendering, real flexbox, smooth animation). Install Bun once with
> `npm install -g bun`. The rest of the CLI runs on Node; `ccsync` automatically
> launches the dashboard under Bun. If Bun isn't installed it tells you and you
> can still use `ccsync status` / `sync` on Node.

Prefer plain commands? Everything is scriptable too:

```bash
ccsync status --all                  # read-only drift report
ccsync sync type-machine --dry-run   # preview one project (no writes)
ccsync sync type-machine --apply     # write it
```

The **first** sync of any project is dry-run by default — you see the diff before
anything is written. Every write is atomic and leaves a `.bak`.

## The two workflows it's built for

**Switching to Codex (bulk push):**
```bash
ccsync sync --all --direction claude-to-codex --apply
```

**Coming back to Claude after a month in Codex:**
```bash
ccsync status --all                                  # see what changed on the Codex side
ccsync sync --all --direction codex-to-claude --apply
ccsync harvest <project>                             # optional: stage Codex's generated memories for review
```

`both` (the default direction) reconciles each side independently, unit by unit,
so editing one fact in Codex and another in Claude never clobber each other.
Conflicts resolve to the newest edit, or use `--prefer claude|codex`.

## Commands

| Command | What it does |
|---|---|
| `ccsync` / `ccsync tui` | Interactive terminal dashboard (default). Review diffs, stage, and apply. |
| `ccsync init` | Build/refresh `projects.json`; detect stranded memory dirs and suggest mappings. |
| `ccsync status [project] [--all]` | Read-only drift report (recommended first command after a break). |
| `ccsync sync [project] [--all]` | Sync a project. Flags below. |
| `ccsync harvest [project] [--accept]` | Stage `~/.codex/memories` as proposed Claude memory files for review. |
| `ccsync skills [--apply]` | Copy custom *local* skills (e.g. `nieuwsbrief-skill`) between Claude/Codex. Ecosystem symlinks are skipped. |
| `ccsync workspace [--apply]` | Sync the workspace-root `CLAUDE.md` index with global `~/.codex/AGENTS.md`. |

`sync` flags: `--dry-run` / `--apply`, `--direction both|claude-to-codex|codex-to-claude`,
`--prefer claude|codex`, `--no-memory`, `--apply-deletions`, `--secrets <mode>`.

## Renamed projects (stranded memory)

Claude's memory dir is derived from the project's path. If you rename a folder,
its memory is stranded under the old name. `ccsync init` detects this and suggests
a mapping; pin it explicitly with:

```bash
ccsync init --map type-machine=meeting-tool
```

(`type-machine` was renamed from `meeting-tool`; its webhook/ClickUp memory lives
under the old path.) Without a mapping, `ccsync` refuses to silently sync nothing.

## Secrets

Memory can contain live secrets (Slack webhooks, API tokens). For Codex to *use*
them they must sit in `AGENTS.md` — but that file is often git-tracked. The
default policy is **`gitignore-guard`**:

- secrets render verbatim so Codex works;
- `AGENTS.md` is added to `.gitignore`;
- if `AGENTS.md` is **already git-tracked**, the write is **blocked** until you opt
  in with `--secrets allow-tracked`, or switch to `--secrets redact` (masks
  secrets in `AGENTS.md`, keeps real values in a gitignored `AGENTS.secrets.md`).

## How the round-trip stays byte-exact

`AGENTS.md` = optional foreign content + managed `ccsync:` regions. Any comment
block that isn't a `ccsync:` marker (e.g. a Next.js codemod's
`nextjs-agent-rules`) is passed through untouched. Each memory fact is carried as
its **whole original content verbatim** inside a self-describing marker recording
its filename, frontmatter shape, EOL, and final-newline — so reconstruction is
byte-identical even if an editor munges `AGENTS.md`'s line endings. Memory facts
that contain a literal `ccsync:` marker fall back to base64.

## Develop

```bash
npm test           # vitest, Node: round-trip fidelity, merge logic, full integration
npm run test:tui   # bun: renders the OpenTUI dashboard headlessly and asserts
npm run typecheck  # Node CLI (tsconfig.json) + OpenTUI dashboard (tsconfig.tui.json)
npm run build      # tsc → dist (Node CLI). The TUI runs from source under Bun.
npm run tui        # bun src/tui/main.tsx — run the dashboard directly
```

**Runtime split:** the CLI (`init`/`sync`/`status`/…) is Node + commander. The
dashboard is React via [OpenTUI](https://opentui.com) and runs under **Bun**;
`src/commands/tui.ts` spawns `bun src/tui/main.tsx`. All sync logic
(`planProject`/`executeProject`) is UI-agnostic and shared by both.

Out of scope by design: `.claude/settings.local.json` / permissions (tool-specific
and they embed secrets), Codex `config.toml`, plugins, history/sessions.
