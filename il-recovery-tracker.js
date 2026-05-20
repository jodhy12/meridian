/**
 * IL Recovery Tracker
 *
 * After every IL stop / stop loss close, record what happened to price in the
 * 30-60 min AFTER we exited. Used to evaluate whether SL delay is worth implementing.
 *
 * Design: lazy evaluation, NOT setTimeout.
 *   - trackILRecovery() appends a pending entry to logs/il_recovery_pending.jsonl
 *   - processPendingILRecoveries() runs each management cycle — processes entries
 *     whose close is >= 65 min old, then removes them from pending
 *   This survives bot restarts (pending file persists on disk).
 *
 * Output: logs/il_recovery-YYYY-MM-DD.jsonl
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "logs");
const PENDING_FILE = path.join(LOG_DIR, "il_recovery_pending.jsonl");

const GT_BASE = "https://api.geckoterminal.com/api/v2";
const MATURE_MIN = 65;       // process entry once close is this old
const STALE_HOURS = 12;      // force-process (or drop) entries older than this
let _processing = false;     // re-entrancy guard

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendRecoveryLog(record) {
  ensureLogDir();
  const date = (record.closed_at || new Date().toISOString()).slice(0, 10);
  fs.appendFileSync(path.join(LOG_DIR, `il_recovery-${date}.jsonl`), JSON.stringify(record) + "\n");
}

function readPending() {
  if (!fs.existsSync(PENDING_FILE)) return [];
  try {
    return fs.readFileSync(PENDING_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch (e) {
    log("il_recovery", `Failed to read pending file: ${e.message}`);
    return [];
  }
}

function writePending(entries) {
  ensureLogDir();
  if (entries.length === 0) {
    if (fs.existsSync(PENDING_FILE)) fs.unlinkSync(PENDING_FILE);
    return;
  }
  fs.writeFileSync(PENDING_FILE, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
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
 * Record an IL/stop-loss close for later recovery analysis.
 * Just appends to the pending file — no timer. Processed later by processPendingILRecoveries().
 *
 * @param {object} params
 * @param {string} params.pool         - pool address
 * @param {string} params.poolName     - human-readable name
 * @param {string} params.closeReason  - close reason text
 * @param {number} params.exitPnlPct   - PnL % at close
 * @param {string} params.closedAt     - ISO timestamp of close
 */
export function trackILRecovery({ pool, poolName, closeReason, exitPnlPct, closedAt }) {
  if (!pool || !closedAt) return;
  ensureLogDir();
  const entry = {
    pool,
    pool_name: poolName,
    closed_at: closedAt,
    exit_pnl_pct: exitPnlPct,
    exit_close_reason: closeReason,
    _queued_at: new Date().toISOString(),
  };
  fs.appendFileSync(PENDING_FILE, JSON.stringify(entry) + "\n");
  log("il_recovery", `Queued post-close tracking for ${poolName} — will process after ${MATURE_MIN}min`);
}

/**
 * Process pending IL recovery entries. Call this from a cron cycle (management).
 * For each entry whose close is >= MATURE_MIN old: fetch OHLCV, compute recovery,
 * write result, remove from pending. Restart-safe — pending file is on disk.
 */
export async function processPendingILRecoveries() {
  if (_processing) return;
  const pending = readPending();
  if (pending.length === 0) return;

  _processing = true;
  try {
    const now = Date.now();
    const stillPending = [];

    for (const entry of pending) {
      const closedAtMs = new Date(entry.closed_at).getTime();
      const ageMin = (now - closedAtMs) / 60000;

      // Not mature yet — keep in pending
      if (ageMin < MATURE_MIN) {
        stillPending.push(entry);
        continue;
      }

      const isStale = ageMin > STALE_HOURS * 60;
      const closedAtTs = Math.floor(closedAtMs / 1000);
      const { bars, error } = await fetchPostClosePrices(entry.pool);

      if (error) {
        // Fetch failed — retry next cycle unless stale (then record error & drop)
        if (isStale) {
          appendRecoveryLog({ ...entry, error, _note: "stale — fetch failed, dropped after retries" });
          log("il_recovery", `${entry.pool_name}: stale + fetch failed (${error}) — recorded & dropped`);
        } else {
          stillPending.push(entry);
          log("il_recovery", `${entry.pool_name}: fetch failed (${error}) — will retry next cycle`);
        }
        continue;
      }

      const priceAtClose = bars.find(b => b.time >= closedAtTs - 60)?.open;
      if (!priceAtClose) {
        if (isStale) {
          appendRecoveryLog({ ...entry, error: "no_price_at_close", _note: "stale — no price data, dropped" });
          log("il_recovery", `${entry.pool_name}: stale + no price at close — recorded & dropped`);
        } else {
          stillPending.push(entry);
        }
        continue;
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
        pool: entry.pool,
        pool_name: entry.pool_name,
        closed_at: entry.closed_at,
        exit_pnl_pct: entry.exit_pnl_pct,
        exit_close_reason: entry.exit_close_reason,
        price_at_close: priceAtClose,
        max_recovery_pct_30m: r30?.max_recovery_pct ?? null,
        max_drawdown_pct_30m: r30?.max_drawdown_pct ?? null,
        max_recovery_pct_60m: r60?.max_recovery_pct ?? null,
        max_drawdown_pct_60m: r60?.max_drawdown_pct ?? null,
        would_have_recovered: r30 != null && r30.max_recovery_pct >= 7,
      };
      appendRecoveryLog(record);
      log("il_recovery",
        `${entry.pool_name} exit=${entry.exit_pnl_pct}% | 30m: rec=${r30?.max_recovery_pct}% dd=${r30?.max_drawdown_pct}% | ` +
        `60m: rec=${r60?.max_recovery_pct}% dd=${r60?.max_drawdown_pct}% | would_recover=${record.would_have_recovered}`
      );
      // Processed — not added back to stillPending (removed)
    }

    writePending(stillPending);
  } catch (e) {
    log("il_recovery", `processPendingILRecoveries error: ${e.message}`);
  } finally {
    _processing = false;
  }
}
