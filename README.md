<p align="center">
  <img src="./assets/banner.png" alt="bodkin" width="100%">
</p>

<p align="center">
  <img alt="tests" src="https://img.shields.io/badge/tests-18%20passing-CCFF00?style=flat-square&labelColor=110E08">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A520-D9D9D9?style=flat-square&labelColor=110E08">
  <img alt="runtime deps" src="https://img.shields.io/badge/runtime%20deps-3-D9D9D9?style=flat-square&labelColor=110E08">
  <img alt="chain" src="https://img.shields.io/badge/chain-4663-D9D9D9?style=flat-square&labelColor=110E08">
  <img alt="custody" src="https://img.shields.io/badge/custody-none-D9D9D9?style=flat-square&labelColor=110E08">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-FFE700?style=flat-square&labelColor=110E08">
</p>

Every pons v2 launch on Robinhood Chain opens behind a **99 % tax that decays to zero in three seconds**. Racing the first block
hands the buy to the creator. The chain seals a block every 100 ms, orders by arrival, and has no gas auction, so the only edge
left is *when*. Bodkin reads a launch in one call, scores it with rules you can read, waits at full draw until the tax is under
your ceiling, and releases. Local, open, non-custodial, dry run by default.

| The problem | What bodkin does | Command |
|---|---|---|
| 24 000 launches a day, 559 graduate | one multicall per launch: dev buy, creator tax, who gets the fees, declared bundle, deployer record, launch-farm fingerprint, curve progress, then a 0–100 score with reasons | `hunt` · `board` |
| the first second costs 99 % | polls `currentSnipeTaxBps` for **your** address every 150 ms and buys under the ceiling. Measured: 0.19 % tax at entry, every time | `snipe` |
| "who is getting paid on this token?" | reads the fee escrow's own `Credited` / `Claimed` events: recipient, accrued, every claim with a timestamp | `fees` |
| "has this deployer ever graduated anything?" | every launch by the address in the window, with its phase | `dev` |
| following one launch by hand | curve fill, buyers, flow and the opening tax every five seconds, then the pool price | `watch` |
| selling after graduation | routes by phase: curve while trading, Uniswap v4 pool behind the pons hook after, refuses during the swept gap | `sell` |
| your own creator fees | pending balance in the escrow and a one-command claim | `wallet` · `claim` |

---

## Install

Node 20 or newer. Three ways, all of them local.

```sh
# 1. a checkout you can read and edit
git clone https://github.com/Phosphenq/bodkin && cd bodkin
npm install
cp .env.example .env
npx bodkin doctor
```

```sh
# 2. straight from GitHub, no clone
npm install -g github:Phosphenq/bodkin
bodkin doctor
```

```sh
# 3. inside the checkout, without the bin
npm run doctor   ·   npm run hunt   ·   npm run board
```

`.env` works out of the box on the public RPC. No key is needed for `doctor`, `hunt`, `watch`, `scan`, `fees`, `dev`, `positions`,
or any dry run. `PRIVATE_KEY` is needed only for `--live`, `sell`, `wallet` and `claim`.

| | |
|---|---|
| **Required** | Node ≥ 20 |
| **Runtime dependencies** | `viem`, `commander`, `ws` |
| **For live trades** | `PRIVATE_KEY` in `.env` and ETH on Robinhood Chain (bridge at robinhood.com/chain) |
| **Detection** | by subscription over publicnode's free websocket, out of the box; `RPC_WS_URL=off` for 300 ms polling, or your own `wss://` |
| **Public RPCs** | two by default: publicnode for state reads (fast, no `eth_getLogs`) and the official Robinhood RPC for logs (rejects bursts with 429, counts calls inside a JSON-RPC batch, meters `eth_getLogs` separately, challenges noisy clients). Bodkin sends single requests through one gate (`RPC_IN_FLIGHT=3`, `RPC_SPACING_MS=50`, `RPC_LOGS_SPACING_MS=400`), routes each method to an endpoint that serves it, benches one that refuses, and waits instead of failing. `RPC_URL=` a private provider carries everything |

## Sixty seconds

```sh
bodkin doctor --probe     # is the chain there, are the pons numbers what we think, does the v4 quoter answer
bodkin hunt               # watch launches arrive with a score and reasons
bodkin board              # the same engine behind a page on 127.0.0.1:4663, dry run
bodkin snipe              # dry run in the terminal: pass reasons, draw, FIRE, marks, exits
bodkin snipe --live       # after you have watched it for an hour
```

---

## Commands

| Command | What it does | Key |
|---|---|---|
| `doctor [--probe]` | RPC, chain id, live pons parameters, optional pool probe | no |
| `hunt` | live feed of launches with a score and reasons; `--json` for pipelines | no |
| `board` | the engine behind a local web page with controls | `--live` only |
| `snipe` | auto-buy launches that pass the rules, manage exits | `--live` only |
| `watch <token>` | follow one token: curve fill, flow, tax, then the pool price | no |
| `scan <token>` | everything on chain about one token | no |
| `fees <token>` | who is paid on a token and every claim | no |
| `dev <address>` | every launch by one deployer with its phase | no |
| `buy <token> <eth>` | buy on the curve or the pool | `--live` only |
| `sell <token> [pct]` | sell a share of your balance wherever the token trades | yes |
| `positions` | open and closed positions with live marks | no |
| `wallet` | the signer: address, balance, unclaimed fees | yes |
| `claim` | claim your creator fees from the escrow | `--live` only |

Every flag and environment variable: [docs/COMMANDS.md](./docs/COMMANDS.md).

## hunt

<p align="center"><img src="./assets/hunt.png" alt="bodkin hunt: live launch feed with dev buy, creator tax, fee recipient, exempt wallets, deployer record, curve progress and score" width="100%"></p>

One card per launch, a follow-up line at +15 s and +60 s. Every field is a chain read, not an API:

- **dev buy** from the curve's `CurveBuy` events in the launch transaction, as a share of the 1 B supply
- **creator tax** and **fee recipient** from the factory record; `third party` means the fees do not go to the deployer (the builder / KOL deal)
- **exempt wallets**: addresses declared exempt from the opening tax in the launch calldata, which is the declared bundle
- **deployer**: prior launches in ~11 h and how many graduated, from an index built once at startup
- **fingerprint**: the same dev-buy wei, tax and links from other fresh wallets inside 30 minutes is a launch farm, and scores like one
- **curve**: real quote in / graduation threshold, FDV in the pair asset (ETH, USDG, or a stock token), and the opening tax *right now*

```
bodkin hunt --fire-only              # only FIRE verdicts
bodkin hunt --min-score 70 --json    # JSON lines for your own pipeline
bodkin hunt --no-follow --for 300    # cards only, stop after five minutes
```

## board

<p align="center"><img src="./assets/board.png" alt="bodkin board: launches with a score bar and pass reasons, positions with live marks and close buttons, editable rules" width="100%"></p>

```
bodkin board            # http://127.0.0.1:4663, dry run
bodkin board --live
```

The engine and a page to watch it. Click a launch for the whole read: links, description, every rule that refused it, every scoring line.
**pause** stops firing without stopping the feed. **close now** sells a position at the current quote. Five rules have steppers and change the
running engine. `p` pause, `f` fire filter, `/` search, `esc` close. It binds loopback, it cannot buy on demand, and `--live` is a launch
flag, not a button. The rest, and two things hidden in the page: [docs/BOARD.md](./docs/BOARD.md).

<p align="center"><img src="./assets/board-drawer.png" alt="the drawer: contract, links, decision, dev buy, fee recipient, exempt wallets, deployer, curve, every scoring line" width="100%"></p>

## snipe

<p align="center"><img src="./assets/snipe.png" alt="bodkin snipe dry run: pass reasons, draw, and FIRE lines with the tax at entry and the wait in milliseconds" width="100%"></p>

Detect → read → decide → wait at full draw → release → mark every 5 s → exit. Dry run unless `--live`.

```
bodkin snipe                                 # dry run with the defaults from .env
bodkin snipe --eth 0.02 --min-score 70       # bigger shots, stricter score
bodkin snipe --keyword "grok|claude"         # only launches whose name/symbol/description match
bodkin snipe --deployer 0xabc… 0xdef…        # only these deployers
bodkin snipe --allow-pairs                   # also USDG and stock-token pairs
bodkin snipe --live                          # sign and send
```

Every `pass` prints the rule that refused the launch. Looprat, the launch that paid its fee recipient 15.44 ETH in nine hours, is refused by
the defaults: it declared four wallets exempt from the opening tax. Relax `maxExemptWallets` on purpose, or not.

Exits: take profit +80 %, stop loss −35 %, trailing 25 % below the peak, max hold 45 min. Marks are real quotes for the whole position.
The rules, the score and where every number comes from: [docs/STRATEGY.md](./docs/STRATEGY.md).

## fees

<p align="center"><img src="./assets/fees.png" alt="bodkin fees on Looprat: recipient, 15.444 ETH credited, three claims with timestamps" width="100%"></p>

Who is paid, how much accrued from the curve and from the graduated pool, every claim with a timestamp and transaction.
On 2026-09-03 this is what `fees` read for $Looprat: recipient is not the deployer, 15.444 ETH credited, 15.444 ETH claimed in three claims,
the first one four minutes before the builder's "i just claimed the creator fees" post.

## watch, scan, dev

```
bodkin watch 0x642d…68c7   # one line every 5 s: curve bar, flow, taxed buys, price; the pool after graduation
bodkin scan  0x642d…68c7   # one token: launch, dev buy, exempt wallets, links, fees, deployer, curve activity
bodkin dev   0x89e6…8043   # one deployer: every launch in the window with its phase
```

## buy, sell, positions, wallet, claim

```
bodkin buy  <token> 0.01          # curve before graduation, v4 pool after; dry run
bodkin sell <token> 50 --live     # sell half of your balance wherever the token trades
bodkin positions                  # open and closed, marked live
bodkin wallet                     # address, ETH, unclaimed creator fees
bodkin claim --live               # take the fees out of the escrow
```

---

## How it works

```mermaid
flowchart LR
    F["factory<br/>TokenLaunched"] -->|"300 ms poll<br/>or websocket"| D[detect]
    D --> E["enrich<br/>1 multicall + 3 tx reads"]
    E --> S["score"]
    S --> R{"rules"}
    R -->|pass| P["logged with why"]
    R -->|fire| W["wait: tax ≤ ceiling"]
    W --> B["buy on curve"]
    B --> M["mark / 5 s"]
    M --> X["TP · SL · trail · hold · close now"]
    X --> O["sell on curve or v4 pool"]
```

- Detection is a websocket subscription to the factory's `TokenLaunched` log (publicnode, free), or a 300 ms block-range poll. There is no
  mempool to watch: the sequencer broadcasts blocks it has already built.
- Enrichment is one `aggregate3` through the canonical Multicall3 (`0xcA11…CA11`) plus the launch transaction, receipt and block, all through
  one RPC gate that routes each method to a public endpoint that serves it and keeps both from answering 429.
- Deployer records come from an in-memory index of every launch and graduation in the last 400 000 blocks, built once at startup.
- Curve math is the protocol's own integer order (`PonsV2BondingCurve.buy/sell`), so `minTokensOut` is computed with the rounding the
  contract uses.
- After graduation the token trades in a Uniswap v4 pool keyed by the pair token and tick spacing the factory recorded for that launch.
  Quotes come from `V4Quoter`; swaps go through the UniversalRouter `V4_SWAP` command, and the router's parameter layout is settled by
  simulation before the first live swap.

More in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), what can go wrong in [docs/SAFETY.md](./docs/SAFETY.md).

## Numbers behind the defaults (2026-09-03, mainnet)

| | |
|---|---|
| opening tax | 9 900 bps at t=0, window 3 s (`snipeTaxStartBps`, `snipeTaxSeconds` on the factory) |
| launch fee | 0.0005 ETH |
| launches / graduations, 24 h | 24 462 / 559 (`TokenLaunched` / `PoolGraduated`, blocks 52 526 287–53 396 287) |
| tempo | 56–152 launches per 3 000 blocks (~5 min) |
| graduation | 4.2 ETH real quote against a 1.68 ETH phantom reserve; 28.57 % of supply reserved for the pool |
| $Looprat fee recipient | 15.444 ETH credited in 71 sweeps, 3 claims, 0 pending |
| dry-run entries | tax 0.19 %; 1.2–1.6 s after detection over the websocket, which sees the launch block about a second earlier than polling did (polling entries landed 188–203 ms after detection) |
| public RPC | 8 parallel calls pass, 16 → half rejected, a batch of 12 → rejected; 2 calls every 100 ms → zero rejections |

## Tests

```sh
npm test
```

Eighteen checks, no network: the curve quote reproduces the 3.00 % dev buy of Looprat and Foreman from their 0.0535 ETH, round trips lose
more than the fee, the opening-tax cap, clamped fills, the score on a Looprat-shaped launch and on a serial deployer, the sniper's refusals,
the launch-farm fingerprint, the unreadable-launch path, the enrichment limiter, the deployer index, v4 pool ids and both router param layouts,
and every exit rule.

## FAQ

**Is it safe to run?** The default is a dry run and every command says so. Nothing leaves your machine except JSON-RPC to the endpoint you
configured. Read [docs/SAFETY.md](./docs/SAFETY.md) before `--live`.

**Why did it pass a launch that went 10x?** The `pass` line names the rule. The defaults refuse declared bundles, heavy dev buys, serial deployers,
launch farms and launches without socials; a 10x can come from any of those. Change the rule on purpose, from the board or the flags.

**Why is a fresh entry marked −10 %?** Marks are real sell quotes for the whole position: they include the 1 % fee, the creator tax and price
impact. That is the round trip, not a loss yet.

**Does it front-run?** No. There is no mempool and no priority fee on this chain; bodkin waits for the opening tax to decay and buys at arrival order.

**Can I use my own RPC?** Set `RPC_URL` and, for subscriptions, `RPC_WS_URL`. Raise `RPC_IN_FLIGHT` and lower `RPC_SPACING_MS` on a private endpoint.

## Built on

| Source | What was taken |
|---|---|
| [`ponsdotdev/ponsfamily`](https://github.com/ponsdotdev/ponsfamily) · [docs.ponsfamily.com/v2](https://docs.ponsfamily.com/v2) | contract addresses, ABIs, the curve's fee order, graduation phases |
| [`slightlyuseless/pons-sniper`](https://github.com/slightlyuseless/pons-sniper) (MIT) | the integer-order quote port and the opening-tax cap |
| [`chainstacklabs/robinhood-chain-sequencer-feed`](https://github.com/chainstacklabs/robinhood-chain-sequencer-feed) | the fact that there is nothing to front-run |
| [Uniswap v4 periphery](https://github.com/Uniswap/v4-periphery) · [universal-router](https://github.com/Uniswap/universal-router) | `Actions`, `Commands`, `ExactInputSingleParams`, the Robinhood Chain deployment addresses |
| [Robinhood Chain docs](https://docs.robinhood.com/chain/) | RPC, sequencer model, the palette |

Bodkin is independent of pons, Uniswap and Robinhood. It refers to the network as "Robinhood Chain" and uses none of their marks; the feather
and the pixel cat in the board are its own drawings.

## License

MIT. Keep the dry run on until you have watched it for an hour.
