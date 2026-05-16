/**
 * IL Recovery Tracker
 *
 * After every IL stop / stop loss close, schedule a background fetch
 * to record what happened to price in the 60 min AFTER we exited.
 * Used to evaluate whether SL delay (Use Case B) is worth implementing.
 *
 * Output: logs/il_recovery-YYYY-MM-DD.jsonl
 *
 * Schema per line:
 *   {
 *     pool, pool_name, exit_pnl_pct, exit_close_reason, closed_at,
 *     price_at_close, max_recovery_pct_30m, max_drawdown_pct_30m,
 *     max_recovery_pct_60m, max_drawdown_pct_60m,
 *     would_have_recovered: bool   // true if max_recovery_pct_30m >= 7%
 *   }
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "logs");

const GT_BASE = "https://api.geckoterminal.com/api/v2";
const TRACK_WINDOW_MIN = 65;  // wait 65 min, then fetch
const PENDING = new Map();    // in-memory map of pool → timer (for cancellation)

function appendRecoveryLog(record) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(LOG_DIR, `il_recovery-${date}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(record) + "\n");
}

async function fetchPostClosePrices(pool) {
  const url = `${GT_BASE}/networks/solana/pools/${pool}/ohlcv/minute?limit=200&currency=usd`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json;version=20230302" } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    const raw = data?.data?.attributes?.ohlcv_list ?? [];
    if (!raw.length) return { error: "empty" };
    const bars = raw.map(([t, o, h, l, c, v]) => ({ time: t, open: o, high: h, low: l, close: c, volume: v }))
                    .sort((a, b) => a.time - b.time);
    return { bars };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Schedule a 65-min post-close fetch to record price recovery/drawdown.
 * Non-blocking — runs in background.
 *
 * @param {object} params
 * @param {string} params.pool             - pool address
 * @param {string} params.poolName         - human-readable name
 * @param {string} params.closeReason      - close reason text
 * @param {number} params.exitPnlPct       - PnL % at close
 * @param {string} params.closedAt         - ISO timestamp of close
 */
export function trackILRecovery({ pool, poolName, closeReason, exitPnlPct, closedAt }) {
  if (!pool || !closedAt) return;
  const closedAtTs = Math.floor(new Date(closedAt).getTime() / 1000);

  // Cancel any existing tracker for same pool (rare but possible)
  if (PENDING.has(pool)) clearTimeout(PENDING.get(pool));

  const timer = setTimeout(async () => {
    PENDING.delete(pool);
    const { bars, error } = await fetchPostClosePrices(pool);
    if (error) {
      log("il_recovery", `${poolName}: failed to fetch post-close OHLCV (${error})`);
      appendRecoveryLog({ pool, pool_name: poolName, closed_at: closedAt, exit_pnl_pct: exitPnlPct, exit_close_reason: closeReason, error });
      return;
    }

    const priceAtClose = bars.find(b => b.time >= closedAtTs - 60)?.open;
    if (!priceAtClose) {
      appendRecoveryLog({ pool, pool_name: poolName, closed_at: closedAt, exit_pnl_pct: exitPnlPct, exit_close_reason: closeReason, error: "no_price_at_close" });
      return;
    }

    const calcWindow = (winMin) => {
      const winEnd = closedAtTs + winMin * 60;
      const inWindow = bars.filter(b => b.time >= closedAtTs && b.time <= winEnd);
      if (!inWindow.length) return null;
      const maxPrice = Math.max(...inWindow.map(b => b.high));
      const minPrice = Math.min(...inWindow.map(b => b.low));
      return {
        max_recovery_pct: Math.round(((maxPrice - priceAtClose) / priceAtClose) * 10000) / 100,
        max_drawdown_pct: Math.round(((minPrice - priceAtClose) / priceAtClose) * 10000) / 100,
      };
    };

    const r30 = calcWindow(30);
    const r60 = calcWindow(60);

    const record = {
      pool,
      pool_name: poolName,
      closed_at: closedAt,
      exit_pnl_pct: exitPnlPct,
      exit_close_reason: closeReason,
      price_at_close: priceAtClose,
      max_recovery_pct_30m: r30?.max_recovery_pct ?? null,
      max_drawdown_pct_30m: r30?.max_drawdown_pct ?? null,
      max_recovery_pct_60m: r60?.max_recovery_pct ?? null,
      max_drawdown_pct_60m: r60?.max_drawdown_pct ?? null,
      would_have_recovered: r30 && r30.max_recovery_pct >= 7,
    };
    appendRecoveryLog(record);

    log("il_recovery",
      `${poolName} exit=${exitPnlPct}% | 30m: rec=${r30?.max_recovery_pct}% dd=${r30?.max_drawdown_pct}% | ` +
      `60m: rec=${r60?.max_recovery_pct}% dd=${r60?.max_drawdown_pct}% | ` +
      `would_recover=${record.would_have_recovered}`
    );
  }, TRACK_WINDOW_MIN * 60 * 1000);

  PENDING.set(pool, timer);
  log("il_recovery", `Scheduled post-close tracking for ${poolName} in ${TRACK_WINDOW_MIN} min`);
}
