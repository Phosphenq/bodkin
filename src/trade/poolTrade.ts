import { parseEventLogs, type Address } from "viem";
import { factoryAbi, tokenAbi, BPS } from "../abi/pons.js";
import { erc20Abi, permit2Abi } from "../abi/uniswap.js";
import { ADDR, ZERO, fastClient, publicClient } from "../chain.js";
import { quoteSell, readCurveState } from "../pons/curve.js";
import { ensureAllowance, sellOnCurve, type BuyResult, type SellResult } from "./curveTrade.js";
import { detectRouterLayout, encodeV4Swap, poolKeyFor, ponsPoolKey, quoteV4 } from "./v4.js";
import { requireAccount, walletClient } from "./wallet.js";

/** Post-graduation venue: the Uniswap v4 pool behind the pons hook, reached through the UniversalRouter. */

const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = Number((1n << 48n) - 1n);

/** v0.1 trades pools in native ETH only; a USDG- or stock-paired pool needs the pair asset, not ETH. */
async function ethPoolKey(token: Address) {
  const { key, pairToken, phase } = await poolKeyFor(token);
  if (phase !== 2) throw new Error(`token is in phase ${phase} (${["curve", "swept", "pool", "rescued"][phase]}), no pool to trade`);
  if (pairToken !== ZERO) throw new Error(`pool is paired with ${pairToken}, not ETH; v0.1 trades ETH pairs only`);
  return key;
}

export async function buyOnPool(token: Address, ethIn: bigint, slippageBps: number, dryRun: boolean): Promise<BuyResult> {
  const key = await ethPoolKey(token);
  const quoted = await quoteV4(key, true, ethIn);
  const minOut = (quoted * (BPS - BigInt(slippageBps))) / BPS;
  const base: BuyResult = { dryRun, venue: "pool", ethIn, tokensQuoted: quoted, minOut };
  if (dryRun) return base;
  const layout = await detectRouterLayout(key);
  const call = encodeV4Swap(key, true, ethIn, minOut, layout);
  const hash = await walletClient().sendTransaction({ to: call.to, data: call.data, value: call.value });
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`pool buy reverted: ${hash}`);
  const me = requireAccount().address.toLowerCase();
  const transfers = parseEventLogs({ abi: tokenAbi, logs: rc.logs, eventName: "Transfer" });
  const tokensOut = transfers
    .filter((t) => t.address.toLowerCase() === token.toLowerCase() && t.args.to.toLowerCase() === me)
    .reduce((a, t) => a + t.args.value, 0n);
  return { ...base, tokensOut, hash, gasUsed: rc.gasUsed };
}

export async function sellOnPool(token: Address, tokensIn: bigint, slippageBps: number, dryRun: boolean): Promise<SellResult> {
  const key = await ethPoolKey(token);
  const quoted = await quoteV4(key, false, tokensIn);
  const minOut = (quoted * (BPS - BigInt(slippageBps))) / BPS;
  const base: SellResult = { dryRun, venue: "pool", tokensIn, ethQuoted: quoted, minOut };
  if (dryRun) return base;
  const me = requireAccount().address;
  // The router pulls ERC-20 input through Permit2: token -> Permit2 (ERC-20 approve), then Permit2 -> router.
  await ensureAllowance(token, ADDR.permit2, tokensIn);
  const [p2amount, p2exp] = await publicClient.readContract({ address: ADDR.permit2, abi: permit2Abi, functionName: "allowance", args: [me, token, ADDR.universalRouter] });
  if (p2amount < tokensIn || p2exp < Math.floor(Date.now() / 1000) + 600) {
    const h = await walletClient().writeContract({ address: ADDR.permit2, abi: permit2Abi, functionName: "approve", args: [token, ADDR.universalRouter, MAX_UINT160, MAX_UINT48] });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
  const layout = await detectRouterLayout(key);
  const call = encodeV4Swap(key, false, tokensIn, minOut, layout);
  const balBefore = await publicClient.getBalance({ address: me });
  const hash = await walletClient().sendTransaction({ to: call.to, data: call.data, value: call.value });
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`pool sell reverted: ${hash}`);
  const balAfter = await publicClient.getBalance({ address: me });
  const gasCost = rc.gasUsed * (rc.effectiveGasPrice ?? 0n);
  return { ...base, ethOut: balAfter - balBefore + gasCost, hash, gasUsed: rc.gasUsed };
}

/** Route a sell by graduation phase: curve while trading, pool after graduation, refuse while swept. */
export async function sellAnywhere(token: Address, tokensIn: bigint, slippageBps: number, dryRun: boolean): Promise<SellResult> {
  const rec = await publicClient.readContract({ address: ADDR.ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
  if (!rec.exists) throw new Error("not a pons v2 token");
  if (rec.phase === 0) return sellOnCurve(rec.curve, token, tokensIn, slippageBps, dryRun);
  if (rec.phase === 2) return sellOnPool(token, tokensIn, slippageBps, dryRun);
  throw new Error(`phase ${rec.phase} (${["curve", "swept", "pool", "rescued"][rec.phase]}): trading is halted between sweep and pool creation`);
}

/** ETH the wallet would get for `tokens` right now on whichever venue is open. Null while swept. */
export async function valueNow(token: Address, tokens: bigint): Promise<{ eth: bigint; venue: "curve" | "pool" } | null> {
  const rec = await publicClient.readContract({ address: ADDR.ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
  if (rec.phase === 0) {
    const s = await readCurveState(rec.curve, undefined, fastClient);
    if (s.graduated || s.readyToGraduate) return null;
    return { eth: quoteSell(s, tokens), venue: "curve" };
  }
  if (rec.phase === 2) {
    if (rec.pairToken !== ZERO) return null; // value in a non-ETH pair asset is not an ETH mark
    return { eth: await quoteV4(ponsPoolKey(token, rec.pairToken, Number(rec.tickSpacing)), false, tokens), venue: "pool" };
  }
  return null;
}

export const tokenBalance = (token: Address, owner: Address): Promise<bigint> =>
  publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
