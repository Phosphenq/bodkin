import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { Action, Command, stateViewAbi, universalRouterAbi, v4QuoterAbi } from "../abi/uniswap.js";
import { ADDR, ZERO, publicClient } from "../chain.js";

/**
 * Graduated pons tokens live in Uniswap v4 pools keyed {ETH, token, fee 0, tickSpacing 200, hooks = pons meme hook}.
 * Swaps go through the UniversalRouter V4_SWAP command with SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL.
 */

export interface PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }

export function ponsPoolKey(token: Address, pairToken: Address = ZERO, tickSpacing = 200, hooks: Address = ADDR.ponsHook): PoolKey {
  const [c0, c1] = BigInt(token) < BigInt(pairToken) ? [token, pairToken] : [pairToken, token];
  // pons v2 pools carry fee 0 on the key; the hook charges the swap fee instead (docs.ponsfamily.com/v2, "Uniswap v4 pools").
  return { currency0: c0, currency1: c1, fee: 0, tickSpacing, hooks };
}

/**
 * The pool key a pons launch actually graduated into, from the factory record: pair token, tick spacing
 * and fee are per launch config, not constants. Throws for launches that have not reached the pool phase.
 */
export async function poolKeyFor(token: Address): Promise<{ key: PoolKey; pairToken: Address; phase: number }> {
  const { factoryAbi } = await import("../abi/pons.js");
  const r = await publicClient.readContract({ address: ADDR.ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
  if (!r.exists) throw new Error("not a pons v2 token");
  return { key: ponsPoolKey(token, r.pairToken, Number(r.tickSpacing), ADDR.ponsHook), pairToken: r.pairToken, phase: Number(r.phase) };
}

export const poolId = (k: PoolKey): Hex =>
  keccak256(encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));

export interface PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  /** currency1 units per one currency0 unit: sqrtPriceX96 encodes sqrt(token1/token0). */
  oneForZero: number;
  /** currency0 units per one currency1 unit (for an ETH pair: ETH per token). */
  zeroForOne: number;
}

export async function poolState(key: PoolKey): Promise<PoolState> {
  const id = poolId(key);
  const [slot0, liquidity] = await Promise.all([
    publicClient.readContract({ address: ADDR.v4StateView, abi: stateViewAbi, functionName: "getSlot0", args: [id] }),
    publicClient.readContract({ address: ADDR.v4StateView, abi: stateViewAbi, functionName: "getLiquidity", args: [id] }),
  ]);
  const sqrt = Number(slot0[0]) / 2 ** 96;
  const oneForZero = sqrt * sqrt;
  return { sqrtPriceX96: slot0[0], tick: slot0[1], liquidity, oneForZero, zeroForOne: oneForZero === 0 ? 0 : 1 / oneForZero };
}

export async function quoteV4(key: PoolKey, zeroForOne: boolean, amountIn: bigint): Promise<bigint> {
  const { result } = await publicClient.simulateContract({
    address: ADDR.v4Quoter,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
  });
  return result[0];
}

export type RouterLayout = "current" | "legacy";

const SWAP_CURRENT = parseAbiParameters("((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)");
const SWAP_LEGACY = parseAbiParameters("((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)");

export interface SwapCall { to: Address; data: Hex; value: bigint }

/** Calldata for one exact-input single-hop v4 swap through the UniversalRouter. */
export function encodeV4Swap(key: PoolKey, zeroForOne: boolean, amountIn: bigint, amountOutMin: bigint, layout: RouterLayout, deadlineSec = Math.floor(Date.now() / 1000) + 60): SwapCall {
  const actions = encodePacked(["uint8", "uint8", "uint8"], [Action.SWAP_EXACT_IN_SINGLE, Action.SETTLE_ALL, Action.TAKE_ALL]);
  const swap = layout === "current"
    ? encodeAbiParameters(SWAP_CURRENT, [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: amountOutMin, minHopPriceX36: 0n, hookData: "0x" }])
    : encodeAbiParameters(SWAP_LEGACY, [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: amountOutMin, hookData: "0x" }]);
  const cIn = zeroForOne ? key.currency0 : key.currency1;
  const cOut = zeroForOne ? key.currency1 : key.currency0;
  const settle = encodeAbiParameters(parseAbiParameters("address, uint256"), [cIn, amountIn]);
  const take = encodeAbiParameters(parseAbiParameters("address, uint256"), [cOut, amountOutMin]);
  const input = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [swap, settle, take]]);
  const data = encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [encodePacked(["uint8"], [Command.V4_SWAP]), [input], BigInt(deadlineSec)] });
  return { to: ADDR.universalRouter, data, value: cIn === ZERO ? amountIn : 0n };
}

let detected: RouterLayout | null = null;

/**
 * The deployed router predates or postdates the `minHopPriceX36` field in ExactInputSingleParams.
 * Settle it by simulating a 0.0001 ETH buy in a live pool with a funded sender (state override), once per process.
 */
export async function detectRouterLayout(key: PoolKey): Promise<RouterLayout> {
  if (detected) return detected;
  const probeFrom: Address = "0x000000000000000000000000000000000000bEEF";
  for (const layout of ["current", "legacy"] as RouterLayout[]) {
    const call = encodeV4Swap(key, true, 100_000_000_000_000n, 0n, layout);
    try {
      await publicClient.call({ account: probeFrom, to: call.to, data: call.data, value: call.value, stateOverride: [{ address: probeFrom, balance: 10n ** 18n }] });
      detected = layout;
      return layout;
    } catch { /* try the other layout */ }
  }
  throw new Error("neither UniversalRouter param layout simulates; pool may lack liquidity or router ABI changed");
}
