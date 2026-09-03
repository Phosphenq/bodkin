import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData } from "viem";
import { universalRouterAbi } from "../src/abi/uniswap.js";
import { encodeV4Swap, poolId, ponsPoolKey } from "../src/trade/v4.js";
import { exitReason, type Position } from "../src/trade/positions.js";

const TOKEN = "0x3333333333333333333333333333333333333333" as const;

test("ETH is always currency0 of a pons pool and the id is a keccak of the five key words", () => {
  const k = ponsPoolKey(TOKEN);
  assert.equal(k.currency0, "0x0000000000000000000000000000000000000000");
  assert.equal(k.currency1, TOKEN);
  assert.equal(k.fee, 0);
  assert.equal(k.tickSpacing, 200);
  assert.match(poolId(k), /^0x[0-9a-f]{64}$/);
  assert.notEqual(poolId(k), poolId({ ...k, tickSpacing: 60 }));
});

test("a buy carries msg.value, a sell carries none, and both decode as UniversalRouter.execute with one V4_SWAP command", () => {
  const k = ponsPoolKey(TOKEN);
  for (const layout of ["current", "legacy"] as const) {
    const buy = encodeV4Swap(k, true, 10n ** 16n, 1n, layout, 1_800_000_000);
    const sell = encodeV4Swap(k, false, 10n ** 24n, 1n, layout, 1_800_000_000);
    assert.equal(buy.value, 10n ** 16n);
    assert.equal(sell.value, 0n);
    const d = decodeFunctionData({ abi: universalRouterAbi, data: buy.data });
    assert.equal(d.functionName, "execute");
    assert.equal(d.args[0], "0x10");
    assert.equal((d.args[1] as readonly string[]).length, 1);
  }
  const cur = encodeV4Swap(k, true, 1n, 0n, "current", 1);
  const leg = encodeV4Swap(k, true, 1n, 0n, "legacy", 1);
  assert.ok(cur.data.length > leg.data.length, "the current layout carries one extra word (minHopPriceX36)");
});

test("exit rules: take profit, stop loss, trailing from peak, max hold", () => {
  const base: Position = { id: "p", token: TOKEN, curve: TOKEN, symbol: "T", name: "T", openedAt: 1_000, dryRun: true, entryEth: (10n ** 18n).toString(), tokens: "1", peakEth: (10n ** 18n).toString(), lastEth: (10n ** 18n).toString(), lastAt: 1_000, status: "open", exits: [] };
  const rules = { takeProfitPct: 80, stopLossPct: 35, trailingPct: 25, maxHoldMin: 45 };
  assert.equal(exitReason(base, 10n ** 18n, rules, 1_100), null);
  assert.match(exitReason(base, 19n * 10n ** 17n, rules, 1_100)!, /take profit/);
  assert.match(exitReason(base, 6n * 10n ** 17n, rules, 1_100)!, /stop loss/);
  assert.match(exitReason({ ...base, peakEth: (16n * 10n ** 17n).toString() }, 11n * 10n ** 17n, rules, 1_100)!, /trailing/);
  assert.match(exitReason(base, 10n ** 18n, rules, 1_000 + 46 * 60)!, /max hold/);
});
