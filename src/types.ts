// Shared types for cc-codex-sync.
//
// Core principle: artifacts are carried as raw bytes. Parsed views (frontmatter
// fields, etc.) exist only for routing/display and are NEVER used to regenerate
// a file. See src/core/frontmatter.ts.

export type FrontmatterShape = "flat" | "nested" | "none";

export type Eol = "lf" | "crlf";

/** A single memory fact file, read byte-exactly. */
export interface ParsedFact {
  /** Original on-disk basename, e.g. "reference_slack_webhook.md". */
  filename: string;
  shape: FrontmatterShape;
  /** Exact original full file content (frontmatter + body), carried verbatim. */
  content: string;
  eol: Eol;
  /** Whether the original file ended with a trailing newline. */
  finalNewline: boolean;
  /** Parsed fields — for routing/display only, never for reconstruction. */
  parsed: {
    name?: string;
    description?: string;
    type?: string;
    nodeType?: string;
    originSessionId?: string;
  };
  /** sha256 over the full original file bytes. */
  hash: string;
  secrets: SecretFinding[];
}

/** The curated MEMORY.md index, carried verbatim. */
export interface MemoryIndex {
  filename: "MEMORY.md";
  content: string;
  eol: Eol;
  finalNewline: boolean;
  hash: string;
  secrets: SecretFinding[];
}

/** The whole Claude side of one project. */
export interface ClaudeSide {
  projectDir: string;
  /** On-disk casing of the instructions file ("CLAUDE.md" or "claude.md"), or null. */
  instructionsFilename: string | null;
  instructions: string | null;
  instructionsEol: Eol;
  instructionsFinalNewline: boolean;
  memoryDir: string | null;
  index: MemoryIndex | null;
  facts: ParsedFact[];
}

/** A managed region's parsed payload inside AGENTS.md. */
export interface ManagedRegions {
  instructions: string | null;
  instructionsEol: Eol;
  instructionsFinalNewline: boolean;
  /** Reconstructed index + facts from the memory region, or null if absent. */
  index: MemoryIndex | null;
  facts: ParsedFact[];
  /** True if AGENTS.md contained a memory region at all. */
  hasMemoryRegion: boolean;
  hasInstructionsRegion: boolean;
}

/** The whole Codex side of one project (AGENTS.md split into managed + foreign). */
export interface CodexSide {
  agentsPath: string;
  exists: boolean;
  /** Full original bytes (for diffing / passthrough), or null when absent. */
  raw: string | null;
  regions: ManagedRegions;
}

export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
  /** Redacted preview of the match. */
  preview: string;
  /** The exact matched secret string (kept in-memory only; never logged). */
  match: string;
}

export type SecretMode = "gitignore-guard" | "allow" | "allow-tracked" | "redact" | "sidecar";

export interface SecretPolicy {
  mode: SecretMode;
  customPatterns: string[];
  ignorePatterns: string[];
  sidecarFilename: string;
  blockOnTracked: boolean;
}

// ---- projects.json (override map) ----

export interface ProjectEntry {
  projectDir: string;
  /** Explicit memory dir override; null = derive from the mangled path. */
  memoryDir: string | null;
  note?: string;
}

export interface ProjectsMap {
  version: 1;
  /** Workspace dir holding the project folders, persisted by `init`. */
  workspace?: string;
  projects: Record<string, ProjectEntry>;
}

// ---- sync-state.json ----
//
// Per project, a flat map of unit key -> the last-synced common-ancestor hash.
// Unit keys: "instructions", "MEMORY.md", and each fact filename. Mtimes are
// read live from disk at plan time, so they are not stored here.

export interface ProjectState {
  lastSyncAt: string;
  memoryDir: string | null;
  units: Record<string, string>;
}

export interface SyncState {
  version: 1;
  projects: Record<string, ProjectState>;
}
