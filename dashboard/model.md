# Radar 2: the value model

This page ranks protocols that **record no token** by an implied value. The value is a claim about what a
token would be worth if the protocol's record stayed as it is. It is not a prediction that a token will be
issued, and it is not a price.

## The formula

```
implied = round(
    tvl_usd
  * category_multiple      // learned from live protocols in the same category
  * 0.55                   // pre-token discount: launch, liquidity and execution risk
  * growth_multiplier      // 7-day TVL change, clamped and damped
  * tenure_multiplier      // how long the protocol has run with no token
  * chain_multiplier       // depth and breadth of its chains
)
```

Every input is one of the snapshot's ten fields, or a table learned from the snapshot. No protocol name is
special-cased.

## The category multiple is learned

For every protocol in the snapshot that records a token and a market cap, `mcap_usd / tvl_usd` is one
comparable. Ratios below 0.005 or above 10 are dropped so one micro-cap or one extreme outlier cannot move
the table. The global median is the fallback.

A category with **at least three** comparables uses its own median. A thinner category inherits the global
median, because one live token is not a category. The applied multiple is clamped to **0.05–0.45**. The
global median on this snapshot is **0.241** from **108** live comparables. The tightest category is
Lending at 0.131 (14 comparables); the widest is Basis Trading at 0.45 after clamping (6 comparables).

The **0.55 pre-token discount** is a single, explicit haircut for the fact that the token does not exist
yet: no liquidity, no price discovery, no guarantee of a launch, and a real chance the protocol never
issues one. It applies to every row, so it changes the level of the board, not its order.

## Growth is damped

`change_7d` is clamped to **−50%..+100%** and passed through at **30%**. A +100% week gives a 1.30
multiplier; a −50% week gives 0.85. A null report is neutral at 1.00. Seven days is noisy, so the model
lets it move a rank without letting it dominate one.

## Tenure is the time without a token

The age is the days from `listed_at` to `as_of`: the day DefiLlama began tracking the protocol, which is
the only age record the snapshot carries. It is a lower bound on the protocol's real age.

| Age | Multiplier | Reading |
| --- | --- | --- |
| 0 days | 0.60 | listed, unproven |
| 90 days | 0.80 | one quarter of history |
| 2 years | 1.15 | the sweet spot: proven, still no token |
| 4 years | 1.08 | proven, launch urgency fading |
| 5 years | 1.05 | long record, slower expected launch |
| 10 years | 1.00 | a durable protocol that may never launch |
| unknown | 0.85 | neutral-discount, never a free pass |

The curve is linearly interpolated between those points. The peak at two years is deliberate: a protocol
that has survived long enough to prove its product, but has not yet issued a token, is the strongest
pre-token candidate. A protocol listed last month is not yet proven; one listed a decade ago has had many
chances to launch and its urgency decays.

## Chain depth is a small modifier

For each chain, the snapshot's protocols that list it are summed into a TVL figure. The figure is
log-scaled across all chains to a 0–1 depth score. The deepest chain sets `0.94 + 0.12 × depth`; up to five
additional chains with a depth score above 0.5 add `0.008` each, capped at **1.10**. A protocol with no
chain recorded takes 0.94. This keeps chain breadth a tie-breaker, not the main event.

## Why the top ranks are top

The top of the board is driven by TVL first, then by the category multiple and tenure. The largest
watchlist protocols are asset managers and allocators with billions of TVL and more than a year of tracked
history. Their categories have fewer than three live comparables, so the model uses the global 0.241
multiple rather than a noisy category median. That is deliberate: a single live token in a category is not
enough evidence to change the multiple for every protocol in it.

The detail view of every row shows the same five factors, the raw snapshot fields, and the page's own
recomputation of the row. The model panel reports how many rows the page recomputed to the same number
`board.json` carries, and how many farm plans the page regenerated to the same strings.

## What the board does not claim

- A protocol that records no token is described exactly that way. The snapshot is DefiLlama's record, not
  proof; a protocol may have a token its record does not carry.
- The board does not say a token will be issued, or when.
- The farm plans are operational sketches: what to do, what it costs, how long to hold. They are not
  financial advice, and no plan asks the reader to pay to claim or to share a seed phrase.
- The watchlist is the floor, never the ceiling. The board covers all 40 watchlist slugs and adds
  independent pre-token protocols below the $50M floor, screened for the same wrapped, staked, bridged,
  versioned and exchange-branded products the house excluded.
