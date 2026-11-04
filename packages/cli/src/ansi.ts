/** Plain ANSI helpers. No dependency; colors switch off when `enabled` is false. */

export interface Palette {
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
  cyan(s: string): string;
}

function wrap(code: number, reset: number): (s: string) => string {
  return (s) => `\u001b[${code}m${s}\u001b[${reset}m`;
}

const identity = (s: string): string => s;

export function palette(enabled: boolean): Palette {
  if (!enabled) {
    return { bold: identity, dim: identity, green: identity, yellow: identity, red: identity, cyan: identity };
  }
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    red: wrap(31, 39),
    cyan: wrap(36, 39),
  };
}

/** Pads columns so rows line up. Cells are plain strings; color after padding breaks widths. */
export function table(rows: string[][], indent = "  "): string {
  if (rows.length === 0) return "";
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) => indent + row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  ").trimEnd())
    .join("\n");
}
