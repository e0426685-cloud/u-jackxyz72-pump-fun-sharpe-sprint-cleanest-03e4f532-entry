// Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins.
// Entry point, run by the grader as `node /bot/main.ts` (Node 22 runs the
// TypeScript as-is; no build step, no install, zero dependencies). The
// strategy lives in strategy.ts; the replay protocol in the vendored SDK
// shim (vendor/makefun-bot.ts, a byte-identical copy of the kit's sdk/ts).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

const strategy = createStrategy();

// Deterministic: the strategy reads nothing but the batches it is fed, so
// two executions produce byte-identical action logs.
await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
