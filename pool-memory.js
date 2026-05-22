/**
 * Pool memory — persistent deploy history per pool.
 *
 * Keyed by pool address. Automatically updated when positions close
 * (via recordPerformance in lessons.js). Agent can query before deploying.
 */

import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";

const POOL_MEMORY_FILE = "./pool-memory.json";
const MAX_NOTE_LENGTH = 280;

function sanitizeStoredNote(text, maxLen = MAX_NOTE_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(POOL_MEMORY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(data, null, 2));
}

function isOorCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text === "oor" || text.includes("out of range") || text.includes("oor");
}

/**
 * Classify close reason → cooldown duration (hours).
 * Categories (most-specific first):
 *   Critical (12h)  — dead pool, near-zero fees, repeated OOR — structurally broken
 *   IL/Stop (1.5h)  — IL stop / stop loss / Early IL — V-shape window
 *   Yield (3h)      — low yield / stale flat — pool quiet but maybe recover
 *   Flat (2h)       — max hold negative / Flat exit — slow death
 *   Direction (0.5h)— pumped above / OOR / Out of range — price moved, fresh state
 *   Default (2h)    — anything else (rare; falls back to tokenCooldownHours)
 */
export function getCooldownByReason(reason) {
  const r = String(reason || "").toLowerCase();
  const cfg = config.management;
  if (!r) return cfg.tokenCooldownHours ?? 2;
  // Critical first — overrides other matches (e.g. "dead pool — OOR after 4 min" should be critical, not direction)
  if (r.includes("dead pool") || r.includes("near-zero fees") || r.includes("no fees") || r.includes("repeated oor") || r.includes("early dead detect")) {
    return cfg.cooldownCriticalHours ?? 12;
  }
  if (r.includes("il stop") || r.includes("stop loss") || r.includes("early il")) {
    return cfg.cooldownILHours ?? 1.5;
  }
  if (r.includes("low yield") || r.includes("stale flat")) {
    return cfg.cooldownYieldHours ?? 3;
  }
  if (r.includes("max hold") || r.includes("flat exit") || r.includes("lost-gains") || r.includes("lost gains")) {
    return cfg.cooldownFlatHours ?? 2;
  }
  if (r.includes("pumped") || r.includes("oor") || r.includes("out of range")) {
    return cfg.cooldownDirectionHours ?? 0.5;
  }
  return cfg.tokenCooldownHours ?? 2;
}

function isAdjustedWinRateExcludedReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("out of range") ||
    text.includes("pumped far above range") ||
    text === "oor" ||
    text.includes("oor");
}

function setPoolCooldown(entry, hours, reason) {
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  entry.cooldown_until = cooldownUntil;
  entry.cooldown_reason = reason;
  return cooldownUntil;
}

function setBaseMintCooldown(db, baseMint, hours, reason) {
  if (!baseMint) return null;
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  for (const entry of Object.values(db)) {
    if (entry?.base_mint === baseMint) {
      entry.base_mint_cooldown_until = cooldownUntil;
      entry.base_mint_cooldown_reason = reason;
    }
  }
  return cooldownUntil;
}

// ─── Write ─────────────────────────────────────────────────────

/**
 * Record a closed deploy into pool-memory.json.
 * Called automatically from recordPerformance() in lessons.js.
 *
 * @param {string} poolAddress
 * @param {Object} deployData
 * @param {string} deployData.pool_name
 * @param {string} deployData.base_mint
 * @param {string} deployData.deployed_at
 * @param {string} deployData.closed_at
 * @param {number} deployData.pnl_pct
 * @param {number} deployData.pnl_usd
 * @param {number} deployData.range_efficiency
 * @param {number} deployData.minutes_held
 * @param {string} deployData.close_reason
 * @param {string} deployData.strategy
 * @param {number} deployData.volatility
 */
export function recordPoolDeploy(poolAddress, deployData) {
  if (!poolAddress) return;

  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: deployData.pool_name || poolAddress.slice(0, 8),
      base_mint: deployData.base_mint || null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  const entry = db[poolAddress];

  const deploy = {
    deployed_at: deployData.deployed_at || null,
    closed_at: deployData.closed_at || new Date().toISOString(),
    pnl_pct: deployData.pnl_pct ?? null,
    pnl_usd: deployData.pnl_usd ?? null,
    range_efficiency: deployData.range_efficiency ?? null,
    minutes_held: deployData.minutes_held ?? null,
    close_reason: deployData.close_reason || null,
    strategy: deployData.strategy || null,
    volatility_at_deploy: deployData.volatility ?? null,
  };

  entry.deploys.push(deploy);
  entry.total_deploys = entry.deploys.length;
  entry.last_deployed_at = deploy.closed_at;
  entry.last_outcome = (deploy.pnl_pct ?? 0) >= 0 ? "profit" : "loss";

  // Recompute aggregates
  const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
  if (withPnl.length > 0) {
    entry.avg_pnl_pct = Math.round(
      (withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100
    ) / 100;
    entry.win_rate = Math.round(
      (withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100
    ) / 100;
  }
  const adjusted = withPnl.filter((d) => !isAdjustedWinRateExcludedReason(d.close_reason));
  entry.adjusted_win_rate_sample_count = adjusted.length;
  entry.adjusted_win_rate = adjusted.length > 0
    ? Math.round((adjusted.filter((d) => d.pnl_pct >= 0).length / adjusted.length) * 10000) / 100
    : 0;

  if (deployData.base_mint && !entry.base_mint) {
    entry.base_mint = deployData.base_mint;
  }

  // Set cooldown based on close reason — uses per-category durations from config
  if (deploy.close_reason) {
    const cooldownHours = getCooldownByReason(deploy.close_reason);
    const cooldownUntil = setPoolCooldown(entry, cooldownHours, deploy.close_reason.slice(0, 60));
    log("pool-memory", `Cooldown ${cooldownHours}h set for ${entry.name} until ${cooldownUntil} (${deploy.close_reason.slice(0, 50)})`);
  }

  const oorTriggerCount = config.management.oorCooldownTriggerCount ?? 3;
  const oorCooldownHours = config.management.oorCooldownHours ?? 12;
  const recentDeploys = entry.deploys.slice(-oorTriggerCount);
  const repeatedOorCloses =
    recentDeploys.length >= oorTriggerCount &&
    recentDeploys.every((d) => isOorCloseReason(d.close_reason));

  if (repeatedOorCloses) {
    const reason = `repeated OOR closes (${oorTriggerCount}x)`;
    const poolCooldownUntil = setPoolCooldown(entry, oorCooldownHours, reason);
    const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, oorCooldownHours, reason);
    log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
    if (entry.base_mint && mintCooldownUntil) {
      log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
    }
  }

  save(db);
  log("pool-memory", `Recorded deploy for ${entry.name} (${poolAddress.slice(0, 8)}): PnL ${deploy.pnl_pct}%`);
}

export function isPoolOnCooldown(poolAddress) {
  if (!poolAddress) return false;
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return false;

  if (entry.cooldown_until && new Date(entry.cooldown_until) > new Date()) return true;
  return false;
}

/**
 * Mark a pool as recently REJECTED by screening (without ever being deployed).
 * Used to prevent whipsaw: pool rejected for distribution risk → indicator decays
 * → pool re-evaluated and accepted in same scanning session.
 * Stored separately from regular cooldown (which applies to closed positions).
 *
 * @param {string} poolAddress
 * @param {string} reason — e.g. "distribution_risk: volume_spike + price dump"
 * @param {number} minutes — cooldown duration (default 60 min)
 */
export function markPoolRejection(poolAddress, reason, minutes = 60) {
  if (!poolAddress) return;
  const db = load();
  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: poolAddress.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }
  const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  db[poolAddress].rejection_cooldown_until = until;
  db[poolAddress].rejection_reason = reason;
  save(db);
  log("pool-memory", `Marked rejection for ${db[poolAddress].name} until ${until} (${reason})`);
}

/**
 * Check if pool has an active rejection cooldown (from screening, not deploy).
 */
export function isPoolOnRejectionCooldown(poolAddress) {
  if (!poolAddress) return false;
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return false;
  if (entry.rejection_cooldown_until && new Date(entry.rejection_cooldown_until) > new Date()) return true;
  return false;
}

export function isBaseMintOnCooldown(baseMint) {
  if (!baseMint) return false;
  const db = load();
  const now = new Date();
  return Object.values(db).some((entry) =>
    entry?.base_mint === baseMint &&
    entry?.base_mint_cooldown_until &&
    new Date(entry.base_mint_cooldown_until) > now
  );
}

// ─── Read ──────────────────────────────────────────────────────

/**
 * Compute statistical confidence label based on sample size.
 * Sample size matters: 100% win_rate with 1 sample ≠ 100% with 30 samples.
 */
function getConfidenceLabel(sampleSize) {
  if (sampleSize === 0) return "no_data";
  if (sampleSize === 1) return "low (1 sample — anecdotal)";
  if (sampleSize < 5) return `low (${sampleSize} samples — insufficient)`;
  if (sampleSize < 10) return `medium (${sampleSize} samples)`;
  if (sampleSize < 20) return `good (${sampleSize} samples)`;
  return `high (${sampleSize} samples)`;
}

/**
 * Aggregate token-level stats across ALL pools sharing same base_mint.
 * Critical: same token in different pools = different pool entries, but
 * pattern detection should be at token level (e.g., HANTA-SOL prank pattern).
 */
function getTokenLevelStats(db, baseMint) {
  if (!baseMint) return null;
  const allDeploys = [];
  let poolsCount = 0;
  for (const entry of Object.values(db)) {
    if (entry?.base_mint === baseMint && entry?.deploys?.length) {
      allDeploys.push(...entry.deploys);
      poolsCount++;
    }
  }
  if (allDeploys.length === 0) return null;
  const wins = allDeploys.filter((d) => (d.pnl_pct ?? 0) > 0).length;
  const losses = allDeploys.filter((d) => (d.pnl_pct ?? 0) < 0).length;
  const winRate = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
  const avgPnl = allDeploys.reduce((s, d) => s + (d.pnl_pct ?? 0), 0) / allDeploys.length;
  return {
    pools_count: poolsCount,
    total_deploys: allDeploys.length,
    wins,
    losses,
    win_rate: winRate,
    avg_pnl_pct: Math.round(avgPnl * 100) / 100,
    confidence: getConfidenceLabel(allDeploys.length),
  };
}

/**
 * Tool handler: get_pool_memory
 * Returns deploy history and summary for a pool.
 * Includes statistical confidence + token-level aggregation across pools.
 */
export function getPoolMemory({ pool_address }) {
  if (!pool_address) return { error: "pool_address required" };

  const db = load();
  const entry = db[pool_address];

  if (!entry) {
    return {
      pool_address,
      known: false,
      message: "No history for this pool — first time deploying here.",
    };
  }

  // Detect consecutive losses for LLM context
  const recentDeploys = entry.deploys.slice(-3);
  const consecutiveLosses = recentDeploys.length === 3 &&
    recentDeploys.every((d) => (d.pnl_pct ?? 0) < 0);

  // Token-level aggregation (across all pools with same base_mint)
  const tokenStats = getTokenLevelStats(db, entry.base_mint);

  return {
    pool_address,
    known: true,
    name: entry.name,
    base_mint: entry.base_mint,
    // Pool-level stats (this specific pool address)
    total_deploys: entry.total_deploys,
    avg_pnl_pct: entry.avg_pnl_pct,
    win_rate: entry.win_rate,
    adjusted_win_rate: entry.adjusted_win_rate ?? 0,
    adjusted_win_rate_sample_count: entry.adjusted_win_rate_sample_count ?? 0,
    pool_confidence: getConfidenceLabel(entry.total_deploys || 0),
    // Token-level stats (across ALL pools sharing this base_mint) — broader pattern view
    token_stats: tokenStats,
    last_deployed_at: entry.last_deployed_at,
    last_outcome: entry.last_outcome,
    consecutive_losses: consecutiveLosses ? 3 : null,
    cooldown_until: entry.cooldown_until || null,
    cooldown_reason: entry.cooldown_reason || null,
    base_mint_cooldown_until: entry.base_mint_cooldown_until || null,
    base_mint_cooldown_reason: entry.base_mint_cooldown_reason || null,
    notes: entry.notes,
    history: entry.deploys.slice(-10), // last 10 deploys
  };
}

/**
 * Record a live position snapshot during a management cycle.
 * Builds a trend dataset while position is still open — not just at close.
 * Keeps last 48 snapshots per pool (~4h at 5min intervals).
 */
export function recordPositionSnapshot(poolAddress, snapshot) {
  if (!poolAddress) return;
  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: snapshot.pair || poolAddress.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
      snapshots: [],
    };
  }

  if (!db[poolAddress].snapshots) db[poolAddress].snapshots = [];

  db[poolAddress].snapshots.push({
    ts: new Date().toISOString(),
    position: snapshot.position,
    pnl_pct: snapshot.pnl_pct ?? null,
    pnl_usd: snapshot.pnl_usd ?? null,
    in_range: snapshot.in_range ?? null,
    unclaimed_fees_usd: snapshot.unclaimed_fees_usd ?? null,
    minutes_out_of_range: snapshot.minutes_out_of_range ?? null,
    age_minutes: snapshot.age_minutes ?? null,
  });

  // Keep last 48 snapshots (~4h at 5min intervals)
  if (db[poolAddress].snapshots.length > 48) {
    db[poolAddress].snapshots = db[poolAddress].snapshots.slice(-48);
  }

  save(db);
}

/**
 * Recall focused context for a specific pool — used before screening or management.
 * Returns a short formatted string ready for injection into the agent goal.
 */
export function recallForPool(poolAddress) {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return null;

  const lines = [];

  // Deploy history summary
  if (entry.total_deploys > 0) {
    lines.push(`POOL MEMORY [${entry.name}]: ${entry.total_deploys} past deploy(s), avg PnL ${entry.avg_pnl_pct}%, win rate ${entry.win_rate}%, last outcome: ${entry.last_outcome}`);
  }

  if (entry.cooldown_until && new Date(entry.cooldown_until) > new Date()) {
    lines.push(`POOL COOLDOWN: active until ${entry.cooldown_until}${entry.cooldown_reason ? ` (${entry.cooldown_reason})` : ""}`);
  }

  if (entry.base_mint_cooldown_until && new Date(entry.base_mint_cooldown_until) > new Date()) {
    lines.push(`TOKEN COOLDOWN: active until ${entry.base_mint_cooldown_until}${entry.base_mint_cooldown_reason ? ` (${entry.base_mint_cooldown_reason})` : ""}`);
  }

  // Recent snapshot trend (last 6 = ~30min)
  const snaps = (entry.snapshots || []).slice(-6);
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const pnlTrend = last.pnl_pct != null && first.pnl_pct != null
      ? (last.pnl_pct - first.pnl_pct).toFixed(2)
      : null;
    const oorCount = snaps.filter(s => s.in_range === false).length;
    lines.push(`RECENT TREND: PnL drift ${pnlTrend !== null ? (pnlTrend >= 0 ? "+" : "") + pnlTrend + "%" : "unknown"} over last ${snaps.length} cycles, OOR in ${oorCount}/${snaps.length} cycles`);
  }

  // Notes
  if (entry.notes?.length > 0) {
    const lastNote = entry.notes[entry.notes.length - 1];
    const safeNote = sanitizeStoredNote(lastNote.note);
    if (safeNote) lines.push(`NOTE: ${safeNote}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Tool handler: add_pool_note
 * Agent can annotate a pool with a freeform note.
 */
export function addPoolNote({ pool_address, note }) {
  if (!pool_address) return { error: "pool_address required" };
  const safeNote = sanitizeStoredNote(note);
  if (!safeNote) return { error: "note required" };

  const db = load();

  if (!db[pool_address]) {
    db[pool_address] = {
      name: pool_address.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  db[pool_address].notes.push({
    note: safeNote,
    added_at: new Date().toISOString(),
  });

  save(db);
  log("pool-memory", `Note added to ${pool_address.slice(0, 8)}: ${safeNote}`);
  return { saved: true, pool_address, note: safeNote };
}
