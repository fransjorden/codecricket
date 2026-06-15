import { createTwoFilesPatch } from "diff";
import pc from "picocolors";

const MAX_DIFF_BYTES = 8000;

/** A colorized unified diff, truncated for very large changes. */
export function unifiedDiff(label: string, oldStr: string, newStr: string): string {
  if (oldStr === newStr) return "";
  const patch = createTwoFilesPatch(label, label, oldStr, newStr, "", "", { context: 2 });
  let body = patch;
  if (body.length > MAX_DIFF_BYTES) {
    body =
      body.slice(0, MAX_DIFF_BYTES) +
      `\n… [diff truncated; ${newStr.length - oldStr.length >= 0 ? "+" : ""}${newStr.length - oldStr.length} bytes net] …\n`;
  }
  return body
    .split("\n")
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) return pc.green(line);
      if (line.startsWith("-") && !line.startsWith("---")) return pc.red(line);
      if (line.startsWith("@@")) return pc.cyan(line);
      return pc.dim(line);
    })
    .join("\n");
}

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx";
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Structured diff lines for a UI to color itself (no embedded ANSI). */
export function diffLines(label: string, oldStr: string, newStr: string, maxLines = 2000): DiffLine[] {
  if (oldStr === newStr) return [];
  const patch = createTwoFilesPatch(label, label, oldStr, newStr, "", "", { context: 2 });
  const out: DiffLine[] = [];
  for (const line of patch.split("\n")) {
    let kind: DiffLineKind = "ctx";
    if (line.startsWith("Index:") || line.startsWith("===") || line.startsWith("+++") || line.startsWith("---")) kind = "meta";
    else if (line.startsWith("@@")) kind = "hunk";
    else if (line.startsWith("+")) kind = "add";
    else if (line.startsWith("-")) kind = "del";
    out.push({ kind, text: line });
    if (out.length >= maxLines) {
      out.push({ kind: "meta", text: `… [truncated at ${maxLines} lines] …` });
      break;
    }
  }
  return out;
}
