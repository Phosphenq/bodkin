import { parseEther, type Address } from "viem";
import { curveAbi } from "./abi/pons.js";
import { fastClient } from "./chain.js";
import { DeployerIndex, limiter } from "./pons/deployerIndex.js";
import { enrichLaunch, hasSocials, devSharePct, type LaunchIntel } from "./pons/enrich.js";
import { FarmDetector } from "./pons/fingerprint.js";
import { watchLaunches, type LaunchEvent } from "./pons/launches.js";
import { scoreLaunch, type Score } from "./score.js";
import { buyOnCurve } from "./trade/curveTrade.js";
import { sellAnywhere, valueNow } from "./trade/poolTrade.js";
import { exitReason, openPosition, openPositions, updatePosition, type ExitRules, type Position } from "./trade/positions.js";
import { getAccount } from "./trade/wallet.js";
import { envNum } from "./util/env.js";
import { bps, eth, hhmmss, short } from "./util/fmt.js";
import { links, osc } from "./util/links.js";
import { c, log } from "./util/log.js";
import { retry } from "./util/retry.js";

/**
 * The sniper. Detect → read → decide → wait at full draw → release.
 *
 * Every pons v2 launch opens behind a 99% tax that decays to zero over ~3 seconds. Racing the first block
 * is a way to hand 99% of the buy to the creator, so this engine reads `currentSnipeTaxBps` for its own
 * recipient and only buys once the tax is under `maxOpeningTaxBps`. The chain is first-come-first-served
 * with no priority fees, so there is nothing to bribe: the decision is when, not how much gas.
 */

export interface SnipeRules {
  ethPerBuy: bigint;
  slippageBps: number;
  maxOpeningTaxBps: number;
  minScore: number;
  maxDevSharePct: number;
  minDevSharePct: number;
  maxCreatorTaxBps: number;
  requireSocials: boolean;
  maxExemptWallets: number;
  /** Skip launches that are not paired with native ETH. */
  ethPairsOnly: boolean;
  /** Regex on name/symbol/description; empty = any. */
  keyword: RegExp | null;
  /** Only buy launches from these deployers; empty = any. */
  deployers: Set<string>;
  maxOpenPositions: number;
  /** Refuse when this many earlier launches in 30 min share the exact fingerprint (a launch farm). */
  maxFarmTwins: number;
  /** Stop firing once this much ETH has been spent on entries in this session. The wall between a bad hour and a drained wallet. */
  sessionBudgetWei: bigint;
  exits: ExitRules;
  /** Give up waiting for the tax to decay after this many ms. */
  maxWaitMs: number;
}

export function rulesFromEnv(overrides: Partial<SnipeRules> = {}): SnipeRules {
  return {
    ethPerBuy: parseEther(String(envNum("SNIPE_ETH", 0.01))),
    slippageBps: envNum("SNIPE_SLIPPAGE_BPS", 300),
    maxOpeningTaxBps: envNum("SNIPE_MAX_TAX_BPS", 300),
    minScore: 60,
    maxDevSharePct: 8,
    minDevSharePct: 0,
    maxCreatorTaxBps: 300,
    requireSocials: true,
    maxExemptWallets: 2,
    ethPairsOnly: true,
    keyword: null,
    deployers: new Set(),
    maxOpenPositions: 3,
    maxFarmTwins: 1,
    sessionBudgetWei: parseEther(String(envNum("SNIPE_BUDGET_ETH", 0.05))),
    exits: {
      takeProfitPct: envNum("TAKE_PROFIT_PCT", 80),
      stopLossPct: envNum("STOP_LOSS_PCT", 35),
      trailingPct: envNum("TRAILING_PCT", 25),
      maxHoldMin: envNum("MAX_HOLD_MIN", 45),
    },
    maxWaitMs: 12_000,
    ...overrides,
  };
}

export interface Decision { fire: boolean; why: string[] }

/** Pure filter over the intel. Every rejection names its rule so the log explains itself. */
export function decide(intel: LaunchIntel, score: Score, rules: SnipeRules, openCount: number, farmTwins = 0, spentWei = 0n): Decision {
  // A launch the RPC would not let us read is not a launch that failed the rules; say so and stop.
  if (!intel.meta && !intel.record && !intel.curve) return { fire: false, why: [`unreadable: ${intel.errors[0] ?? "no data"}`] };
  const why: string[] = [];
  if (openCount >= rules.maxOpenPositions) why.push(`open positions ${openCount} ≥ ${rules.maxOpenPositions}`);
  if (spentWei + rules.ethPerBuy > rules.sessionBudgetWei) why.push(`session budget ${eth(rules.sessionBudgetWei)} ETH reached (${eth(spentWei)} spent)`);
  if (farmTwins > rules.maxFarmTwins) why.push(`launch farm: ${farmTwins} twins in 30 min > ${rules.maxFarmTwins}`);
  if (rules.ethPairsOnly && intel.pair.symbol !== "ETH") why.push(`pair is ${intel.pair.symbol}, not ETH`);
  if (score.total < rules.minScore) why.push(`score ${score.total} < ${rules.minScore}`);
  const dev = devSharePct(intel.tx);
  if (dev > rules.maxDevSharePct) why.push(`dev share ${dev.toFixed(2)}% > ${rules.maxDevSharePct}%`);
  if (dev < rules.minDevSharePct) why.push(`dev share ${dev.toFixed(2)}% < ${rules.minDevSharePct}%`);
  if (intel.record && intel.record.creatorTaxBps > rules.maxCreatorTaxBps) why.push(`creator tax ${bps(intel.record.creatorTaxBps)} > ${bps(rules.maxCreatorTaxBps)}`);
  if (rules.requireSocials && !hasSocials(intel.meta).any) why.push("no socials");
  if (intel.tx && intel.tx.exemptions.length > rules.maxExemptWallets) why.push(`${intel.tx.exemptions.length} exempt wallets > ${rules.maxExemptWallets}`);
  if (rules.keyword) {
    const hay = `${intel.meta?.name ?? ""} ${intel.meta?.symbol ?? ""} ${intel.meta?.description ?? ""}`;
    if (!rules.keyword.test(hay)) why.push(`keyword ${rules.keyword} not found`);
  }
  if (rules.deployers.size && !rules.deployers.has(intel.ev.deployer.toLowerCase())) why.push("deployer not on the allow-list");
  if (!intel.curve || intel.curve.graduated || intel.curve.readyToGraduate) why.push("curve not open");
  return { fire: why.length === 0, why };
}

/** Poll the curve's opening tax for our recipient until it is under the ceiling, or give up. */
export async function waitForTax(curve: Address, recipient: Address, maxBps: number, maxWaitMs: number): Promise<{ ok: boolean; taxBps: number; waitedMs: number }> {
  const t0 = Date.now();
  for (;;) {
    let tax = 0n;
    try {
      tax = await fastClient.readContract({ address: curve, abi: curveAbi, functionName: "currentSnipeTaxBps", args: [recipient] });
    } catch { tax = 0n; }
    if (tax <= BigInt(maxBps)) return { ok: true, taxBps: Number(tax), waitedMs: Date.now() - t0 };
    if (Date.now() - t0 > maxWaitMs) return { ok: false, taxBps: Number(tax), waitedMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 150));
  }
}

export interface EngineOpts { live: boolean; rules: SnipeRules; onEvent?: (e: Record<string, unknown>) => void; /** Read and score but do not fire until resume() is called. */ startPaused?: boolean }

/** What the board (or any caller) can do to a running engine. Rules are read live, so editing them takes effect on the next launch. */
export interface EngineHandle {
  stop: () => void;
  /** Stop firing without stopping the feed or the exits. */
  pause: () => void;
  resume: () => void;
  paused: () => boolean;
  /** ETH spent on entries in this session (wei). */
  spent: () => bigint;
  /** Sell a position now, whatever the exit rules say. Dry-run positions close at the current quote. */
  close: (positionId: string) => Promise<{ ethOut: bigint; pnlPct: number; venue: string; hash?: string }>;
  rules: SnipeRules;
}

/** Runs until stopped: watches launches, fires by the rules, and manages open positions every 5 s. */
export function startEngine(opts: EngineOpts): EngineHandle {
  const { rules, live } = opts;
  const account = getAccount();
  if (live && !account) throw new Error("--live needs PRIVATE_KEY in .env");
  const recipient: Address = account?.address ?? "0x000000000000000000000000000000000000dEaD";
  const emit = (e: Record<string, unknown>) => opts.onEvent?.({ t: Date.now(), ...e });
  const busy = new Set<string>();
  const limit = limiter(3);
  const deployers = new DeployerIndex();
  const farms = new FarmDetector();
  let paused = !!opts.startPaused;
  let spent = 0n;
  deployers.start(
    (b) => { log.info(c.muted(`deployer index ready: ${b.launches} launches, ${b.graduations} graduations in the last ${deployers.windowBlocks} blocks`)); emit({ kind: "index", launches: b.launches, graduations: b.graduations }); },
    (e, sec) => log.warn(`deployer index: ${e.message.split("\n")[0]}; scoring without deployer history, retry in ${sec} s`),
  );
  const sweep = setInterval(() => { if (deployers.ready) void deployers.sweepGraduations().catch(() => undefined); }, 60_000);

  log.info(`${c.neon("bodkin")} ${c.muted(`snipe · ${live ? c.onNeon(" LIVE ") : "dry run"} · ${eth(rules.ethPerBuy)} ETH per shot · budget ${eth(rules.sessionBudgetWei)} ETH · max open ${rules.maxOpenPositions} · tax ceiling ${bps(rules.maxOpeningTaxBps)} · min score ${rules.minScore} · TP ${rules.exits.takeProfitPct}% SL ${rules.exits.stopLossPct}% trail ${rules.exits.trailingPct}% hold ${rules.exits.maxHoldMin}m`)}`);

  const onLaunch = async (ev: LaunchEvent) => {
    const t0 = Date.now();
    deployers.note(ev);
    const intel = await limit(() => retry(() => enrichLaunch(ev, recipient)));
    const dq = deployers.quick(ev.deployer, ev.blockNumber);
    const { twins } = farms.note(intel);
    const score = scoreLaunch(intel, { deployer: dq, farmTwins: twins });
    const sym = intel.meta?.symbol ? `$${intel.meta.symbol}` : short(ev.token);
    const d = decide(intel, score, rules, openPositions().length + busy.size, twins, spent);
    if (d.fire && paused) d.why.push(live ? "not armed" : "demo not started");
    const soc = hasSocials(intel.meta);
    emit({
      kind: "launch", token: ev.token, curve: ev.curve, symbol: sym, name: intel.meta?.name ?? "(unreadable)", score: score.total, verdict: score.verdict,
      fire: d.why.length === 0, why: d.why, devPct: devSharePct(intel.tx), taxBps: intel.record?.creatorTaxBps, pair: intel.pair.symbol, readMs: Date.now() - t0,
      // everything the board's detail drawer shows, from memory, no second read
      detail: {
        reasons: score.reasons,
        description: (intel.meta?.description ?? "").replace(/\s+/g, " ").trim().slice(0, 280),
        socials: { x: soc.twitter ? intel.meta?.socials.twitter : "", web: soc.website ? intel.meta?.socials.website : "", tg: soc.telegram ? intel.meta?.socials.telegram : "" },
        deployer: ev.deployer, deployerPrior: dq?.prior ?? null, deployerGraduated: dq?.graduated ?? null,
        feeRecipient: intel.record?.creatorFeeRecipient ?? null, feeToDeployer: !!(intel.record && intel.tx && intel.record.creatorFeeRecipient.toLowerCase() === intel.tx.from.toLowerCase()),
        exempt: intel.tx?.exemptions ?? [], devBuy: intel.tx ? (Number(intel.tx.devBuyWei) / 10 ** intel.pair.decimals).toFixed(intel.pair.decimals === 18 ? 4 : 2) : null,
        progress: intel.curve ? Number(intel.curve.realQuoteReserve) / Math.max(1, Number(intel.curve.graduationThreshold)) : null,
        openingTaxBps: intel.curve ? Number(intel.curve.openingTaxBps) : null, block: ev.blockNumber.toString(), tx: ev.txHash, errors: intel.errors,
      },
    });
    if (!d.fire || paused) { log.info(`${c.muted(hhmmss())}  ${c.muted("pass ")} ${sym.padEnd(10)} score ${String(score.total).padStart(3)}  ${c.muted(d.why.join("; "))}`); return; }
    busy.add(ev.token);
    try {
      log.info(`${c.muted(hhmmss())}  ${c.neon("draw ")} ${sym.padEnd(10)} score ${String(score.total).padStart(3)}  ${c.muted(`read in ${Date.now() - t0} ms, waiting for the opening tax ≤ ${bps(rules.maxOpeningTaxBps)}`)}`);
      const w = await waitForTax(ev.curve, recipient, rules.maxOpeningTaxBps, rules.maxWaitMs);
      if (!w.ok) { log.info(`${c.muted(hhmmss())}  ${c.muted("hold ")} ${sym.padEnd(10)} tax still ${bps(w.taxBps)} after ${w.waitedMs} ms, skipped`); emit({ kind: "hold", token: ev.token, taxBps: w.taxBps }); return; }
      const res = await buyOnCurve(ev.curve, rules.ethPerBuy, rules.slippageBps, !live);
      const got = res.tokensOut ?? res.tokensQuoted;
      spent += rules.ethPerBuy;
      const pos = openPosition({ token: ev.token, curve: ev.curve, symbol: intel.meta?.symbol ?? "?", name: intel.meta?.name ?? "?", openedAt: Math.floor(Date.now() / 1000), entryTx: res.hash, dryRun: !live, entryEth: rules.ethPerBuy.toString(), tokens: got.toString() });
      log.info(`${c.muted(hhmmss())}  ${c.onNeon(" FIRE ")} ${osc(sym.padEnd(10), links.axiom())} ${live ? "bought" : "would buy"} ${eth(rules.ethPerBuy)} ETH → ${(Number(got) / 1e18 / 1e6).toFixed(2)}M tokens at tax ${bps(w.taxBps)} after ${w.waitedMs} ms wait  ${c.muted(osc(ev.token, links.pons(ev.token)))}${res.hash ? "  " + c.muted(res.hash) : ""}`);
      emit({ kind: "fire", token: ev.token, symbol: sym, ethIn: rules.ethPerBuy.toString(), tokens: got.toString(), taxBps: w.taxBps, waitedMs: w.waitedMs, tx: res.hash ?? null, live, positionId: pos.id });
    } catch (e) {
      log.warn(`${sym} ${live ? "buy failed" : "dry-run quote failed"}: ${(e as Error).message.split("\n")[0]}`);
      emit({ kind: "error", token: ev.token, message: (e as Error).message.split("\n")[0] });
    } finally { busy.delete(ev.token); }
  };

  const stopWatch = watchLaunches((ev) => { void onLaunch(ev); });

  const closing = new Set<string>();
  const sellOut = async (pos: Position, reason: string) => {
    const tokens = BigInt(pos.tokens);
    const res = await sellAnywhere(pos.token, tokens, rules.slippageBps, !live);
    const out = res.ethOut ?? res.ethQuoted;
    updatePosition(pos.id, { status: "closed", lastEth: out.toString(), exits: [...pos.exits, { at: Math.floor(Date.now() / 1000), tokens: tokens.toString(), ethOut: out.toString(), reason, tx: res.hash, dryRun: !live }] });
    const realized = Number(((out - BigInt(pos.entryEth)) * 10_000n) / BigInt(pos.entryEth)) / 100;
    log.info(`${c.muted(hhmmss())}  ${realized >= 0 ? c.neon("exit ") : c.loss("exit ")} $${pos.symbol.padEnd(9)} ${live ? "sold" : "would sell"} for ${eth(out)} ETH (${realized >= 0 ? "+" : ""}${realized.toFixed(1)}%) on ${res.venue}: ${reason}${res.hash ? "  " + c.muted(res.hash) : ""}`);
    emit({ kind: "exit", positionId: pos.id, symbol: pos.symbol, ethOut: out.toString(), pnlPct: realized, reason, tx: res.hash ?? null, venue: res.venue });
    return { ethOut: out, pnlPct: realized, venue: res.venue, hash: res.hash };
  };

  const manage = async () => {
    for (const pos of openPositions()) {
      if (closing.has(pos.id)) continue;
      try {
        const tokens = BigInt(pos.tokens);
        const v = await valueNow(pos.token, tokens);
        if (!v) { emit({ kind: "swept", positionId: pos.id }); continue; }
        const peak = BigInt(pos.peakEth) > v.eth ? BigInt(pos.peakEth) : v.eth;
        updatePosition(pos.id, { lastEth: v.eth.toString(), lastAt: Math.floor(Date.now() / 1000), peakEth: peak.toString() });
        const reason = exitReason({ ...pos, peakEth: peak.toString() }, v.eth, rules.exits);
        const pnl = Number(((v.eth - BigInt(pos.entryEth)) * 10_000n) / BigInt(pos.entryEth)) / 100;
        emit({ kind: "mark", positionId: pos.id, symbol: pos.symbol, valueEth: v.eth.toString(), pnlPct: pnl, venue: v.venue, peakPct: Number(((peak - BigInt(pos.entryEth)) * 10_000n) / BigInt(pos.entryEth)) / 100 });
        if (!reason) continue;
        await sellOut(pos, reason);
      } catch (e) {
        log.warn(`manage ${pos.symbol}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  };
  const timer = setInterval(() => { void manage(); }, 5_000);
  if (paused) log.info(c.muted(`${hhmmss()}  feed only: launches are read and scored, nothing fires until start`));
  return {
    stop: () => { stopWatch(); clearInterval(timer); clearInterval(sweep); },
    pause: () => { paused = true; emit({ kind: "paused", paused: true }); log.info(c.muted(`${hhmmss()}  stopped: launches are read and scored, nothing fires`)); },
    resume: () => { paused = false; emit({ kind: "paused", paused: false }); log.info(c.muted(`${hhmmss()}  ${live ? "armed: live buys are on" : "demo started: dry-run buys are on"}`)); },
    paused: () => paused,
    spent: () => spent,
    close: async (positionId: string) => {
      const pos = openPositions().find((p) => p.id === positionId);
      if (!pos) throw new Error("no open position with that id");
      if (closing.has(pos.id)) throw new Error("already closing");
      closing.add(pos.id);
      try { return await sellOut(pos, "closed by hand"); } finally { closing.delete(pos.id); }
    },
    rules,
  };
}

export type { Position };
