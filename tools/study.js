/**
 * Study top LPers for a pool and extract behavioural patterns.
 * Used by the /learn command — not called on every cycle.
 */

import { log } from "../logger.js";

const LPAGENT_API = "https://api.lpagent.io/open-api/v1";
const LPAGENT_KEYS = (process.env.LPAGENT_API_KEY || "").split(",").map(k => k.trim()).filter(Boolean);
let _keyIndex = 0;
function nextKey() {
  if (!LPAGENT_KEYS.length) return null;
  const key = LPAGENT_KEYS[_keyIndex % LPAGENT_KEYS.length];
  _keyIndex++;
  return key;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch top LPers for a pool, filter to credible performers,
 * and return condensed behaviour patterns for LLM consumption.
 */
export async function studyTopLPers({ pool_address, limit = 4 }) {
  if (!LPAGENT_KEYS.length) {
    return { pool: pool_address, message: "LPAGENT_API_KEY not set in .env — study_top_lpers is disabled.", patterns: [], lpers: [] };
  }

  // ── 1. Top LPers for this pool ──────────────────────────────
  const topRes = await fetch(
    `${LPAGENT_API}/pools/${pool_address}/top-lpers?sort_order=desc&page=1&limit=20`,
    { headers: { "x-api-key": nextKey() } }
  );

  if (!topRes.ok) {
    if (topRes.status === 429) {
      throw new Error(`Rate limit exceeded. Please wait 60 seconds before studying this pool again.`);
    }
    throw new Error(`top-lpers API error: ${topRes.status}`);
  }

  const topData = await topRes.json();
  const all = topData.data || [];

  // Filter to LPers with enough data to be meaningful
  const credible = all.filter(
    (l) => l.total_lp >= 3 && l.win_rate >= 0.6 && l.total_inflow > 1000
  );

  // Sort by ROI descending, take top N
  const top = credible
    .sort((a, b) => b.roi - a.roi)
    .slice(0, limit);

  if (top.length === 0) {
    return {
      pool: pool_address,
      message: "No credible LPers found (need ≥3 positions, ≥60% win rate, ≥$1k inflow).",
      patterns: [],
      historical_samples: [],
    };
  }

  // ── 2. Historical positions for each top LPer ───────────────
  const historicalSamples = [];

  for (const lper of top) {
    const sample = {
      owner: lper.owner,
      owner_short: lper.owner.slice(0, 8) + "...",
      summary: {
        total_positions: lper.total_lp,
        win_rate: Math.round(lper.win_rate * 100) + "%",
        avg_hold_hours: Number(lper.avg_age_hour?.toFixed(2)),
        roi: (lper.roi * 100).toFixed(2) + "%",
        fee_pct_of_capital: (lper.fee_percent * 100).toFixed(2) + "%",
        total_pnl_usd: Math.round(lper.total_pnl),
      },
      positions: [],
    };

    try {
      // Small buffer to avoid race conditions on the 5-req limit
      await sleep(1000); 

      const histRes = await fetch(
        `${LPAGENT_API}/lp-positions/historical?owner=${lper.owner}&page=1&limit=50`,
        { headers: { "x-api-key": nextKey() } }
      );

      if (!histRes.ok) {
        historicalSamples.push(sample);
        continue;
      }

      const histData = await histRes.json();
      const positions = histData.data || [];

      sample.positions = positions.map((p) => ({
          pool: p.pool,
          pair: p.pairName || `${p.tokenName0}-${p.tokenName1}`,
          hold_hours: p.ageHour != null ? Number(p.ageHour?.toFixed(2)) : null,
          pnl_usd: Math.round(p.pnl?.value || 0),
          pnl_pct: ((p.pnl?.percent || 0) * 100).toFixed(1) + "%",
          fee_usd: Math.round(p.collectedFee || 0),
          in_range_pct: p.inRangePct != null ? Math.round(p.inRangePct * 100) + "%" : null,
          strategy: p.strategy || null,
          closed_reason: p.closeReason || null,
        }));
      historicalSamples.push(sample);
    } catch {
      historicalSamples.push(sample);
    }
  }

  // ── 3. Aggregate patterns ────────────────────────────────────
  const patterns = {
    top_lper_count: top.length,
    avg_hold_hours: avg(top.map((l) => l.avg_age_hour).filter(isNum)),
    avg_win_rate: avg(top.map((l) => l.win_rate).filter(isNum)),
    avg_roi_pct: avg(top.map((l) => l.roi * 100).filter(isNum)),
    avg_fee_pct_of_capital: avg(top.map((l) => l.fee_percent * 100).filter(isNum)),
    best_roi: (Math.max(...top.map((l) => l.roi)) * 100).toFixed(2) + "%",
    // Scalpers (hold < 1h) vs holders (> 4h)
    scalper_count: top.filter((l) => l.avg_age_hour < 1).length,
    holder_count: top.filter((l) => l.avg_age_hour >= 4).length,
  };

  return {
    pool: pool_address,
    patterns,
    lpers: historicalSamples,
  };
}

function avg(arr) {
  if (!arr.length) return null;
  return Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 100) / 100;
}

function isNum(n) {
  return typeof n === "number" && isFinite(n);
}

// ─── Lightweight LPer quality signal for screening ─────────────
// Single API call (vs studyTopLPers which calls N historical endpoints).
// Cached for 1h to avoid hammering during repeated screening cycles.
const _lperCache = new Map();
const LPER_CACHE_TTL_SUCCESS = 60 * 60 * 1000;  // 1h for real signals
const LPER_CACHE_TTL_FAILURE = 5 * 60 * 1000;   // 5m for failures (allow retry after API recovers)

// Auto-disable on 401 — top-lpers endpoint requires premium plan.
// Set once on first 401, blocks all further calls until process restart (user can upgrade then restart).
let _lperApiUnauthorized = false;

/**
 * Quick LPer quality assessment — just top-lpers endpoint, no historical fetch.
 * Returns classification + aggregate metrics for use as screening signal.
 *
 * Tiers (based on top LPer aggregate quality):
 *   elite   — avg ROI ≥ 20%, avg win_rate ≥ 70%, ≥3 credible LPers (smart money zone)
 *   good    — avg ROI ≥ 10%, avg win_rate ≥ 60%, ≥2 credible LPers
 *   neutral — any credible LPers but below "good" thresholds
 *   weak    — no credible LPers (all losing, low sample, or bot-dominated)
 *   none    — API failed or pool has no LP data
 */
export async function getLperQualitySignal({ pool_address }) {
  if (!pool_address) return { tier: "none", reason: "no pool address" };
  if (!LPAGENT_KEYS.length) return { tier: "none", reason: "LPAGENT_API_KEY not set" };
  // Hard-skip if API previously returned 401 — endpoint requires premium plan
  if (_lperApiUnauthorized) return { tier: "none", reason: "premium endpoint disabled (401)" };

  // Cache check — separate TTL for success vs failure (failures retry sooner)
  const cached = _lperCache.get(pool_address);
  if (cached) {
    const ttl = cached.signal.tier === "none" ? LPER_CACHE_TTL_FAILURE : LPER_CACHE_TTL_SUCCESS;
    if (Date.now() - cached.ts < ttl) {
      return cached.signal;
    }
  }

  try {
    const res = await fetch(
      `${LPAGENT_API}/pools/${pool_address}/top-lpers?sort_order=desc&page=1&limit=15`,
      { headers: { "x-api-key": nextKey() } }
    );
    if (!res.ok) {
      // 401 = premium endpoint not authorized → disable for entire process to stop wasting calls
      if (res.status === 401) {
        _lperApiUnauthorized = true;
        log("lper_quality", `LPer signal DISABLED for session — API 401 (top-lpers endpoint requires premium plan). Upgrade & restart bot to re-enable.`);
        return { tier: "none", reason: "premium endpoint disabled (401)" };
      }
      const signal = { tier: "none", reason: `API ${res.status}` };
      _lperCache.set(pool_address, { signal, ts: Date.now() });
      log("lper_quality", `${pool_address.slice(0, 8)}... API ${res.status} — caching "none" 5min`);
      return signal;
    }
    const data = await res.json();
    const all = data?.data || [];

    // Credible filter: enough samples to be statistically meaningful
    const credible = all.filter(l => l.total_lp >= 3 && l.total_inflow > 1000);

    if (credible.length === 0) {
      const signal = {
        tier: "weak",
        credible_count: 0,
        total_lpers: all.length,
        reason: all.length === 0 ? "no LP data" : "no credible LPers (need ≥3 positions, ≥$1k inflow)",
      };
      _lperCache.set(pool_address, { signal, ts: Date.now() });
      return signal;
    }

    const avgRoi = credible.reduce((s, l) => s + (l.roi || 0), 0) / credible.length * 100;
    const avgWinRate = credible.reduce((s, l) => s + (l.win_rate || 0), 0) / credible.length * 100;
    const avgHoldHours = credible.reduce((s, l) => s + (l.avg_age_hour || 0), 0) / credible.length;
    const bestRoi = Math.max(...credible.map(l => (l.roi || 0) * 100));
    const scalperRatio = credible.filter(l => l.avg_age_hour < 1).length / credible.length;

    // Tier classification
    let tier = "neutral";
    if (credible.length >= 3 && avgRoi >= 20 && avgWinRate >= 70) tier = "elite";
    else if (credible.length >= 2 && avgRoi >= 10 && avgWinRate >= 60) tier = "good";

    const signal = {
      tier,
      credible_count: credible.length,
      avg_roi_pct: Math.round(avgRoi * 10) / 10,
      avg_win_rate_pct: Math.round(avgWinRate * 10) / 10,
      avg_hold_hours: Math.round(avgHoldHours * 10) / 10,
      best_roi_pct: Math.round(bestRoi * 10) / 10,
      scalper_ratio: Math.round(scalperRatio * 100) / 100,
    };
    _lperCache.set(pool_address, { signal, ts: Date.now() });
    return signal;
  } catch (e) {
    const signal = { tier: "none", reason: e.message };
    _lperCache.set(pool_address, { signal, ts: Date.now() });
    return signal;
  }
}
