/**
 * OHLCV fetcher + technical indicator calculator.
 * Uses GeckoTerminal public API (no key required).
 *
 * Indicators:
 *  - RSI(2)        — overbought exit signal (>=90)
 *  - BB(20)        — Bollinger Bands exit signal (price above upper)
 *  - MACD(12/26/9) — momentum exit signal (first green bar)
 *  - ATR(14)       — volatility measure → suggests optimal bins_below
 *  - Volume Spike  — last candle volume vs 20-period avg (entry warning)
 *  - VWAP          — price vs session average (exit signal if >15% extended)
 *  - Supertrend    — trend direction filter for entry (10,3)
 */

import { log } from "../logger.js";
import { notifyTechnicalSignal, isEnabled as telegramEnabled } from "../telegram.js";

const GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2";

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
    avgGain = (avgGain * (period - 1) + (diff >= 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return Math.round((100 - 100 / (1 + avgGain / avgLoss)) * 100) / 100;
}

// ─── Bollinger Bands ───────────────────────────────────────────
function bollingerBands(closes, period = 20, multiplier = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((sum, c) => sum + Math.pow(c - sma, 2), 0) / period);
  return {
    upper:  Math.round((sma + multiplier * std) * 1e8) / 1e8,
    middle: Math.round(sma * 1e8) / 1e8,
    lower:  Math.round((sma - multiplier * std) * 1e8) / 1e8,
  };
}

// ─── MACD ──────────────────────────────────────────────────────
function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast   = ema(closes, fast);
  const emaSlow   = ema(closes, slow);
  const offset    = slow - fast;
  const macdLine  = emaSlow.map((v, i) => emaFast[i + offset] - v);
  const signalLine = ema(macdLine, signal);
  const histogram  = macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1];
  const prevHist   = macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2];
  return {
    macd:           Math.round(macdLine[macdLine.length - 1] * 1e8) / 1e8,
    signal:         Math.round(signalLine[signalLine.length - 1] * 1e8) / 1e8,
    histogram:      Math.round(histogram * 1e8) / 1e8,
    first_green_bar: histogram > 0 && prevHist <= 0,
  };
}

// ─── ATR(14) ───────────────────────────────────────────────────
function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trValues = [];
  for (let i = 1; i < bars.length; i++) {
    trValues.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low  - bars[i - 1].close)
    ));
  }
  // Wilder smoothing (RMA)
  let atrVal = trValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trValues.length; i++) {
    atrVal = (atrVal * (period - 1) + trValues[i]) / period;
  }
  const currentPrice = bars[bars.length - 1].close;
  const atrPct = (atrVal / currentPrice) * 100;
  // Suggest bins_below: scale ATR% linearly → [30, 60]
  // Data from 72 positions: bins 41-60 = best bucket (+0.39% avg), 81+ = dust (+0.03%)
  const suggestedBins = Math.round(Math.min(60, Math.max(30, 30 + (atrPct / 10) * 30)));
  return {
    value:          Math.round(atrVal * 1e8) / 1e8,
    pct:            Math.round(atrPct * 100) / 100,
    suggested_bins_below: suggestedBins,
  };
}

// ─── Volume Spike ──────────────────────────────────────────────
function volumeSpike(bars, lookback = 20, threshold = 3) {
  if (bars.length < lookback + 1) return null;
  const recent  = bars.slice(-lookback - 1, -1);
  const avgVol  = recent.reduce((s, b) => s + b.volume, 0) / lookback;
  const lastVol = bars[bars.length - 1].volume;
  const ratio   = avgVol > 0 ? lastVol / avgVol : 0;
  return {
    last_volume:   Math.round(lastVol * 100) / 100,
    avg_volume_20: Math.round(avgVol * 100) / 100,
    ratio:         Math.round(ratio * 100) / 100,
    is_spike:      ratio >= threshold,
    warning:       ratio >= threshold
      ? `Volume spike: last candle ${ratio.toFixed(1)}× above 20-period avg — token may be at peak, high OOR risk`
      : null,
  };
}

// ─── VWAP ──────────────────────────────────────────────────────
function vwap(bars) {
  if (!bars.length) return null;
  let cumTPV = 0, cumVol = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    cumTPV += tp * b.volume;
    cumVol += b.volume;
  }
  if (cumVol === 0) return null;
  const vwapVal    = cumTPV / cumVol;
  const lastClose  = bars[bars.length - 1].close;
  const distPct    = ((lastClose - vwapVal) / vwapVal) * 100;
  return {
    value:        Math.round(vwapVal * 1e8) / 1e8,
    distance_pct: Math.round(distPct * 100) / 100,
    extended:     distPct > 15,  // price >15% above VWAP = overextended, exit risk
  };
}

// ─── Supertrend(10, 3) ─────────────────────────────────────────
function supertrend(bars, period = 10, multiplier = 3) {
  if (bars.length < period + 2) return null;

  // ATR (Wilder) for each bar
  const trArr = [];
  for (let i = 1; i < bars.length; i++) {
    trArr.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low  - bars[i - 1].close)
    ));
  }
  let atrVal = trArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const atrArr = [atrVal];
  for (let i = period; i < trArr.length; i++) {
    atrVal = (atrVal * (period - 1) + trArr[i]) / period;
    atrArr.push(atrVal);
  }

  // Compute supertrend from index (period) onwards
  let prevUpper = null, prevLower = null, prevST = null, prevClose = null;
  let stVal = null, isBullish = true;

  for (let i = 0; i < atrArr.length; i++) {
    const barIdx = i + period;
    const bar    = bars[barIdx];
    const hl2    = (bar.high + bar.low) / 2;
    const a      = atrArr[i];

    let upper = hl2 + multiplier * a;
    let lower = hl2 - multiplier * a;

    if (prevUpper !== null) {
      upper = (upper < prevUpper || prevClose > prevUpper) ? upper : prevUpper;
      lower = (lower > prevLower || prevClose < prevLower) ? lower : prevLower;
    }

    if (prevST === null) {
      stVal     = upper;
      isBullish = bar.close > upper;
    } else if (prevST === prevUpper) {
      stVal     = bar.close > upper ? lower : upper;
      isBullish = bar.close > upper;
    } else {
      stVal     = bar.close < lower ? upper : lower;
      isBullish = bar.close >= lower;
    }

    prevUpper = upper;
    prevLower = lower;
    prevST    = stVal;
    prevClose = bar.close;
  }

  return {
    value:      Math.round(stVal * 1e8) / 1e8,
    is_bullish: isBullish,
    direction:  isBullish ? "up" : "down",
    warning:    !isBullish ? "Supertrend bearish — avoid entry, price below trend line" : null,
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

// ─── In-memory OHLCV cache (5 min TTL) ─────────────────────────
const _ohlcvCache = new Map();
const OHLCV_CACHE_TTL = 5 * 60 * 1000;

// ─── GeckoTerminal OHLCV fetch ─────────────────────────────────
async function fetchOhlcv(poolAddress, timeframe = "15m") {
  const cacheKey = `${poolAddress}:${timeframe}`;
  const cached = _ohlcvCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < OHLCV_CACHE_TTL) return cached.bars;

  const tf       = TIMEFRAME_MAP[timeframe] ?? TIMEFRAME_MAP["15m"];
  const rawLimit = tf.aggregate > 1 ? Math.min(tf.aggregate * 60, 1000) : 100;
  const url      = `${GECKOTERMINAL_BASE}/networks/solana/pools/${poolAddress}/ohlcv/${tf.gt}?limit=${rawLimit}&currency=usd`;

  // Retry up to 2x on 429 with exponential backoff
  const HEADERS = { "Accept": "application/json;version=20230302" };
  let res = await fetch(url, { headers: HEADERS });
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 5000));
    res = await fetch(url, { headers: HEADERS });
  }
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 10000));
    res = await fetch(url, { headers: HEADERS });
  }
  if (!res.ok) throw new Error(`GeckoTerminal OHLCV fetch failed: ${res.status} ${res.statusText}`);

  const data = await res.json();
  const raw  = data?.data?.attributes?.ohlcv_list ?? [];
  if (!raw.length) throw new Error("GeckoTerminal returned empty OHLCV data");

  const bars = raw.map(([t, o, h, l, c, v]) => ({ time: t, open: o, high: h, low: l, close: c, volume: v }));
  const result = tf.aggregate > 1 ? aggregateCandles(bars, tf.aggregate) : bars;
  _ohlcvCache.set(cacheKey, { bars: result, ts: Date.now() });
  return result;
}

// ─── Main exported tool handler ────────────────────────────────
/**
 * Fetch OHLCV from GeckoTerminal and compute all technical indicators.
 *
 * EXIT signals (MANAGER):
 *   - RSI(2) >= 90 + BB upper breach     → signal_1
 *   - RSI(2) >= 90 + MACD first green    → signal_2
 *   - VWAP distance > 15%                → vwap.extended
 *
 * ENTRY filters (SCREENER):
 *   - volume_spike.is_spike              → avoid (already pumped)
 *   - supertrend.is_bullish              → only deploy if true
 *   - atr.suggested_bins_below           → use as bins_below instead of formula
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

  // ── Compute all indicators ─────────────────────────────────
  const rsiVal    = rsi(closes, 2);
  const bb        = bollingerBands(closes, 20, 2);
  const macdVal   = macd(closes, 12, 26, 9);
  const atrVal    = atr(bars, 14);
  const volSpike  = volumeSpike(bars, 20, 3);
  const vwapVal   = vwap(bars);
  const stVal     = supertrend(bars, 10, 3);

  // ── Exit signals ───────────────────────────────────────────
  const rsiOverbought     = rsiVal !== null && rsiVal >= 90;
  const priceAboveBBUpper = bb !== null && currentClose >= bb.upper;
  const macdFirstGreen    = macdVal?.first_green_bar ?? false;
  const vwapExtended      = vwapVal?.extended ?? false;

  const signal1   = rsiOverbought && priceAboveBBUpper;
  const signal2   = rsiOverbought && macdFirstGreen;
  const exitSignal = signal1 || signal2 || vwapExtended;

  const exitReason = signal1
    ? "RSI(2) >= 90 + Price above BB upper"
    : signal2
      ? "RSI(2) >= 90 + MACD first green bar"
      : vwapExtended
        ? `Price ${vwapVal.distance_pct.toFixed(1)}% above VWAP — overextended`
        : null;

  // ── Entry warnings ─────────────────────────────────────────
  const entryWarnings = [];
  if (volSpike?.is_spike)    entryWarnings.push(volSpike.warning);
  if (stVal && !stVal.is_bullish) entryWarnings.push(stVal.warning);

  log("ohlcv", `${pool_address} [${timeframe}] RSI=${rsiVal} VWAP_dist=${vwapVal?.distance_pct}% volSpike=${volSpike?.is_spike} ST=${stVal?.direction} → exit=${exitSignal}`);

  if (exitSignal && telegramEnabled()) {
    notifyTechnicalSignal({
      pair:         pool_address.slice(0, 8) + "...",
      timeframe,
      rsi2:         rsiVal,
      bbUpper:      bb?.upper,
      currentClose,
      macdGreen:    macdFirstGreen,
      exitReason:   exitReason + " — close position",
    }).catch(() => {});
  }

  return {
    pool_address,
    timeframe,
    candles_used:  bars.length,
    current_close: currentClose,
    indicators: {
      rsi2:            rsiVal,
      bollinger_bands: bb,
      macd:            macdVal,
      atr:             atrVal,
      volume_spike:    volSpike,
      vwap:            vwapVal,
      supertrend:      stVal,
    },
    // ── EXIT signals (MANAGER) ──────────────────────────────
    exit_signal: exitSignal,
    exit_reason: exitReason,
    signals: {
      rsi_overbought:       rsiOverbought,
      price_above_bb_upper: priceAboveBBUpper,
      macd_first_green_bar: macdFirstGreen,
      vwap_extended:        vwapExtended,
      signal_1_active:      signal1,
      signal_2_active:      signal2,
    },
    // ── ENTRY filters (SCREENER) ────────────────────────────
    entry_ok:       entryWarnings.length === 0,
    entry_warnings: entryWarnings,
    suggested_bins_below: atrVal?.suggested_bins_below ?? null,
  };
}
