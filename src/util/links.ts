/**
 * Where a launch can be opened from bodkin's output. pons and the explorer are canonical; Axiom and FOMO are the
 * terminals people actually trade in, and both have a page per launch: Axiom keys a Robinhood Chain market by the
 * pons curve address, FOMO by the token address (its web page needs a signed-in session, anonymous visitors land on
 * the home page). Referral codes ride only on the landing pages (axiom.trade/@handle, fomo.family/r/code): a ?ref=
 * on a token page changes nothing, checked 4.09.2026. Set REF_AXIOM / REF_FOMO in .env to your own handles; leave
 * them empty to drop the sign-up links.
 */
import { c } from "./log.js";

const axiomRef = () => process.env.REF_AXIOM?.trim() ?? "phosphen";
const fomoRef = () => process.env.REF_FOMO?.trim() ?? "phosphenq";

export const links = {
  pons: (token: string) => `https://www.ponsfamily.com/token/${token}`,
  explorer: (token: string) => `https://robinhoodchain.blockscout.com/token/${token}`,
  /** Axiom's page for the launch; the id is the pons curve, not the token. */
  axiom: (curve: string) => `https://axiom.trade/meme/${curve.toLowerCase()}?chain=robinhood`,
  /** FOMO's page for the launch. */
  fomo: (token: string) => `https://fomo.family/tokens/robinhood/${token.toLowerCase()}`,
  /** Landing pages that carry the referral; empty when the handle is empty. */
  axiomRef: () => (axiomRef() ? `https://axiom.trade/@${axiomRef()}` : ""),
  fomoRef: () => (fomoRef() ? `https://fomo.family/r/${fomoRef()}` : ""),
};

/** OSC 8 terminal hyperlink: Windows Terminal, iTerm2, kitty, VS Code and most modern terminals make it Ctrl+clickable. */
export function osc(text: string, url: string): string {
  const tty = process.stdout.isTTY === true || !!process.env.FORCE_COLOR;
  if (!url || process.env.NO_COLOR || !tty) return text;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** One line with the sign-up links: a neon badge and neon links, so it does not sink into the grey header. Empty when both handles are empty. */
export function refLine(): string {
  const parts = [links.axiomRef() ? c.neon(osc("axiom", links.axiomRef())) : "", links.fomoRef() ? c.neon(osc("fomo", links.fomoRef())) : ""].filter(Boolean);
  return parts.length ? `${c.onNeon(" sign up ")} ${parts.join(c.muted(" · "))}` : "";
}
