# Bodkin brand: how the Robinhood Chain language is applied

Source system: `design.md` (measured from robinhood.com/us/en/crypto/chain on 2026-09-03) and the official
Robinhood Chain brand guidelines. Bodkin borrows the palette and the posture, never the marks.

## Name

A **bodkin** is the narrow, square-section arrowhead English longbowmen used to punch through plate armour.
On pons v2 every launch opens behind a 99 % tax that decays to zero in three seconds; the bot's job is to
wait at full draw and go through that wall at the right instant. One word, one image, one mechanic.

## Palette (product)

| Token | Hex | Bodkin role |
|---|---|---|
| `bg` | `#000000` | terminal and board canvas |
| `panel` | `#110E08` | cards, table rows on hover, position tiles |
| `chip` | `#23231F` | tags: launchpad, pair asset, phase |
| `line` | `#35322D` | every hairline |
| `text` | `#FFFFFF` | names, headline numbers |
| `text-2` | `#D9D9D9` | body, labels |
| `muted` | `#BFBFBF` | timestamps, addresses, footnotes |
| `neon` | `#CCFF00` | **the trigger only**: FIRE decisions, the live-mode badge, primary buttons, score ≥ 80 |
| `on-neon` | `#110E08` | text on neon |
| `loss` | `#FF6B5C` | negative PnL and stop-loss text only; never a fill |

Rule of one chroma: profit is not green. A winning position is white on black with a neon badge; a losing one
is `loss` text. Neon is spent on decisions, not on moods.

## Type

| Role | Face | Why |
|---|---|---|
| display, section titles, the wordmark | **Instrument Serif** 400, negative tracking, sentence case | open stand-in for Martina Plantijn; the "finance" voice |
| UI, labels, buttons | **Inter** 400/500 | open stand-in for Capsule Sans |
| numbers, addresses, hashes, the CLI | **JetBrains Mono** 400 | the site loads a mono face and never uses it; a terminal is where it belongs |

Weight ceiling 500. Nothing bold. Nothing all-caps except ticker symbols, which are data.

## Shape and depth

- Controls are full pills (44 px, `0 32px`). Panels are 24 px. Tags are 12 px. The three radii never swap roles.
- Depth is surface tone plus a 1 px `line`. Zero shadows, zero gradients on black.
- One polarity flip per surface: the README hero band and the "armed" state of the board header are neon with
  `on-neon` text. Everything else stays black.

## Logo

`assets/icon.svg`: a vertical bodkin point (a narrow kite with a notched base) on a short shaft, neon on black,
inside a 24 px-radius tile with a hairline. It reads at 40 px in a launch feed, which is the size that matters.
`assets/logo.svg` adds the lowercase serif wordmark. `assets/token.svg` is the 1000×1000 token image: the point
alone, no text.

Never place the Robinhood feather or wordmark next to it. Refer to the network only as "Robinhood Chain".

## Voice

Sentence case. Short declaratives. Numbers before adjectives. The interface says what it read on chain and
what it decided; it does not promise profit. Every claim in the README is a measurement with a date.
