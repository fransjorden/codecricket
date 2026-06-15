/** @jsxImportSource @opentui/react */
// Bun entrypoint for the OpenTUI dashboard. Launched by src/commands/tui.ts.
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App, type TuiOptions } from "./app.js";

function parseArgs(argv: string[]): TuiOptions {
  const o: TuiOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--workspace") o.workspace = next();
    else if (a === "--direction") o.direction = next();
    else if (a === "--secrets") o.secretMode = next();
    else if (a === "--project") o.project = next();
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App opts={opts} />);
