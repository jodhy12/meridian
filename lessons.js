/**
 * Agent learning system.
 *
 * After each position closes, performance is analyzed and lessons are
 * derived. These lessons are injected into the system prompt so the
 * agent avoids repeating mistakes and doubles down on what works.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const LESSONS_FILE = path.join(__dirname, "lessons.json");
const MIN_EVOLVE_POSITIONS = 5;   // don't evolve until we have real data
const MAX_CHANGE_PER_STEP  = 0.20; // never shift a threshold more than 20% at once
const MAX_MANUAL_LESSON_LENGTH = 400;
const SCARCITY_WINDOW  = 6;  // look at last N screening outcomes
const SCARCITY_THRESHOLD = 2; // avg candidates below this = scarcity mode

function sanitizeLessonText(text, maxLen = MAX_MANUAL_LESSON_LENGTH) {
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
  if (!fs.existsSync(LESSONS_FILE)) {
    return { lessons: [], performance: [], screening_outcomes: [] };
  }
  try {
    const d = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
    if (!d.screening_outcomes) d.screening_outcomes = [];
    return d;
  } catch {
    return { lessons: [], performance: [], screening_outcomes: [] };
  }
}

function save(data) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}

// ─── Record Position Performance ──────────────────────────────

/**
 * Call this when a position closes. Captures performance data and
 * derives a lesson if the outcome was notably good or bad.
 *
 * @param {Object} perf
 * @param {string} perf.position       - Position address
 * @param {string} perf.pool           - Pool address
 * @param {string} perf.pool_name      - Pool name (e.g. "Mustard-SOL")
 * @param {string} perf.strategy       - "spot" | "curve" | "bid_ask"
 * @param {number} perf.bin_range      - Bin range used
 * @param {number} perf.bin_step       - Pool bin step
 * @param {number} perf.volatility     - Pool volatility at deploy time
 * @param {number} perf.fee_tvl_ratio  - fee/TVL ratio at deploy time
 * @param {number} perf.organic_score  - Token organic score at deploy time
 * @param {number} perf.amount_sol     - Amount deployed
 * @param {number} perf.fees_earned_usd - Total fees earned
 * @param {number} perf.final_value_usd - Value when closed
 * @param {number} perf.initial_value_usd - Value when opened
 * @param {number} perf.minutes_in_range  - Total minutes position was in range
 * @param {number} perf.minutes_held      - Total minutes position was held
 * @param {string} perf.close_reason   - Why it was closed
 */
export async function recordPerformance(perf) {
  const data = load();

  // Guard against unit-mixed records where a SOL-sized final value is
  // accidentally written into a USD field (e.g. final_value_usd = 2 for a 2 SOL close).
  const suspiciousUnitMix =
    Number.isFinite(perf.initial_value_usd) &&
    Number.isFinite(perf.final_value_usd) &&
    Number.isFinite(perf.amount_sol) &&
    perf.initial_value_usd >= 20 &&
    perf.amount_sol >= 0.25 &&
    perf.final_value_usd > 0 &&
    perf.final_value_usd <= perf.amount_sol * 2;

  if (suspiciousUnitMix) {
    log("lessons_warn", `Skipped suspicious performance record for ${perf.pool_name || perf.pool}: initial=${perf.initial_value_usd}, final=${perf.final_value_usd}, amount_sol=${perf.amount_sol}`);
    return;
  }

  const pnl_usd = (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
  const pnl_pct = perf.initial_value_usd > 0
    ? (pnl_usd / perf.initial_value_usd) * 100
    : 0;
  const range_efficiency = perf.minutes_held > 0
    ? (perf.minutes_in_range / perf.minutes_held) * 100
    : 0;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const suspiciousAbsurdClosedPnl =
    Number.isFinite(pnl_pct) &&
    perf.initial_value_usd >= 20 &&
    pnl_pct <= -90 &&
    !closeReasonText.includes("stop loss");

  if (suspiciousAbsurdClosedPnl) {
    log("lessons_warn", `Skipped absurd closed PnL record for ${perf.pool_name || perf.pool}: pnl_pct=${pnl_pct.toFixed(2)} reason=${perf.close_reason}`);
    return;
  }

  const entry = {
    ...perf,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  data.performance.push(entry);

  // Derive and store a lesson
  const lesson = derivLesson(entry);
  if (lesson) {
    data.lessons.push(lesson);
    log("lessons", `New lesson: ${lesson.rule}`);
  }

  save(data);

  // Update pool-level memory
  if (perf.pool) {
    const { recordPoolDeploy } = await import("./pool-memory.js");
    recordPoolDeploy(perf.pool, {
      pool_name: perf.pool_name,
      base_mint: perf.base_mint,
      deployed_at: perf.deployed_at,
      closed_at: entry.recorded_at,
      pnl_pct: entry.pnl_pct,
      pnl_usd: entry.pnl_usd,
      range_efficiency: entry.range_efficiency,
      minutes_held: perf.minutes_held,
      close_reason: perf.close_reason,
      strategy: perf.strategy,
      volatility: perf.volatility,
    });
  }

  // Evolve thresholds every 5 closed positions — gated by autoEvolveEnabled flag
  // Default: OFF (respect user-tuned config). Set autoEvolveEnabled: true to re-enable.
  if (data.performance.length % MIN_EVOLVE_POSITIONS === 0) {
    const { config, reloadScreeningThresholds } = await import("./config.js");
    if (config.management?.autoEvolveEnabled) {
      const result = evolveThresholds(data.performance, config);
      if (result?.changes && Object.keys(result.changes).length > 0) {
        reloadScreeningThresholds();
        log("evolve", `Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
      }
    }

    // Darwinian signal weight recalculation
    if (config.darwin?.enabled) {
      const { recalculateWeights } = await import("./signal-weights.js");
      const wResult = recalculateWeights(data.performance, config);
      if (wResult.changes.length > 0) {
        log("evolve", `Darwin: adjusted ${wResult.changes.length} signal weight(s)`);
      }
    }
  }

}

/**
 * Backfill signal_snapshot for old performance records that have
 * numeric fields (volatility, organic_score, etc.) but no snapshot.
 * This allows Darwinian learning to use historical data immediately.
 *
 * Returns count of records updated.
 */
export function backfillSignalSnapshots() {
  const data = load();
  let updated = 0;

  for (const perf of data.performance) {
    if (perf.signal_snapshot) continue; // already has snapshot

    // Build snapshot from existing performance fields
    const snap = {};
    if (perf.organic_score != null) snap.organic_score = perf.organic_score;
    if (perf.fee_tvl_ratio != null) snap.fee_tvl_ratio = perf.fee_tvl_ratio;
    if (perf.volatility != null)    snap.volatility = perf.volatility;
    if (perf.bin_step != null)      snap.bin_step = perf.bin_step;
    if (perf.bin_range?.bins_below != null) snap.bins_below = perf.bin_range.bins_below;

    // Only save if we have at least 2 meaningful signals
    if (Object.keys(snap).length >= 2) {
      perf.signal_snapshot = snap;
      updated++;
    }
  }

  if (updated > 0) {
    save(data);
    log("lessons", `Backfilled signal_snapshot for ${updated} performance records`);
  }

  return updated;
}

/**
 * Derive a lesson from a closed position's performance.
 * Only generates a lesson if the outcome was clearly good or bad.
 */
function derivLesson(perf) {
  const tags = [];

  // Categorize outcome
  const outcome = perf.pnl_pct >= 5 ? "good"
    : perf.pnl_pct >= 0 ? "neutral"
    : perf.pnl_pct >= -5 ? "poor"
    : "bad";

  if (outcome === "neutral") return null; // nothing interesting to learn

  // Build context description
  const context = [
    `${perf.pool_name}`,
    `strategy=${perf.strategy}`,
    `bin_step=${perf.bin_step}`,
    `volatility=${perf.volatility}`,
    `fee_tvl_ratio=${perf.fee_tvl_ratio}`,
    `organic=${perf.organic_score}`,
    `bin_range=${typeof perf.bin_range === 'object' ? JSON.stringify(perf.bin_range) : perf.bin_range}`,
  ].join(", ");

  let rule = "";

  if (outcome === "good" || outcome === "bad") {
    if (perf.range_efficiency < 30 && outcome === "bad") {
      rule = `AVOID: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — went OOR ${100 - perf.range_efficiency}% of the time. Consider wider bin_range or bid_ask strategy.`;
      tags.push("oor", perf.strategy, `volatility_${Math.round(perf.volatility)}`);
    } else if (perf.range_efficiency > 80 && outcome === "good") {
      rule = `PREFER: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — ${perf.range_efficiency}% in-range efficiency, PnL +${perf.pnl_pct}%.`;
      tags.push("efficient", perf.strategy);
    } else if (outcome === "bad" && perf.close_reason?.includes("volume")) {
      rule = `AVOID: Pools with fee_tvl_ratio=${perf.fee_tvl_ratio} that showed volume collapse — fees evaporated quickly. Minimum sustained volume check needed before deploying.`;
      tags.push("volume_collapse");
    } else if (outcome === "good") {
      rule = `WORKED: ${context} → PnL +${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%.`;
      tags.push("worked");
    } else {
      rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
      tags.push("failed");
    }
  }

  if (!rule) return null;

  return {
    id: Date.now(),
    rule,
    tags,
    outcome,
    context,
    pnl_pct: perf.pnl_pct,
    range_efficiency: perf.range_efficiency,
    pool: perf.pool,
    created_at: new Date().toISOString(),
  };
}

// ─── Screening Outcome Tracking ────────────────────────────────

/**
 * Record how many candidates were found in a screening cycle.
 * Used by scarcity detection to auto-relax thresholds.
 */
export async function recordScreeningOutcome(candidateCount) {
  const data = load();
  data.screening_outcomes.push({
    t: new Date().toISOString(),
    n: candidateCount,
  });
  // Keep only last 20 outcomes
  if (data.screening_outcomes.length > 20) {
    data.screening_outcomes = data.screening_outcomes.slice(-20);
  }
  save(data);

  // Scarcity-triggered evolution — disabled by default to respect user-tuned config.
  // Auto-relaxing maxVolatility/minFee from scarcity overrides data-backed manual tuning.
  // Re-enable via `autoEvolveEnabled: true` in user-config if user wants adaptive behavior.
  const { config, reloadScreeningThresholds } = await import("./config.js");
  if (!config.management?.autoEvolveEnabled) {
    return;
  }

  const recent = data.screening_outcomes.slice(-SCARCITY_WINDOW);
  if (
    recent.length >= SCARCITY_WINDOW &&
    avg(recent.map((o) => o.n)) < SCARCITY_THRESHOLD &&
    data.performance.length >= MIN_EVOLVE_POSITIONS
  ) {
    const result = evolveThresholds(data.performance, config);
    if (result?.changes && Object.keys(result.changes).length > 0) {
      reloadScreeningThresholds();
      log("evolve", `Scarcity-triggered evolution: ${JSON.stringify(result.changes)}`);
    }
  }
}

// ─── Adaptive Threshold Evolution ──────────────────────────────

/**
 * Analyze closed position performance and evolve screening thresholds.
 * Writes changes to user-config.json and returns a summary.
 *
 * @param {Array}  perfData - Array of performance records (from lessons.json)
 * @param {Object} config   - Live config object (mutated in place)
 * @returns {{ changes: Object, rationale: Object } | null}
 */
export function evolveThresholds(perfData, config) {
  if (!perfData || perfData.length < MIN_EVOLVE_POSITIONS) return null;

  const winners = perfData.filter((p) => p.pnl_pct > 0);
  const losers  = perfData.filter((p) => p.pnl_pct < -5);

  // Need at least some signal in both directions before adjusting
  const hasSignal = winners.length >= 2 || losers.length >= 2;
  if (!hasSignal) return null;

  // Detect candidate scarcity from screening outcomes
  const data = load();
  const recentOutcomes = data.screening_outcomes.slice(-SCARCITY_WINDOW);
  const scarcityMode = recentOutcomes.length >= SCARCITY_WINDOW
    && avg(recentOutcomes.map((o) => o.n)) < SCARCITY_THRESHOLD;

  if (scarcityMode) {
    log("evolve", `Scarcity mode: avg ${avg(recentOutcomes.map(o => o.n)).toFixed(1)} candidates over last ${recentOutcomes.length} screens — relaxing filters`);
  }

  const changes   = {};
  const rationale = {};

  // ── 2. minFeeActiveTvlRatio ───────────────────────────────────
  // Raise floor if low-fee pools underperform; lower if over-filtering (scarcity).
  {
    const winnerFees = winners.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const loserFees  = losers.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const current    = config.screening.minFeeActiveTvlRatio;

    if (winnerFees.length >= 2) {
      const minWinnerFee = Math.min(...winnerFees);
      const avgWinnerFee = avg(winnerFees);
      if (minWinnerFee > current * 1.2) {
        // Raise: winners are all well above current floor
        const target  = minWinnerFee * 0.85;
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
        const rounded = Number(newVal.toFixed(2));
        if (rounded > current) {
          changes.minFeeActiveTvlRatio = rounded;
          rationale.minFeeActiveTvlRatio = `Min winner fee_tvl=${minWinnerFee.toFixed(2)} — raised floor ${current} → ${rounded}`;
        }
      } else if (scarcityMode && avgWinnerFee < current * 1.1) {
        // Lower: scarcity + winners barely above current floor → we're over-filtering
        const target  = avgWinnerFee * 0.75;
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
        const rounded = Number(newVal.toFixed(2));
        if (rounded < current) {
          changes.minFeeActiveTvlRatio = rounded;
          rationale.minFeeActiveTvlRatio = `Scarcity + avg winner fee_tvl=${avgWinnerFee.toFixed(2)} near floor — lowered ${current} → ${rounded}`;
        }
      }
    }

    if (loserFees.length >= 2 && !changes.minFeeActiveTvlRatio) {
      const maxLoserFee = Math.max(...loserFees);
      if (maxLoserFee < current * 1.5 && winnerFees.length > 0) {
        const minWinnerFee = Math.min(...winnerFees);
        if (minWinnerFee > maxLoserFee) {
          const target  = maxLoserFee * 1.2;
          const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
          const rounded = Number(newVal.toFixed(2));
          if (rounded > current) {
            changes.minFeeActiveTvlRatio = rounded;
            rationale.minFeeActiveTvlRatio = `Losers fee_tvl<=${maxLoserFee.toFixed(2)}, winners higher — raised ${current} → ${rounded}`;
          }
        }
      }
    }
  }

  // ── 2b. minVolume ─────────────────────────────────────────────
  // Raise if losers had lower volume; lower in scarcity mode if winners are near floor.
  {
    const winnerVols = winners.map((p) => p.signal_snapshot?.volume ?? p.volume_window).filter(isFiniteNum);
    const loserVols  = losers.map((p) => p.signal_snapshot?.volume ?? p.volume_window).filter(isFiniteNum);
    const current    = config.screening.minVolume;

    if (winnerVols.length >= 2 && loserVols.length >= 2) {
      const avgWinnerVol = avg(winnerVols);
      const avgLoserVol  = avg(loserVols);
      if (avgWinnerVol > avgLoserVol * 1.5) {
        // Winners have significantly more volume → raise floor
        const minWinnerVol = Math.min(...winnerVols);
        const target = minWinnerVol * 0.8;
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 1000, 200_000);
        if (newVal > current) {
          changes.minVolume = newVal;
          rationale.minVolume = `Winner avg vol ${avgWinnerVol.toFixed(0)} vs loser ${avgLoserVol.toFixed(0)} — raised ${current} → ${newVal}`;
        }
      }
    }

    if (scarcityMode && winnerVols.length >= 2 && !changes.minVolume) {
      const avgWinnerVol = avg(winnerVols);
      if (avgWinnerVol < current * 1.3) {
        // Scarcity + winners barely above floor → lower it
        const target = avgWinnerVol * 0.7;
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 1000, 200_000);
        if (newVal < current) {
          changes.minVolume = newVal;
          rationale.minVolume = `Scarcity + avg winner vol=${avgWinnerVol.toFixed(0)} near floor — lowered ${current} → ${newVal}`;
        }
      }
    }
  }

  // ── 3. minOrganic ─────────────────────────────────────────────
  // Raise organic floor if low-organic tokens consistently failed.
  {
    const loserOrganics  = losers.map((p) => p.organic_score).filter(isFiniteNum);
    const winnerOrganics = winners.map((p) => p.organic_score).filter(isFiniteNum);
    const current        = config.screening.minOrganic;

    if (loserOrganics.length >= 2 && winnerOrganics.length >= 1) {
      const avgLoserOrganic  = avg(loserOrganics);
      const avgWinnerOrganic = avg(winnerOrganics);
      // Only raise if there's a clear gap (winners consistently more organic)
      if (avgWinnerOrganic - avgLoserOrganic >= 10) {
        // Set floor just below worst winner
        const minWinnerOrganic = Math.min(...winnerOrganics);
        const target = Math.max(minWinnerOrganic - 3, current);
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 60, 90);
        if (newVal > current) {
          changes.minOrganic = newVal;
          rationale.minOrganic = `Winner avg organic ${avgWinnerOrganic.toFixed(0)} vs loser avg ${avgLoserOrganic.toFixed(0)} — raised from ${current} → ${newVal}`;
        }
      }
    }
  }

  // ── 4. maxVolatility ──────────────────────────────────────────
  // Lower ceiling if high-vol pools consistently lose; raise if winners need more range.
  {
    const loserVols  = losers.map((p) => p.volatility).filter(isFiniteNum);
    const winnerVols = winners.map((p) => p.volatility).filter(isFiniteNum);
    const current    = config.screening.maxVolatility;

    if (loserVols.length >= 2 && winnerVols.length >= 1 && current != null) {
      const avgLoserVol  = avg(loserVols);
      const avgWinnerVol = avg(winnerVols);
      if (avgLoserVol - avgWinnerVol >= 1.0) {
        // Tighten: losers are clearly more volatile
        const maxWinnerVol = Math.max(...winnerVols);
        const target = Math.max(maxWinnerVol + 0.5, 3);
        const newVal = Number(clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 3, 10).toFixed(1));
        if (newVal < current) {
          changes.maxVolatility = newVal;
          rationale.maxVolatility = `Loser avg vol ${avgLoserVol.toFixed(1)} vs winner ${avgWinnerVol.toFixed(1)} — lowered ${current} → ${newVal}`;
        }
      } else if (scarcityMode) {
        // Relax: scarcity mode, winners and losers have similar vol → ceiling too tight
        const maxWinnerVol = Math.max(...winnerVols);
        if (maxWinnerVol > current * 0.85) {
          const target = maxWinnerVol * 1.2;
          const newVal = Number(clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 3, 10).toFixed(1));
          if (newVal > current) {
            changes.maxVolatility = newVal;
            rationale.maxVolatility = `Scarcity + max winner vol=${maxWinnerVol.toFixed(1)} near ceiling — raised ${current} → ${newVal}`;
          }
        }
      }
    }
  }

  // ── 4b. minVolatility ─────────────────────────────────────────
  // Lower floor if winners have lower volatility than the current minimum.
  {
    const winnerVols = winners.map((p) => p.volatility).filter(isFiniteNum);
    const current    = config.screening.minVolatility ?? null;

    if (current != null && winnerVols.length >= 2) {
      const minWinnerVol = Math.min(...winnerVols);
      if (minWinnerVol < current) {
        // Winners exist below current floor → floor is cutting valid pools
        const target = Math.max(minWinnerVol * 0.9, 0.5);
        const newVal = Number(clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.5, 3).toFixed(1));
        if (newVal < current) {
          changes.minVolatility = newVal;
          rationale.minVolatility = `Min winner vol=${minWinnerVol.toFixed(1)} below floor — lowered ${current} → ${newVal}`;
        }
      } else if (scarcityMode) {
        const avgWinnerVol = avg(winnerVols);
        if (avgWinnerVol < current * 1.5) {
          const target = Math.max(avgWinnerVol * 0.6, 0.5);
          const newVal = Number(clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.5, 3).toFixed(1));
          if (newVal < current) {
            changes.minVolatility = newVal;
            rationale.minVolatility = `Scarcity + avg winner vol=${avgWinnerVol.toFixed(1)} near floor — lowered ${current} → ${newVal}`;
          }
        }
      }
    }
  }

  // ── 5. minHolders ────────────────────────────────────────────
  // Raise holder floor if low-holder tokens fail more often.
  {
    const loserHolders  = losers.map((p) => p.signal_snapshot?.holder_count).filter(isFiniteNum);
    const winnerHolders = winners.map((p) => p.signal_snapshot?.holder_count).filter(isFiniteNum);
    const current       = config.screening.minHolders;

    if (loserHolders.length >= 2 && winnerHolders.length >= 1) {
      const avgLoserH  = avg(loserHolders);
      const avgWinnerH = avg(winnerHolders);
      if (avgWinnerH - avgLoserH >= 200) {
        const minWinnerH = Math.min(...winnerHolders);
        const target = Math.max(minWinnerH - 100, current);
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 200, 5000);
        if (newVal > current) {
          changes.minHolders = newVal;
          rationale.minHolders = `Winner avg holders ${avgWinnerH.toFixed(0)} vs loser ${avgLoserH.toFixed(0)} — raised from ${current} → ${newVal}`;
        }
      }
    }
  }

  // ── 6. minMcap ───────────────────────────────────────────────
  // Raise mcap floor if low-mcap tokens consistently fail.
  {
    const loserMcaps  = losers.map((p) => p.signal_snapshot?.mcap).filter(isFiniteNum);
    const winnerMcaps = winners.map((p) => p.signal_snapshot?.mcap).filter(isFiniteNum);
    const current     = config.screening.minMcap;

    if (loserMcaps.length >= 2 && winnerMcaps.length >= 1) {
      const avgLoserMcap  = avg(loserMcaps);
      const avgWinnerMcap = avg(winnerMcaps);
      if (avgWinnerMcap > avgLoserMcap * 1.5) {
        const minWinnerMcap = Math.min(...winnerMcaps);
        const target = Math.max(minWinnerMcap * 0.8, current);
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 50_000, 5_000_000);
        if (newVal > current) {
          changes.minMcap = newVal;
          rationale.minMcap = `Winner avg mcap ${avgWinnerMcap.toFixed(0)} vs loser ${avgLoserMcap.toFixed(0)} — raised from ${current} → ${newVal}`;
        }
      }
    }
  }

  // ── 7. bins_below optimization — DISABLED ────────────────────
  // Self-reinforcing loop: all historical data used bins_below=20, so evolve
  // always resets to 20 regardless of manual config. Disabled to allow manual
  // tuning. Optimal range from external data: 30-60 bins.

  if (Object.keys(changes).length === 0) return { changes: {}, rationale: {} };

  // ── Persist changes to user-config.json ───────────────────────
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }

  Object.assign(userConfig, changes);
  userConfig._lastEvolved = new Date().toISOString();
  userConfig._positionsAtEvolution = perfData.length;

  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

  // Apply to live config object immediately
  const s = config.screening;
  if (changes.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = changes.minFeeActiveTvlRatio;
  if (changes.minVolume            != null) s.minVolume            = changes.minVolume;
  if (changes.minOrganic           != null) s.minOrganic           = changes.minOrganic;
  if (changes.maxVolatility        != null) s.maxVolatility        = changes.maxVolatility;
  if (changes.minVolatility        != null) s.minVolatility        = changes.minVolatility;
  if (changes.minHolders           != null) s.minHolders           = changes.minHolders;
  if (changes.minMcap              != null) s.minMcap              = changes.minMcap;
  // binsBelow evolution disabled — see section 7 comment above

  // Log a lesson summarizing the evolution
  const lessonsData = load();
  lessonsData.lessons.push({
    id: Date.now(),
    rule: `[AUTO-EVOLVED @ ${perfData.length} positions] ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")} — ${Object.values(rationale).join("; ")}`,
    tags: ["evolution", "config_change"],
    outcome: "manual",
    created_at: new Date().toISOString(),
  });
  save(lessonsData);

  return { changes, rationale };
}

// ─── Helpers ───────────────────────────────────────────────────

function isFiniteNum(n) {
  return typeof n === "number" && isFinite(n);
}

function avg(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}


function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/** Move current toward target by at most maxChange fraction. */
function nudge(current, target, maxChange) {
  const delta = target - current;
  const maxDelta = current * maxChange;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

// ─── Manual Lessons ────────────────────────────────────────────

/**
 * Add a manual lesson (e.g. from operator observation).
 *
 * @param {string}   rule
 * @param {string[]} tags
 * @param {Object}   opts
 * @param {boolean}  opts.pinned - Always inject regardless of cap
 * @param {string}   opts.role   - "SCREENER" | "MANAGER" | "GENERAL" | null (all roles)
 */
export function addLesson(rule, tags = [], { pinned = false, role = null } = {}) {
  const safeRule = sanitizeLessonText(rule);
  if (!safeRule) return;
  const data = load();
  data.lessons.push({
    id: Date.now(),
    rule: safeRule,
    tags,
    outcome: "manual",
    pinned: !!pinned,
    role: role || null,
    created_at: new Date().toISOString(),
  });
  save(data);
  log("lessons", `Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${safeRule}`);
}

/**
 * Pin a lesson by ID — pinned lessons are always injected regardless of cap.
 */
export function pinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = true;
  save(data);
  log("lessons", `Pinned lesson ${id}: ${lesson.rule.slice(0, 60)}`);
  return { found: true, pinned: true, id, rule: lesson.rule };
}

/**
 * Unpin a lesson by ID.
 */
export function unpinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = false;
  save(data);
  return { found: true, pinned: false, id, rule: lesson.rule };
}

/**
 * List lessons with optional filters — for agent browsing via Telegram.
 */
export function listLessons({ role = null, pinned = null, tag = null, limit = 30 } = {}) {
  const data = load();
  let lessons = [...data.lessons];

  if (pinned !== null) lessons = lessons.filter((l) => !!l.pinned === pinned);
  if (role)            lessons = lessons.filter((l) => !l.role || l.role === role);
  if (tag)             lessons = lessons.filter((l) => l.tags?.includes(tag));

  return {
    total: lessons.length,
    lessons: lessons.slice(-limit).map((l) => ({
      id: l.id,
      rule: l.rule.slice(0, 120),
      tags: l.tags,
      outcome: l.outcome,
      pinned: !!l.pinned,
      role: l.role || "all",
      created_at: l.created_at?.slice(0, 10),
    })),
  };
}

/**
 * Remove a lesson by ID.
 */
export function removeLesson(id) {
  const data = load();
  const before = data.lessons.length;
  data.lessons = data.lessons.filter((l) => l.id !== id);
  save(data);
  return before - data.lessons.length;
}

/**
 * Remove lessons matching a keyword in their rule text (case-insensitive).
 */
export function removeLessonsByKeyword(keyword) {
  const data = load();
  const before = data.lessons.length;
  const kw = keyword.toLowerCase();
  data.lessons = data.lessons.filter((l) => !l.rule.toLowerCase().includes(kw));
  save(data);
  return before - data.lessons.length;
}

/**
 * Clear ALL lessons (keeps performance data).
 */
export function clearAllLessons() {
  const data = load();
  const count = data.lessons.length;
  data.lessons = [];
  save(data);
  return count;
}

/**
 * Clear ALL performance records.
 */
export function clearPerformance() {
  const data = load();
  const count = data.performance.length;
  data.performance = [];
  save(data);
  return count;
}

// ─── Lesson Retrieval ──────────────────────────────────────────

// Tags that map to each agent role — used for role-aware lesson injection
const ROLE_TAGS = {
  SCREENER: ["screening", "narrative", "strategy", "deployment", "token", "volume", "entry", "bundler", "holders", "organic"],
  MANAGER:  ["management", "risk", "oor", "fees", "position", "hold", "close", "pnl", "rebalance", "claim"],
  GENERAL:  [], // all lessons
};

/**
 * Get lessons formatted for injection into the system prompt.
 * Structured injection with three tiers:
 *   1. Pinned        — always injected, up to PINNED_CAP
 *   2. Role-matched  — lessons tagged for this agentType, up to ROLE_CAP
 *   3. Recent        — fill remaining slots up to RECENT_CAP
 *
 * @param {Object} opts
 * @param {string} [opts.agentType]  - "SCREENER" | "MANAGER" | "GENERAL"
 * @param {number} [opts.maxLessons] - Override total cap (default 35)
 */
export function getLessonsForPrompt(opts = {}) {
  // Support legacy call signature: getLessonsForPrompt(20)
  if (typeof opts === "number") opts = { maxLessons: opts };

  const { agentType = "GENERAL", maxLessons } = opts;

  const data = load();
  if (data.lessons.length === 0) return null;

  // Smaller caps for automated cycles — they don't need the full lesson history
  const isAutoCycle = agentType === "SCREENER" || agentType === "MANAGER";
  const PINNED_CAP  = isAutoCycle ? 5  : 10;
  const ROLE_CAP    = isAutoCycle ? 6  : 15;
  const RECENT_CAP  = maxLessons ?? (isAutoCycle ? 10 : 35);

  const outcomePriority = { bad: 0, poor: 1, failed: 1, good: 2, worked: 2, manual: 1, neutral: 3, evolution: 2 };
  const byPriority = (a, b) => (outcomePriority[a.outcome] ?? 3) - (outcomePriority[b.outcome] ?? 3);

  // Exclude lessons that pollute LLM context:
  // - self_tune: past config changes already persisted in user-config.json (re-applying = stale)
  // - outdated: explicitly marked outdated by maintainer/LLM (no longer applicable to current strategy)
  const eligibleLessons = data.lessons.filter((l) => !l.tags?.includes("self_tune") && !l.outdated);

  // ── Tier 1: Pinned ──────────────────────────────────────────────
  // Respect role even for pinned lessons — a pinned SCREENER lesson shouldn't pollute MANAGER
  const pinned = eligibleLessons
    .filter((l) => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL"))
    .sort(byPriority)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map((l) => l.id));

  // ── Tier 2: Role-matched ────────────────────────────────────────
  const roleTags = ROLE_TAGS[agentType] || [];
  const roleMatched = eligibleLessons
    .filter((l) => {
      if (usedIds.has(l.id)) return false;
      // Include if: lesson has no role restriction OR matches this role
      const roleOk = !l.role || l.role === agentType || agentType === "GENERAL";
      // Include if: lesson has role-relevant tags OR no tags (general)
      const tagOk  = roleTags.length === 0 || !l.tags?.length || l.tags.some((t) => roleTags.includes(t));
      return roleOk && tagOk;
    })
    .sort(byPriority)
    .slice(0, ROLE_CAP);

  roleMatched.forEach((l) => usedIds.add(l.id));

  // ── Tier 3: Recent fill ─────────────────────────────────────────
  const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
  const recent = remainingBudget > 0
    ? eligibleLessons
        .filter((l) => !usedIds.has(l.id))
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
        .slice(0, remainingBudget)
    : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  if (selected.length === 0) return null;

  const sections = [];
  if (pinned.length)      sections.push(`── PINNED (${pinned.length}) ──\n` + fmt(pinned));
  if (roleMatched.length) sections.push(`── ${agentType} (${roleMatched.length}) ──\n` + fmt(roleMatched));
  if (recent.length)      sections.push(`── RECENT (${recent.length}) ──\n` + fmt(recent));

  return sections.join("\n\n");
}

function fmt(lessons) {
  return lessons.map((l) => {
    const date = l.created_at ? l.created_at.slice(0, 16).replace("T", " ") : "unknown";
    const pin  = l.pinned ? "📌 " : "";
    return `${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
  }).join("\n");
}

/**
 * Get individual performance records filtered by time window.
 * Tool handler: get_performance_history
 *
 * @param {Object} opts
 * @param {number} [opts.hours=24]   - How many hours back to look
 * @param {number} [opts.limit=50]   - Max records to return
 */
export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return { positions: [], count: 0, hours };

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const filtered = p
    .filter((r) => r.recorded_at >= cutoff)
    .slice(-limit)
    .map((r) => ({
      pool_name: r.pool_name,
      pool: r.pool,
      strategy: r.strategy,
      pnl_usd: r.pnl_usd,
      pnl_pct: r.pnl_pct,
      fees_earned_usd: r.fees_earned_usd,
      range_efficiency: r.range_efficiency,
      minutes_held: r.minutes_held,
      close_reason: r.close_reason,
      closed_at: r.recorded_at,
    }));

  // Use pnl_pct for WR (pnl_usd rounds to 0 on small positions, misclassifies winners)
  // Sum pnl by SOL-era detection (initial_value < 5 = SOL deposit, >= 5 = USD-era legacy)
  const solEra = filtered.filter((r) => (r.fees_earned_usd ?? 0) < 5 && (r.pnl_pct ?? 0) > -100);
  const totalPnl = solEra.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = filtered.filter((r) => (r.pnl_pct ?? 0) > 0).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    positions: filtered,
  };
}

/**
 * Compute rolling average PnL% over last N days. Used for pause-and-learn mode.
 * Returns { avgPnlPct, totalPnlSol, sampleSize } — null if no data.
 */
export function getRollingPnl({ windowDays = 5, minSamples = 5 } = {}) {
  const data = load();
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();
  const recent = (data.performance || []).filter((r) => (r.recorded_at || "") >= cutoff);
  if (recent.length < minSamples) return null;
  const avgPnlPct = recent.reduce((s, r) => s + (r.pnl_pct ?? 0), 0) / recent.length;
  const totalPnlSol = recent.reduce(
    (s, r) => s + ((r.pnl_pct ?? 0) / 100) * (r.initial_value_usd ?? 0),
    0
  );
  return { avgPnlPct, totalPnlSol, sampleSize: recent.length };
}

/**
 * Get count of recent losing closes within window. Used for consecutive-loss cooldown (P5).
 * A "loss" = pnl_pct <= lossThresholdPct (default -0.5%, ignores noise).
 */
export function getRecentLossCount({ windowMs = 3600000, lossThresholdPct = -0.5 } = {}) {
  const data = load();
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const recent = (data.performance || []).filter((r) => (r.recorded_at || "") >= cutoff);
  const losses = recent.filter((r) => (r.pnl_pct ?? 0) <= lossThresholdPct);
  return { total: recent.length, losses: losses.length, lastLossAt: losses[losses.length - 1]?.recorded_at ?? null };
}

/**
 * Get performance stats summary.
 */
export function getPerformanceSummary() {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return null;

  // Filter SOL-era only for total_pnl aggregation (mixed USD/SOL data otherwise meaningless).
  // SOL-era detection: initial_value < 5 (real SOL deposits, not USD-era $20+ entries).
  // Use pnl_pct × initial_value (pnl_usd rounds to 0 on small positions, totals understate true PnL)
  const solEra = p.filter((x) => (x.initial_value_usd ?? 0) < 5);
  const totalPnl = solEra.reduce((s, x) => s + ((x.pnl_pct ?? 0) / 100) * (x.initial_value_usd ?? 0), 0);
  const avgPnlPct = p.reduce((s, x) => s + (x.pnl_pct ?? 0), 0) / p.length;
  const avgRangeEfficiency = p.reduce((s, x) => s + (x.range_efficiency ?? 0), 0) / p.length;
  // WR uses pnl_pct (pnl_usd rounds to 0 on small positions, misclassifies winners — same bug as signal-weights)
  const wins = p.filter((x) => (x.pnl_pct ?? 0) > 0).length;

  return {
    total_positions_closed: p.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 100) / 100,
    avg_range_efficiency_pct: Math.round(avgRangeEfficiency * 10) / 10,
    win_rate_pct: Math.round((wins / p.length) * 100),
    total_lessons: data.lessons.length,
  };
}
