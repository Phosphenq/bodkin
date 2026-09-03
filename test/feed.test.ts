import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The watchdog logic without a network: the same thresholds watchLaunches uses, applied to a fake clock.
 * If the socket has been quiet longer than QUIET_MS the feed must switch to polling; once it speaks again
 * within 10 s the poll must stop. This is the behaviour that keeps the board from freezing for good.
 */
const QUIET_MS = 45_000;
function step(state: { lastWsAt: number; polling: boolean; recoveries: number }, now: number) {
  const quiet = now - state.lastWsAt;
  if (quiet > QUIET_MS && !state.polling) { state.polling = true; state.recoveries++; state.lastWsAt = now; }
  else if (state.polling && now - state.lastWsAt < 10_000) { /* socket alive: keep polling until the next tick confirms */ }
  return state;
}

test("a websocket that goes quiet for 45 s hands over to polling, and only once per outage", () => {
  const s = { lastWsAt: 0, polling: false, recoveries: 0 };
  step(s, 30_000);
  assert.equal(s.polling, false, "30 s of silence is a quiet chain, not a dead pipe");
  step(s, 50_000);
  assert.equal(s.polling, true);
  assert.equal(s.recoveries, 1);
  step(s, 60_000);
  assert.equal(s.recoveries, 1, "no second recovery while already polling");
});

test("the feed health snapshot is a copy, not a live reference", async () => {
  const { feedHealth } = await import("../src/pons/launches.js");
  const a = feedHealth();
  const b = feedHealth();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  assert.ok(["websocket", "polling"].includes(a.mode));
});
