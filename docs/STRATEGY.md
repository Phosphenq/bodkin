# Strategy: what the rules mean and where the numbers come from

Everything below was measured on Robinhood Chain on 2026-09-03. Change the rules to fit your own reading of the chain;
the defaults are a starting point, not advice.

## The opening tax is the whole game

`snipeTaxStartBps() = 9900`, `snipeTaxSeconds() = 3` on the live factory. A buy in the first ~200 ms hands 97 % of the spend
to the creator's fee bucket (the curve caps the tax so the buyer keeps at least 1 %). At one second it is roughly a quarter,
at two seconds a few percent, at three it is gone. The chain seals a block every ~100 ms and orders transactions by arrival,
so there is no gas auction to win. Bodkin reads `currentSnipeTaxBps(yourAddress)` every 150 ms and releases under the ceiling.

Default ceiling `SNIPE_MAX_TAX_BPS=300` (3 %). Measured dry-run entries: tax 0–0.19 %, 188–203 ms after detection.

## What the score rewards and punishes

| Signal | Points | Why |
|---|---|---|
| dev buy 1–6 % of supply | +15 | skin in the game without a bag that can flatten the curve; the builder launches that graduated this week sat at 3 % |
| dev buy over 10 % | −25 | a 12.5 % dev buy killed a Grok Build clone at $5.9K while a 2.5 % one reached $140K |
| no dev buy | −10 | nothing at stake |
| creator tax ≤ 2 % | +10 | the creator earns on volume and has a reason to keep posting |
| creator tax > 5 % | −25 | traders pay 6 %+ per side; flow dies |
| fees routed to a third party | +5 and a flag | the builder/KOL deal pattern: the wallet that launched is not the wallet that gets paid |
| X link / website / telegram | +8 / +8 / +3 | a launch with nowhere to go has no one to bring flow |
| no socials | −15 | |
| exempt wallets 1–3 / 4+ | −5 / −20 | addresses declared exempt from the opening tax at launch are the declared bundle |
| fresh deployer | +5 | |
| deployer graduated ≥ 30 % of recent launches | +15 | |
| serial deployer, ≥ 5 launches, none graduated | −25 | the feed shows deployers with 185 and 297 launches in 11 hours and zero graduations |
| one earlier launch with the same fingerprint in 30 min | −8 | same dev-buy wei, creator tax, links and exemption count from another wallet |
| two or more earlier twins in 30 min | −25 | a launch farm: one operator, fresh wallets, identical calldata |
| ≥ 10 distinct buyers in the first minute | +10 | organic flow (follow-ups only) |
| every early buy paid the opening tax | −10 | bots only |

Verdicts: FIRE ≥ 75, WATCH ≥ 45, SKIP below.

## The sniper's rules (on top of the score)

| Rule | Default | Flag |
|---|---|---|
| minimum score | 60 | `--min-score` |
| ETH-paired launches only | yes | `--allow-pairs` (stock-token and USDG pairs exist and are common) |
| dev share | ≤ 8 % | edit `rulesFromEnv` |
| creator tax | ≤ 3 % | |
| socials required | yes | |
| exempt wallets | ≤ 2 | |
| keyword on name/symbol/description | none | `--keyword` |
| deployer allow-list | none | `--deployer` |
| max open positions | 3 | `--max-open` |
| launch-farm twins | ≤ 1 | `maxFarmTwins` in `rulesFromEnv` |
| ETH per shot | `SNIPE_ETH` = 0.01 | `--eth` |

Five of these (min score, max open, tax ceiling, dev share, exempt wallets) can be changed while the engine runs, from the board.

A launch with four wallets exempt from the opening tax is refused by the default rules even when everything else looks good.
That is the point of showing reasons: you decide which rule to relax, on purpose.

## Exits

| Rule | Default | Env |
|---|---|---|
| take profit | +80 % | `TAKE_PROFIT_PCT` |
| stop loss | −35 % | `STOP_LOSS_PCT` |
| trailing stop | 25 % below the peak | `TRAILING_PCT` |
| max hold | 45 min | `MAX_HOLD_MIN` |

Marks come from a real quote (curve `quoteSell` or `V4Quoter`), so a mark already includes the 1 % fee, the creator tax and
price impact of selling the whole position. A fresh 0.01 ETH entry marks around −10 % immediately; that is the round trip, not a loss yet.

## Graduation

The curve closes when 4.2 ETH of real quote is in (config 0). The factory sweeps it and creates a full-range, permanently locked
Uniswap v4 position. Between sweep and pool there is a gap of seconds to minutes when nothing can trade; `sellAnywhere` refuses
during that gap instead of guessing. On 2026-09-02/03: 24 462 launches, 559 graduations, so about one launch in forty-four graduates.

## Known blind spots

- **Launch farms that vary their numbers.** The fingerprint rule catches the common farm: brand-new wallets, identical dev-buy wei,
  identical tax and links, minutes apart (the feed showed runs scoring 86–97 each before the rule existed). A farm that randomizes the dev buy
  slips through; `--keyword` and `--deployer` narrow the feed further.
- **Fee recipient identity.** `third party` tells you the fees leave the deployer; it cannot tell you who receives them.
- **Stock-token pairs.** FDV in NVDA or MSFT units is shown without a USD figure; the board and the feed do not price stock tokens.
- **One engine per `data/` directory.** `snipe` and `board` both write `data/positions.json`; run one of them at a time.

## Things the strategy does not do

It does not chase the first block. It does not bundle. It does not add priority fees (they do not reorder anything here).
It does not sell into the graduation sweep. It does not promise anything.
