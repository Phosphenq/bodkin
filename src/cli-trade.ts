import type { Command } from "commander";
import { getAddress, isAddress, parseEther, type Address } from "viem";
import { factoryAbi } from "./abi/pons.js";
import { ADDR, publicClient } from "./chain.js";
import { banner } from "./util/banner.js";
import { eth, iso, pad, usd } from "./util/fmt.js";
import { c, log } from "./util/log.js";
import { ethUsd } from "./util/price.js";

/** The commands that can move money. Registered from cli.ts; every one defaults to dry run. */

const addr = (s: string): Address => {
  if (!isAddress(s)) throw new Error(`not an address: ${s}`);
  return getAddress(s);
};

interface SnipeCli { live?: boolean; eth?: string; minScore?: string; maxTaxBps?: string; keyword?: string; deployer?: string[]; maxOpen?: string; for?: string; slippage?: string; allowPairs?: boolean }

async function snipeRules(o: SnipeCli) {
  const { rulesFromEnv } = await import("./snipe.js");
  return rulesFromEnv({
    ...(o.eth ? { ethPerBuy: parseEther(o.eth) } : {}),
    ...(o.minScore ? { minScore: Number(o.minScore) } : {}),
    ...(o.maxTaxBps ? { maxOpeningTaxBps: Number(o.maxTaxBps) } : {}),
    ...(o.slippage ? { slippageBps: Number(o.slippage) } : {}),
    ...(o.keyword ? { keyword: new RegExp(o.keyword, "i") } : {}),
    ...(o.deployer?.length ? { deployers: new Set(o.deployer.map((d) => d.toLowerCase())) } : {}),
    ...(o.maxOpen ? { maxOpenPositions: Number(o.maxOpen) } : {}),
    ...(o.allowPairs ? { ethPairsOnly: false } : {}),
  });
}

const fmtTokens = (n: bigint) => (Number(n) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 0 });

export function registerTradeCommands(program: Command): void {
  program
    .command("snipe")
    .description("auto-buy launches that pass the rules, entering only once the opening tax has decayed; manages exits")
    .option("--live", "sign and send real transactions (default: dry run)")
    .option("--eth <n>", "ETH per buy (default SNIPE_ETH)")
    .option("--min-score <n>", "minimum score to fire (default 60)")
    .option("--max-tax-bps <n>", "opening-tax ceiling in bps before buying (default SNIPE_MAX_TAX_BPS)")
    .option("--slippage <bps>", "slippage in bps (default SNIPE_SLIPPAGE_BPS)")
    .option("--keyword <regex>", "only launches whose name/symbol/description match")
    .option("--deployer <address...>", "only launches from these deployers")
    .option("--max-open <n>", "max simultaneous positions (default 3)")
    .option("--allow-pairs", "also fire on non-ETH pairs (USDG, stock tokens)")
    .option("--for <seconds>", "stop after this many seconds")
    .action(async (o: SnipeCli) => {
      const { startEngine } = await import("./snipe.js");
      const { notify } = await import("./alerts/telegram.js");
      const rules = await snipeRules(o);
      banner();
      const engine = startEngine({ live: !!o.live, rules, onEvent: (e) => { if (e.kind === "fire" || e.kind === "exit") void notify(e); } });
      if (o.for) setTimeout(() => { engine.stop(); console.log(c.muted(`\nbodkin stopped after ${o.for}s`)); process.exit(0); }, Number(o.for) * 1000).unref();
      process.on("SIGINT", () => { engine.stop(); console.log(c.muted("\nbodkin stopped")); process.exit(0); });
    });

  program
    .command("wallet")
    .description("the configured signer: address, ETH balance, unclaimed creator fees; never prints the key")
    .action(async () => {
      const { getAccount } = await import("./trade/wallet.js");
      const { escrowAbi } = await import("./abi/pons.js");
      const acct = getAccount();
      if (!acct) { console.log(c.muted("no PRIVATE_KEY in .env: analytics and dry runs work without one; live trades need it")); return; }
      const [bal, pending, price] = await Promise.all([
        publicClient.getBalance({ address: acct.address }),
        publicClient.readContract({ address: ADDR.ponsEscrow, abi: escrowAbi, functionName: "balanceOf", args: [acct.address] }),
        ethUsd(),
      ]);
      console.log(`${c.white("address")}   ${acct.address}`);
      console.log(`${c.white("balance")}   ${eth(bal)} ETH ${c.muted(usd(price === null ? null : (Number(bal) / 1e18) * price))}`);
      console.log(`${c.white("fees")}      ${eth(pending)} ETH unclaimed in the pons escrow ${c.muted(usd(price === null ? null : (Number(pending) / 1e18) * price))}${pending > 0n ? "   " + c.neon("bodkin claim --live") : ""}`);
      console.log(`${c.white("explorer")}  https://robinhoodchain.blockscout.com/address/${acct.address}`);
    });

  program
    .command("claim")
    .description("claim your creator fees from the pons escrow (the creator wallet of your own launches)")
    .option("--live", "sign and send (default: show what would be claimed)")
    .action(async (o: { live?: boolean }) => {
      const { requireAccount, walletClient } = await import("./trade/wallet.js");
      const { escrowAbi } = await import("./abi/pons.js");
      const { parseEventLogs } = await import("viem");
      const acct = requireAccount();
      const price = await ethUsd();
      const pending = await publicClient.readContract({ address: ADDR.ponsEscrow, abi: escrowAbi, functionName: "balanceOf", args: [acct.address] });
      if (pending === 0n) { console.log(c.muted(`nothing to claim for ${acct.address}`)); return; }
      console.log(`${o.live ? "claiming" : "dry run: would claim"} ${c.neon(eth(pending) + " ETH")} ${c.muted(usd(price === null ? null : (Number(pending) / 1e18) * price))} for ${acct.address}`);
      if (!o.live) return;
      const hash = await walletClient().writeContract({ address: ADDR.ponsEscrow, abi: escrowAbi, functionName: "claim" });
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") { log.error(`claim reverted: ${hash}`); process.exit(1); }
      const got = parseEventLogs({ abi: escrowAbi, logs: rc.logs, eventName: "Claimed" }).reduce((a, l) => a + l.args.amount, 0n);
      console.log(`claimed ${c.neon(eth(got) + " ETH")}  ${c.muted(hash)}`);
    });

  program
    .command("buy <token> <eth>")
    .description("buy a pons v2 token with ETH: on the curve before graduation, on the v4 pool after")
    .option("--live", "sign and send (default: dry run)")
    .option("--slippage <bps>", "slippage in bps", "300")
    .action(async (tokenArg: string, ethArg: string, o: { live?: boolean; slippage: string }) => {
      const token = addr(tokenArg);
      const { buyOnCurve } = await import("./trade/curveTrade.js");
      const { buyOnPool } = await import("./trade/poolTrade.js");
      const rec = await publicClient.readContract({ address: ADDR.ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
      if (!rec.exists) { log.error("not a pons v2 token"); process.exit(1); }
      const amount = parseEther(ethArg);
      const res = rec.phase === 0 ? await buyOnCurve(rec.curve, amount, Number(o.slippage), !o.live) : await buyOnPool(token, amount, Number(o.slippage), !o.live);
      console.log(`${o.live ? "bought" : "dry run:"} ${eth(res.ethIn)} ETH → ${fmtTokens(res.tokensOut ?? res.tokensQuoted)} tokens on the ${res.venue} (min ${fmtTokens(res.minOut)})${res.hash ? "  " + res.hash : ""}`);
    });

  program
    .command("sell <token> [pct]")
    .description("sell a percentage of your balance (default 100): on the curve before graduation, on the v4 pool after")
    .option("--live", "sign and send (default: dry run)")
    .option("--slippage <bps>", "slippage in bps", "300")
    .action(async (tokenArg: string, pctArg = "100", o: { live?: boolean; slippage: string }) => {
      const token = addr(tokenArg);
      const { sellAnywhere, tokenBalance } = await import("./trade/poolTrade.js");
      const { getAccount } = await import("./trade/wallet.js");
      const acct = getAccount();
      if (!acct) { log.error("PRIVATE_KEY is needed to know the balance to sell"); process.exit(1); }
      const bal = await tokenBalance(token, acct.address);
      const amount = (bal * BigInt(Math.round(Number(pctArg) * 100))) / 10_000n;
      if (amount === 0n) { log.error("nothing to sell"); process.exit(1); }
      const res = await sellAnywhere(token, amount, Number(o.slippage), !o.live);
      console.log(`${o.live ? "sold" : "dry run:"} ${fmtTokens(res.tokensIn)} tokens → ${eth(res.ethOut ?? res.ethQuoted)} ETH on the ${res.venue} (min ${eth(res.minOut)})${res.hash ? "  " + res.hash : ""}`);
    });

  program
    .command("positions")
    .description("open and closed positions with live marks")
    .action(async () => {
      const { loadPositions } = await import("./trade/positions.js");
      const { valueNow } = await import("./trade/poolTrade.js");
      const price = await ethUsd();
      const list = loadPositions();
      if (!list.length) { console.log(c.muted("no positions yet")); return; }
      for (const p of list) {
        const entry = BigInt(p.entryEth);
        let mark = BigInt(p.lastEth);
        if (p.status === "open") { const v = await valueNow(p.token, BigInt(p.tokens)).catch(() => null); if (v) mark = v.eth; }
        const last = p.status === "closed" ? BigInt(p.exits.at(-1)?.ethOut ?? "0") : mark;
        const pnl = entry ? Number(((last - entry) * 10_000n) / entry) / 100 : 0;
        const tag = p.status === "open" ? c.neon("open  ") : c.muted("closed");
        const pnlTxt = pnl >= 0 ? c.neon("+" + pnl.toFixed(1) + "%") : c.loss(pnl.toFixed(1) + "%");
        console.log(`${tag} ${pad("$" + p.symbol, 10)} ${p.dryRun ? c.muted("dry ") : c.white("live")}  in ${eth(entry)} ETH  ${p.status === "open" ? "now" : "out"} ${eth(last)} ETH  ${pnlTxt} ${c.muted(usd(price === null ? null : (Number(last - entry) / 1e18) * price))}  ${c.muted(iso(p.openedAt))}${p.status === "closed" ? "  " + c.muted(p.exits.at(-1)?.reason ?? "") : ""}`);
      }
    });

  program
    .command("board")
    .description("local web board on 127.0.0.1: live launches, decisions, positions (dry run unless --live)")
    .option("--port <n>", "port", process.env.BOARD_PORT || "4663")
    .option("--live", "sign and send real transactions")
    .option("--eth <n>", "ETH per buy")
    .option("--min-score <n>", "minimum score to fire")
    .option("--keyword <regex>", "only launches matching")
    .option("--allow-pairs", "also fire on non-ETH pairs")
    .action(async (o: SnipeCli & { port: string }) => {
      const { startBoard } = await import("./board/server.js");
      const rules = await snipeRules(o);
      banner();
      await startBoard({ port: Number(o.port), live: !!o.live, rules });
    });
}
