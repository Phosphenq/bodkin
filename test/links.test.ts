import { test } from "node:test";
import assert from "node:assert/strict";
import { links, refLine } from "../src/util/links.js";

const TOKEN = "0x6219c797646FD54EdDE1497f66d3F76a2Bb67F81";
const CURVE = "0x38B9A9d9DB16c302c30a1046AB2d4B11Fc1f668B";

test("axiom is keyed by the lowercase curve, fomo by the lowercase token", () => {
  assert.equal(links.axiom(CURVE), "https://axiom.trade/meme/0x38b9a9d9db16c302c30a1046ab2d4b11fc1f668b?chain=robinhood");
  assert.equal(links.fomo(TOKEN), "https://fomo.family/tokens/robinhood/0x6219c797646fd54edde1497f66d3f76a2bb67f81");
  assert.equal(links.pons(TOKEN), `https://www.ponsfamily.com/token/${TOKEN}`);
});

test("empty handles drop the sign-up links and the sign-up line", () => {
  const a = process.env.REF_AXIOM, f = process.env.REF_FOMO;
  process.env.REF_AXIOM = ""; process.env.REF_FOMO = "";
  try {
    assert.equal(links.axiomRef(), "");
    assert.equal(links.fomoRef(), "");
    assert.equal(refLine(), "");
  } finally {
    process.env.REF_AXIOM = a ?? "phosphen"; process.env.REF_FOMO = f ?? "phosphenq";
  }
  assert.equal(links.axiomRef(), `https://axiom.trade/@${process.env.REF_AXIOM}`);
  assert.match(refLine().replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, ""), /^ sign up  axiom · fomo$/);
});
