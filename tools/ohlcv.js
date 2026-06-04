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
  // Suggest bins_below: scale ATR% linearly → [12, 20]
  // Bengbeng wallet analysis (Jun 2026): medium range -10% to -40% = WR 85%, avg +1.17%
  //   vs tight 0% to -10% = WR 63%, avg -0.55% (worst category)
  // At 100bp bin_step: 12 bins = 12% range, 20 bins = 20% range → medium territory
  // History: [15,30] → [10,18] → [8,14] → [12,20] (widened back based on bengbeng data)
  const suggestedBins = Math.round(Math.min(20, Math.max(12, 10 + (atrPct / 10) * 8)));
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
  // Time-bucket aggregation aligned to bucket boundaries (00/15/30/45 for 15m).
  // GeckoTerminal skips minutes with zero volume — count-based grouping would
  // produce misaligned candles spanning >n minutes of real time, breaking all
  // downstream indicators (RSI, BB, MACD, VWAP, supertrend, ATR).
  const sorted = [...bars].sort((a, b) => a.time - b.time);
  const bucketSec = n * 60;
  const buckets = new Map();
  for (const b of sorted) {
    const key = Math.floor(b.time / bucketSec) * bucketSec;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, { time: key, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    } else {
      existing.high = Math.max(existing.high, b.high);
      existing.low = Math.min(existing.low, b.low);
      existing.close = b.close;
      existing.volume += b.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

// ─── In-memory OHLCV cache (5 min TTL) ─────────────────────────
const _ohlcvCache = new Map();
// Cache TTL extended 2026-05-23 from 5min to 12min to reduce GeckoTerminal 429 rate limits.
// At 15min screening interval, 12min cache means same-pool refetch only when cache expires
// between cycles. Reduces API calls ~50% when pools repeat across cycles (typical trending).
const OHLCV_CACHE_TTL = 12 * 60 * 1000;

// Global rate-limit cooldown — when 429 hit, skip subsequent calls until cooldown expires
// Avoids wasting 30+ seconds per pool on retries during severe rate limiting
let _gtCooldownUntil = 0;
const GT_COOLDOWN_MS = 60 * 1000;  // 60s back-off after 429

// ─── GeckoTerminal OHLCV fetch ─────────────────────────────────
async function fetchOhlcv(poolAddress, timeframe = "15m") {
  const cacheKey = `${poolAddress}:${timeframe}`;
  const cached = _ohlcvCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < OHLCV_CACHE_TTL) return cached.bars;

  // Global cooldown — fail fast during rate-limit window
  if (Date.now() < _gtCooldownUntil) {
    const remaining = Math.ceil((_gtCooldownUntil - Date.now()) / 1000);
    throw new Error(`GeckoTerminal cooldown ${remaining}s more (skip until rate limit clears)`);
  }

  const tf       = TIMEFRAME_MAP[timeframe] ?? TIMEFRAME_MAP["15m"];
  const rawLimit = tf.aggregate > 1 ? Math.min(tf.aggregate * 60, 1000) : 100;
  const url      = `${GECKOTERMINAL_BASE}/networks/solana/pools/${poolAddress}/ohlcv/${tf.gt}?limit=${rawLimit}&currency=usd`;

  // Single retry on 429 — if still failing, set cooldown and bail
  const HEADERS = { "Accept": "application/json;version=20230302" };
  let res = await fetch(url, { headers: HEADERS });
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 3000));
    res = await fetch(url, { headers: HEADERS });
  }
  if (res.status === 429) {
    _gtCooldownUntil = Date.now() + GT_COOLDOWN_MS;
    throw new Error(`GeckoTerminal 429 — set ${GT_COOLDOWN_MS/1000}s cooldown`);
  }
  if (!res.ok) throw new Error(`GeckoTerminal OHLCV fetch failed: ${res.status} ${res.statusText}`);

  const data = await res.json();
  const raw  = data?.data?.attributes?.ohlcv_list ?? [];
  if (!raw.length) throw new Error("GeckoTerminal returned empty OHLCV data");

  // GeckoTerminal returns ohlcv_list NEWEST-FIRST — sort to oldest-first so
  // indicators (RSI, VWAP, MACD, supertrend) walk time forward correctly.
  const bars = raw.map(([t, o, h, l, c, v]) => ({ time: t, open: o, high: h, low: l, close: c, volume: v }))
                  .sort((a, b) => a.time - b.time);
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
  // RSI2 trend — diff vs previous candle (positive = climbing = bounce starting)
  // Added 2026-05-23: distinguishes "bounce in progress" from "falling knife"
  // Winners pattern: RSI2_trend > +5 (climbing from oversold) → high WR
  // Losers pattern: RSI2_trend ≤ 0 with RSI2 <20 → falling knife continues
  let rsi2Trend = null;
  if (closes.length >= 3) {
    const rsiPrev = rsi(closes.slice(0, -1), 2);
    if (rsiVal !== null && rsiPrev !== null) {
      rsi2Trend = Math.round((rsiVal - rsiPrev) * 100) / 100;
    }
  }
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
  // Volume spike at rsi2<15 = Pattern B buyer step-in (valid entry) — no warning
  // Volume spike at rsi2>=15 = potential peak / high OOR risk — warn
  if (volSpike?.is_spike && !(rsiVal != null && rsiVal < 15)) entryWarnings.push(volSpike.warning);
  if (stVal && !stVal.is_bullish) entryWarnings.push(stVal.warning);

  // Verifiable diagnostic log — cross-check against TradingView (same TF, same indicator settings)
  // Includes bar count + bucket time range so we can spot data sparsity / misalignment issues
  const firstBucket = bars[0]?.time ? new Date(bars[0].time * 1000).toISOString().slice(5, 16).replace("T", " ") : "?";
  const lastBucket  = bars[bars.length - 1]?.time ? new Date(bars[bars.length - 1].time * 1000).toISOString().slice(5, 16).replace("T", " ") : "?";
  const closeStr    = currentClose ? currentClose.toExponential(3) : "?";
  const bbUpperStr  = bb?.upper ? bb.upper.toExponential(3) : "?";
  log("ohlcv",
    `${pool_address} [${timeframe}] ` +
    `bars=${bars.length} (${firstBucket}→${lastBucket} UTC) ` +
    `close=${closeStr} BBu=${bbUpperStr} ` +
    `RSI2=${rsiVal}${rsi2Trend != null ? ` (Δ${rsi2Trend>=0?'+':''}${rsi2Trend})` : ''} ` +
    `VWAPd=${vwapVal?.distance_pct}% ` +
    `volSpike=${volSpike?.is_spike} ST=${stVal?.direction} ` +
    `→ exit=${exitSignal}${exitReason ? ` (${exitReason})` : ""}`
  );

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
      rsi2_trend:      rsi2Trend,   // delta vs previous candle (positive=climbing, negative=falling)
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
    // ── BOUNCE signal (SCREENER — dump entry mode) ──────────
    // Score 0–100: probability price will recover from current dump level.
    // Factors: RSI2 extreme + trend direction + volume spike (buyer step-in)
    //          + MACD first green bar + VWAP distance + supertrend.
    bounce_score:    (() => {
      let s = 0;
      if (rsiVal !== null) {
        if (rsiVal < 10)      s += 35;
        else if (rsiVal < 15) s += 25;
        else if (rsiVal < 25) s += 15;
        else if (rsiVal < 35) s += 8;
      }
      if (rsi2Trend !== null) {
        if (rsi2Trend >= 10)      s += 30;
        else if (rsi2Trend >= 5)  s += 20;
        else if (rsi2Trend > 0)   s += 10;
        else if (rsi2Trend < -5)  s = Math.max(0, s - 15); // still falling hard — penalise
      }
      // Volume spike at oversold = buyer step-in confirmation
      if (volSpike?.is_spike && rsiVal !== null && rsiVal < 35) s += 20;
      // MACD first green bar = momentum flip
      if (macdVal?.first_green_bar) s += 15;
      // Healthy oversold distance from VWAP
      const vd = vwapVal?.distance_pct ?? 0;
      if (vd <= -5 && vd >= -22) s += 10;
      // Supertrend already bullish
      if (stVal?.is_bullish) s += 10;
      return Math.min(100, Math.max(0, s));
    })(),
    // Dump entry mode: strong bounce signal, price in dump zone — flip bins for bounce capture
    // bins_below=4 (minimal downside exposure) bins_above=20 (maximise bounce traversal)
    is_dump_entry: (() => {
      const score = (() => {
        let s = 0;
        if (rsiVal !== null) {
          if (rsiVal < 10) s += 35; else if (rsiVal < 15) s += 25; else if (rsiVal < 25) s += 15; else if (rsiVal < 35) s += 8;
        }
        if (rsi2Trend !== null) { if (rsi2Trend >= 10) s += 30; else if (rsi2Trend >= 5) s += 20; else if (rsi2Trend > 0) s += 10; else if (rsi2Trend < -5) s = Math.max(0, s - 15); }
        if (volSpike?.is_spike && rsiVal !== null && rsiVal < 35) s += 20;
        if (macdVal?.first_green_bar) s += 15;
        const vd = vwapVal?.distance_pct ?? 0;
        if (vd <= -5 && vd >= -22) s += 10;
        if (stVal?.is_bullish) s += 10;
        return Math.min(100, Math.max(0, s));
      })();
      const vd = vwapVal?.distance_pct ?? 0;
      return score >= 50 && rsiVal !== null && rsiVal < 35 && vd < -5;
    })(),
  };
}
