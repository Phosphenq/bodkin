import { Command } from "commander";
import { appendFileSync, mkdirSync } from "node:fs";
import { getAddress, isAddress, type Address } from "viem";
import { factoryAbi } from "./abi/pons.js";
import { ADDR, ZERO as ZERO_ADDR, fastClient, httpUrl, publicClient, wsUrl } from "./chain.js";
import { banner } from "./util/banner.js";
import { readCurveState } from "./pons/curve.js";
import { deployerHistory } from "./pons/dev.js";
import { DeployerIndex, limiter } from "./pons/deployerIndex.js";
import { FarmDetector } from "./pons/fingerprint.js";
import { curveActivity, enrichLaunch, readTokenMeta, type LaunchIntel } from "./pons/enrich.js";
import { feeForensics } from "./pons/fees.js";
import { findLaunch, recentLaunches, watchLaunches, type LaunchEvent } from "./pons/launches.js";
import { scoreLaunch } from "./score.js";
import { ago, eth, iso, pad, short, usd } from "./util/fmt.js";
import { c, hr, log } from "./util/log.js";
import { ethUsd } from "./util/price.js";
import { retry } from "./util/retry.js";
import { launchCard, launchUpdate } from "./view.js";

const program = new Command();
program.name("bodkin").description("The sniper terminal for pons v2 on Robinhood Chain. Local, open, non-custodial.").version("0.1.0");

const addr = (s: string): Address => {
  if (!isAddress(s)) throw new Error(`not an address: ${s}`);
  return getAddress(s);
};
const jsonSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

// ---------------------------------------------------------------------------------------------
program
  .command("doctor")
  .description("check RPC, chain id, pons contracts and live launch parameters")
  .option("--probe", "also quote a graduated pool through the v4 quoter and settle the router layout")
  .action(async (opts: { probe?: boolean }) => {
    const t0 = Date.now();
    const [chainId, block, gas] = await Promise.all([fastClient.getChainId(), fastClient.getBlockNumber(), fastClient.getGasPrice()]);
    const rtt = Date.now() - t0;
    const ok = (b: boolean) => (b ? c.neon("ok") : c.loss("FAIL"));
    log.info(`${c.white("rpc")}        ${httpUrl()}  ${rtt} ms round trip  ${ok(chainId === 4663)} chain ${chainId}, block ${block}, gas ${eth(gas, 9)} ETH`);
    log.info(`${c.white("websocket")}  ${wsUrl ? `${wsUrl.slice(0, 40)}…` : c.muted("not set, polling every " + (process.env.POLL_MS || 300) + " ms")}`);
    const f = { address: ADDR.ponsFactory, abi: factoryAbi } as const;
    const [hook, escrow, pm, fee, taxBps, taxSec, maxTax, enabled] = await Promise.all([
      publicClient.readContract({ ...f, functionName: "memeHook" }),
      publicClient.readContract({ ...f, functionName: "feeEscrow" }),
      publicClient.readContract({ ...f, functionName: "poolManager" }),
      publicClient.readContract({ ...f, functionName: "launchFee" }),
      publicClient.readContract({ ...f, functionName: "snipeTaxStartBps" }),
      publicClient.readContract({ ...f, functionName: "snipeTaxSeconds" }),
      publicClient.readContract({ ...f, functionName: "maxCreatorTaxBps" }),
      publicClient.readContract({ ...f, functionName: "launchEnabled" }),
    ]);
    log.info(`${c.white("factory")}    ${ADDR.ponsFactory}  launches ${enabled ? "enabled" : c.loss("DISABLED")}`);
    log.info(`   hook ${ok(hook.toLowerCase() === ADDR.ponsHook.toLowerCase())}  escrow ${ok(escrow.toLowerCase() === ADDR.ponsEscrow.toLowerCase())}  poolManager ${ok(pm.toLowerCase() === ADDR.v4PoolManager.toLowerCase())}`);
    log.info(`   launch fee ${eth(fee)} ETH   opening tax ${Number(taxBps) / 100}% decaying over ${taxSec}s   max creator tax ${Number(maxTax) / 100}%`);
    const recent = await recentLaunches(3_000n);
    log.info(`${c.white("tempo")}      ${recent.length} launches in the last 3000 blocks (~5 min)`);
    const price = await ethUsd();
    log.info(`${c.white("eth/usd")}    ${price ? `$${price.toFixed(0)}` : c.muted("offline")}`);
    log.info(`${c.white("wallet")}     ${process.env.PRIVATE_KEY ? "key present (used only by live trades)" : c.muted("no key, analytics and dry-run only")}`);
    if (opts.probe) {
      // Pool path: quote 0.001 ETH into the most recently graduated pool and settle the router's param layout by simulation.
      const { parseAbiItem } = await import("viem");
      const { quoteV4, poolKeyFor, detectRouterLayout, poolState } = await import("./trade/v4.js");
      const { ZERO } = await import("./chain.js");
      const head = await publicClient.getBlockNumber();
      const grads = await publicClient.getLogs({ address: ADDR.ponsFactory, event: parseAbiItem("event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)"), fromBlock: head - 200_000n, toBlock: head });
      let picked: { tok: Address; key: Awaited<ReturnType<typeof poolKeyFor>>["key"] } | null = null;
      for (const g of grads.reverse().slice(0, 25)) {
        const tok = g.args.token;
        if (!tok) continue;
        const k = await poolKeyFor(tok);
        if (k.pairToken === ZERO) { picked = { tok, key: k.key }; break; }
      }
      if (!picked) { log.warn("no ETH-paired graduation in the last 200k blocks to probe against"); return; }
      const [q, st, layout] = await Promise.all([quoteV4(picked.key, true, 10n ** 15n), poolState(picked.key), detectRouterLayout(picked.key)]);
      log.info(`${c.white("v4 probe")}   ${short(picked.tok)}: 0.001 ETH → ${(Number(q) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens, pool liquidity ${st.liquidity.toString().slice(0, 6)}…, router layout ${c.neon(layout)}`);
    }
  });

// ---------------------------------------------------------------------------------------------
interface HuntOpts { backfill: string; minScore: string; fireOnly?: boolean; follow: boolean; json?: boolean; poll?: string }

/** Launches arrive in bursts and the public RPC answers bursts with errors: at most 3 enrichments in flight. */
const limit = limiter(3);
/** Who launched what, built once at startup; a deployer's record then costs no RPC call per launch. */
const deployers = new DeployerIndex();
const farms = new FarmDetector();

async function presentLaunch(ev: LaunchEvent, price: number | null, opts: HuntOpts): Promise<LaunchIntel | null> {
  deployers.note(ev);
  return limit(() => presentLaunchNow(ev, price, opts));
}

async function presentLaunchNow(ev: LaunchEvent, price: number | null, opts: HuntOpts): Promise<LaunchIntel | null> {
  const t0 = Date.now();
  const intel = await retry(() => enrichLaunch(ev));
  const dq = deployers.quick(ev.deployer, ev.blockNumber);
  const { twins } = farms.note(intel);
  const score = scoreLaunch(intel, { deployer: dq, farmTwins: twins });
  const minScore = Number(opts.minScore || 0);
  if (score.total < minScore || (opts.fireOnly && score.verdict !== "FIRE")) return null; // hidden launches get no follow-up lines either
  if (opts.json) {
    console.log(JSON.stringify({ t: new Date().toISOString(), ev, meta: intel.meta, record: intel.record, tx: intel.tx, curve: intel.curve, deployer: dq, score }, jsonSafe));
  } else {
    console.log(launchCard(intel, score, { ethUsd: price, deployer: dq }) + `\n   ${c.muted(`read in ${Date.now() - t0} ms · ${intel.errors.join("; ")}`)}`);
  }
  try {
    mkdirSync("data", { recursive: true });
    appendFileSync("data/launches.jsonl", JSON.stringify({ t: Date.now(), token: ev.token, curve: ev.curve, deployer: ev.deployer, name: intel.meta?.name, symbol: intel.meta?.symbol, score: score.total, verdict: score.verdict, devPct: intel.tx ? Number(intel.tx.devTokens) / 1e25 : null, taxBps: intel.record?.creatorTaxBps ?? null, block: ev.blockNumber.toString() }) + "\n");
  } catch { /* data dir not writable: feed still works */ }
  return intel;
}

async function followLaunch(intel: LaunchIntel, dq: { prior: number; graduated: number } | null, price: number | null, opts: HuntOpts): Promise<void> {
  const launchTs = intel.tx?.timestamp ?? Math.floor(Date.now() / 1000);
  for (const at of [15, 60]) {
    const wait = launchTs * 1000 + at * 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const [activity, curve] = await limit(() => retry(() => Promise.all([curveActivity(intel.ev.curve, intel.ev.blockNumber), readCurveState(intel.ev.curve)])));
      const fresh = { ...intel, curve };
      const score = scoreLaunch(fresh, { deployer: dq, activity, ageSec: at });
      if (opts.json) console.log(JSON.stringify({ t: new Date().toISOString(), update: at, token: intel.ev.token, activity, curve, score }, jsonSafe));
      else console.log(launchUpdate(fresh, score, activity, at, { ethUsd: price }));
      if (curve.graduated || curve.readyToGraduate) { console.log(`   ${c.neon("graduated")} ${intel.meta?.symbol ?? ""} left the curve`); return; }
    } catch (e) { log.warn(`follow-up failed for ${short(intel.ev.token)}: ${(e as Error).message.split("\n")[0]}`); }
  }
}

program
  .command("hunt")
  .description("live feed of pons v2 launches with dev buy, tax, fee recipient, bundle, deployer record and a score")
  .option("--backfill <n>", "show the last n launches before going live", "3")
  .option("--min-score <n>", "hide launches below this score", "0")
  .option("--fire-only", "show only FIRE verdicts")
  .option("--no-follow", "skip the +15 s and +60 s follow-up lines")
  .option("--json", "print JSON lines instead of cards")
  .option("--poll <ms>", "HTTP poll interval when no websocket is set")
  .option("--for <seconds>", "stop after this many seconds (demos, tests)")
  .action(async (opts: HuntOpts & { for?: string }) => {
    if (opts.for) setTimeout(() => { console.log(c.muted(`\nbodkin stopped after ${opts.for}s`)); process.exit(0); }, Number(opts.for) * 1000).unref();
    const price = await ethUsd();
    if (!opts.json) {
      banner();
      console.log(`${c.neon("bodkin")} ${c.muted("hunt · pons v2 · Robinhood Chain (4663) · " + (wsUrl ? "websocket" : `poll ${opts.poll || process.env.POLL_MS || 300} ms`) + (price ? ` · ETH $${price.toFixed(0)}` : ""))}`);
      console.log(hr());
    }
    deployers.start(
      (b) => { if (!opts.json) console.log(c.muted(`deployer index ready: ${b.launches} launches, ${b.graduations} graduations in the last ${deployers.windowBlocks} blocks`)); },
      (e, sec) => log.warn(`deployer index: ${e.message.split("\n")[0]}; cards run without deployer history, retry in ${sec} s`),
    );
    const sweep = setInterval(() => { if (deployers.ready) void deployers.sweepGraduations().catch(() => undefined); }, 60_000);
    sweep.unref();
    const n = Number(opts.backfill || 0);
    if (n > 0) {
      try {
        const recent = (await recentLaunches(3_000n)).slice(-n);
        for (const ev of recent) await presentLaunch(ev, price, opts);
        if (!opts.json) console.log(hr());
      } catch (e) { log.warn(`backfill skipped: ${(e as { details?: string }).details ?? (e as Error).message.split("\n")[0]}`); }
    }
    const stop = watchLaunches(async (ev) => {
      const intel = await presentLaunch(ev, price, opts);
      if (intel && opts.follow !== false) void followLaunch(intel, deployers.quick(ev.deployer, ev.blockNumber), price, opts);
    }, { pollMs: opts.poll ? Number(opts.poll) : undefined });
    process.on("SIGINT", () => { stop(); clearInterval(sweep); console.log(c.muted("\nbodkin stopped")); process.exit(0); });
  });

// ---------------------------------------------------------------------------------------------
program
  .command("scan <token>")
  .description("everything on chain about one pons v2 token: launch, dev buy, fees, deployer, curve, activity")
  .action(async (tokenArg: string) => {
    const token = addr(tokenArg);
    const price = await ethUsd();
    const ev = await findLaunch(token);
    if (!ev) { log.error("no pons v2 TokenLaunched event found for this token"); process.exit(1); }
    const [intel, hist] = await Promise.all([enrichLaunch(ev), deployerHistory(ev.deployer, 400_000n).catch(() => null)]);
    const activity = await curveActivity(ev.curve, ev.blockNumber);
    const ageSec = intel.tx ? Math.floor(Date.now() / 1000 - intel.tx.timestamp) : undefined;
    const dq = hist ? { prior: hist.launches.filter((l) => l.blockNumber < ev.blockNumber).length, graduated: hist.graduated } : null;
    const score = scoreLaunch(intel, { deployer: dq, activity, ageSec });
    console.log(launchCard(intel, score, { ethUsd: price, deployer: dq, activity }));
    console.log(hr());
    console.log(`${c.white("launched")}   ${intel.tx ? iso(intel.tx.timestamp) + " (" + ago(intel.tx.timestamp) + " ago)" : "?"}  block ${ev.blockNumber}  tx ${c.muted(ev.txHash)}`);
    console.log(`${c.white("launcher")}   ${ev.deployer}  recipient of dev tokens ${intel.tx?.recipient ?? "?"}`);
    console.log(`${c.white("curve")}      ${ev.curve}  phase ${intel.record?.phase ?? "?"} ${["curve", "swept", "pool", "rescued"][intel.record?.phase ?? 0]}`);
    if (intel.tx?.exemptions.length) console.log(`${c.white("exempt")}     ${intel.tx.exemptions.join(", ")}`);
    if (intel.meta) {
      const s = intel.meta.socials;
      console.log(`${c.white("links")}      ${[s.twitter, s.website, s.telegram, s.discord, s.farcaster].filter(Boolean).join("  ") || c.muted("none")}`);
      if (intel.meta.logo) console.log(`${c.white("logo")}       ${intel.meta.logo}`);
    }
    if (intel.record) {
      const fees = await feeForensics(intel.record.creatorFeeRecipient, ev.curve, ev.blockNumber);
      const tot = Number(fees.totalCredited) / 1e18;
      console.log(`${c.white("fees")}       recipient ${fees.recipient}  credited ${eth(fees.totalCredited)} ETH ${c.muted(usd(price === null ? null : tot * price))} (${fees.curveCredits} curve credits, ${fees.poolCredits} pool credits)  claimed ${eth(fees.totalClaimed)} ETH in ${fees.claims.length} claim${fees.claims.length === 1 ? "" : "s"}  pending ${eth(fees.pending)} ETH`);
    }
    if (hist) console.log(`${c.white("deployer")}   ${hist.launches.length} launches in the window, ${hist.graduated} graduated, ${hist.onCurve} still on curve`);
    console.log(`${c.white("explorer")}   https://robinhoodchain.blockscout.com/token/${token}`);
  });

// ---------------------------------------------------------------------------------------------
program
  .command("watch <token>")
  .description("follow one token live: curve fill, buyers, flow, opening tax, then the v4 pool price after graduation")
  .option("--every <seconds>", "refresh interval", "5")
  .option("--for <seconds>", "stop after this many seconds")
  .action(async (tokenArg: string, opts: { every: string; for?: string }) => {
    const token = addr(tokenArg);
    const price = await ethUsd();
    const ev = await findLaunch(token);
    if (!ev) { log.error("no pons v2 TokenLaunched event found for this token"); process.exit(1); }
    const intel = await enrichLaunch(ev);
    const sym = intel.meta?.symbol ? `$${intel.meta.symbol}` : short(token);
    console.log(`${c.white(intel.meta?.name ?? token)} ${c.neon(sym)}  ${c.muted(token)}  ${c.muted("every " + opts.every + " s, ctrl-c to stop")}`);
    console.log(hr());
    const { quoteV4, poolKeyFor } = await import("./trade/v4.js");
    const { progress, fdvQuote, spotPrice } = await import("./pons/curve.js");
    const t0 = Date.now();
    let lastBlock = ev.blockNumber;
    let buys = 0, sells = 0, taxed = 0;
    const buyers = new Set<string>();
    let stop = false;
    process.on("SIGINT", () => { stop = true; console.log(c.muted("\nbodkin stopped")); process.exit(0); });
    while (!stop) {
      try {
        const rec = await publicClient.readContract({ address: ADDR.ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
        if (rec.phase === 0) {
          const [curve, act] = await Promise.all([readCurveState(ev.curve), curveActivity(ev.curve, lastBlock + 1n)]);
          buys += act.buys; sells += act.sells; taxed += act.taxedBuys;
          if (act.lastBlock > lastBlock) lastBlock = act.lastBlock;
          const p = progress(curve);
          const filled = Math.round(p * 20);
          const fdv = fdvQuote(curve);
          const tax = Number(curve.openingTaxBps);
          console.log(`${c.muted(new Date().toISOString().slice(11, 19))}  curve ${c.neon("█".repeat(filled) + "░".repeat(20 - filled))} ${(p * 100).toFixed(1).padStart(5)}%  ${eth(curve.realQuoteReserve)}/${eth(curve.graduationThreshold)} ETH  fdv ${fdv.toFixed(2)} ETH ${c.muted(usd(price === null ? null : fdv * price))}  ${c.muted(`+${act.buys}b/${act.sells}s`)} total ${buys}b/${sells}s ${taxed} taxed  px ${spotPrice(curve).toExponential(2)}${tax > 0 ? "  " + c.loss(`opening tax ${(tax / 100).toFixed(2)}%`) : ""}`);
          if (curve.readyToGraduate) console.log(`   ${c.neon("ready to graduate")}: the curve is sold out, the pool comes next`);
        } else if (rec.phase === 2) {
          const { key, pairToken } = await poolKeyFor(token);
          if (pairToken !== ZERO_ADDR) { console.log(`   ${c.neon("graduated")} into a ${short(pairToken)} pool; watch tracks ETH pairs only`); break; }
          const out = await quoteV4(key, false, 10n ** 24n); // 1M tokens
          const perToken = Number(out) / 1e18 / 1e6;
          console.log(`${c.muted(new Date().toISOString().slice(11, 19))}  ${c.neon("pool")}  1M tokens → ${eth(out)} ETH  px ${perToken.toExponential(2)} ETH  fdv ${(perToken * 1e9).toFixed(2)} ETH ${c.muted(usd(price === null ? null : perToken * 1e9 * price))}`);
        } else {
          console.log(`${c.muted(new Date().toISOString().slice(11, 19))}  phase ${rec.phase}: ${["curve", "swept, pool not created yet", "pool", "rescued"][rec.phase]}`);
        }
      } catch (e) { log.warn((e as Error).message.split("\n")[0]); }
      if (opts.for && Date.now() - t0 > Number(opts.for) * 1000) break;
      await new Promise((r) => setTimeout(r, Number(opts.every) * 1000));
    }
  });

// ---------------------------------------------------------------------------------------------
program
  .command("fees <token>")
  .description("creator-fee forensics: who is paid, how much accrued, every claim with a timestamp")
  .action(async (tokenArg: string) => {
    const token = addr(tokenArg);
    const price = await ethUsd();
    const ev = await findLaunch(token);
    if (!ev) { log.error("no pons v2 TokenLaunched event found for this token"); process.exit(1); }
    const [meta, rec] = await Promise.all([readTokenMeta(token).catch(() => null), publicClient.readContract({ address: ADDR.ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] })]);
    const fees = await feeForensics(rec.creatorFeeRecipient, ev.curve, ev.blockNumber);
    const u = (w: bigint) => c.muted(usd(price === null ? null : (Number(w) / 1e18) * price));
    console.log(`${c.white(meta?.name ?? token)} ${c.neon(meta?.symbol ? "$" + meta.symbol : "")}  creator tax ${Number(rec.creatorTaxBps) / 100}%  launched block ${ev.blockNumber}`);
    console.log(`${c.white("fee recipient")}  ${fees.recipient}${fees.recipient.toLowerCase() === ev.deployer.toLowerCase() ? "  (the deployer)" : "  " + c.neon("(not the deployer)")}`);
    console.log(`${c.white("credited")}       ${eth(fees.totalCredited)} ETH ${u(fees.totalCredited)}  = curve ${eth(fees.curveCredited)} ETH in ${fees.curveCredits} sweeps + pool ${eth(fees.poolCredited)} ETH in ${fees.poolCredits} sweeps ${c.muted("(pool sweeps cover every pool of this recipient)")}`);
    console.log(`${c.white("claimed")}        ${eth(fees.totalClaimed)} ETH ${u(fees.totalClaimed)} in ${fees.claims.length} claim${fees.claims.length === 1 ? "" : "s"}   ${c.white("pending")} ${eth(fees.pending)} ETH ${u(fees.pending)}`);
    if (fees.claims.length) {
      console.log(hr());
      for (const cl of fees.claims) console.log(`   ${cl.timestamp ? iso(cl.timestamp) : "block " + cl.block}   ${pad(eth(cl.amount) + " ETH", 14)} ${u(cl.amount)}   ${c.muted(cl.tx)}`);
    }
  });

// ---------------------------------------------------------------------------------------------
program
  .command("dev <address>")
  .description("deployer history: every pons v2 launch by this address in the window, with graduation phase")
  .option("--blocks <n>", "window in blocks (~864k per day)", "2600000")
  .action(async (a: string, opts: { blocks: string }) => {
    const deployer = addr(a);
    const hist = await deployerHistory(deployer, BigInt(opts.blocks));
    console.log(`${c.white(deployer)}  ${hist.launches.length} launches in ${opts.blocks} blocks, ${c.neon(String(hist.graduated))} graduated, ${hist.onCurve} on curve`);
    console.log(hr());
    const newest = hist.launches.slice(-25);
    const metas = await Promise.all(newest.map((l) => readTokenMeta(l.token).catch(() => null)));
    const blocks = await Promise.all(newest.map((l) => publicClient.getBlock({ blockNumber: l.blockNumber }).catch(() => null)));
    newest.forEach((l, i) => {
      const m = metas[i];
      const ts = blocks[i] ? iso(Number(blocks[i]!.timestamp)) : `block ${l.blockNumber}`;
      console.log(`   ${ts}  ${pad((m?.symbol ? "$" + m.symbol : "?").slice(0, 12), 12)} ${pad((m?.name ?? "").slice(0, 28), 28)} ${pad(l.phaseName, 8)} ${c.muted(l.token)}`);
    });
    if (hist.launches.length > 25) console.log(c.muted(`   … ${hist.launches.length - 25} older launches not listed`));
  });

const { registerTradeCommands } = await import("./cli-trade.js");
registerTradeCommands(program);

program.parseAsync(process.argv).catch((e) => {
  const err = e as Error & { details?: string; shortMessage?: string };
  log.error(err.shortMessage ?? err.message.split("\n")[0], err.details ? c.muted(`(${err.details})`) : "");
  process.exit(1);
});
