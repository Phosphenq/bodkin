import assert from "node:assert/strict";
import { test } from "node:test";
import { DeployerIndex, limiter } from "../src/pons/deployerIndex.js";
import type { LaunchIntel } from "../src/pons/enrich.js";
import { scoreLaunch } from "../src/score.js";
import { decide, rulesFromEnv } from "../src/snipe.js";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const D1 = "0x1111111111111111111111111111111111111111" as const;

test("the limiter runs at most n jobs at once and drains in order", async () => {
  const limit = limiter(2);
  let active = 0, peak = 0;
  const order: number[] = [];
  const job = (i: number) => limit(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); active--; order.push(i); return i; });
  const out = await Promise.all([1, 2, 3, 4, 5].map(job));
  assert.deepEqual(out, [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  assert.equal(order.length, 5);
});

test("the deployer index answers from memory: prior launches before the block, graduations counted", () => {
  const idx = new DeployerIndex();
  const ev = (token: string, block: bigint) => ({ token: token as `0x${string}`, curve: ZERO, deployer: D1, pairToken: ZERO, launchConfigId: 0n, graduationThreshold: 0n, blockNumber: block, txHash: "0x00" as const, logIndex: 0, seenAtMs: 0 });
  assert.equal(idx.quick(D1, 100n), null, "not ready before build");
  idx.ready = true;
  idx.note(ev("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 10n));
  idx.note(ev("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 20n));
  idx.note(ev("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 20n)); // duplicate delivery is ignored
  idx.note(ev("0xcccccccccccccccccccccccccccccccccccccccc", 30n));
  (idx as unknown as { graduatedTokens: Set<string> }).graduatedTokens.add("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.deepEqual(idx.quick(D1, 25n), { prior: 2, graduated: 1 });
  assert.deepEqual(idx.quick(D1, 5n), { prior: 0, graduated: 0 });
  assert.deepEqual(idx.size, { deployers: 1, tokens: 3, graduated: 1 });
});

test("a launch farm is three wallets printing the same fingerprint inside half an hour", async () => {
  const { FarmDetector } = await import("../src/pons/fingerprint.js");
  const base = {
    ev: { token: "0x3333333333333333333333333333333333333333", curve: ZERO, deployer: D1, pairToken: ZERO, launchConfigId: 0n, graduationThreshold: 0n, blockNumber: 1n, txHash: "0x00", logIndex: 0, seenAtMs: 0 },
    meta: { name: "x", symbol: "X", logo: "", description: "", socials: { twitter: "https://x.com/a", telegram: "", discord: "", website: "https://a.b", farcaster: "" } },
    record: { creatorFeeRecipient: D1, creatorTaxBps: 200, phase: 0, poolFee: 0, tickSpacing: 200, buybackEnabled: false },
    tx: { from: D1, to: ZERO, valueWei: 0n, devBuyWei: 600_000_000_000_000n, devTokens: 0n, exemptions: [], recipient: D1, timestamp: 0 },
    curve: null, pair: { address: ZERO, symbol: "ETH", decimals: 18, usdPerUnit: null }, errors: [],
  } as unknown as LaunchIntel;
  const farms = new FarmDetector();
  const other = (d: string) => ({ ...base, ev: { ...base.ev, deployer: d as `0x${string}` } });
  assert.equal(farms.note(base, 1_000).twins, 0);
  assert.equal(farms.note(base, 2_000).twins, 0, "the same wallet again is not a twin");
  assert.equal(farms.note(other("0x2222222222222222222222222222222222222222"), 3_000).twins, 2);
  const third = farms.note(other("0x3333333333333333333333333333333333333333"), 4_000);
  assert.equal(third.twins, 3);
  assert.equal(farms.note(other("0x4444444444444444444444444444444444444444"), 4_000 + 31 * 60_000).twins, 0, "outside the window nothing counts");
  const s = scoreLaunch(base, { farmTwins: 3 });
  assert.ok(s.reasons.some((r) => r.startsWith("-25 launch farm")));
  assert.equal(decide(base, s, rulesFromEnv(), 0, 3).why.some((w) => w.startsWith("launch farm")), true);
  assert.equal(decide(base, s, rulesFromEnv(), 0, 1).why.some((w) => w.startsWith("launch farm")), false);
});

test("the session budget stops firing before the wallet is drained", async () => {
  const { scoreLaunch } = await import("../src/score.js");
  const base = {
    ev: { token: "0x3333333333333333333333333333333333333333", curve: "0x4444444444444444444444444444444444444444", deployer: D1, pairToken: ZERO, launchConfigId: 0n, graduationThreshold: 0n, blockNumber: 1n, txHash: "0x00", logIndex: 0, seenAtMs: 0 },
    meta: { name: "x", symbol: "X", logo: "", description: "a real description of a real thing that is long enough", socials: { twitter: "https://x.com/a", telegram: "", discord: "", website: "https://a.b", farcaster: "" } },
    record: { creatorFeeRecipient: D1, creatorTaxBps: 100, phase: 0, poolFee: 0, tickSpacing: 200, buybackEnabled: false },
    tx: { from: D1, to: ZERO, valueWei: 0n, devBuyWei: 53_519_145_802_650_970n, devTokens: 30_000_000n * 10n ** 18n, exemptions: [], recipient: D1, timestamp: 0 },
    curve: { quoteReserve: 1n, tokenReserve: 1n, realQuoteReserve: 0n, sellableTokens: 1n, reservedTokens: 0n, graduationThreshold: 1n, feeBps: 100n, creatorTaxBps: 100n, openingTaxBps: 0n, graduated: false, readyToGraduate: false, launchedAt: 0, readAtMs: 0 },
    pair: { address: ZERO, symbol: "ETH", decimals: 18, usdPerUnit: null }, errors: [],
  } as unknown as LaunchIntel;
  const rules = rulesFromEnv({ sessionBudgetWei: 25n * 10n ** 15n, ethPerBuy: 10n ** 16n }); // 0.025 ETH budget, 0.01 per buy
  const s = scoreLaunch(base, { deployer: { prior: 0, graduated: 0 } });
  assert.equal(decide(base, s, rules, 0, 0, 0n).fire, true);
  assert.equal(decide(base, s, rules, 0, 0, 10n ** 16n).fire, true, "second buy fits: 0.02 of 0.025");
  const third = decide(base, s, rules, 0, 0, 2n * 10n ** 16n);
  assert.equal(third.fire, false, "third buy would exceed the budget");
  assert.ok(third.why[0].startsWith("session budget"));
});

test("an unreadable launch is refused as unreadable, not as a rule failure", () => {
  const intel: LaunchIntel = {
    ev: { token: "0x3333333333333333333333333333333333333333", curve: ZERO, deployer: D1, pairToken: ZERO, launchConfigId: 0n, graduationThreshold: 0n, blockNumber: 1n, txHash: "0x00", logIndex: 0, seenAtMs: 0 },
    meta: null, record: null, tx: null, curve: null, pair: { address: ZERO, symbol: "ETH", decimals: 18, usdPerUnit: null }, errors: ["tx: HTTP 429 after 5 tries"],
  };
  const d = decide(intel, scoreLaunch(intel), rulesFromEnv(), 0);
  assert.equal(d.fire, false);
  assert.equal(d.why.length, 1);
  assert.match(d.why[0], /^unreadable: tx: HTTP 429/);
});
