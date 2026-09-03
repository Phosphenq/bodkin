import assert from "node:assert/strict";
import { test } from "node:test";
import type { LaunchIntel } from "../src/pons/enrich.js";
import { scoreLaunch } from "../src/score.js";
import { decide, rulesFromEnv } from "../src/snipe.js";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const A = "0x1111111111111111111111111111111111111111" as const;
const B = "0x2222222222222222222222222222222222222222" as const;

/** The builder-launch shape seen on mainnet this week: 3% dev buy, 1% creator tax, fees to a third party, X + website, 4 exempt wallets. */
function builderLaunch(over: Partial<LaunchIntel> = {}): LaunchIntel {
  return {
    ev: { token: "0x3333333333333333333333333333333333333333", curve: "0x4444444444444444444444444444444444444444", deployer: A, pairToken: ZERO, launchConfigId: 0n, graduationThreshold: 42n * 10n ** 17n, blockNumber: 53_000_000n, txHash: "0x00", logIndex: 0, seenAtMs: 0 },
    meta: { name: "Night Shift Harness", symbol: "SHIFT", logo: "ipfs://x", description: "A local agent harness that works the night shift on your tasks so you do not have to", socials: { twitter: "https://x.com/example/status/1", telegram: "", discord: "", website: "https://github.com/example/shift", farcaster: "" } },
    record: { creatorFeeRecipient: B, creatorTaxBps: 100, phase: 0, poolFee: 0, tickSpacing: 200, buybackEnabled: false },
    tx: { from: A, to: ZERO, valueWei: 0n, devBuyWei: 53_519_145_802_650_970n, devTokens: 30_000_000n * 10n ** 18n, exemptions: [A, B, ZERO, ZERO], recipient: A, timestamp: 1_788_397_521 },
    curve: { quoteReserve: 1_733_000_000_000_000_000n, tokenReserve: 970_000_000n * 10n ** 18n, realQuoteReserve: 53_000_000_000_000_000n, sellableTokens: 684_285_714n * 10n ** 18n, reservedTokens: 285_714_285n * 10n ** 18n, graduationThreshold: 42n * 10n ** 17n, feeBps: 100n, creatorTaxBps: 100n, openingTaxBps: 0n, graduated: false, readyToGraduate: false, launchedAt: 1_788_397_521, readAtMs: 0 },
    pair: { address: ZERO, symbol: "ETH", decimals: 18, usdPerUnit: null },
    errors: [],
    ...over,
  };
}

test("a builder-shaped launch scores FIRE even with its declared bundle", () => {
  const s = scoreLaunch(builderLaunch(), { deployer: { prior: 0, graduated: 0 } });
  assert.equal(s.verdict, "FIRE");
  assert.ok(s.reasons.some((r) => r.includes("third party")));
  assert.ok(s.reasons.some((r) => r.includes("declared bundle")));
});

test("a serial deployer with no graduations and no socials is a SKIP", () => {
  const i = builderLaunch({ meta: { ...builderLaunch().meta!, socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" } } });
  const s = scoreLaunch(i, { deployer: { prior: 185, graduated: 0 } });
  assert.equal(s.verdict, "SKIP");
});

test("dev share over 10% costs 25 points", () => {
  const heavy = builderLaunch({ tx: { ...builderLaunch().tx!, devTokens: 181_600_000n * 10n ** 18n } });
  const a = scoreLaunch(builderLaunch()).total;
  const b = scoreLaunch(heavy).total;
  assert.equal(a - b, 40, "15 for the good band minus -25 for over 10%");
});

test("the sniper refuses a launch with four exempt wallets by default, because that is a declared bundle", () => {
  const rules = rulesFromEnv();
  const s = scoreLaunch(builderLaunch(), { deployer: { prior: 0, graduated: 0 } });
  const d = decide(builderLaunch(), s, rules, 0);
  assert.equal(d.fire, false);
  assert.ok(d.why.some((w) => w.includes("exempt wallets")));
});

test("the sniper fires when the bundle rule is relaxed, and stops at the position cap", () => {
  const rules = rulesFromEnv({ maxExemptWallets: 4 });
  const s = scoreLaunch(builderLaunch(), { deployer: { prior: 0, graduated: 0 } });
  assert.equal(decide(builderLaunch(), s, rules, 0).fire, true);
  assert.equal(decide(builderLaunch(), s, rules, 3).fire, false);
  assert.equal(decide(builderLaunch({ pair: { address: "0x1111111111111111111111111111111111111111", symbol: "USDG", decimals: 6, usdPerUnit: 1 } }), s, rules, 0).fire, false);
});
