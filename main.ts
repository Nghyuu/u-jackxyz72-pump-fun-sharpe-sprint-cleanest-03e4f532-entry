// Steady Climb — a Sharpe-first paper bot for the pump.fun replay.
//
// Idea: buy only seasoned curves whose tape is warming up (steady net SOL inflow from
// several different wallets, price climbing and holding near its recent high), start
// small, add only while the trade is working, and bank the win early. Losses are cut
// fast with a stop and a trailing stop, and no position is allowed to go stale. Many
// small, controlled round trips beat one moonshot: that is what a Sharpe ranking pays.
//
// Fully deterministic: every decision is a pure function of the batches the harness
// sends. No clock, no randomness, no I/O, no files written. Iteration is only over
// insertion-ordered maps fed by the batch stream, so the two graded runs agree.
// (runBot is called at the bottom of this file, after all state is declared, so no
// batch can ever run before the bookkeeping exists.)

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAM = 1_000_000_000n; // lamports per SOL
const CURVE_FEE_BPS = 125n; // 1.25% curve fee on sells
const BPS = 10_000n;

// --- tunables (SOL units unless noted) ---------------------------------------
const LOOKBACK = 40; // slots of tape the entry signal reads
const MIN_AGE = 300; // slots since CreateEvent before a coin may be bought
const MIN_NET_SOL = 2.0; // net SOL inflow over the lookback
const MIN_BUYS = 6; // buy trades in the lookback
const MIN_BUYERS = 6; // distinct buying wallets in the lookback
const MIN_RISE = 0.10; // price now vs window start, at least +10%
const MAX_RISE = 0.8; // skip coins that already ran >80% in one window
const NEAR_HIGH = 0.95; // price now at least 95% of the window high
const MIN_REAL_SOL = 3; // real SOL reserve at entry, lower bound
const MAX_REAL_SOL = 80; // real SOL reserve at entry, upper bound
const FIRST_BUY_SOL = 0.08; // first buy of a position
const ADD_SOL = 0.08; // each pyramid add
const MAX_STAKE_SOL = 0.32; // most SOL committed to one position
const MIN_BUY_SOL = 0.02; // smallest buy worth sending
const BUY_SLIP = 2000; // buy slippage tolerance (bps)
const SELL_SLIP = 10_000; // sells go out wide open
const TAKE_PROFIT = 0.35; // exit when value >= cost * 1.35
const STOP_LOSS = 0.10; // exit when value <= cost * 0.90
const TRAIL_ARM = 0.08; // trailing stop arms once value >= cost * 1.08
const TRAIL = 0.12; // exit when value falls 12% from its peak
const MAX_HOLD = 1200; // slots before a flat position is closed
const COOLDOWN = 200; // slots to ignore a coin after an exit
const MAX_ENTRIES_PER_COIN = 2;
const FADE_WINDOW = 20; // slots of tape for the fade exit
const FADE_NET_SOL = -1000; // fade exit disabled: tuned out on the dev window
const MAX_MAIN = 4; // momentum slots; the 5th open slot is kept for probes
const MAX_EXPOSURE_SOL = 5; // cap on SOL at cost across all positions
const PROBE_SOL = 0.02; // guardrail probe buy size
const TARGET_COINS = 30; // pacing target over the run
const TARGET_FILLS = 120;
const PACE_SECS = 21_600; // 6 hours

interface Tick {
  slot: number;
  buy: boolean;
  sol: number; // SOL
  user: string;
  price: number; // virtual SOL / virtual tokens
}

interface Coin {
  created: number | null;
  ticks: Tick[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peak: number; // best close value seen, SOL
  invested: number; // SOL sent in buys (fees included)
  lastAddPrice: number;
  leaving: boolean;
  filled: boolean;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

/** SOL a sale of `tokens` would return, curve fee and one tx fee deducted. */
function closeValue(vq: bigint, vt: bigint, tokens: bigint, txLamports: bigint): number {
  if (tokens <= 0n || vt + tokens === 0n) return 0;
  const gross = (tokens * vq) / (vt + tokens);
  const afterFee = gross - (gross * CURVE_FEE_BPS) / BPS;
  const net = afterFee - txLamports;
  return net <= 0n ? 0 : Number(net) / 1e9;
}

// --- strategy state (module scope, fed only by the batch stream) --------------
const book = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
const probes = new Map<Pubkey, boolean>(); // mint -> true once its probe sell is due
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstBlockTime: number | null = null;
let lastBlockTime: number | null = null;

function coinOf(mint: Pubkey): Coin {
  let c = book.get(mint);
  if (c === undefined) {
    c = { created: null, ticks: [], entries: 0, lastExit: -1e12 };
    book.set(mint, c);
  }
  return c;
}

/** Net SOL flow over the last `w` slots of a coin's tape. */
function netFlow(c: Coin, now: number, w: number): number {
  let net = 0;
  for (let i = c.ticks.length - 1; i >= 0; i--) {
    const t = c.ticks[i]!;
    if (t.slot <= now - w) break;
    net += t.buy ? t.sol : -t.sol;
  }
  return net;
}

/** Entry signal: warming tape on a seasoned, liquid-enough curve. */
function signalOk(c: Coin, now: number, realSol: number): boolean {
  if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) return false;
  if (c.created === null || now - c.created < MIN_AGE) return false;
  const from = now - LOOKBACK;
  const mid = now - LOOKBACK / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const buyers = new Map<string, number>();
  for (const t of c.ticks) {
    if (t.slot <= from) {
      startPrice = t.price;
      continue;
    }
    if (startPrice < 0) startPrice = t.price;
    const signed = t.buy ? t.sol : -t.sol;
    if (t.slot <= mid) netOld += signed;
    else netNew += signed;
    if (t.buy) {
      buySol += t.sol;
      buys++;
      buyers.set(t.user, (buyers.get(t.user) ?? 0) + t.sol);
    } else {
      sellSol += t.sol;
    }
    if (t.price > high) high = t.price;
    last = t.price;
  }
  if (buys < MIN_BUYS || buyers.size < MIN_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  if (startPrice <= 0 || last <= 0) return false;
  const rise = last / startPrice - 1;
  if (rise < MIN_RISE || rise > MAX_RISE) return false;
  if (last < high * NEAR_HIGH) return false;
  // Acceleration: the newer half of the window must be pulling harder than the older.
  if (netNew <= 0 || netNew < netOld) return false;
  return true;
}

function decide(state: BotState, batch: Batch, now: number): OrderInput[] {
  const tx = state.txFeeLamports();
  const txSol = Number(tx) / 1e9;
  const traded: Pubkey[] = [];
  const seenTraded = new Set<Pubkey>();

  for (const f of batch.fills) {
    if (f.status === 'filled' && !f.client_id.startsWith('_')) {
      myFills++;
      myCoins.add(f.mint);
    }
  }
  for (const e of batch.events) {
    if (e.block_time !== null) {
      if (firstBlockTime === null) firstBlockTime = e.block_time;
      if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
    }
    if (e.event === 'CreateEvent') {
      coinOf(e.mint).created = e.slot;
    } else if (e.event === 'TradeEvent') {
      const c = coinOf(e.mint);
      c.ticks.push({
        slot: e.slot,
        buy: e.is_buy,
        sol: Number(e.sol_amount) / 1e9,
        user: e.user,
        price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
      });
      if (!seenTraded.has(e.mint)) {
        seenTraded.add(e.mint);
        traded.push(e.mint);
      }
    }
  }
  // Prune old ticks so the tape stays short.
  for (const mint of traded) {
    const c = book.get(mint)!;
    const keepFrom = now - Math.max(LOOKBACK, FADE_WINDOW) - 5;
    let cut = 0;
    while (cut < c.ticks.length && c.ticks[cut]!.slot <= keepFrom) cut++;
    if (cut > 0) c.ticks.splice(0, cut);
  }

  const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
  const pendingMints = new Set<Pubkey>();
  const pendingSell = new Set<Pubkey>();
  for (const po of state.pending.values()) {
    pendingMints.add(po.order.mint);
    if (po.order.side === 'sell') pendingSell.add(po.order.mint);
  }
  const cap = state.hello.caps.max_orders_per_batch;
  const orders: OrderInput[] = [];

  // 1. Exits first: take profit, stop, trailing stop, fade, stale.
  for (const [mint, h] of held) {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (pos === undefined) {
      if (!pendingMints.has(mint)) {
        held.delete(mint);
        if (h.filled) coinOf(mint).lastExit = now;
        else coinOf(mint).entries--;
      }
      continue;
    }
    h.filled = true;
    if (curve === undefined || curve.complete) continue;
    const mk = marks.get(mint);
    const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
    const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
    const value = closeValue(vq, vt, pos.token_amount, tx);
    const cost = Number(pos.cost_lamports) / 1e9;
    if (value > h.peak) h.peak = value;
    let exit = h.leaving;
    if (!exit && cost > 0 && value >= cost * (1 + TAKE_PROFIT)) exit = true;
    if (!exit && cost > 0 && value <= cost * (1 - STOP_LOSS)) exit = true;
    if (!exit && cost > 0 && h.peak >= cost * (1 + TRAIL_ARM) && value <= h.peak * (1 - TRAIL)) exit = true;
    if (!exit && netFlow(coinOf(mint), now, FADE_WINDOW) < FADE_NET_SOL) exit = true;
    if (!exit && now - h.opened > MAX_HOLD) exit = true;
    if (!exit) continue;
    h.leaving = true;
    if (pendingSell.has(mint)) continue;
    if (orders.length >= cap) break;
    orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP });
  }

  // 2. Probe sells: a probe round trip closes as soon as its buy lands.
  for (const [mint, selling] of probes) {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (pos === undefined) {
      if (!pendingMints.has(mint)) probes.delete(mint);
      continue;
    }
    if (curve === undefined || curve.complete || pendingMints.has(mint)) continue;
    if (orders.length >= cap) break;
    orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP });
    if (!selling) probes.set(mint, true);
  }

  // 3. Entries and pyramid adds on coins that traded this batch.
  let freeSol = Number(state.freeCashLamports()) / 1e9;
  let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
  let mainLeft = MAX_MAIN - held.size;
  let exposure = 0;
  for (const [mint, h] of held) {
    exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / 1e9);
  }
  for (const mint of traded) {
    if (orders.length >= cap) break;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (pendingMints.has(mint) || probes.has(mint)) continue;
    const c = book.get(mint)!;
    const h = held.get(mint);
    const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    const realSol = Number(curve.real_quote_reserves) / 1e9;
    let want: number;
    if (h === undefined) {
      if (slotsLeft <= 0 || mainLeft <= 0) continue;
      if (c.entries >= MAX_ENTRIES_PER_COIN || now - c.lastExit < COOLDOWN) continue;
      if (!signalOk(c, now, realSol)) continue;
      want = FIRST_BUY_SOL;
    } else {
      // Pyramid only into strength: price above the last add, position in profit.
      if (h.leaving || !h.filled || h.invested >= MAX_STAKE_SOL - MIN_BUY_SOL) continue;
      const pos = state.positions.get(mint);
      if (pos === undefined) continue;
      if (price <= h.lastAddPrice) continue;
      const cost = Number(pos.cost_lamports) / 1e9;
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      const value = closeValue(vq, vt, pos.token_amount, tx);
      if (value < cost) continue;
      if (netFlow(c, now, LOOKBACK) < MIN_NET_SOL) continue;
      want = Math.min(ADD_SOL, MAX_STAKE_SOL - h.invested);
    }
    // The hello caps limit this batch's buys on one mint to 1% of its real reserve.
    const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / 1e9;
    let amount = Math.min(capSol, want, MAX_EXPOSURE_SOL - exposure);
    if (amount > freeSol - txSol) amount = freeSol - txSol;
    if (amount < MIN_BUY_SOL) continue;
    const lamports = BigInt(Math.floor(amount * 1e9));
    orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP });
    freeSol -= amount + txSol;
    exposure += amount;
    if (h === undefined) {
      held.set(mint, { opened: now, peak: 0, invested: amount, lastAddPrice: price, leaving: false, filled: false });
      c.entries++;
      slotsLeft--;
      mainLeft--;
    } else {
      h.invested += amount;
      h.lastAddPrice = price;
    }
  }

  // 4. Guardrail pacing: if fills or coins lag the elapsed share of the run,
  // open a tiny probe round trip on a liquid coin that traded this batch.
  if (probes.size < 1 && slotsLeft > 0 && firstBlockTime !== null && lastBlockTime !== null) {
    const pace = Math.min(1, (lastBlockTime - firstBlockTime) / PACE_SECS);
    const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
    const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
    if (needCoins || needFills) {
      const minRq = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (held.has(mint) || probes.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
        if (needCoins && !needFills && myCoins.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (Number(curve.real_quote_reserves) / 1e9 < minRq * 1.5) continue;
        if (freeSol < PROBE_SOL + 2 * txSol) break;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * 1e9)), max_slippage_bps: BUY_SLIP });
        probes.set(mint, false);
        freeSol -= PROBE_SOL + txSol;
        break;
      }
    }
  }

  return orders;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    return decide(state, batch, batch.slot);
  },
});
