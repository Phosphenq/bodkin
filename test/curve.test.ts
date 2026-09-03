import assert from "node:assert/strict";
import { test } from "node:test";
import { amountOut, effectiveOpeningBps, fdvQuote, minOutFromRate, progress, quoteBuy, quoteSell, spotPrice, type CurveState } from "../src/pons/curve.js";

/** Launch config 0 as read from the factory on 2026-09-03: 1B supply, phantom 1.68 ETH, threshold 4.2 ETH, fee 1%. */
const fresh = (over: Partial<CurveState> = {}): CurveState => ({
  quoteReserve: 1_680_000_000_000_000_000n,
  tokenReserve: 1_000_000_000n * 10n ** 18n,
  realQuoteReserve: 0n,
  sellableTokens: 714_285_714_285_714_285_714_285_715n,
  reservedTokens: 285_714_285_714_285_714_285_714_285n,
  graduationThreshold: 4_200_000_000_000_000_000n,
  feeBps: 100n,
  creatorTaxBps: 100n,
  openingTaxBps: 0n,
  graduated: false,
  readyToGraduate: false,
  launchedAt: 0,
  readAtMs: 0,
  ...over,
});

test("constant product: 0.0535 ETH on a fresh curve buys about 3.0% of supply (Looprat, Foreman)", () => {
  const q = quoteBuy(fresh(), 53_519_145_802_650_970n);
  const share = Number(q.tokensOut) / 1e27;
  assert.ok(share > 0.0295 && share < 0.0305, `got ${share}`);
  assert.equal(q.refund, 0n);
  assert.equal(q.clamped, false);
});

test("fees come off the input on a buy and off the output on a sell, so a round trip loses more than the fee", () => {
  const s = fresh();
  const spend = 10n ** 17n;
  const q = quoteBuy(s, spend);
  const after: CurveState = { ...s, quoteReserve: s.quoteReserve + spend - (spend * 200n) / 10_000n, tokenReserve: s.tokenReserve - q.tokensOut };
  const back = quoteSell(after, q.tokensOut);
  assert.ok(back < spend, "selling straight back must not profit");
  assert.ok(back > (spend * 95n) / 100n, `round trip lost too much: ${back}`);
});

test("opening tax is capped so a buyer always nets at least 1%", () => {
  assert.equal(effectiveOpeningBps(fresh({ openingTaxBps: 9_900n })), 9_700n);
  assert.equal(effectiveOpeningBps(fresh({ openingTaxBps: 250n })), 250n);
  assert.equal(effectiveOpeningBps(fresh({ openingTaxBps: 0n })), 0n);
});

test("a 99% opening tax makes the first-second buy nearly worthless", () => {
  const taxed = quoteBuy(fresh({ openingTaxBps: 9_900n }), 10n ** 17n);
  const clean = quoteBuy(fresh(), 10n ** 17n);
  assert.ok(taxed.tokensOut * 20n < clean.tokensOut, "taxed buy should get under 5% of the clean fill");
});

test("a buy larger than the sellable remainder clamps and refunds", () => {
  const s = fresh({ sellableTokens: 1_000_000n * 10n ** 18n });
  const q = quoteBuy(s, 10n ** 18n);
  assert.equal(q.clamped, true);
  assert.equal(q.tokensOut, s.sellableTokens);
  assert.ok(q.refund > 0n);
  assert.equal(q.spent + q.refund, 10n ** 18n);
});

test("minOut bounds the rate, progress and fdv are sane", () => {
  assert.equal(minOutFromRate(10_000n, 300), 9_700n);
  assert.equal(progress(fresh({ realQuoteReserve: 2_100_000_000_000_000_000n })), 0.5);
  assert.equal(progress(fresh({ realQuoteReserve: 9n * 10n ** 18n })), 1);
  const px = spotPrice(fresh());
  assert.ok(Math.abs(px - 1.68e-9) < 1e-12);
  assert.ok(Math.abs(fdvQuote(fresh()) - 1.68) < 1e-6, "fdv of a fresh curve equals the phantom reserve");
  assert.equal(amountOut(100n, 1000n, 1000n), 90n);
});
