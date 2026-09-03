# Command reference

Every command, every flag, every environment variable. Run any command with `--help` for the same text in the terminal.
`bodkin` is the installed binary; from a source checkout use `npx tsx src/cli.ts <command>` or `npm run <script>`.

Commands that can move money (`snipe`, `buy`, `sell`, `claim`, `board --live`) are **dry run unless you pass `--live`**.
A dry run reads the same chain state and prints the same decision; it just does not sign.

| Command | What it does | Needs a key |
|---|---|---|
| [`doctor`](#doctor) | RPC, chain id, live pons parameters, optional pool probe | no |
| [`hunt`](#hunt) | live feed of launches with a score and reasons | no |
| [`board`](#board) | the same engine as `snipe` behind a local web page with controls | only with `--live` |
| [`snipe`](#snipe) | auto-buy launches that pass the rules, manage exits | only with `--live` |
| [`watch`](#watch) | follow one token: curve fill, flow, tax, then the pool price | no |
| [`scan`](#scan) | everything on chain about one token | no |
| [`fees`](#fees) | who is paid on a token and every claim | no |
| [`dev`](#dev) | every launch by one deployer with its phase | no |
| [`buy`](#buy) | buy a token on the curve or the pool | only with `--live` |
| [`sell`](#sell) | sell a share of your balance wherever the token trades | yes |
| [`positions`](#positions) | open and closed positions with live marks | no |
| [`wallet`](#wallet) | the configured signer: address, balance, unclaimed fees | yes |
| [`claim`](#claim) | claim your creator fees from the pons escrow | only with `--live` |

---

## doctor

```
bodkin doctor [--probe]
```

Reads, from the live factory: `launchEnabled`, `launchFee`, `snipeTaxStartBps`, `snipeTaxSeconds`, `maxCreatorTaxBps`, and checks that the
hook, escrow and pool manager the factory points at are the ones bodkin knows. Prints the RPC round trip, launches in the last ~5 minutes,
ETH/USD, and whether a key is configured.

`--probe` additionally finds the most recent ETH-paired graduation, quotes 0.001 ETH through the Uniswap `V4Quoter`, reads the pool's
liquidity, and settles the UniversalRouter parameter layout by simulation. If the probe passes, pool-side sells will work.

## hunt

```
bodkin hunt [--backfill <n>] [--min-score <n>] [--fire-only] [--no-follow] [--json] [--poll <ms>] [--for <seconds>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--backfill <n>` | 3 | show the last n launches before going live |
| `--min-score <n>` | 0 | hide launches below this score (hidden launches get no follow-ups either) |
| `--fire-only` | off | show only launches whose verdict is FIRE |
| `--no-follow` | off | skip the +15 s and +60 s follow-up lines |
| `--json` | off | one JSON object per line instead of cards: `ev`, `meta`, `record`, `tx`, `curve`, `deployer`, `score` |
| `--poll <ms>` | `POLL_MS` (300) | HTTP poll interval when no websocket is set |
| `--for <seconds>` | | stop after this many seconds |

Each card: name, symbol, contract, verdict and score; dev buy as a share of supply and in the pair asset; creator tax; where the fees go
(`deployer` or `third party`); wallets declared exempt from the opening tax; socials and the description; the deployer's prior launches and
graduations in the index window; the curve bar, real quote in, FDV, and the opening tax at read time; then every scoring reason.
`hunt` also appends a line per launch to `data/launches.jsonl`.

## board

```
bodkin board [--port <n>] [--live] [--eth <n>] [--min-score <n>] [--keyword <regex>] [--allow-pairs]
```

Starts the same engine as `snipe` and serves `http://127.0.0.1:4663` (or `BOARD_PORT`). Everything on the page is described in
[BOARD.md](./BOARD.md): launches with a score bar and the first pass reason, a detail drawer per launch with links and every scoring line,
positions with live marks and a **close now** button, rules with steppers that change the running engine, pause/resume, filters, search,
keyboard shortcuts, sound on fire. Dry run unless `--live`.

## snipe

```
bodkin snipe [--live] [--eth <n>] [--min-score <n>] [--max-tax-bps <n>] [--slippage <bps>] [--keyword <regex>]
             [--deployer <address...>] [--max-open <n>] [--allow-pairs] [--for <seconds>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--live` | off | sign and send; without it every buy and sell is quoted and logged only |
| `--eth <n>` | `SNIPE_ETH` (0.01) | ETH per buy |
| `--min-score <n>` | 60 | minimum score to fire |
| `--max-tax-bps <n>` | `SNIPE_MAX_TAX_BPS` (300) | do not buy while the opening tax is above this |
| `--slippage <bps>` | `SNIPE_SLIPPAGE_BPS` (300) | rate slippage for `minTokensOut` / `minQuoteOut` |
| `--keyword <regex>` | | only launches whose name, symbol or description match (case-insensitive) |
| `--deployer <a...>` | | only these deployers |
| `--max-open <n>` | 3 | simultaneous positions |
| `--allow-pairs` | off | also fire on USDG- and stock-token-paired launches |
| `--for <seconds>` | | stop after this many seconds |

The loop: detect → read → score → rules → wait until `currentSnipeTaxBps(you) ≤ ceiling` (polled every 150 ms, give up after 12 s) →
buy on the curve → mark every 5 s → sell on take profit, stop loss, trailing stop, or max hold. Every `pass` prints the rule that refused
the launch. Exits are configured in `.env` (`TAKE_PROFIT_PCT`, `STOP_LOSS_PCT`, `TRAILING_PCT`, `MAX_HOLD_MIN`).
Optional Telegram alerts on fire and exit when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set.

Run **one** engine per `data/` directory: `snipe` and `board` both write `data/positions.json`.

## watch

```
bodkin watch <token> [--every <seconds>] [--for <seconds>]
```

One line every `--every` seconds (default 5) while the token is on the curve: curve bar, real quote / threshold, FDV, buys and sells since
the last line and in total, taxed buys, spot price, and the opening tax while it is non-zero. After graduation it quotes 1 M tokens through
the v4 pool and prints the price and FDV. Tracks ETH pairs on the pool side.

## scan

```
bodkin scan <token>
```

Launch time and block, launcher and recipient of the dev tokens, curve address and phase, exempt wallets, links, the fee recipient with
credited / claimed / pending amounts, the deployer's record in the window, and the curve's activity since launch. One page, all from chain.

## fees

```
bodkin fees <token>
```

Reads the pons fee escrow's own `Credited` and `Claimed` events for the token's creator-fee recipient: how much was credited by this
token's curve, how much by the shared v4 hook (which covers every graduated pool of that recipient), every claim with its timestamp and
transaction, and what is still pending. The `(not the deployer)` flag means the fees leave the wallet that launched the token.

## dev

```
bodkin dev <address> [--blocks <n>]
```

Every pons v2 launch by the address inside the window (default 2 600 000 blocks, about three days), the graduation phase of the newest 25,
and how many graduated in total.

## buy

```
bodkin buy <token> <eth> [--live] [--slippage <bps>]
```

Quotes in the protocol's own integer order and buys on the curve before graduation or on the v4 pool after it. `minTokensOut` bounds the
rate, so a clamped fill at that rate settles and a worse one reverts. Calling `buy` in the first second of a launch pays the opening tax;
`snipe` is the command that waits it out.

## sell

```
bodkin sell <token> [pct] [--live] [--slippage <bps>]
```

Sells `pct` percent of your balance (default 100) wherever the token trades: the curve while it is open, the v4 pool after graduation.
Refuses during the swept gap between the two. Pool sells go through Permit2 (one ERC-20 approve and one Permit2 approve the first time).

## positions

```
bodkin positions
```

Every position in `data/positions.json` with a live mark for the open ones: entry, current or exit value, PnL, USD, and the exit reason.

## wallet

```
bodkin wallet
```

The signer's address, ETH balance, unclaimed creator fees in the pons escrow, and an explorer link. Prints nothing about the key itself.

## claim

```
bodkin claim [--live]
```

If you are the creator wallet of a launch, your share of every trade accrues in the pons escrow. `claim` reads the pending balance and,
with `--live`, calls `claim()` and prints what arrived.

---

## Environment (`.env`)

| Variable | Default | Used by |
|---|---|---|
| `RPC_URL` | publicnode + official RPC | comma-separated, preferred first; `#nologs` after an endpoint that refuses `eth_getLogs`; one private provider can carry everything |
| `RPC_WS_URL` | publicnode websocket | detection by subscription; `off` = HTTP polling; or your own `wss://` |
| `POLL_MS` | 300 | HTTP detection interval when the websocket is off |
| `RPC_IN_FLIGHT` | 3 | requests in flight through the gate |
| `RPC_SPACING_MS` | 50 | minimum gap between request starts |
| `RPC_LOGS_SPACING_MS` | 400 | minimum gap between `eth_getLogs` calls, which the public endpoint meters separately |
| `PRIVATE_KEY` | | `snipe --live`, `buy --live`, `sell`, `wallet`, `claim`, `board --live` |
| `SNIPE_ETH` | 0.01 | ETH per buy |
| `SNIPE_SLIPPAGE_BPS` | 300 | slippage |
| `SNIPE_MAX_TAX_BPS` | 300 | opening-tax ceiling |
| `TAKE_PROFIT_PCT` | 80 | exit |
| `STOP_LOSS_PCT` | 35 | exit |
| `TRAILING_PCT` | 25 | exit, measured from the peak |
| `MAX_HOLD_MIN` | 45 | exit |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | | alerts |
| `BOARD_PORT` | 4663 | board |
| `NO_COLOR` | | plain output; `FORCE_COLOR=1` keeps colors when piping |

## Files

| Path | What |
|---|---|
| `data/positions.json` | every position the engine opened, with marks and exits |
| `data/launches.jsonl` | one line per launch `hunt` presented |
| `.env` | your settings and, if you trade live, your key; git-ignored |
