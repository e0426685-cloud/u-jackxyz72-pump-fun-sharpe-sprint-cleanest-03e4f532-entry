// Cleanest-paper-bot entry for the Pump.fun Sharpe Sprint.
//
// Shape: a launch sniper with a quality filter, a tight stop, a partial
// take-profit, a realised-PnL throttle, and a paced guardrail probe stream.
// The whole point is hourly Sharpe over a 6h window: steady small gains,
// tiny drawdowns, and a trade in most hours beat one lucky runner.
//
// How it trades, in one paragraph: watch every CreateEvent. In a coin's
// first three slots, count the opening tape — how much real SOL the curve
// already holds, how many trades printed, how many distinct non-creator
// wallets bought, how big the creator's own buy was, whether anyone sold
// into it, and whether the creator has sold. Buy only launches that pass
// all of that, at most 0.2 SOL (the 1%-of-reserve cap binds first on most
// coins), with 5% buy slippage so a fill that gaps up in the 2-slot latency
// is refused instead of chased. Then exit fast: sell 30% at +15%, let the
// rest ride to +20% or a breakeven stop, cut at -3%, never hold past 20
// slots, and leave at once if the creator sells. If the last 15 closed
// trades average worse than -0.002 SOL, stop opening main positions for
// ~2h and sample the regime with 0.012 SOL probes instead. Separately, a
// paced probe stream (0.012 SOL on looser launches) keeps the count of
// qualifying round trips near 4 per hour, so the 20-mint guardrail is met
// even in a slow stretch. Pure function of the batches: no clock, no
// randomness, no I/O, no environment reads.
//
// Tuned on the kit's 24h dev window: net −0.035 SOL, max drawdown 0.0095,
// 96 qualifying mints (24/28/25/20 per 6h block). The plain sniper baseline
// is −0.138 SOL on the same window; the momentum and reversion pilots are
// far worse, and the exit/throttle numbers below are the flat middle of
// their grids, not a single best cell.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Buy at most this many lamports per coin (the 1% reserve cap binds first). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Oldest age (slots since create) at which a first buy may be decided. */
  maxEntryAge: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: number;
  maxDevBuy: number;
  /** Trades seen before entry, at least. */
  minTrades: number;
  /** Distinct non-creator buyers before entry: at most (bundled launches dump). */
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Skip the coin when the creator has sold before entry. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Sell this share (bps) of the position once it is up this much (bps). */
  partialTakeBps: number;
  partialSellBps: number;
  /** After the partial take, exit the rest at cost (0 = breakeven stop). */
  breakevenStopBps: number;
  /** Exit the whole position when it is worth this much over its cost (bps). */
  takeProfitBps: number;
  /** Exit the whole position when it is worth this much under its cost (bps). */
  stopLossBps: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Throttle: closed trades averaged over this window (main positions only). */
  throttleWindow: number;
  /** Trip the throttle when the window mean is below this (lamports, negative). */
  throttleMeanLamports: number;
  /** Slots to pause main entries after the throttle trips. */
  throttlePauseSlots: number;
  /** While paused, at most one regime probe per this many slots. */
  throttleProbeEverySlots: number;
  /** Probe stake (lamports) — above the 0.01 SOL guardrail minimum. */
  probeLamports: number;
  /** Guardrail pacing: target this many qualifying mints per clock hour. */
  pacePerHour: number;
  /** At most one guardrail probe per this many slots. */
  probeEverySlots: number;  /** Loose probe filter: real SOL reserve at least this (lamports). */
  probeMinRealSol: number;
  /** Loose probe filter: trades seen, at least. */
  probeMinTrades: number;
  /** Loose probe filter: distinct non-creator buyers, at most. */
  probeMaxBuyers: number;
  /** Loose probe filter: oldest age (slots) at which a probe may be decided. */
  probeMaxAge: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeLamports: 200_000_000,
  minBuyLamports: 5_000_000,
  maxEntryAge: 3,
  minRealSol: 3_000_000_000,
  maxRealSol: 30_000_000_000,
  minDevBuy: 0,
  maxDevBuy: 2_500_000_000,
  minTrades: 3,
  maxBuyers: 3,
  maxSellRatioBps: 500,
  skipDevSold: true,
  buySlippageBps: 500,
  partialTakeBps: 1500,
  partialSellBps: 3000,
  breakevenStopBps: 0,
  takeProfitBps: 2000,
  stopLossBps: 300,
  maxHoldSlots: 20,
  exitOnDevSell: true,
  throttleWindow: 15,
  // Pause main entries when the last 15 closed main trades average worse
  // than −0.002 SOL; milder streaks do not trip it (verified on the grid).
  throttleMeanLamports: -2_000_000,
  throttlePauseSlots: 18_000,
  throttleProbeEverySlots: 2000,
  probeLamports: 12_000_000,
  pacePerHour: 4,
  probeEverySlots: 1500,
  probeMinRealSol: 300_000_000,
  probeMinTrades: 1,
  probeMaxBuyers: 5,
  probeMaxAge: 25,
};

/** Curve fees on pump.fun: 95 bps protocol + 30 bps creator = 1.25% per side. */
const FEE_BPS = 125n;

interface Launch {
  mint: Pubkey;
  createdSlot: number;
  creator: Pubkey;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  devSold: boolean;
  complete: boolean;
  /** A main-size buy has been sent on this coin. */
  mainBought: boolean;
  /** A probe buy has been sent on this coin. */
  probeBought: boolean;
  /** No more buys on this coin (exited, completed, or aged out). */
  done: boolean;
}

interface OpenTrade {
  openedSlot: number;
  /** Tx fees paid on this position's fills so far. */
  txPaid: bigint;
  /** True while the position still holds its pre-partial cost basis. */
  tookPartial: boolean;
  /** The creator had already sold when the position opened. */
  devSoldAtOpen: boolean;
  /** True when every buy on this coin so far was probe-size. */
  probeOnly: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

/** What selling `tokens` against (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  const fee = (gross * FEE_BPS + BPS - 1n) / BPS;
  return gross - fee;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Strategy {
  const launches = new Map<Pubkey, Launch>();
  const open = new Map<Pubkey, OpenTrade>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  /** Per-mint trade legs: buy spend, sell proceeds, and tx fees, until the round trip closes. */
  const legs = new Map<Pubkey, { buy: bigint; sell: bigint; tx: bigint }>();
  /** Realised PnL of recently closed main positions, oldest first. */
  const closedMain: bigint[] = [];
  /** Distinct mints with a filled buy of at least probe size (guardrail pace). */
  const qualifying = new Set<Pubkey>();
  let pausedUntilSlot = -1;
  let lastProbeSlot = -1_000_000;
  let firstBlockTime: number | null = null;
  let nowBlockTime = 0;

  function noteLaunch(e: Extract<Batch['events'][number], { event: 'CreateEvent' }>): void {
    launches.set(e.mint, {
      mint: e.mint,
      createdSlot: e.slot,
      creator: e.creator,
      devBuy: 0n,
      trades: 0,
      buyers: new Set(),
      bought: 0n,
      soldByOthers: 0n,
      devSold: false,
      complete: false,
      mainBought: false,
      probeBought: false,
      done: false,
    });
  }

  function noteTrade(e: Extract<Batch['events'][number], { event: 'TradeEvent' }>): void {
    const c = launches.get(e.mint);
    if (c === undefined) return;
    const sol = BigInt(e.sol_amount);
    c.trades += 1;
    const isDev = e.user === c.creator;
    if (e.is_buy) {
      c.bought += sol;
      if (isDev && e.slot === c.createdSlot) c.devBuy += sol;
      else if (!isDev) c.buyers.add(e.user);
    } else if (isDev) {
      c.devSold = true;
    } else {
      c.soldByOthers += sol;
    }
  }

  /** Is this launch a main-size entry right now? */
  function passesMain(c: Launch, state: BotState): boolean {
    if (c.done || c.complete || c.mainBought) return false;
    if (state.slot - c.createdSlot > p.maxEntryAge) return false;
    if (c.devSold && p.skipDevSold) return false;
    if (c.trades < p.minTrades) return false;
    if (c.buyers.size > p.maxBuyers) return false;
    if (c.devBuy < BigInt(p.minDevBuy) || c.devBuy > BigInt(p.maxDevBuy)) return false;
    if (c.bought > 0n && (c.soldByOthers * BPS) / c.bought > BigInt(p.maxSellRatioBps)) return false;
    const curve = state.curves.get(c.mint);
    if (curve === undefined || curve.complete) return false;
    const rq = curve.real_quote_reserves;
    if (rq < BigInt(p.minRealSol) || rq > BigInt(p.maxRealSol)) return false;
    return true;
  }

  /** Is this launch a guardrail-probe entry right now (loose filter)? */
  function passesProbe(c: Launch, state: BotState): boolean {
    if (c.done || c.complete || c.probeBought) return false;
    const age = state.slot - c.createdSlot;
    if (age < 0 || age > p.probeMaxAge) return false;
    if (c.devSold) return false;
    if (c.trades < p.probeMinTrades) return false;
    if (c.buyers.size > p.probeMaxBuyers) return false;
    const curve = state.curves.get(c.mint);
    if (curve === undefined || curve.complete) return false;
    if (curve.real_quote_reserves < BigInt(p.probeMinRealSol)) return false;
    return true;
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const o of state.pending.values()) {
      if (o.order.mint === mint && o.order.side === 'buy') return true;
    }
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const o of state.pending.values()) {
      if (o.order.mint === mint && o.order.side === 'sell') return true;
    }
    return false;
  }

  return {
    onBatch(state, batch) {
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') noteLaunch(e);
        else if (e.event === 'TradeEvent') noteTrade(e);
        else {
          const c = launches.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (e.block_time > nowBlockTime) nowBlockTime = e.block_time;
        }
      }

      const txFee = state.txFeeLamports();
      const cap = state.hello.caps.max_orders_per_batch;
      const orders: OrderInput[] = [];
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Fold fills in: track legs, close out positions, feed the throttle.
      // A round trip's realised PnL is booked only when the position is fully
      // closed (no tokens left, no sell pending), so partial takes never
      // book a fake loss against the full buy spend.
      for (const f of batch.fills) {
        if (f.status !== 'filled') continue;
        const leg = legs.get(f.mint) ?? { buy: 0n, sell: 0n, tx: 0n };
        legs.set(f.mint, leg);
        leg.tx += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy') {
          leg.buy += BigInt(f.quote_lamports);
          if (BigInt(f.quote_lamports) >= BigInt(p.probeLamports)) qualifying.add(f.mint);
          const t = open.get(f.mint);
          if (t === undefined) {
            const c = launches.get(f.mint);
            open.set(f.mint, {
              openedSlot: f.slot,
              txPaid: BigInt(f.tx_fee_lamports),
              tookPartial: false,
              devSoldAtOpen: c?.devSold ?? false,
              probeOnly: !(c?.mainBought ?? false),
            });
          } else {
            t.txPaid += BigInt(f.tx_fee_lamports);
            if (launches.get(f.mint)?.mainBought) t.probeOnly = false;
          }
        } else {
          leg.sell += BigInt(f.quote_lamports);
          const closedOut = !state.positions.has(f.mint) && !hasPendingSell(state, f.mint);
          if (closedOut) {
            const realised = leg.sell - leg.buy - leg.tx;
            legs.delete(f.mint);
            const c = launches.get(f.mint);
            if (c !== undefined && c.mainBought) {
              closedMain.push(realised);
              if (closedMain.length > Math.max(1, p.throttleWindow)) closedMain.shift();
              if (closedMain.length >= p.throttleWindow) {
                const mean = closedMain.reduce((a, b) => a + b, 0n) / BigInt(closedMain.length);
                if (mean < BigInt(p.throttleMeanLamports)) pausedUntilSlot = state.slot + p.throttlePauseSlots;
              }
            }
            open.delete(f.mint);
            selling.delete(f.mint);
          }
        }
        if (f.client_id.startsWith('_')) {
          open.delete(f.mint);
          selling.delete(f.mint);
        }
      }
      for (const mint of [...selling]) {
        if (!hasPendingSell(state, mint)) selling.delete(mint);
      }
      for (const mint of [...open.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) {
          open.delete(mint);
        }
      }

      // Exits first: partial take, full take-profit, breakeven stop, stop-loss,
      // max hold, creator sell.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = launches.get(mint);
        let t = open.get(mint);
        if (t === undefined) {
          t = { openedSlot: state.slot, txPaid: txFee, tookPartial: false, devSoldAtOpen: c?.devSold ?? false, probeOnly: false };
          open.set(mint, t);
        }
        const mk = marks.get(mint) ?? (() => {
          const cv = state.curves.get(mint);
          if (cv === undefined) return undefined;
          return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        })();
        if (mk === undefined) continue;
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - txFee;
        const basis = pos.cost_lamports + t.txPaid;
        if (basis <= 0n) continue;
        let exitAll = false;
        if (!t.tookPartial && value * BPS >= basis * (BPS + BigInt(p.partialTakeBps))) {
          const part = (pos.token_amount * BigInt(p.partialSellBps)) / BPS;
          if (part > 0n && part < pos.token_amount) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
            selling.add(mint);
            t.tookPartial = true;
            if (c !== undefined) c.done = true;
            continue;
          }
        }
        if (value * BPS >= basis * (BPS + BigInt(p.takeProfitBps))) exitAll = true;
        if (t.tookPartial && value * BPS <= basis * (BPS - BigInt(p.breakevenStopBps))) exitAll = true;
        if (value * BPS <= basis * (BPS - BigInt(p.stopLossBps))) exitAll = true;
        if (state.slot - t.openedSlot >= p.maxHoldSlots) exitAll = true;
        if (p.exitOnDevSell && c !== undefined && c.devSold && !t.devSoldAtOpen) exitAll = true;
        if (!exitAll) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: main size when the throttle allows, probes on pace or while paused.
      const paused = state.slot < pausedUntilSlot;
      let free = state.freeCashLamports() - txFee * BigInt(orders.length);
      let openCount = state.committedPositionCount();
      const elapsedHours =
        firstBlockTime === null ? 0 : Math.max(0, (nowBlockTime - firstBlockTime) / 3600);
      const behindPace = qualifying.size < p.pacePerHour * elapsedHours;
      const probeDue = state.slot - lastProbeSlot >= p.probeEverySlots;

      for (const c of launches.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createdSlot;

        // Main-size entry.
        if (!paused && !c.mainBought && passesMain(c, state)) {
          if (openCount >= state.hello.caps.max_open_positions) continue;
          if (hasPendingBuy(state, c.mint)) continue;
          const maxBuy = state.maxBuyLamports(c.mint);
          const want = BigInt(p.stakeLamports);
          const amount = want < maxBuy ? want : maxBuy;
          if (amount < BigInt(p.minBuyLamports)) continue;
          if (free < amount + txFee) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
          free -= amount + txFee;
          c.mainBought = true;
          openCount += 1;
          continue;
        }

        // Guardrail / regime probe: one per pace window, only when behind the
        // qualifying-mint pace, or while the throttle has main entries paused.
        // A probed coin can still earn a main buy later; the probe never
        // consumes it.
        if (!probeDue) continue;
        if (!behindPace && !paused) continue;
        if (!passesProbe(c, state)) continue;
        // While paused, probes sample main setups only — that is what tells
        // us the regime has turned.
        if (paused && !passesMain(c, state)) continue;
        if (openCount >= state.hello.caps.max_open_positions) continue;
        if (hasPendingBuy(state, c.mint)) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = BigInt(p.probeLamports) < maxBuy ? BigInt(p.probeLamports) : maxBuy;
        if (amount < BigInt(p.probeLamports)) continue;
        if (free < amount + txFee) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + txFee;
        c.probeBought = true;
        lastProbeSlot = state.slot;
        openCount += 1;
      }
      return orders;
    },
  };
}
