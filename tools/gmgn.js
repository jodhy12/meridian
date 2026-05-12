/**
 * GMGN OpenAPI helpers — Solana token enrichment.
 * Mirror interface of okx.js for drop-in replacement.
 *
 * Auth: X-APIKEY header + timestamp (seconds) + client_id (unique nonce per request).
 * Server enforces replay protection: same client_id+timestamp combo rejected.
 *
 * Setup:
 *   1. Register at https://gmgn.ai/ai
 *   2. Add to .env:
 *      GMGN_API_KEY=<your key>           ← required
 *
 * Field mapping verified against real responses (2026-05-12).
 */
import crypto from "crypto";
import { log } from "../logger.js";

const BASE = "https://openapi.gmgn.ai";
const CHAIN_SOLANA = "sol";
const CLIENT_PREFIX = "meridian";

const GMGN_API_KEY = process.env.GMGN_API_KEY || "";
const REQUEST_DELAY_MS = 500;   // serial gap between requests (GMGN strict; 350ms still triggered ban)
const CACHE_TTL_MS = 10 * 60 * 1000;  // cache 10 min per token+endpoint
const NEG_CACHE_TTL_MS = 60 * 1000;   // failed lookups cached 1 min (don't hammer same broken token)

const cache = new Map();  // key=`${path}:${address}` → { data, expiresAt }
let bannedUntil = 0;       // timestamp until rate-limit ban expires (server-side reset_at)

// Serial request queue — guarantees only ONE in-flight request at a time
// regardless of how many parallel callers. Prevents race condition on lastRequestAt.
let requestQueue = Promise.resolve();

function isAvailable() {
  return !!GMGN_API_KEY;
}

function genClientId() {
  return `${CLIENT_PREFIX}_${crypto.randomBytes(8).toString("hex")}`;
}

async function executeRequest(path, params) {
  // Honor server-side ban — fail fast until reset
  if (Date.now() < bannedUntil) {
    const waitS = Math.ceil((bannedUntil - Date.now()) / 1000);
    throw new Error(`GMGN banned for ${waitS}s more (skipping)`);
  }

  const ts = Math.floor(Date.now() / 1000);
  const allParams = { ...params, timestamp: ts, client_id: genClientId() };
  const qs = Object.entries(allParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const url = `${BASE}${path}?${qs}`;
  const res = await fetch(url, {
    headers: {
      "X-APIKEY": GMGN_API_KEY,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    // Parse rate limit reset to set bannedUntil
    if (res.status === 429) {
      try {
        const j = JSON.parse(txt);
        if (j.reset_at) bannedUntil = j.reset_at * 1000;
        else bannedUntil = Date.now() + 60_000;  // default 1min back-off
      } catch {
        bannedUntil = Date.now() + 60_000;
      }
    }
    throw new Error(`GMGN ${res.status}: ${path} — ${txt.slice(0, 100)}`);
  }
  const json = await res.json();
  if (json.code !== 0) {
    throw new Error(`GMGN ${json.error || json.code}: ${json.message || "unknown"} (${path})`);
  }
  return json.data;
}

async function gmgnGet(path, params = {}) {
  if (!isAvailable()) throw new Error("GMGN_API_KEY not configured");

  // Cache check first — no queueing needed
  const cacheKey = `${path}:${params.address || ""}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.error) throw cached.error;
    return cached.data;
  }

  // Enqueue: only one request executes at a time, with REQUEST_DELAY_MS gap
  const task = requestQueue.then(async () => {
    try {
      const data = await executeRequest(path, params);
      cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
      return data;
    } catch (err) {
      // Negative cache so we don't retry-spam broken tokens
      cache.set(cacheKey, { error: err, expiresAt: Date.now() + NEG_CACHE_TTL_MS });
      throw err;
    } finally {
      // Spacing: sleep AFTER each request before next dequeues
      await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
    }
  });

  // Replace queue with task that ignores errors (so chain doesn't break)
  requestQueue = task.catch(() => {});
  return task;
}

const num = (v) => v != null && v !== "" ? parseFloat(v) : null;
const int = (v) => v != null && v !== "" ? parseInt(v, 10) : null;
const bool = (v) => v === 1 || v === true || v === "1";

/**
 * Token security flags — honeypot, blacklist, sell restrictions.
 */
export async function getRiskFlags(tokenAddress) {
  try {
    const data = await gmgnGet("/v1/token/security", { chain: CHAIN_SOLANA, address: tokenAddress });
    if (!data) return null;
    return {
      is_rugpull:    bool(data.is_blacklist) || (num(data.lock_summary?.lock_percent) === 0 && data.burn_status !== "burn"),
      is_wash:       false, // GMGN doesn't expose wash directly
      is_honeypot:   bool(data.honeypot) || bool(data.is_honeypot),
      can_sell:      !bool(data.can_not_sell),
      buy_tax:       num(data.buy_tax),
      sell_tax:      num(data.sell_tax),
      risk_level:    data.is_show_alert ? 2 : 1,
      source:        "gmgn-security",
    };
  } catch (e) {
    log("gmgn", `risk-flags failed for ${tokenAddress.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

/**
 * Advanced token info — security flags + holder concentration + smart money proxy.
 * Combines /v1/token/info + /v1/token/security + /v1/market/token_top_traders.
 *
 * Smart money proxy: count top traders with wallet_tag_v2 set (TOP*, KOL, SMART, etc.)
 *                    or with positive PnL > $1k (proven traders).
 */
export async function getAdvancedInfo(tokenAddress) {
  try {
    // Serial calls (NOT parallel) — GMGN rate-limit is strict, parallel triggers 429 ban.
    // Throttle inside gmgnGet handles inter-request delay automatically.
    const info = await gmgnGet("/v1/token/info", { chain: CHAIN_SOLANA, address: tokenAddress }).catch(() => ({}));
    const sec = await gmgnGet("/v1/token/security", { chain: CHAIN_SOLANA, address: tokenAddress }).catch(() => ({}));
    const tradersData = await gmgnGet("/v1/market/token_top_traders", { chain: CHAIN_SOLANA, address: tokenAddress, limit: 20 }).catch(() => ({}));
    const traders = tradersData?.list || [];

    // Smart money / KOL detection from top traders
    const tagged = traders.filter(t => t.wallet_tag_v2);
    const profitableSmart = traders.filter(t => (t.profit || 0) > 1000);
    const smartMoneyCount = new Set([...tagged, ...profitableSmart].map(t => t.address)).size;
    const kolPresent = tagged.some(t => /KOL|TOP|SMART|FOLLOW/i.test(t.wallet_tag_v2));

    // top_10_holder_rate is decimal (e.g. "0.1342" = 13.42%)
    const top10Decimal = num(sec.top_10_holder_rate);
    const top10Pct = top10Decimal != null ? top10Decimal * 100 : null;

    // Tags
    const tags = [];
    if (bool(sec.honeypot)) tags.push("honeypot");
    if (smartMoneyCount > 0) tags.push("smartMoneyBuy");
    if (kolPresent) tags.push("kolPresent");
    if (sec.burn_status === "burn") tags.push("liquidityBurned");
    if (info.launchpad_platform) tags.push(`launchpad_${info.launchpad_platform.toLowerCase()}`);

    // Risk: blacklist or unable to sell or high tax
    const riskLevel = bool(sec.honeypot) || bool(sec.can_not_sell) || num(sec.sell_tax) > 0.1 ? 3
                    : sec.is_show_alert ? 2 : 1;

    return {
      risk_level:       riskLevel,
      bundle_pct:       null,  // GMGN doesn't expose bundle % directly
      sniper_pct:       null,
      suspicious_pct:   null,
      dev_holding_pct:  num(sec.dev_token_burn_ratio) != null ? num(sec.dev_token_burn_ratio) * 100 : null,
      top10_pct:        top10Pct,
      lp_burned_pct:    sec.burn_status === "burn" ? 100 : (num(sec.burn_ratio) != null ? num(sec.burn_ratio) * 100 : null),
      total_fee_sol:    num(info.total_fee),
      dev_rug_count:    null,  // not in standard GMGN response
      dev_token_count:  null,
      creator:          null,
      tags,
      is_honeypot:      bool(sec.honeypot),
      smart_money_buy:  smartMoneyCount > 0,
      smart_money_count: smartMoneyCount,
      kol_in_clusters:  kolPresent,
      dev_sold_all:     num(sec.dev_token_burn_ratio) >= 0.99,
      dev_buying_more:  false,  // not detectable via security alone
      low_liquidity:    num(info.liquidity) < 5000,
      dex_boost:        false,
      dex_screener_paid: false,
      can_sell:         !bool(sec.can_not_sell),
      buy_tax:          num(sec.buy_tax),
      sell_tax:         num(sec.sell_tax),
      renounced:        bool(sec.renounced_mint) && bool(sec.renounced_freeze_account),
    };
  } catch (e) {
    log("gmgn", `advanced-info failed for ${tokenAddress.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

/**
 * Top traders list — used for cluster/KOL analysis.
 * Maps real GMGN response (rich PnL/balance data) to simpler cluster shape.
 */
export async function getClusterList(tokenAddress, limit = 5) {
  try {
    const data = await gmgnGet("/v1/market/token_top_traders", { chain: CHAIN_SOLANA, address: tokenAddress, limit: 20 });
    const list = data?.list || [];
    if (!list.length) return [];

    return list.slice(0, limit).map((t) => ({
      address:       t.address,
      holding_pct:   num(t.amount_percentage) != null ? num(t.amount_percentage) * 100 : null,
      trend:         (t.netflow_amount > 0) ? "buying" : (t.netflow_amount < 0) ? "selling" : "holding",
      avg_hold_days: null,  // GMGN doesn't expose holding period directly
      pnl_pct:       num(t.realized_pnl) != null ? num(t.realized_pnl) * 100 : null,
      pnl_usd:       num(t.profit),
      buy_vol_usd:   num(t.buy_volume_cur),
      sell_vol_usd:  num(t.sell_volume_cur),
      avg_buy_price: null,
      has_kol:       !!t.wallet_tag_v2 && /KOL|TOP|SMART|FOLLOW/i.test(t.wallet_tag_v2),
      tag:           t.wallet_tag_v2 || null,
      address_count: 1,
    }));
  } catch (e) {
    log("gmgn", `cluster-list failed for ${tokenAddress.slice(0, 8)}: ${e.message}`);
    return [];
  }
}

/**
 * Price + market data — current price, ATH, holders, mcap proxy, liquidity.
 */
export async function getPriceInfo(tokenAddress) {
  try {
    const data = await gmgnGet("/v1/token/info", { chain: CHAIN_SOLANA, address: tokenAddress });
    if (!data) return null;
    const price = num(data.price);
    const ath = num(data.ath_price);
    const supply = num(data.total_supply) || num(data.circulating_supply);
    const mcap = price != null && supply != null ? price * supply : null;
    return {
      price,
      ath,
      atl:              null,  // GMGN doesn't expose ATL
      price_vs_ath_pct: ath > 0 && price ? parseFloat(((price / ath) * 100).toFixed(1)) : null,
      price_change_5m:  null,
      price_change_1h:  null,
      volume_5m:        null,
      volume_1h:        null,
      holders:          int(data.holder_count),
      market_cap:       mcap,
      liquidity:        num(data.liquidity),
      launchpad:        data.launchpad_platform || null,
      creation_ts:      int(data.creation_timestamp),
      migrated_ts:      int(data.migrated_timestamp),
      total_fee_sol:    num(data.total_fee),
    };
  } catch (e) {
    log("gmgn", `price-info failed for ${tokenAddress.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

/**
 * Parallel fetch all enrichment data.
 */
export async function getFullTokenAnalysis(tokenAddress) {
  // Serial — internal calls already cached, so subsequent same-token lookups are free
  const advanced = await getAdvancedInfo(tokenAddress).catch(() => null);
  const price    = await getPriceInfo(tokenAddress).catch(() => null);
  const clusters = await getClusterList(tokenAddress).catch(() => []);
  return { advanced, clusters, price };
}

export { isAvailable };
