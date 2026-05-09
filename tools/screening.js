import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown, isPoolOnRejectionCooldown, markPoolRejection } from "../pool-memory.js";
import { loadWeights } from "../signal-weights.js";

// Cache evolved weights for the duration of a screening cycle
let _cachedWeights = null;
let _cachedWeightsAt = 0;
function getEvolvedWeights() {
  const now = Date.now();
  if (!_cachedWeights || now - _cachedWeightsAt > 60_000) {
    _cachedWeights = loadWeights()?.weights || {};
    _cachedWeightsAt = now;
  }
  return _cachedWeights;
}

const DATAPI_JUP = "https://datapi.jup.ag/v1";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";



/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 50,
} = {}) {
  const s = config.screening;

  // Base filters applied to all categories
  const baseFilters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap<=${s.maxMcap}`,
    `tvl<=${s.maxTvl}`,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
  ].filter(Boolean);

  // Strict filters — only for trending (established pools)
  const strictFilters = [
    ...baseFilters,
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    "quote_token_organic_score>=60",
  ].join("&&");

  // Loose filters — for "new" category (early pools, low volume ok)
  // Use a fixed low floor (0.05) instead of % of strict threshold —
  // prevents loose filter from being too aggressive when strict is high (e.g. 1.5 * 0.25 = 0.375)
  const looseFeeFloor = Math.min(0.05, (s.minFeeActiveTvlRatio || 0.15) * 0.25);
  const looseFilters = [
    ...baseFilters,
    `base_token_holders>=50`,
    `tvl>=500`,
    `fee_active_tvl_ratio>=${looseFeeFloor}`,
  ].join("&&");

  // Scan multiple categories in parallel
  const categories = [
    { category: s.category || "trending", filters: strictFilters },
    { category: "new", filters: looseFilters },
    { category: "top", filters: strictFilters },
  ];

  const results = await Promise.allSettled(
    categories.map(({ category, filters }) => {
      const url = `${POOL_DISCOVERY_BASE}/pools?` +
        `page_size=${page_size}` +
        `&filter_by=${encodeURIComponent(filters)}` +
        `&timeframe=${s.timeframe}` +
        `&category=${category}`;
      return fetch(url).then((res) => {
        if (!res.ok) throw new Error(`Pool Discovery API error (${category}): ${res.status}`);
        return res.json();
      }).then((data) => ({ category, pools: data.data || [] }));
    })
  );

  // Merge — deduplicate by pool address
  const seen = new Set();
  const allPools = [];
  for (const r of results) {
    if (r.status !== "fulfilled") {
      log("screening", `Category fetch failed: ${r.reason?.message}`);
      continue;
    }
    const { category, pools } = r.value;
    for (const p of pools) {
      if (!seen.has(p.pool_address)) {
        seen.add(p.pool_address);
        p._source_category = category; // tag for logging
        allPools.push(p);
      }
    }
  }

  log("screening", `Discovered ${allPools.length} unique pools across ${categories.map(c => c.category).join("+")} categories`);

  const condensed = allPools.map(condensePool);

  const WSOL_MINT = "So11111111111111111111111111111111111111112";

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = condensed.filter((p) => {
    if (p.quote?.mint !== WSOL_MINT) {
      log("screening", `Filtered ${p.name} — quote token is not SOL (${p.quote?.symbol})`);
      return false;
    }
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens/devs`);

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              return { pool: p.pool, dev: t?.dev || null };
            })
            .catch(() => ({ pool: p.pool, dev: null }))
        )
      );
      const devMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") devMap[r.value.pool] = r.value.dev;
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; // enrich in-place
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  return {
    total: allPools.length,
    pools,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  const { pools } = await discoverPools({ page_size: 50 });
  const filteredOut = [];

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));

  const eligible = pools
    .filter((p) => {
      if (occupiedPools.has(p.pool)) {
        pushFilteredReason(filteredOut, p, "already have an open position in this pool");
        return false;
      }
      if (occupiedMints.has(p.base?.mint)) {
        pushFilteredReason(filteredOut, p, "already holding this base token in another pool");
        return false;
      }
      if (isPoolOnCooldown(p.pool)) {
        log("screening", `Filtered cooldown pool ${p.name} (${p.pool.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "pool cooldown active");
        return false;
      }
      if (isBaseMintOnCooldown(p.base?.mint)) {
        log("screening", `Filtered cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "token cooldown active");
        return false;
      }
      return true;
    })
    .slice(0, limit);

  // enrichPvpRisk removed — PVP data surfaced via LLM judgment from pool metrics
  // Enrich with OKX data — advanced info (risk/bundle/sniper) + ATH price (no API key required)
  if (eligible.length > 0) {
    const { getAdvancedInfo, getPriceInfo, getClusterList, getRiskFlags } = await import("./okx.js");
    const okxResults = await Promise.allSettled(
      eligible.map(async (p) => {
        if (!p.base?.mint) return { adv: null, price: null, clusters: [], risk: null };
        const [adv, price, clusters, risk] = await Promise.allSettled([
          getAdvancedInfo(p.base.mint),
          getPriceInfo(p.base.mint),
          getClusterList(p.base.mint),
          getRiskFlags(p.base.mint),
        ]);

        const mintShort = p.base.mint.slice(0, 8);
        if (adv.status !== "fulfilled")      log("okx", `advanced-info unavailable for ${p.name} (${mintShort})`);
        if (price.status !== "fulfilled")    log("okx", `price-info unavailable for ${p.name} (${mintShort})`);
        if (clusters.status !== "fulfilled") log("okx", `cluster-list unavailable for ${p.name} (${mintShort})`);
        if (risk.status !== "fulfilled")     log("okx", `risk-check unavailable for ${p.name} (${mintShort})`);

        return {
          adv: adv.status === "fulfilled" ? adv.value : null,
          price: price.status === "fulfilled" ? price.value : null,
          clusters: clusters.status === "fulfilled" ? clusters.value : [],
          risk: risk.status === "fulfilled" ? risk.value : null,
        };
      })
    );
    for (let i = 0; i < eligible.length; i++) {
      const r = okxResults[i];
      if (r.status !== "fulfilled") continue;
      const { adv, price, clusters, risk } = r.value;
      if (adv) {
        eligible[i].risk_level      = adv.risk_level;
        eligible[i].bundle_pct      = adv.bundle_pct;
        eligible[i].sniper_pct      = adv.sniper_pct;
        eligible[i].suspicious_pct  = adv.suspicious_pct;
        eligible[i].smart_money_buy = adv.smart_money_buy;
        eligible[i].dev_sold_all    = adv.dev_sold_all;
        eligible[i].dex_boost       = adv.dex_boost;
        eligible[i].dex_screener_paid = adv.dex_screener_paid;
        if (adv.creator && !eligible[i].dev) eligible[i].dev = adv.creator;
      }
      if (risk) {
        eligible[i].is_rugpull = risk.is_rugpull;
        eligible[i].is_wash    = risk.is_wash;
      }
      if (price) {
        eligible[i].price_vs_ath_pct = price.price_vs_ath_pct;
        eligible[i].ath              = price.ath;
      }
      if (clusters?.length) {
        // Surface KOL presence and top cluster trend for LLM
        eligible[i].kol_in_clusters      = clusters.some((c) => c.has_kol);
        eligible[i].top_cluster_trend    = clusters[0]?.trend ?? null;      // buy|sell|neutral
        eligible[i].top_cluster_hold_pct = clusters[0]?.holding_pct ?? null;
      }
    }
    // Wash trading hard filter — fake volume = misleading fee yield
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      if (p.is_wash) {
        log("screening", `Risk filter: dropped ${p.name} — wash trading flagged`);
        pushFilteredReason(filteredOut, p, "wash trading flagged");
        return false;
      }
      return true;
    }));

    // ATH filter — drop pools where price is too close to ATH
    const athFilter = config.screening.athFilterPct;
    if (athFilter != null) {
      const threshold = 100 + athFilter; // e.g. -20 → threshold = 80 (price must be <= 80% of ATH)
      const before = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.price_vs_ath_pct == null) return true; // no data → don't filter
        if (p.price_vs_ath_pct > threshold) {
          log("screening", `ATH filter: dropped ${p.name} — ${p.price_vs_ath_pct}% of ATH (limit: ${threshold}%)`);
          pushFilteredReason(filteredOut, p, `${p.price_vs_ath_pct}% of ATH > ${threshold}% limit`);
          return false;
        }
        return true;
      }));
      if (eligible.length < before) log("screening", `ATH filter removed ${before - eligible.length} pool(s)`);
    }

    // Drop any pools whose creator is on the dev blocklist (caught via advanced-info)
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer (okx) ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via OKX creator check`);
  }

  // ── Hard volatility filter ───────────────────────────────────
  // Data: vol>5 positions avg -4% PnL (BURNIE -7.73%, Freg -4.36%). vol≤5 are recoverable.
  // Data: vol<2 positions avg -0.37% PnL — too quiet, fees don't cover gas.
  const maxVol = config.screening.maxVolatility ?? 5;
  const minVol = config.screening.minVolatility ?? null;
  eligible.splice(0, eligible.length, ...eligible.filter((p) => {
    const vol = Number(p.volatility ?? 0);
    if (vol > maxVol) {
      log("screening", `Vol filter: dropped ${p.name} — volatility ${vol} > ${maxVol}`);
      pushFilteredReason(filteredOut, p, `volatility ${vol} > ${maxVol}`);
      return false;
    }
    if (minVol != null && vol < minVol) {
      log("screening", `Vol filter: dropped ${p.name} — volatility ${vol} < ${minVol} (too quiet)`);
      pushFilteredReason(filteredOut, p, `volatility ${vol} < ${minVol}`);
      return false;
    }
    return true;
  }));

  // ── Swap activity filter ─────────────────────────────────────
  // Data: 65% of pools with good fee/TVL still produce zero fees after deploy.
  // swap_count and unique_traders from Meteora API are real-time activity indicators.
  const minSwaps   = config.screening.minSwapCount ?? 5;
  const minTraders = config.screening.minUniqueTraders ?? 3;
  eligible.splice(0, eligible.length, ...eligible.filter((p) => {
    const swaps   = Number(p.swap_count ?? 0);
    const traders = Number(p.unique_traders ?? 0);
    if (swaps < minSwaps) {
      log("screening", `Activity filter: dropped ${p.name} — swap_count ${swaps} < ${minSwaps}`);
      pushFilteredReason(filteredOut, p, `swap_count ${swaps} < ${minSwaps}`);
      return false;
    }
    if (traders < minTraders) {
      log("screening", `Activity filter: dropped ${p.name} — unique_traders ${traders} < ${minTraders}`);
      pushFilteredReason(filteredOut, p, `unique_traders ${traders} < ${minTraders}`);
      return false;
    }
    return true;
  }));

  // ── Distribution risk filter (anti-whipsaw) ──────────────────
  // Data: soothsayer-SOL May 8 — rejected at 01:25 (volume_spike + price -5.8%),
  // accepted at 01:40 when signals decayed → -11.30% loss.
  // Hard rule: volume_spike >= 3 AND price_change_pct <= -5 = high distribution risk.
  // Mark 60-min rejection cooldown to prevent re-evaluation when signals decay too fast.
  eligible.splice(0, eligible.length, ...eligible.filter((p) => {
    // Check existing rejection cooldown first (from previous cycle)
    if (isPoolOnRejectionCooldown(p.pool)) {
      log("screening", `Filtered ${p.name} — rejection cooldown active (recent distribution risk)`);
      pushFilteredReason(filteredOut, p, "rejection cooldown active");
      return false;
    }
    // New distribution risk detection
    const volumeSpike = Number(p.volume_spike ?? 0);
    const priceChange = Number(p.price_change_pct ?? 0);
    if (volumeSpike >= 3 && priceChange <= -5) {
      log("screening", `Filtered ${p.name} — distribution risk: volume_spike=${volumeSpike}× + price_change=${priceChange}%`);
      pushFilteredReason(filteredOut, p, `distribution risk: vol_spike ${volumeSpike}× + dump ${priceChange}%`);
      markPoolRejection(p.pool, `distribution_risk vol=${volumeSpike}x price=${priceChange}%`, 60);
      return false;
    }
    return true;
  }));

  // ── Enrich with pool memory + token stats (for scoring + LLM context) ───
  // Lookup pool history before scoring — token-level pattern catches multi-pool tokens
  const { getPoolMemory } = await import("../pool-memory.js");
  for (const pool of eligible) {
    try {
      const mem = getPoolMemory({ pool_address: pool.pool });
      if (mem?.known) {
        pool._pool_memory = mem;
        pool._token_stats = mem.token_stats || null;
      }
    } catch { /* non-blocking */ }
  }

  // ── Score and rank candidates ────────────────────────────────
  for (const pool of eligible) {
    const smartWalletsPresent = !!(pool.kol_in_clusters || pool.smart_money_buy);
    const { score, breakdown } = scoreCandidate(pool, smartWalletsPresent);
    pool.score = score;
    pool.score_breakdown = breakdown;
    pool.score_label = score >= 60 ? "STRONG" : score >= 50 ? "GOOD" : score >= 35 ? "MARGINAL" : "SKIP";
  }

  eligible.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  log("screening", `Scored ${eligible.length} candidate(s): ${eligible.map((p) => `${p.name}=${p.score}`).join(", ")}`);

  return {
    candidates: eligible.slice(0, limit),
    total_screened: pools.length,
    filtered_examples: filteredOut.slice(0, 3),
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${pool_address}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const pool = (data.data || [])[0];

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    // API sometimes returns 0 for fee_active_tvl_ratio on short timeframes — compute from raw values as fallback
    fee_active_tvl_ratio: p.fee_active_tvl_ratio > 0
      ? fix(p.fee_active_tvl_ratio, 4)
      : (p.active_tvl > 0 ? fix((p.fee / p.active_tvl) * 100, 4) : 0),
    volatility: fix(p.volatility, 2),


    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
  };
}

/**
 * Score a condensed pool candidate for LP quality.
 * Returns { score, breakdown } where score is 0-100+.
 *
 * Framework based on DLMM profitability dynamics:
 *   P&L = fee_earned - IL
 *   → Maximize: fee rate, organic activity, smart money signals
 *   → Minimize: IL risk (volatility, dump signals, concentration)
 *
 * Thresholds: ≥60 = deploy, 40-59 = caution, <40 = skip
 */
export function scoreCandidate(pool, smartWalletsPresent = false) {
  const breakdown = {};
  let score = 0;

  // Pull evolved weights from Darwinian system (fee_tvl=1.798, bot_holders=0.54, etc.)
  // Weights >1 = winning signals (boost), <1 = toxic (penalize harder).
  // Use sqrt scaling to dampen extreme weights (1.798→1.34, 0.5→0.71) and prevent
  // any single component from dominating the score.
  const w = getEvolvedWeights();
  const wMul = (key, fallback = 1) => {
    const v = Number(w[key]);
    if (!Number.isFinite(v) || v <= 0) return fallback;
    return Math.sqrt(v); // dampen: 1.8→1.34, 0.5→0.71
  };
  // Helper: apply weight then clamp to a max (ensures component caps hold)
  const weighted = (raw, weightKey, max) => {
    const w = wMul(weightKey);
    return Math.round(Math.min(max, raw * w));
  };
  // Helper for penalties: invert toxic weights (0.5 → 1.5× penalty)
  const penaltyWeight = (key) => {
    const v = Number(w[key]);
    if (!Number.isFinite(v) || v <= 0) return 1;
    if (v >= 1) return 1; // winning signal — no penalty amplification
    return 1 + (1 - v); // toxic: 0.5→1.5, 0.7→1.3
  };

  // ── Fee/TVL ratio (35 pts max, capped at pump-trap level) ─────
  // Primary predictor of fee income. Target scaled per timeframe.
  // CAP: feeTvl > 5 = pump trap (post-pump distribution), score plateaus at target * 4.
  const timeframe = config.screening.timeframe || "30m";
  const feeTvlTarget = { "5m": 0.04, "15m": 0.1, "30m": 0.4, "1h": 1.0, "2h": 0.8, "4h": 0.8, "24h": 3.0 }[timeframe] ?? 0.4;
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  // Cap effective ratio at 4× target — anything beyond is pump-trap suspect
  const effectiveFeeTvl = Math.min(feeTvl, feeTvlTarget * 4);
  const feeRaw = Math.min(35, effectiveFeeTvl / feeTvlTarget * 35);
  const feePts = weighted(feeRaw, "fee_tvl_ratio", 35);
  score += feePts;
  breakdown.fee_tvl = `${feeTvl}% → +${feePts} (target ${feeTvlTarget}%)`;

  // ── Pump-trap penalty (0 to -25) ────────────────────────────
  // Data: MOGMAN -83% (fee_tvl 6.09), Freg -4% (7.9), Rise -4% (8.4), POKE6900 -1.5% (8.2)
  // Extreme fee_tvl ratios indicate dumping into LP, not organic activity.
  let pumpTrapPts = 0;
  if (feeTvl > 8) pumpTrapPts = -25;
  else if (feeTvl > 6) pumpTrapPts = -15;
  else if (feeTvl > feeTvlTarget * 5) pumpTrapPts = -8;
  if (pumpTrapPts) {
    score += pumpTrapPts;
    breakdown.pump_trap = `${feeTvl}% → ${pumpTrapPts} (extreme fee_tvl)`;
  }

  // ── Organic score (20 pts max) ──────────────────────────────
  const organic = Number(pool.organic_score || 0);
  const organicRaw = organic < 50 ? 0 : Math.min(20, (organic - 50) / 50 * 20);
  const organicPts = weighted(organicRaw, "organic_score", 20);
  score += organicPts;
  breakdown.organic = `${organic} → +${organicPts}`;

  // ── Smart wallets / on-chain signals (15 pts max, STACKED) ──
  // FIX: previously used Math.max which prevented stacking. Now both contribute.
  const tags = pool.okx_tags || [];
  const devSoldAll = tags.includes("dev_sold_all") || pool.dev_sold_all;
  const smartMoneyBuy = tags.includes("smart_money_buy") || pool.smart_money_buy;
  const kolPresent = pool.kol_in_clusters;
  const swPts = smartWalletsPresent ? weighted(8, "smart_wallets_present", 8) : 0;
  const onChainPts = (devSoldAll ? 2 : 0) + (smartMoneyBuy ? 4 : 0) + (kolPresent ? 4 : 0);
  const signalPts = Math.min(15, swPts + onChainPts); // STACKED, capped at 15
  score += signalPts;
  breakdown.smart_signals = `sw=${smartWalletsPresent} okx_smart=${smartMoneyBuy} kol=${kolPresent} dev_sold=${devSoldAll} → +${signalPts}`;

  // ── Token age (gradual scaling, 0-7 pts) ─────────────────────
  // FIX: was binary jumps (0/3/5). Now gradual: log-scale up to 30d.
  // Weighted by evolved token_age weight (currently 1.798 — strong winner signal).
  const ageHours = Number(pool.token_age_hours || 0);
  let ageRaw = 0;
  if (ageHours >= 720) ageRaw = 7;        // 30d+
  else if (ageHours >= 336) ageRaw = 6;   // 14d
  else if (ageHours >= 168) ageRaw = 5;   // 7d
  else if (ageHours >= 72) ageRaw = 3;    // 3d
  else if (ageHours >= 24) ageRaw = 2;    // 1d
  else if (ageHours >= 12) ageRaw = 1;    // 12h
  const agePts = weighted(ageRaw, "token_age_hours", 7);
  score += agePts;
  breakdown.token_age = `${Math.round(ageHours / 24)}d → +${agePts}`;

  // ── Volatility (penalized harder via toxic weight 0.513) ─────
  // Sweet spot 2-4. Toxic weight amplifies penalty for high vol.
  const vol = Number(pool.volatility || 0);
  const volRaw = vol < 2 ? 2 : vol <= 4 ? 5 : vol <= 5 ? 0 : vol <= 7 ? -25 : -35;
  const volPts = volRaw >= 0
    ? weighted(volRaw, "volatility", 5)
    : Math.round(volRaw * penaltyWeight("volatility"));
  score += volPts;
  breakdown.volatility = `${vol} → ${volPts >= 0 ? "+" : ""}${volPts}`;

  // ── Price momentum penalty (0 to -25) ───────────────────────
  const priceChange = Number(pool.price_change_pct || 0);
  let momentumPts = 0;
  if (priceChange > 50) momentumPts = -25;
  else if (priceChange > 20) momentumPts = -15;
  else if (priceChange > 10) momentumPts = -10;
  else if (priceChange < -10) momentumPts = -25;
  else if (priceChange < -5) momentumPts = -10;
  score += momentumPts;
  if (momentumPts) breakdown.price_1h = `${priceChange}% → ${momentumPts}`;

  // ── Holder concentration penalty (0 to -20) ──────────────────
  const top10 = Number(pool.top10_pct || 0);
  const top10RawPts = top10 > 70 ? -20 : top10 > 55 ? -10 : top10 > 45 ? -5 : 0;
  // top10 weight is high (1.158 — winning negative signal) — stronger penalty
  const top10Pts = top10RawPts < 0 ? Math.round(top10RawPts * penaltyWeight("top10_holders_pct")) : 0;
  score += top10Pts;
  if (top10Pts) breakdown.top10_pct = `${top10}% → ${top10Pts}`;

  // ── NEW: Bot holders penalty (0 to -20) ──────────────────────
  // Toxic signal (weight 0.54). MOGMAN had 32.3% — score-level catch.
  const botPct = Number(pool.bot_holders_pct ?? 0);
  let botRawPts = 0;
  if (botPct > 40) botRawPts = -20;
  else if (botPct > 30) botRawPts = -12;
  else if (botPct > 20) botRawPts = -5;
  // Invert toxic weight: 0.54 → 1.46× penalty
  const botPts = botRawPts < 0 ? Math.round(botRawPts * penaltyWeight("bot_holders_pct")) : 0;
  score += botPts;
  if (botPts) breakdown.bot_holders = `${botPct}% → ${botPts}`;

  // ── NEW: Holder count bonus/penalty (-10 to +5) ──────────────
  // Sparse holders = rug-prone. Many holders = distributed risk.
  const holderCount = Number(pool.holder_count ?? 0);
  let holderPts = 0;
  if (holderCount > 0) {
    if (holderCount >= 1000) holderPts = 5;
    else if (holderCount >= 500) holderPts = 3;
    else if (holderCount >= 200) holderPts = 0;
    else if (holderCount >= 100) holderPts = -5;
    else holderPts = -10;
    holderPts = holderPts >= 0
      ? weighted(holderPts, "holder_count", 5)
      : Math.round(holderPts * penaltyWeight("holder_count"));
  }
  score += holderPts;
  if (holderPts) breakdown.holders = `${holderCount} → ${holderPts >= 0 ? "+" : ""}${holderPts}`;

  // ── NEW: Volume spike penalty (0 to -15) ─────────────────────
  // Boosted weight (1.158) — strong predictor when paired with caution.
  // Spikes >4× = often pump-and-dump in progress.
  const volumeSpike = Number(pool.volume_spike ?? pool._tech_snapshot?.volume_spike ?? 0);
  let spikePts = 0;
  if (volumeSpike >= 5) spikePts = -15;
  else if (volumeSpike >= 4) spikePts = -10;
  else if (volumeSpike >= 3) spikePts = -5;
  score += spikePts;
  if (spikePts) breakdown.volume_spike = `${volumeSpike}× → ${spikePts}`;

  // ── Swap activity bonus (10 pts max) ────────────────────────
  const swaps = Number(pool.swap_count ?? 0);
  const traders = Number(pool.unique_traders ?? 0);
  const activityRaw = (swaps >= 50 ? 7 : swaps >= 20 ? 5 : swaps >= 10 ? 3 : 0)
                    + (traders >= 20 ? 5 : traders >= 10 ? 3 : traders >= 5 ? 1 : 0);
  const activityPts = weighted(activityRaw, "swap_count", 12);
  score += activityPts;
  breakdown.activity = `swaps=${swaps} traders=${traders} → +${activityPts}`;

  // ── Pool memory factor (-15 to +8) ────────────────────────────
  // Statistical confidence required: ≥3 samples to avoid "100% WR sample 1" prank.
  // Token-level pattern preferred over pool-level (catches HANTA-SOL multi-pool pattern).
  const tokenStats = pool._token_stats;  // populated by enrichment if available
  const poolStats = pool._pool_memory;    // populated by enrichment if available
  // Token-level priority (broader pattern across all pools sharing base_mint)
  if (tokenStats && tokenStats.total_deploys >= 3) {
    const wr = tokenStats.win_rate;
    const avg = tokenStats.avg_pnl_pct ?? 0;
    let memPts = 0;
    if (wr >= 65 && avg > 0) memPts = 8;        // strong winner
    else if (wr >= 55) memPts = 4;              // decent
    else if (wr <= 30 || avg < -1) memPts = -15;// loser pattern
    else if (wr <= 45) memPts = -8;             // weak
    if (memPts !== 0) {
      score += memPts;
      breakdown.token_history = `wr=${wr}% avg=${avg.toFixed(2)}% (${tokenStats.total_deploys} deploys) → ${memPts >= 0 ? "+" : ""}${memPts}`;
    }
  } else if (poolStats && poolStats.adjusted_win_rate_sample_count >= 3) {
    const wr = poolStats.adjusted_win_rate;
    const avg = poolStats.avg_pnl_pct ?? 0;
    let memPts = 0;
    if (wr >= 65 && avg > 0) memPts = 5;
    else if (wr >= 55) memPts = 2;
    else if (wr <= 30 || avg < -1) memPts = -10;
    else if (wr <= 45) memPts = -5;
    if (memPts !== 0) {
      score += memPts;
      breakdown.pool_history = `wr=${wr}% avg=${avg.toFixed(2)}% (${poolStats.adjusted_win_rate_sample_count} samples) → ${memPts >= 0 ? "+" : ""}${memPts}`;
    }
  }

  return { score: Math.round(score), breakdown };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  return n != null ? Number(n.toFixed(decimals)) : null;
}

function pushFilteredReason(list, pool, reason) {
  if (!list || !pool) return;
  list.push({
    name: pool.name || `${pool.base?.symbol || "?"}-${pool.quote?.symbol || "?"}`,
    reason,
  });
}
