/**
 * Where a token can be opened from bodkin's output. pons and the explorer are canonical; Axiom and FOMO are the
 * terminals people actually trade in, and they carry the referral of whoever runs this copy of bodkin.
 * Set REF_AXIOM / REF_FOMO in .env to your own handles; leave them empty to hide those links.
 */
const axiomRef = () => process.env.REF_AXIOM?.trim() ?? "phosphen";
const fomoRef = () => process.env.REF_FOMO?.trim() ?? "phosphenq";

export const links = {
  pons: (token: string) => `https://www.ponsfamily.com/token/${token}`,
  explorer: (token: string) => `https://robinhoodchain.blockscout.com/token/${token}`,
  /** Axiom's Pulse on Robinhood Chain, through the referral; the token page itself needs a session on their side. */
  axiom: () => (axiomRef() ? `https://axiom.trade/@${axiomRef()}?chain=robinhood` : ""),
  axiomToken: (token: string) => `https://axiom.trade/meme/${token}?chain=robinhood`,
  /** FOMO is an app; the referral page carries the code and the store link. */
  fomo: () => (fomoRef() ? `https://fomo.family/r/${fomoRef()}` : ""),
};

/** OSC 8 terminal hyperlink: Windows Terminal, iTerm2, kitty, VS Code and most modern terminals make it Ctrl+clickable. */
export function osc(text: string, url: string): string {
  const tty = process.stdout.isTTY === true || !!process.env.FORCE_COLOR;
  if (!url || process.env.NO_COLOR || !tty) return text;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
