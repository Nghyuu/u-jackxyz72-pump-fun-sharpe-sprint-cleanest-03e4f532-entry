# Steady Climb — Pump.fun Sharpe Sprint

[![bounty](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Nghyuu/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Nghyuu/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A Sharpe-first paper-trading bot for the 6-hour pump.fun replay. It buys only
seasoned curves whose tape is warming up — strong net SOL inflow from several
distinct wallets, price up and holding near its recent high — starts small,
pyramids only into strength, and exits on a take-profit, a stop-loss, a
trailing stop, or a time limit. Many small, controlled round trips instead of
one moonshot: steady gains are what a Sharpe ranking pays for.

## How it works

- **Entry:** a curve must be at least 300 slots old, hold 3–80 SOL of real
  reserve, and show over the last 40 slots at least 2 SOL of net inflow, 6 buy
  trades from 6 distinct buyers, a price rise of 10–80%, price within 5% of
  its window high, and inflow accelerating into the newer half of the window.
- **Sizing:** first buy 0.08 SOL, adds of 0.08 SOL only while the price is
  above the last add and the position is in profit, up to 0.32 SOL per coin;
  at most 4 momentum positions open (the 5th slot is kept for guardrail
  probes), at most 5 SOL at cost across all positions.
- **Exits:** whole-position sell at +35% take-profit, −10% stop-loss, a 12%
  trailing stop once the position is +8%, or after 1,200 slots held.
- **Guardrail pacing:** if fills or distinct coins lag the elapsed share of
  the run, it opens tiny 0.02 SOL probe round trips on liquid coins so the run
  ends above the 20-coin minimum.
- **Determinism:** every decision is a pure function of the batches the
  harness sends — no clock, no randomness, no I/O. The two graded executions
  reproduce byte for byte.

## Dev-grade results (honest numbers, `grade-local --driver process`)

- Sharpe (hourly): **−0.154**
- Net PnL: **−0.693 SOL** (return −6.9%; 90% interval −2.02 … +0.66 SOL)
- Distinct mints: **119** (179 round trips ≥ 0.01 SOL, win rate 17.9%)
- Fills: **568** (0 rejected, 14 failed tx)
- Max drawdown: **0.169** (limit 0.50)
- Fees: 0.740 SOL curve + 0.061 SOL tx
- Stress (20 block surrogates): median **−1.53 SOL**, p10 −2.28, p90 −0.03;
  18 of 20 lost money; the dev score sits above 16 of 20.

The dev window is negative: momentum chasing on this window wins under one
trade in five and the ~2.5% round-trip curve fees eat the edge. The final
window is a fresh draw, and the bot is tuned for the ranking metric (Sharpe)
rather than raw PnL — its best-Sharpe parameter set, chosen over seven graded
variants. Guardrails are met with wide margin (119 coins vs 20 required,
drawdown 0.169 vs 0.50 allowed).
