/** The wordmark, ANSI-shadow block letters, lime fading to Robinhood yellow. Skipped for --json and NO_COLOR. */
const LINES = [
  "██████╗  ██████╗ ██████╗ ██╗  ██╗██╗███╗   ██╗",
  "██╔══██╗██╔═══██╗██╔══██╗██║ ██╔╝██║████╗  ██║",
  "██████╔╝██║   ██║██║  ██║█████╔╝ ██║██╔██╗ ██║",
  "██╔══██╗██║   ██║██║  ██║██╔═██╗ ██║██║╚██╗██║",
  "██████╔╝╚██████╔╝██████╔╝██║  ██╗██║██║ ╚████║",
  "╚═════╝  ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝",
];
/** #CCFF00 → #FFE700, one step per line. */
const GRADIENT: [number, number, number][] = [[204, 255, 0], [214, 250, 0], [224, 246, 0], [235, 241, 0], [245, 236, 0], [255, 231, 0]];

let printed = false;

export function banner(tagline = "the sniper terminal for pons v2 on Robinhood Chain"): void {
  if (printed) return;
  printed = true;
  const color = !process.env.NO_COLOR && (process.stdout.isTTY === true || !!process.env.FORCE_COLOR);
  const out = LINES.map((l, i) => (color ? `\x1b[38;2;${GRADIENT[i].join(";")}m${l}\x1b[0m` : l));
  console.log("\n" + out.join("\n"));
  console.log((color ? "\x1b[38;2;150;150;150m" : "") + `  ${tagline}` + (color ? "\x1b[0m" : "") + "\n");
}

export const BANNER_LINES = LINES;
