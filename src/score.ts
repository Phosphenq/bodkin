import { devSharePct, hasSocials, type CurveActivity, type LaunchIntel } from "./pons/enrich.js";
import { progress } from "./pons/curve.js";

export type Verdict = "FIRE" | "WATCH" | "SKIP";

export interface Score {
  total: number;
  verdict: Verdict;
  reasons: string[];
}

export interface ScoreContext {
  deployer?: { prior: number; graduated: number } | null;
  activity?: CurveActivity | null;
  /** Seconds since launch when `activity` was read. */
  ageSec?: number;
  /** Earlier launches in the last 30 min with the same fingerprint (dev-buy wei, tax, links) from other wallets. */
  farmTwins?: number;
  thresholds?: { fire: number; watch: number };
}

/**
 * Rule-based, explainable. Every point traces to a line here, and every line traces to something
 * observed on Robinhood Chain launches (dev share, creator tax, declared bundles, deployer record,
 * early organic flow). Starts at 50; clamps to 0..100.
 */
export function scoreLaunch(intel: LaunchIntel, ctx: ScoreContext = {}): Score {
  let s = 50;
  const r: string[] = [];
  const add = (pts: number, why: string) => { s += pts; r.push(`${pts >= 0 ? "+" : ""}${pts} ${why}`); };

  const dev = devSharePct(intel.tx);
  if (intel.tx) {
    if (dev === 0) add(-10, "no dev buy, nothing at stake");
    else if (dev < 1) add(0, `dev buy ${dev.toFixed(2)}%, token-sized`);
    else if (dev <= 6) add(15, `dev buy ${dev.toFixed(2)}%, inside the 1–6% band`);
    else if (dev <= 10) add(0, `dev buy ${dev.toFixed(2)}%, heavy`);
    else add(-25, `dev buy ${dev.toFixed(2)}%, over 10%`);
  }

  if (intel.record) {
    const tax = intel.record.creatorTaxBps;
    if (tax === 0) add(5, "no creator tax");
    else if (tax <= 200) add(10, `creator tax ${tax / 100}%, creator earns on volume`);
    else if (tax <= 500) add(-5, `creator tax ${tax / 100}%`);
    else add(-25, `creator tax ${tax / 100}%, traders pay ${1 + tax / 100}% per side`);
    if (intel.tx && intel.record.creatorFeeRecipient.toLowerCase() !== intel.tx.from.toLowerCase()) {
      add(5, "fees routed to a third party (builder / KOL deal pattern)");
    }
  }

  const soc = hasSocials(intel.meta);
  if (!soc.any) add(-15, "no socials");
  else {
    if (soc.twitter) add(8, "has X link");
    if (soc.website) add(8, "has website");
    if (soc.telegram) add(3, "has telegram");
  }
  if ((intel.meta?.description?.length ?? 0) >= 40) add(4, "real description");

  if (intel.tx) {
    const n = intel.tx.exemptions.length;
    if (n === 0) add(5, "no declared bundle wallets");
    else if (n <= 3) add(-5, `${n} wallet(s) exempt from the opening tax`);
    else add(-20, `${n} wallets exempt from the opening tax, declared bundle`);
  }

  if ((ctx.farmTwins ?? 0) >= 2) add(-25, `launch farm: ${ctx.farmTwins! + 1} launches with this exact fingerprint in 30 min`);
  else if (ctx.farmTwins === 1) add(-8, "one earlier launch with this exact fingerprint in 30 min");

  if (ctx.deployer) {
    const { prior, graduated } = ctx.deployer;
    if (prior === 0) add(5, "fresh deployer");
    else if (graduated / prior >= 0.3) add(15, `deployer graduated ${graduated}/${prior} recent launches`);
    else if (prior >= 5 && graduated === 0) add(-25, `serial deployer, ${prior} launches, none graduated`);
    else add(-5, `deployer ${prior} recent launches, ${graduated} graduated`);
  }

  if (ctx.activity && intel.curve) {
    const a = ctx.activity;
    if (a.uniqueBuyers >= 10) add(10, `${a.uniqueBuyers} distinct buyers`);
    else if (a.uniqueBuyers >= 4) add(5, `${a.uniqueBuyers} distinct buyers`);
    if (a.buys > 0 && a.taxedBuys === a.buys) add(-10, "every buy so far paid the opening tax (bots only)");
    if (a.sells > a.buys && a.buys > 3) add(-10, "more sells than buys");
    const p = progress(intel.curve);
    if (p >= 0.25 && (ctx.ageSec ?? 999) <= 120) add(10, `${(p * 100).toFixed(0)}% of the curve filled in ${ctx.ageSec}s`);
  }

  const total = Math.max(0, Math.min(100, s));
  const fire = ctx.thresholds?.fire ?? 75;
  const watch = ctx.thresholds?.watch ?? 45;
  const verdict: Verdict = total >= fire ? "FIRE" : total >= watch ? "WATCH" : "SKIP";
  return { total, verdict, reasons: r };
}
