/**
 * OHLCV fetcher + technical indicator calculator.
 * Uses GeckoTerminal public API (no key required).
 *
 * Indicators:
 *  - RSI(2)  — period=2, overbought at 90
 *  - BB(20)  — Bollinger Bands, 20-period SMA ± 2 std dev
 *  - MACD    — 12/26/9 EMA
 */

import { log } from "../logger.js";

const GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2";

// GeckoTerminal supports: "minute", "hour", "day"
// For 15m we fetch minute candles and aggregate manually
const TIMEFRAME_MAP = {
  "1m":  { gt: "minute", aggregate: 1  },
  "5m":  { gt: "minute", aggregate: 5  },
  "15m": { gt: "minute", aggregate: 15 },
  "1h":  { gt: "hour",   aggregate: 1  },
  "4h":  { gt: "hour",   aggregate: 4  },
};

// ─── EMA ───────────────────────────────────────────────────────
function ema(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let emaPrev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(emaPrev);
  for (let i = period; i < values.length; i++) {
    emaPrev = values[i] * k + emaPrev * (1 - k);
    result.push(emaPrev);
  }
  return result;
}

// ─── RSI ───────────────────────────────────────────────────────
function rsi(closes, period = 2) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

// ─── Bollinger Bands ───────────────────────────────────────────
function bollingerBands(closes, period = 20, multiplier = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, c) => sum + Math.pow(c - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: Math.round((sma + multiplier * std) * 1e8) / 1e8,
    middle: Math.round(sma * 1e8) / 1e8,
    lower: Math.round((sma - multiplier * std) * 1e8) / 1e8,
  };
}

// ─── MACD ──────────────────────────────────────────────────────
function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);

  const offset = slow - fast;
  const macdLine = emaSlow.map((v, i) => emaFast[i + offset] - v);
  const signalLine = ema(macdLine, signal);

  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  const prevMacd = macdLine[macdLine.length - 2];
  const prevSignal = signalLine[signalLine.length - 2];

  const histogram = lastMacd - lastSignal;
  const prevHistogram = prevMacd - prevSignal;
  const firstGreenBar = histogram > 0 && prevHistogram <= 0;

  return {
    macd: Math.round(lastMacd * 1e8) / 1e8,
    signal: Math.round(lastSignal * 1e8) / 1e8,
    histogram: Math.round(histogram * 1e8) / 1e8,
    first_green_bar: firstGreenBar,
  };
}

// ─── Aggregate minute candles into larger timeframe ────────────
function aggregateCandles(bars, n) {
  if (n <= 1) return bars;
  const result = [];
  for (let i = 0; i + n <= bars.length; i += n) {
    const slice = bars.slice(i, i + n);
    result.push({
      time:   slice[0].time,
      open:   slice[0].open,
      high:   Math.max(...slice.map(b => b.high)),
      low:    Math.min(...slice.map(b => b.low)),
      close:  slice[slice.length - 1].close,
      volume: slice.reduce((s, b) => s + b.volume, 0),
    });
  }
  return result;
}

// ─── GeckoTerminal OHLCV fetch ─────────────────────────────────
async function fetchOhlcv(poolAddress, timeframe = "15m") {
  const tf = TIMEFRAME_MAP[timeframe] ?? TIMEFRAME_MAP["15m"];

  // Need enough raw candles to aggregate + compute indicators (MACD needs 35+)
  // For 15m: need 35 aggregated candles × 15 raw = 525 raw → use limit=1000
  const rawLimit = tf.aggregate > 1 ? Math.min(tf.aggregate * 60, 1000) : 100;

  const url = `${GECKOTERMINAL_BASE}/networks/solana/pools/${poolAddress}/ohlcv/${tf.gt}?limit=${rawLimit}&currency=usd`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json;version=20230302" },
  });

  if (!res.ok) {
    throw new Error(`GeckoTerminal OHLCV fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  // GeckoTerminal returns { data: { attributes: { ohlcv_list: [[ts, o, h, l, c, v], ...] } } }
  const raw = data?.data?.attributes?.ohlcv_list ?? [];
  if (!raw.length) throw new Error("GeckoTerminal returned empty OHLCV data");

  const bars = raw.map(([t, o, h, l, c, v]) => ({
    time: t, open: o, high: h, low: l, close: c, volume: v,
  }));

  return tf.aggregate > 1 ? aggregateCandles(bars, tf.aggregate) : bars;
}

// ─── Main exported tool handler ────────────────────────────────
/**
 * Fetch OHLCV from GeckoTerminal and compute RSI(2), BB(20), MACD(12/26/9).
 * Accepts pool_address (Meteora pool address = GeckoTerminal pool address on Solana).
 * Returns signals and an exit_signal boolean based on Evil Panda criteria.
 */
export async function getTechnicalSignals({ pool_address, timeframe = "15m" }) {
  if (!pool_address) return { error: "pool_address required" };

  let bars;
  try {
    bars = await fetchOhlcv(pool_address, timeframe);
  } catch (e) {
    log("ohlcv_error", `Failed to fetch OHLCV for ${pool_address}: ${e.message}`);
    return { error: e.message, pool_address };
  }

  if (bars.length < 27) {
    return { error: `Not enough candles: got ${bars.length}, need at least 27`, pool_address };
  }

  const closes = bars.map(b => b.close);
  const currentClose = closes[closes.length - 1];

  const rsiVal = rsi(closes, 2);
  const bb = bollingerBands(closes, 20, 2);
  const macdVal = macd(closes, 12, 26, 9);

  // ── Exit signal logic (Evil Panda: confluence of 2) ──────────
  const rsiOverbought = rsiVal !== null && rsiVal >= 90;
  const priceAboveBBUpper = bb !== null && currentClose >= bb.upper;
  const macdFirstGreen = macdVal?.first_green_bar ?? false;

  const signal1 = rsiOverbought && priceAboveBBUpper;   // RSI + BB
  const signal2 = rsiOverbought && macdFirstGreen;       // RSI + MACD
  const exitSignal = signal1 || signal2;

  log("ohlcv", `${pool_address} [${timeframe}] RSI=${rsiVal} BB_upper=${bb?.upper} close=${currentClose} MACD_green=${macdFirstGreen} → exit=${exitSignal}`);

  return {
    pool_address,
    timeframe,
    candles_used: bars.length,
    current_close: currentClose,
    indicators: {
      rsi2: rsiVal,
      bollinger_bands: bb,
      macd: macdVal,
    },
    signals: {
      rsi_overbought: rsiOverbought,
      price_above_bb_upper: priceAboveBBUpper,
      macd_first_green_bar: macdFirstGreen,
      signal_1_active: signal1,
      signal_2_active: signal2,
    },
    exit_signal: exitSignal,
    exit_reason: exitSignal
      ? signal1
        ? "RSI(2) >= 90 + Price above BB upper — take profit signal"
        : "RSI(2) >= 90 + MACD first green bar — take profit signal"
      : null,
  };
}
