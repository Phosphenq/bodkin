/** Terminal colors in the brand palette. Truecolor escapes; falls back to plain text when NO_COLOR is set. */
const on = !process.env.NO_COLOR && (process.stdout.isTTY === true || !!process.env.FORCE_COLOR);
const wrap = (open: string) => (s: string | number) => (on ? `${open}${s}\x1b[0m` : String(s));

export const c = {
  neon: wrap("\x1b[38;2;204;255;0m"),
  onNeon: wrap("\x1b[48;2;204;255;0m\x1b[38;2;17;14;8m"),
  white: wrap("\x1b[38;2;255;255;255m"),
  text: wrap("\x1b[38;2;217;217;217m"),
  muted: wrap("\x1b[38;2;150;150;150m"),
  loss: wrap("\x1b[38;2;255;107;92m"),
  dim: wrap("\x1b[2m"),
};

export const log = {
  info: (...a: unknown[]) => console.log(...a),
  warn: (...a: unknown[]) => console.error(c.loss("!"), ...a),
  error: (...a: unknown[]) => console.error(c.loss("✗"), ...a),
};

export function hr(width = 72): string {
  return c.muted("─".repeat(width));
}
