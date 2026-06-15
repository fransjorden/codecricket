// Forward direction: a ClaudeSide -> an updated AGENTS.md string, preserving
// any foreign content already present.

import type { ClaudeSide } from "../types.js";
import { renderMemoryRegionBody, upsertRegion } from "./fence.js";
import { toLf } from "./frontmatter.js";

export function renderAgentsFromClaude(existingRaw: string, side: ClaudeSide): string {
  let raw = existingRaw;

  if (side.instructions !== null) {
    const inner = toLf(side.instructions);
    raw = upsertRegion(raw, "instructions", inner, {
      eol: side.instructionsEol,
      finalnl: side.instructionsFinalNewline ? "1" : "0",
    });
  }

  if (side.index || side.facts.length > 0) {
    const body = renderMemoryRegionBody(side.index, side.facts);
    raw = upsertRegion(raw, "memory", body, {});
  }

  return raw;
}
