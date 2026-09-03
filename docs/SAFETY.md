# Safety

## Custody

- The only secret is `PRIVATE_KEY` in your own `.env`. It is read by `src/trade/wallet.ts` and used to sign transactions sent to the RPC
  you configured. It is never printed, logged, written to `data/`, or sent anywhere else.
- Use a fresh wallet with only what you are willing to lose in a session. Bodkin never asks for more than one buy at a time.
- `.env` is git-ignored. `data/positions.json` contains token addresses and amounts, not keys.

## Dry run is the default

`snipe`, `buy`, `sell`, `claim` and `board` quote and log without sending unless you pass `--live`. A dry run reads the same chain state
and prints the same decision, so you can watch the engine for an hour before it is allowed to spend anything.

## What can still go wrong with `--live`

| Risk | What bodkin does | What it cannot do |
|---|---|---|
| the curve graduates between quote and send | `minTokensOut` bounds the rate; a clamped fill at that rate settles, a worse one reverts | recover gas spent on a revert |
| a launch is a honeypot on the pool side | the curve itself is protocol code; the pons v4 hook is the same singleton for every launch | guarantee a token's *pool* behaves if the protocol changes |
| a public RPC rate-limits or challenges the client | one gate for every request: two endpoints with capabilities, bounded concurrency, spacing, a cooldown after a 429, a penalty box, retries that wait; detection over a websocket needs no polling | make a public endpoint faster; set `RPC_URL` / `RPC_WS_URL` to a provider |
| the sequencer's compliance filter voids a transaction | none; it is protocol-level | anything |
| stop-loss fires into a thin curve | marks are real quotes for the full position size, so the exit price is what the mark showed | avoid slippage on an illiquid curve |
| a launch farm passes every per-launch rule | the fingerprint rule refuses the third identical launch inside half an hour | catch a farm that varies its numbers |
| you relax `maxExemptWallets` | prints the exact number of exempt wallets and their addresses in `scan` and the drawer | tell you who they are |

## What the board can and cannot do

It listens on 127.0.0.1 only. It can pause and resume firing, close an open position at the current quote, and change five numeric rules
inside fixed bounds. It cannot buy on demand and cannot switch a dry run to live: `--live` is decided when you start it. Anyone on your
machine can open it; nobody outside can. If several people share the machine, start it with a different `--port` and assume they can click.

## Fees and taxes you pay on every trade

- Curve: 1 % base fee plus the creator tax (0–10 %, shown per launch) on the input of a buy and the output of a sell.
- Pool: the pons hook takes 1 % plus the creator tax from the unspecified currency of each swap; the pool's own LP fee is 0.
- Opening tax: 99 % decaying to 0 over 3 s on buys only. Bodkin waits it out; if you call `buy` by hand in the first second, you pay it.

## Not investment advice

Bodkin reads state and executes rules you configured. It has no opinion about any token, and neither does this repository.
