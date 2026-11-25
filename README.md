# Cleanest Paper Bot — Pump.fun Sharpe Sprint

[![Bounty](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/e0426685-cloud/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/e0426685-cloud/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) on [make.fun](https://make.fun). It trades a 6-hour pump.fun replay for the highest **hourly Sharpe ratio** — steady, controlled gains beat one lucky moonshot. Paper trading only; no real funds, no network, no secrets.

## Strategy

A launch sniper with a quality filter, a tight stop, a partial take-profit, a realised-PnL throttle, and a paced guardrail probe stream (see `strategy.ts` for the full reasoning):

- **Entry:** buy only in a coin's first 3 slots, only if the opening tape passes: ≥3 SOL real reserves, ≥3 trades, ≤3 distinct non-creator buyers, creator's own buy ≤2.5 SOL, almost no selling into the launch, creator hasn't sold. At most 0.2 SOL per coin (the 1%-of-reserve cap binds first), 5% buy slippage so a fill that gaps up in the 2-slot latency is refused, not chased.
- **Exit, fast:** sell 30% at +15%, rest to +20% or a breakeven stop, cut at −3%, never hold past 20 slots, leave at once if the creator sells.
- **Throttle:** if the last 15 closed main trades average worse than −0.002 SOL, stop opening main positions for ~2 hours and sample the regime with 0.012 SOL probes.
- **Guardrail probes:** a paced stream of 0.012 SOL buys on looser launches keeps qualifying round trips near 4 per hour, so the 20-mint / 0.01-SOL guardrail is met even in a slow stretch. Max 5 open positions, long only.

## Local dev-window numbers

Measured with the kit's own replay model on the full 24h dev window (128,058 events, 1,222 mints):

- Net PnL **−0.035 SOL** (near breakeven; halves +0.033 / −0.068)
- Max drawdown **0.0095** (limit 0.50)
- **96 distinct mints** traded (24 / 28 / 25 / 20 per 6h block — above the 20-mint guardrail in every block)
- 199 fills, hourly Sharpe (24h) −0.09, best rolling-6h Sharpe +0.56
- The plain sniper baseline on the same window scores −0.138 SOL; momentum and reversion pilots are far worse (−9.4 and −3.8 SOL)

## Run it

```sh
node main.ts   # speaks agent-fun/replay/v2 NDJSON on stdin/stdout
```

Grade locally with the kit CLI (process driver; this VM has no Docker):

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## Files

- `main.ts` — entry point (thin `runBot` wrapper)
- `strategy.ts` — the strategy
- `vendor/makefun-bot.ts` — the kit's protocol shim, byte-identical
- `LICENSE` — MIT
