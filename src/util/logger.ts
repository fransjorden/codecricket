import pc from "picocolors";

let verbose = false;
let quiet = false;

export function setVerbosity(opts: { verbose?: boolean; quiet?: boolean }): void {
  verbose = !!opts.verbose;
  quiet = !!opts.quiet;
}

export const log = {
  info(msg: string): void {
    if (!quiet) console.log(msg);
  },
  step(msg: string): void {
    if (!quiet) console.log(pc.cyan("→ ") + msg);
  },
  ok(msg: string): void {
    if (!quiet) console.log(pc.green("✓ ") + msg);
  },
  warn(msg: string): void {
    console.warn(pc.yellow("⚠ ") + msg);
  },
  error(msg: string): void {
    console.error(pc.red("✗ ") + msg);
  },
  danger(msg: string): void {
    console.error(pc.bgRed(pc.white(" SECRET ")) + " " + msg);
  },
  debug(msg: string): void {
    if (verbose && !quiet) console.log(pc.dim("  " + msg));
  },
  dim: pc.dim,
  bold: pc.bold,
};
