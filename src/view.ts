import { fdvQuote, progress, spotPrice } from "./pons/curve.js";
import { devSharePct, hasSocials, type CurveActivity, type LaunchIntel } from "./pons/enrich.js";
import type { Score } from "./score.js";
import { bps, eth, hhmmss, pad, short, usd } from "./util/fmt.js";
import { c } from "./util/log.js";

export interface ViewCtx {
  ethUsd: number | null;
  deployer?: { prior: number; graduated: number } | null;
  activity?: CurveActivity | null;
}

export function verdictTag(v: Score["verdict"]): string {
  if (v === "FIRE") return c.onNeon(" FIRE ");
  if (v === "WATCH") return c.white("WATCH ");
  return c.muted("SKIP  ");
}

/** Multi-line card for one launch, the unit of the `hunt` feed. */
export function launchCard(intel: LaunchIntel, score: Score, ctx: ViewCtx): string {
  const { ev, meta, record, tx, curve } = intel;
  const name = meta?.name ?? "(unreadable)";
  const sym = meta?.symbol ? `$${meta.symbol}` : "";
  const ts = tx?.timestamp ? hhmmss(tx.timestamp) : hhmmss();
  const lines: string[] = [];
  lines.push(`${c.muted(ts)}  ${c.white(name)}  ${c.neon(sym)}  ${c.muted(ev.token)}  ${verdictTag(score.verdict)} ${c.white(String(score.total))}`);

  const dev = tx ? `${devSharePct(tx).toFixed(2)}% (${(Number(tx.devBuyWei) / 10 ** intel.pair.decimals).toFixed(intel.pair.decimals === 18 ? 4 : 2)} ${intel.pair.symbol})` : "?";
  const tax = record ? bps(record.creatorTaxBps) : "?";
  let feeTo = "?";
  if (record && tx) {
    feeTo = record.creatorFeeRecipient.toLowerCase() === tx.from.toLowerCase()
      ? "deployer"
      : `${short(record.creatorFeeRecipient)} ${c.neon("third party")}`;
  }
  const ex = tx ? tx.exemptions.length : 0;
  lines.push(`   dev buy ${c.white(dev)}   creator tax ${c.white(tax)}   fees → ${feeTo}   exempt wallets ${ex ? c.loss(String(ex)) : c.white("0")}`);

  const soc = hasSocials(meta);
  const socTxt = [soc.twitter && "x", soc.website && "web", soc.telegram && "tg"].filter(Boolean).join(" ") || c.loss("none");
  const desc = (meta?.description ?? "").replace(/\s+/g, " ").trim();
  lines.push(`   socials ${socTxt}   ${c.muted(desc.length > 96 ? desc.slice(0, 96) + "…" : desc)}`);

  if (ctx.deployer) {
    const d = ctx.deployer;
    lines.push(`   deployer ${c.muted(short(ev.deployer))}  ${d.prior} prior launch${d.prior === 1 ? "" : "es"} in ~11h, ${d.graduated} graduated`);
  }
  if (curve && record && record.phase !== 0) {
    lines.push(`   ${c.neon("graduated")} → ${["curve", "swept", "v4 pool", "rescued"][record.phase]}  ${c.muted("curve reserves are empty after graduation; price now lives in the pool")}`);
  } else if (curve) {
    const p = progress(curve);
    const pair = intel.pair;
    const dec = pair.decimals;
    const q = (w: bigint) => (Number(w) / 10 ** dec).toFixed(dec === 18 ? 3 : 2);
    const fdvQ = fdvQuote(curve) * 10 ** (18 - dec); // fdv in pair units for any decimals
    const filled = Math.round(p * 20);
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);
    const open = curve.openingTaxBps > 0n ? c.loss(`opening tax ${bps(curve.openingTaxBps)}`) : c.muted("opening tax 0");
    const perUnitUsd = pair.symbol === "ETH" ? ctx.ethUsd : pair.usdPerUnit;
    const fdvUsd = perUnitUsd === null ? null : fdvQ * perUnitUsd;
    lines.push(`   curve ${c.neon(bar)} ${(p * 100).toFixed(1)}%  ${q(curve.realQuoteReserve)}/${q(curve.graduationThreshold)} ${pair.symbol}   fdv ${fdvQ.toFixed(2)} ${pair.symbol} ${c.muted(usd(fdvUsd))}   ${open}`);
  }
  if (ctx.activity) {
    const a = ctx.activity;
    lines.push(`   flow ${a.buys} buys / ${a.sells} sells, ${a.uniqueBuyers} buyers, ${a.taxedBuys} taxed, net ${eth(a.quoteIn - a.quoteOut)} ETH`);
  }
  lines.push(`   ${c.muted(score.reasons.join(" · "))}`);
  return lines.join("\n");
}

/** One-line follow-up printed at +15 s / +60 s. */
export function launchUpdate(intel: LaunchIntel, score: Score, activity: CurveActivity, ageSec: number, ctx: ViewCtx): string {
  const sym = intel.meta?.symbol ? `$${intel.meta.symbol}` : short(intel.ev.token);
  const cur = intel.curve;
  const p = cur ? progress(cur) : 0;
  const px = cur ? spotPrice(cur) : 0;
  const fdv = cur ? fdvQuote(cur) : 0;
  const fdvUsd = ctx.ethUsd === null ? null : fdv * ctx.ethUsd;
  return `${c.muted(hhmmss())}  ${pad(sym, 10)} +${pad(`${ageSec}s`, 4)} ${verdictTag(score.verdict)} ${String(score.total).padStart(3)}  curve ${(p * 100).toFixed(1).padStart(5)}%  fdv ${fdv.toFixed(2)} ETH ${c.muted(usd(fdvUsd))}  ${activity.buys}b/${activity.sells}s ${activity.uniqueBuyers} buyers  px ${px.toExponential(2)}`;
}
