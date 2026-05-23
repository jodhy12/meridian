import "./env-boot.js"; // MUST be first — loads .env before any module reads process.env
import cron from "node-cron";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, closePosition } from "./tools/dlmm.js";
import { getTechnicalSignals } from "./tools/ohlcv.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates, getPoolDetail } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary, backfillSignalSnapshots, recordScreeningOutcome } from "./lessons.js";
import { registerCronRestarter, executeTool } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, sendHTML, notifyOutOfRange, notifyClose, isEnabled as telegramEnabled, createLiveMessage } from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, getTrackedPositions, setPositionInstruction, setLastTpCheckPct, updatePnlAndCheckExits, queuePeakConfirmation, resolvePendingPeak, queueTrailingDropConfirmation, resolvePendingTrailingDrop, reconcileFromLessons } from "./state.js";
import { recordPositionSnapshot, recallForPool, addPoolNote } from "./pool-memory.js";
import { getTokenInfo } from "./tools/token.js";
import { cachePoolSignals } from "./screening-cache.js";
import { getLperQualitySignal } from "./tools/study.js";
import { processPendingILRecoveries } from "./il-recovery-tracker.js";

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);

// Backfill state.json from lessons.json for any positions that were closed
// but not tracked (e.g. state.json was overwritten or positions predated tracking)
const reconcileResult = reconcileFromLessons();
if (reconcileResult.added > 0) {
  log("startup", `Reconciled ${reconcileResult.added} positions from lessons.json into state.json`);
}

// Backfill signal_snapshot for old performance records so Darwinian learning
// can use historical data immediately (volatility, organic_score, etc.)
const backfilled = backfillSignalSnapshots();
if (backfilled > 0) {
  log("startup", `Backfilled signal_snapshot for ${backfilled} historical positions`);
}

const TP_PCT = config.management.takeProfitFeePct;
const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
let _pollTriggeredAt = 0; // epoch ms — cooldown for poller-triggered management
const _peakConfirmTimers = new Map();
const _trailingDropConfirmTimers = new Map();
const TRAILING_PEAK_CONFIRM_DELAY_MS = 15_000;
const TRAILING_PEAK_CONFIRM_TOLERANCE = 0.85;
const TRAILING_DROP_CONFIRM_DELAY_MS = 8_000;  // lowered 15s→8s: less slippage while still filtering noise wicks
const TRAILING_DROP_CONFIRM_TOLERANCE_PCT = 1.0;

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Escape HTML special chars for Telegram */
function escHTML(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Format management report for Telegram (compact HTML) */
function formatMgmtTelegram(positionData, actionMap, mgmtReport, solMode) {
  const cur = solMode ? "◎" : "$";
  const D = "━━━━━━━━━━━━━━━━━━━━";

  const lines = positionData.map((p) => {
    const act = actionMap.get(p.position) || { action: "STAY" };
    const pnl = p.pnl_pct ?? 0;
    const pnlUsd = p.pnl_usd ?? 0;
    const rangeEmoji = p.in_range ? "🟢" : "🔴";
    const pnlEmoji = pnl >= 3 ? "🚀" : pnl >= 0 ? "📈" : pnl > -3 ? "📉" : "🔻";
    const pnlSign = pnl >= 0 ? "+" : "";

    const actionLine = act.action === "CLOSE"
      ? `❌ CLOSE — <i>${escHTML(act.reason?.substring(0, 80) ?? "")}</i>`
      : act.action === "CLAIM"
      ? `💰 CLAIM fees`
      : `✅ HOLD`;

    const val    = (p.total_value_usd ?? 0).toFixed(4);
    const fee    = (p.unclaimed_fees_usd ?? 0).toFixed(4);
    const age    = p.age_minutes ?? 0;
    const ageStr = age >= 60 ? `${Math.floor(age/60)}h${age%60 > 0 ? age%60+"m" : ""}` : `${age}m`;
    const pnlUsdStr = Math.abs(pnlUsd) >= 0.0001 ? ` (${pnlSign}${cur}${Math.abs(pnlUsd).toFixed(4)})` : "";

    // Yield rate
    const yield24h = p.fee_per_tvl_24h ?? null;
    const yieldStr = yield24h != null ? `yield ${yield24h.toFixed(2)}%` : null;

    // OOR info
    const oorMin = p.minutes_out_of_range ?? 0;
    const waitMin = config.management.outOfRangeWaitMinutes;
    const oorStr = !p.in_range && oorMin > 0 ? `⏱ OOR ${oorMin}m/${waitMin}m` : null;

    // Strategy + bin step + peak + volatility from tracked state
    const tracked = getTrackedPosition(p.position);
    const strat = tracked?.strategy ?? null;
    const binStep = tracked?.bin_step ?? null;
    const peakPnl = tracked?.peak_pnl_pct ?? null;
    const volatility = tracked?.volatility ?? null;
    const peakStr = peakPnl != null && peakPnl > 0 ? `peak ${peakPnl.toFixed(2)}%` : null;
    const volStr = volatility != null ? `vol ${volatility.toFixed(1)}` : null;
    const stratStr = [strat, binStep ? `${binStep}bs` : null].filter(Boolean).join(" · ");

    // Bin position visualization
    // For in-range: progress bar showing where active bin sits between lower and upper
    // For OOR: indicate direction and distance from range
    const activeBin = p.active_bin;
    const lowerBin = p.lower_bin;
    const upperBin = p.upper_bin;
    let binLine = null;
    if (activeBin != null && lowerBin != null && upperBin != null && upperBin > lowerBin) {
      const rangeWidth = upperBin - lowerBin;
      if (p.in_range) {
        const pctFromLower = ((activeBin - lowerBin) / rangeWidth) * 100;
        const clamped = Math.max(0, Math.min(100, pctFromLower));
        const barWidth = 16;
        const fillIdx = Math.round((clamped / 100) * (barWidth - 1));
        const bar = Array.from({ length: barWidth }, (_, i) => i === fillIdx ? "●" : "─").join("");
        const pctRounded = Math.round(clamped);
        const zoneIcon = pctRounded >= 85 ? "⚠️" : pctRounded <= 15 ? "⚠️" : "🟢";
        binLine = `   📍 <code>${lowerBin} [${bar}] ${upperBin}</code>  ${zoneIcon} bin ${activeBin} (${pctRounded}%)`;
      } else if (activeBin > upperBin) {
        const binsAbove = activeBin - upperBin;
        binLine = `   🔺 <code>[${lowerBin},${upperBin}]</code> · bin ${activeBin} <b>${binsAbove} above</b>`;
      } else if (activeBin < lowerBin) {
        const binsBelow = lowerBin - activeBin;
        binLine = `   🔻 <code>[${lowerBin},${upperBin}]</code> · bin ${activeBin} <b>${binsBelow} below</b>`;
      }
    }

    // Instruction/note
    const instrLine = p.instruction ? `📝 <i>${escHTML(p.instruction.substring(0, 60))}</i>` : null;

    // ─── Mobile-friendly structured layout ───
    // Group 1: Position value + fees (capital info)
    const pnlUsdInline = Math.abs(pnlUsd) >= 0.0001
      ? `  (${pnl >= 0 ? "+" : "-"}${cur}${Math.abs(pnlUsd).toFixed(4)})`
      : "";
    const moneyLine = `💰 Val ${cur}${val}${pnlUsdInline}`;
    const feesLine  = `📊 Fees ${cur}${fee}${yield24h != null ? `  ·  yield ${yield24h.toFixed(2)}%` : ""}`;
    // Group 2: Risk metrics (peak / volatility / age)
    const riskParts = [
      ageStr ? `⏱ ${ageStr}` : null,
      peakStr ? `🎯 ${peakStr}` : null,
      volStr ? `⚡ ${volStr}` : null,
    ].filter(Boolean);
    const riskLine = riskParts.length > 0 ? riskParts.join("  ·  ") : null;
    // Group 3: Strategy + OOR status
    const stratParts = [stratStr ? `🧭 ${stratStr}` : null, oorStr ? oorStr : null].filter(Boolean);
    const stratLine = stratParts.length > 0 ? stratParts.join("  ·  ") : null;

    return [
      `${rangeEmoji} <b>${escHTML(p.pair)}</b>  ${pnlEmoji} <b>${pnlSign}${pnl.toFixed(2)}%</b>`,
      moneyLine,
      feesLine,
      riskLine,
      stratLine,
      binLine ? binLine.trim() : null,
      instrLine,
      actionLine,
    ].filter(Boolean).join("\n");
  });

  const totalVal = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
  const totalFee = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);
  const totalPnl = positionData.reduce((s, p) => s + (p.pnl_usd ?? 0), 0);
  const pnlSign  = totalPnl >= 0 ? "+" : "";

  return (
    `🔄 <b>Management</b>\n` +
    `${D}\n` +
    lines.join(`\n${D}\n`) +
    `\n${D}\n` +
    `📊 ${positionData.length} pos  ·  ${cur}${totalVal.toFixed(4)}  ·  PnL ${pnlSign}${cur}${totalPnl.toFixed(4)}  ·  fees ${cur}${totalFee.toFixed(4)}`
  );
}

/** Convert basic markdown to Telegram HTML (escape first, then convert) */
function mdToTelegramHTML(text) {
  if (!text) return text;
  // Strip markdown that can't pair properly (unclosed bold/italic from truncation)
  let s = escHTML(text);
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__(.+?)__/g, "<i>$1</i>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Clean up leftover unpaired markers (from truncation)
  s = s.replace(/\*\*[^*]*$/g, "");
  s = s.replace(/__[^_]*$/g, "");
  s = s.replace(/`[^`]*$/g, "");
  return s;
}

/** Format screening report for Telegram (compact HTML) */
function formatScreenTelegram(rawReport, deployedOverride = null) {
  if (!rawReport) return null;
  const D = "━━━━━━━━━━━━━━━━━━━━";
  const text = stripThink(rawReport);

  // Use explicit deploy flag if provided (avoids LLM report misclassification)
  // Fall back to regex only when override is not set
  const deployed = deployedOverride !== null ? deployedOverride : /deployed|position opened|🚀/i.test(text);
  const blocked  = !deployed && /blocked|cooldown|no deploy|skip/i.test(text);
  const noPass   = !deployed && /no candidates|0 candidates|all.*filtered/i.test(text);

  const icon = deployed ? "🚀" : blocked ? "⛔" : noPass ? "🔍" : "🔍";
  const title = deployed ? "Deployed" : blocked ? "Blocked" : noPass ? "No Candidates" : "Screening";

  // Truncate at line boundary — Telegram limit is 4096, leave buffer for title + live-msg sections
  let truncated = text;
  const limit = 2500;
  if (text.length > limit) {
    const cut = text.lastIndexOf("\n", limit);
    truncated = text.substring(0, cut > 800 ? cut : limit) + "…";
  }

  return `${icon} <b>${title}</b>\n${D}\n${mdToTelegramHTML(truncated)}`;
}


function schedulePeakConfirmation(positionAddress) {
  if (!positionAddress || _peakConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _peakConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      resolvePendingPeak(positionAddress, position?.pnl_pct ?? null, TRAILING_PEAK_CONFIRM_TOLERANCE);
    } catch (error) {
      log("state_warn", `Peak confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_PEAK_CONFIRM_DELAY_MS);

  _peakConfirmTimers.set(positionAddress, timer);
}

function scheduleTrailingDropConfirmation(positionAddress) {
  if (!positionAddress || _trailingDropConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _trailingDropConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      const resolved = resolvePendingTrailingDrop(
        positionAddress,
        position?.pnl_pct ?? null,
        config.management.trailingDropPct,
        TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
      );
      if (resolved?.confirmed) {
        log("state", `[Trailing recheck] Confirmed trailing exit for ${positionAddress} — triggering management`);
        runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Trailing recheck management failed: ${e.message}`));
      }
    } catch (error) {
      log("state_warn", `Trailing drop confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_DROP_CONFIRM_DELAY_MS);

  _trailingDropConfirmTimers.set(positionAddress, timer);
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    log("cron", `Briefing generated (${briefing.length} chars)`);
    if (telegramEnabled()) {
      const result = await sendHTML(briefing);
      if (result?.ok) {
        log("cron", `Briefing sent to Telegram (message_id=${result.result?.message_id})`);
      } else {
        log("cron_error", `Briefing sendHTML returned non-OK: ${JSON.stringify(result)?.slice(0, 200)}`);
      }
    } else {
      log("cron", "Briefing skipped Telegram send (TOKEN not configured)");
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  _cronTasks = [];
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  let positionData = [];
  let actionMap = new Map();
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  // Process any matured IL recovery entries (lazy eval — restart-safe, no timers)
  processPendingILRecoveries().catch((e) => log("cron_error", `IL recovery processing failed: ${e.message}`));

  try {
    const livePositions = await getMyPositions({ force: true }).catch((e) => {
      log("cron_error", `getMyPositions failed: ${e.message}`);
      return null;
    });
    positions = livePositions?.positions || [];
    timers._lastKnownPositionCount = positions.length;
    // Track max volatility for dynamic management interval
    const trackedVols = positions.map(p => {
      const tracked = getTrackedPosition(p.position);
      return tracked?.volatility ?? 0;
    });
    timers._lastKnownMaxVolatility = trackedVols.length > 0 ? Math.max(...trackedVols) : 0;

    // Debug: compare API result vs state.js
    const statePositions = getTrackedPositions(true);
    if (positions.length !== statePositions.length) {
      log("cron_warn", `Position mismatch: API=${positions.length} state=${statePositions.length} (state: ${statePositions.map(p => p.position_address?.slice(0,8)).join(", ")})`);
    } else {
      log("cron", `Positions: API=${positions.length} state=${statePositions.length}`);
    }

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      if (!silent && telegramEnabled()) {
        sendHTML("🔄 <b>Management</b>\n\nNo open positions — triggering screening.").catch(() => {});
      }
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      return null; // finally block will release _managementBusy
    }

    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }

    // Snapshot + load pool memory
    positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // JS trailing TP check
    const exitMap = new Map();
    for (const p of positionData) {
      if (!p.pnl_pct_suspicious && queuePeakConfirmation(p.position, p.pnl_pct)) {
        schedulePeakConfirmation(p.position);
      }
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        if (exit.action === "TRAILING_TP" && exit.needs_confirmation) {
          if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct)) {
            scheduleTrailingDropConfirmation(p.position);
          }
          continue;
        }
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    actionMap = new Map();
    const tpAnalysisQueue = [];
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      // Sanity-check PnL against tracked initial deposit — API sometimes returns bad data
      // giving -99% PnL which would incorrectly trigger stop loss
      const tracked = getTrackedPosition(p.position);
      const pnlSuspect = (() => {
        if (p.pnl_pct == null) return false;
        if (p.pnl_pct > -90) return false; // only flag extreme negatives
        // Cross-check: if we have a tracked deposit and current value isn't near zero, it's bad data
        if (tracked?.amount_sol && (p.total_value_usd ?? 0) > 0.01) {
          log("cron_warn", `Suspect PnL for ${p.pair}: ${p.pnl_pct}% but position still has value — skipping PnL rules`);
          return true;
        }
        return false;
      })();

      // Rule 0: IL-based stop loss — detects value deterioration even when fees mask it
      // IL = position value drop excluding fees. Fees can cover IL temporarily but if IL > maxILPct,
      // the position is deteriorating and will likely get worse.
      const maxIL = config.management.maxILPct;
      if (maxIL != null && p.total_value_usd != null && tracked?.amount_sol) {
        const initialDeposit = config.management.solMode ? tracked.amount_sol : tracked.initial_value_usd;
        if (initialDeposit > 0) {
          const ilPct = ((p.total_value_usd - initialDeposit) / initialDeposit) * 100;
          if (ilPct <= maxIL) {
            actionMap.set(p.position, { action: "CLOSE", rule: "0", reason: `IL stop: position value ${ilPct.toFixed(2)}% (excl fees) <= ${maxIL}% limit` });
            continue;
          }
        }
      }
      // Rule 1a: hard stop loss — no override (catastrophic protection)
      if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct <= config.management.stopLossPct * 2) {
        actionMap.set(p.position, { action: "CLOSE", rule: "1a", reason: `hard stop loss ${p.pnl_pct.toFixed(2)}%` });
        continue;
      }
      // Rule 1: soft stop loss — skip if fees are strong and still in range (IL may recover)
      if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct <= config.management.stopLossPct) {
        const feeStrong = (p.fee_per_tvl_24h ?? 0) >= config.management.minFeePerTvl24h;
        if (p.in_range && feeStrong) {
          log("cron", `[Rule 1] ${p.pair}: PnL ${p.pnl_pct.toFixed(2)}% hit stop loss but fees strong (${p.fee_per_tvl_24h}) & in range — HOLD for recovery`);
        } else {
          actionMap.set(p.position, { action: "CLOSE", rule: 1, reason: `stop loss (pnl ${p.pnl_pct.toFixed(2)}%, fee/tvl=${p.fee_per_tvl_24h ?? 0}, in_range=${p.in_range})` });
          continue;
        }
      }
      // Rule 2: take profit — analyze before closing
      // At each new integer PnL% (3%, 4%, 5%...), run technical analysis.
      // Bullish + no exit signal → HOLD. Bearish or exit signal → CLOSE.
      if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct >= config.management.takeProfitFeePct) {
        const tracked = getTrackedPosition(p.position);
        const currentFloor = Math.floor(p.pnl_pct);
        const lastCheckPct = tracked?.last_tp_check_pct ?? 0;
        // Only re-analyze at each new integer % threshold
        if (currentFloor > lastCheckPct) {
          tpAnalysisQueue.push({ position: p, floor: currentFloor });
        } else {
          actionMap.set(p.position, { action: "STAY" });
        }
        // Between thresholds: hold (trailing handles the mechanical exit)
        continue;
      }
      // Rule 3: pumped far above range
      if (p.active_bin != null && p.upper_bin != null &&
          p.active_bin > p.upper_bin + config.management.outOfRangeBinsToClose) {
        actionMap.set(p.position, { action: "CLOSE", rule: 3, reason: "pumped far above range" });
        continue;
      }
      // Rule 4: stale above range — wait time scales DOWN with volatility (memecoin recovery is unlikely)
      if (p.active_bin != null && p.upper_bin != null &&
          p.active_bin > p.upper_bin) {
        const baseWait = config.management.outOfRangeWaitMinutes;
        const vol = tracked?.volatility ?? tracked?.signal_snapshot?.volatility ?? 0;
        const oorWait = vol >= 4 ? Math.max(8, Math.round(baseWait * 0.4))
                      : vol >= 2 ? Math.max(15, Math.round(baseWait * 0.7))
                      : baseWait;
        if ((p.minutes_out_of_range ?? 0) >= oorWait) {
          actionMap.set(p.position, { action: "CLOSE", rule: 4, reason: `OOR above (vol-scaled wait ${oorWait}m)` });
          continue;
        }
      }
      // Rule 4b: dumped far below range (symmetric to Rule 3)
      if (p.active_bin != null && p.lower_bin != null &&
          p.lower_bin - p.active_bin > config.management.outOfRangeBinsToClose) {
        actionMap.set(p.position, { action: "CLOSE", rule: "4b", reason: "dumped far below range" });
        continue;
      }
      // Rule 4c: stale below range — same vol-scaling as 4
      if (p.active_bin != null && p.lower_bin != null &&
          p.active_bin < p.lower_bin) {
        const baseWait = config.management.outOfRangeWaitMinutes;
        const vol = tracked?.volatility ?? tracked?.signal_snapshot?.volatility ?? 0;
        const oorWait = vol >= 4 ? Math.max(8, Math.round(baseWait * 0.4))
                      : vol >= 2 ? Math.max(15, Math.round(baseWait * 0.7))
                      : baseWait;
        if ((p.minutes_out_of_range ?? 0) >= oorWait) {
          actionMap.set(p.position, { action: "CLOSE", rule: "4c", reason: `OOR below (vol-scaled wait ${oorWait}m)` });
          continue;
        }
      }
      // Effective peak — used by recovery-grace guards below to avoid killing positions mid-recovery.
      // Includes pending peak (in 15s confirmation) + current PnL (peak hasn't pushed yet) + confirmed peak.
      const recoveryGracePeak = config.management.recoveryGracePeakPct ?? 0.5;
      const effectivePeakPnl = Math.max(
        tracked?.peak_pnl_pct ?? 0,
        tracked?.pending_peak_pnl_pct ?? 0,
        p.pnl_pct ?? 0,
      );
      const hasShownLife = effectivePeakPnl >= recoveryGracePeak;

      // Rule 5: fee yield too low AND position is losing (avoid gas-drain closes on profitable positions)
      // A profitable in-range position should keep running toward TP — closing it at 0.1% pnl costs more in gas than it gains.
      // Recovery guard: skip if position ever showed peak ≥ recoveryGracePeakPct (likely oscillating, not dead).
      if (p.fee_per_tvl_24h != null &&
          p.fee_per_tvl_24h < config.management.minFeePerTvl24h &&
          (p.age_minutes ?? 0) >= (config.management.minAgeBeforeYieldCheck ?? 60) &&
          (p.pnl_pct ?? 0) <= 0 &&
          !hasShownLife) {
        actionMap.set(p.position, { action: "CLOSE", rule: 5, reason: `low yield (peak ${effectivePeakPnl.toFixed(2)}% < ${recoveryGracePeak}%)` });
        continue;
      }
      // Rule 6: stale — IL winning with no meaningful fees (position stuck in loss)
      // Recovery guard: skip if peak ≥1% — position had real movement, deserves recovery time.
      if (!pnlSuspect &&
          (p.age_minutes ?? 0) >= 90 &&
          (p.pnl_pct ?? 0) < -2 &&
          (p.unclaimed_fees_usd ?? 0) < 0.05 &&
          effectivePeakPnl < 1) {
        actionMap.set(p.position, { action: "CLOSE", rule: 6, reason: `stale — IL > fees (peak ${effectivePeakPnl.toFixed(2)}% < 1%)` });
        continue;
      }
      // Rule 7: "nyayur" check — in range but generating ~zero fees → dead pool
      // Data (May 4-7, 2026): 4 closes, 0 wins (avg PnL -0.00%) — was triggering too fast at 10m
      // Adjusted: 10m → 30m threshold to give pool time to develop fee accumulation
      // Pool genuinely dead if yield≤0.01% AND fees<0.001 sustained for 30min (not transient)
      // Recovery guard: skip if peak ≥0.5% — pool isn't dead, it moved at some point.
      if (p.in_range &&
          (p.age_minutes ?? 0) >= 30 &&
          (p.fee_per_tvl_24h ?? -1) <= 0.01 &&
          (p.unclaimed_fees_usd ?? 0) < 0.001 &&
          !hasShownLife) {
        actionMap.set(p.position, { action: "CLOSE", rule: 7, reason: `near-zero fees after 30 min — dead pool (peak ${effectivePeakPnl.toFixed(2)}% < ${recoveryGracePeak}%)` });
        continue;
      }
      // Rule 7b: Early-dead detection via fee accumulation rate
      // Added 2026-05-22 from snapshot timeline analysis: winners 30-60m fee 0.007 SOL avg (rate ~0.00016/min),
      // marginals 0.004 SOL (rate ~0.00009/min), losers 0.004 SOL with drift negative.
      // Threshold 0.00005 SOL/min catches marginals/losers while keeping winners (BABYTROLL win had rate ~0.00009/min at 15-30m).
      // Window 25-45m: before rule 7's 30m flat-fee check, more aggressive on rate.
      const earlyDeadEnabled = config.management.earlyDeadEnabled !== false;
      const earlyDeadMinAge = config.management.earlyDeadMinAge ?? 25;
      const earlyDeadMaxAge = config.management.earlyDeadMaxAge ?? 45;
      const earlyDeadRate = config.management.earlyDeadFeeRatePerMin ?? 0.00005;
      if (earlyDeadEnabled &&
          p.in_range &&
          (p.age_minutes ?? 0) >= earlyDeadMinAge &&
          (p.age_minutes ?? 0) <= earlyDeadMaxAge &&
          !hasShownLife) {
        const feeRate = (p.unclaimed_fees_usd ?? 0) / Math.max(1, p.age_minutes);
        if (feeRate < earlyDeadRate) {
          actionMap.set(p.position, { action: "CLOSE", rule: "7b", reason: `Early dead detect: fee rate ${(feeRate*1000).toFixed(3)}m◎/min < ${(earlyDeadRate*1000).toFixed(3)}m◎/min threshold at age ${p.age_minutes}m (peak ${effectivePeakPnl.toFixed(2)}%)` });
          continue;
        }
      }
      // Rule 8: max hold for clearly-negative PnL
      // Original data: 5 positions held >120m while negative = -14.10% total loss
      // Refined: noise band (-1.5%, 0%) is normal oscillation, NOT exit-worthy
      // Lost-gains guard: if position had real peak (≥1%) but now lost ≥half, close — don't wait for IL stop
      // (Data 2026-05-11: WOJAK held 252m peak-to-IL-stop -7.10%, HANTA held 137m -7.52% — recovery never came)
      const maxHoldNeg = config.management.maxHoldNegativeMinutes;
      const maxHoldNegPnlThreshold = config.management.maxHoldNegativePnlPct ?? -1.5;
      const trackedPeak = tracked?.peak_pnl_pct ?? 0;
      if (!pnlSuspect && maxHoldNeg != null &&
          (p.age_minutes ?? 0) >= maxHoldNeg &&
          (p.pnl_pct ?? 0) <= maxHoldNegPnlThreshold) {
        actionMap.set(p.position, { action: "CLOSE", rule: 8, reason: `max hold negative: ${p.age_minutes}m > ${maxHoldNeg}m with pnl ${p.pnl_pct.toFixed(2)}% <= ${maxHoldNegPnlThreshold}% (peak was ${trackedPeak.toFixed(2)}%)` });
        continue;
      }
      // Rule 8b: lost gains — peak was real (≥1%) but position fully reversed (current ≤ -peak)
      // Catches WOJAK/HANTA pattern: pumped to +X%, slid down for hours, hit IL stop at -7%
      // Triggers when total swing = 2× peak (peak +1.5% → close at -1.5%) — clear reversal, not noise
      // Avoids overlap with trailing TP (only activates peak ≥2%, so 8b handles 1-2% peak range)
      const lostGainsPeakMin = config.management.lostGainsPeakMinPct ?? 1.0;
      const lostGainsMinAge = config.management.lostGainsMinAgeMin ?? 30;
      if (!pnlSuspect && p.pnl_pct != null &&
          (p.age_minutes ?? 0) >= lostGainsMinAge &&
          trackedPeak >= lostGainsPeakMin &&
          (p.pnl_pct ?? 0) <= -trackedPeak) {
        actionMap.set(p.position, { action: "CLOSE", rule: "8b", reason: `lost gains: peak ${trackedPeak.toFixed(2)}% → current ${p.pnl_pct.toFixed(2)}% (full reversal, ${p.age_minutes}m old)` });
        continue;
      }
      // Rule 9: max hold flat — data: ADHD 406m peak 0.25%, 我的刀盾 964m peak 0.63%, Aliens 234m peak 0.02%
      // Fix: include pending peak + current PnL — bug killed ASTEROID at +0.64% mid-recovery
      // Tighten threshold 1.0% → 0.5% to keep catching the original dead-flat cases
      const maxHoldFlat = config.management.maxHoldFlatMinutes;
      const flatPeakThreshold = config.management.maxHoldFlatPeakPct ?? 0.5;
      const effectivePeak = Math.max(
        tracked?.peak_pnl_pct ?? 0,
        tracked?.pending_peak_pnl_pct ?? 0,
        p.pnl_pct ?? 0,
      );
      if (maxHoldFlat != null &&
          (p.age_minutes ?? 0) >= maxHoldFlat &&
          effectivePeak < flatPeakThreshold) {
        actionMap.set(p.position, { action: "CLOSE", rule: 9, reason: `stale flat: ${p.age_minutes}m > ${maxHoldFlat}m with effective peak ${effectivePeak.toFixed(2)}% < ${flatPeakThreshold}% (confirmed=${(tracked?.peak_pnl_pct ?? 0).toFixed(2)}%, pending=${(tracked?.pending_peak_pnl_pct ?? 0).toFixed(2)}%, current=${(p.pnl_pct ?? 0).toFixed(2)}%)` });
        continue;
      }
      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Smart TP analysis: check if profitable position should keep running ──
    // LP-relevant signals: exit_signal (sharp move coming), volume health, range proximity
    for (const { position: p, floor } of tpAnalysisQueue) {
      try {
        await new Promise(r => setTimeout(r, 500)); // GeckoTerminal rate limit
        const tech = await getTechnicalSignals({ pool_address: p.pool_address || p.pool, timeframe: "15m" });
        const exitSignal = tech?.exit_signal ?? false;
        const volSpike = tech?.indicators?.volume_spike?.is_spike ?? false;
        const feeDying = (p.fee_per_tvl_24h ?? 999) < config.management.minFeePerTvl24h;
        const shouldClose = exitSignal || (feeDying && !volSpike);
        setLastTpCheckPct(p.position, floor);
        if (shouldClose) {
          const reason = exitSignal
            ? `TP exit: ${tech.exit_reason} at ${p.pnl_pct.toFixed(2)}%`
            : `TP exit: fees dying (fee/tvl=${p.fee_per_tvl_24h}) at ${p.pnl_pct.toFixed(2)}%`;
          actionMap.set(p.position, { action: "CLOSE", rule: 2, reason });
          log("cron", `[TP Analysis] ${p.pair}: CLOSE — ${reason}`);
        } else {
          actionMap.set(p.position, { action: "STAY" });
          log("cron", `[TP Analysis] ${p.pair}: HOLD at ${p.pnl_pct.toFixed(2)}% (fees healthy, no exit signal) — next check at ${floor + 1}%`);
        }
      } catch (e) {
        log("cron_warn", `[TP Analysis] Failed for ${p.pair}: ${e.message} — fallback to hard TP`);
        actionMap.set(p.position, { action: "CLOSE", rule: 2, reason: `take profit (analysis failed) at ${p.pnl_pct.toFixed(2)}%` });
      }
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = config.management.solMode ? `◎${p.total_value_usd ?? "?"}` : `$${p.total_value_usd ?? "?"}`;
      const unclaimed = config.management.solMode ? `◎${p.unclaimed_fees_usd ?? "?"}` : `$${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${p.pnl_pct ?? "?"}% | Yield: ${p.fee_per_tvl_24h ?? "?"}% | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "exit") line += `\n⚡ Trailing TP: ${act.reason}`;
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\nRule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | ${cur}${totalValue.toFixed(4)} | fees: ${cur}${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Execute actions directly (no LLM — rules already decided) ──
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      log("cron", `Management: ${actionPositions.length} action(s) — executing directly (no LLM)`);
      const actionResults = [];

      for (const p of actionPositions) {
        const act = actionMap.get(p.position);
        try {
          if (act.action === "CLOSE" || act.action === "TRAILING_TP" || act.action === "STOP_LOSS" || act.action === "EARLY_IL") {
            const reason = act.reason || act.action;
            await liveMessage?.toolStart("close_position");
            let result = await executeTool("close_position", {
              position_address: p.position,
              reason,
            });
            // Retry once on transient network errors
            if (result?.success === false && /fetch failed|ECONNRESET|ECONNREFUSED|socket hang|ETIMEDOUT/i.test(result?.error || "")) {
              log("cron", `[Mgmt] Close failed (network error), retrying in 4s: ${result.error}`);
              await new Promise(r => setTimeout(r, 4000));
              result = await executeTool("close_position", { position_address: p.position, reason });
            }
            await liveMessage?.toolFinish("close_position", result, result?.success !== false);
            const status = result?.success !== false ? "✅" : `❌ ${result?.error || "failed"}`;
            actionResults.push(`${p.pair}: CLOSE ${status} — ${reason}`);
            log("cron", `[Mgmt] Closed ${p.pair}: ${status}`);
          } else if (act.action === "CLAIM") {
            await liveMessage?.toolStart("claim_fees");
            const result = await executeTool("claim_fees", {
              position_address: p.position,
            });
            await liveMessage?.toolFinish("claim_fees", result, result?.success !== false);
            const status = result?.success !== false ? "✅" : `❌ ${result?.error || "failed"}`;
            actionResults.push(`${p.pair}: CLAIM ${status}`);
            log("cron", `[Mgmt] Claimed ${p.pair}: ${status}`);
          }
        } catch (e) {
          actionResults.push(`${p.pair}: ${act.action} ❌ ${e.message}`);
          log("cron_error", `[Mgmt] ${act.action} ${p.pair} failed: ${e.message}`);
        }
      }

      mgmtReport += `\n\n${actionResults.join("\n")}`;
    } else {
      log("cron", "Management: all positions STAY — no actions needed");
      await liveMessage?.note("No tool actions needed.");
    }

    // Refresh position count + volatility after actions
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    timers._lastKnownPositionCount = afterCount;
    const afterVols = (afterPositions?.positions || []).map(p => getTrackedPosition(p.position)?.volatility ?? 0);
    timers._lastKnownMaxVolatility = afterVols.length > 0 ? Math.max(...afterVols) : 0;

    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        const formatted = positionData.length > 0
          ? formatMgmtTelegram(positionData, actionMap, mgmtReport, config.management.solMode)
          : `🔄 <b>Management</b>\n\n${mdToTelegramHTML(stripThink(mgmtReport).substring(0, 2500))}`;
        if (liveMessage) {
          // Combine into single message — finalize live message with formatted report as footer
          await liveMessage.finalize(formatted || "").catch(() => {});
        } else if (formatted) {
          sendHTML(formatted).catch((e) => log("telegram_warn", `Management report send failed: ${e.message}`));
        }
      }
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  // ── Guard: prevent overlapping cycles ───────────────────────────────────────
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true;
  _screeningLastTriggered = Date.now();

  let liveMessage = null;
  let screenReport = null;
  let deploySucceeded = false; // tracks whether deploy_position actually succeeded

  // ── Guard: pre-check positions + balance ────────────────────────────────────
  let positions, balance;
  try {
    [positions, balance] = await Promise.all([
      getMyPositions({ force: true }),
      getWalletBalances(),
    ]);

    if (positions.total_positions >= config.risk.maxPositions) {
      screenReport = `Screening skipped — max positions reached (${positions.total_positions}/${config.risk.maxPositions}).`;
      log("cron", screenReport);
      _screeningBusy = false;
      return screenReport;
    }

    const minRequired = Math.max(config.management.minSolToOpen, config.management.deployAmountSol + config.management.gasReserve);
    if (process.env.DRY_RUN !== "true" && balance.sol < minRequired) {
      screenReport = `Screening skipped — insufficient SOL (${balance.sol.toFixed(3)} < ${minRequired}).`;
      log("cron", screenReport);
      _screeningBusy = false;
      return screenReport;
    }
  } catch (e) {
    screenReport = `Screening pre-check failed: ${e.message}`;
    log("cron_error", screenReport);
    _screeningBusy = false;
    return screenReport;
  }

  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);

  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }

  try {
    const deployAmount = computeDeployAmount(balance.sol);
    log("cron", `Deploy amount: ${deployAmount} SOL (wallet: ${balance.sol} SOL)`);

    // ── Step 1: Discover + score candidates ─────────────────────────────────
    const { candidates = [] } = await getTopCandidates({ limit: 10 }).catch(() => ({}));

    // Record outcome for scarcity detection (async, non-blocking)
    recordScreeningOutcome(candidates.length);

    if (candidates.length === 0) {
      screenReport = `⛔ NO DEPLOY\n\nNo candidates passed discovery filters.`;
      return screenReport;
    }

    log("cron", `Step 1 done — ${candidates.length} scored candidates`);

    // ── Step 2: Enrich each candidate (token info + tech signals + bins) ─────
    const enriched = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;

      // 2a. Token info (launchpad, audit)
      const tiResult = await getTokenInfo({ query: mint }).catch(() => null);
      const ti = tiResult?.results?.[0] ?? null;

      // 2b. Hard filter — launchpad
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.blockedLaunchpads?.includes(launchpad)) {
        log("screening", `Filtered ${pool.name} — blocked launchpad (${launchpad})`);
        continue;
      }

      // 2c. Hard filter — bot holders
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotPct != null && botPct > maxBotPct) {
        log("screening", `Filtered ${pool.name} — bot holders ${botPct}% > ${maxBotPct}%`);
        continue;
      }

      // 2d. Hard filter — dead pool trap (high fee_tvl but low organic = stale/fake activity)
      // Data: AgenC-SOL fee_tvl=3.51, organic=55 → 0 fees in 15 min (dead pool)
      const organicScore = pool.organic_score ?? 100;
      if ((pool.fee_active_tvl_ratio ?? 0) >= 3 && organicScore < 65) {
        log("screening", `Filtered ${pool.name} — dead pool suspect: fee_tvl=${pool.fee_active_tvl_ratio} but organic=${organicScore} < 65`);
        continue;
      }

      // 2e. Pump trap filter — fee_tvl > 6 is almost always a post-pump signal
      // Data: MOGMAN -83% (fee_tvl 6.09), Freg -4.36% (7.9), Rise -4.19% (8.4), POKE6900 -1.54% (8.2)
      if ((pool.fee_active_tvl_ratio ?? 0) > 6) {
        log("screening", `Filtered ${pool.name} — pump trap: fee_tvl=${pool.fee_active_tvl_ratio} > 6 (post-pump, high rug risk)`);
        continue;
      }

      // 2e-bonus. Multi-TF Fee/TVL pump trap detection
      // Pump pattern: fee_tvl(4h) >> fee_tvl(current TF) = sustained pump dropping = post-pump phase
      // Healthy: ratios consistent across TFs
      // Threshold raised 2026-05-23 from 5× to 8× → 12× — May 22 log showed 33% of blocks (128 of 388) were
      // in borderline 5-8× range. Loosened to allow active-pump pools through (general policy, all tokens).
      try {
        const pool4h = await getPoolDetail({ pool_address: pool.pool, timeframe: "4h" });
        const fee4h = Number(pool4h?.fee_active_tvl_ratio || 0);
        const feeNow = Number(pool.fee_active_tvl_ratio || 0);
        const pumpTrapRatio = config.screening.pumpTrapMultiTfRatio ?? 8;
        if (fee4h > 0 && feeNow > 0 && fee4h / feeNow > pumpTrapRatio) {
          log("screening", `Filtered ${pool.name} — pump trap multi-TF: fee_tvl 4h=${fee4h.toFixed(2)} >> current=${feeNow.toFixed(2)} (ratio ${(fee4h/feeNow).toFixed(1)}× > ${pumpTrapRatio}× — post-pump)`);
          continue;
        }
        pool._fee_tvl_4h = fee4h;
      } catch (e) {
        // Non-blocking — if API fails, continue with single-TF check
      }

      // 2f. Technical signals (entry ok? bearish? volume spike?)
      // Delay to avoid GeckoTerminal 429 — sequential calls, 3.5s apart (raised from 2.5 → safer for free tier)
      await new Promise(r => setTimeout(r, 3500));
      let tech = null;
      let techFetchOk = false;
      try {
        const raw = await getTechnicalSignals({ pool_address: pool.pool, timeframe: "15m" });
        if (!raw?.error) {
          tech = raw;
          techFetchOk = true;
        }
      } catch { /**/ }

      // 2d-bonus. Multi-TF supertrend confirmation (1h)
      // Hard-skip if 15m AND 1h both bearish — strong macro downtrend signal
      // Skip 1h fetch (2026-05-23) if 15m already shows clear filter conditions — saves GT API quota
      let tech1h = null;
      let tech1hFetchOk = false;
      const skip1hReason = (() => {
        if (!techFetchOk) return null;  // 15m failed, still need 1h to verify
        const t = tech;
        const rsi = t?.indicators?.rsi2;
        const vwap = t?.indicators?.vwap?.distance_pct;
        const st15m = t?.indicators?.supertrend?.is_bullish;
        // 15m already strongly bullish → 1h confirmation low value
        if (st15m === true && rsi != null && rsi >= 25 && rsi <= 65 && vwap != null && vwap >= -15 && vwap <= 5) {
          return "15m already shows Pattern A entry (RSI/VWAP/ST aligned)";
        }
        // 15m extreme bad signals → 1h check pointless (will be skipped anyway)
        if (vwap != null && (vwap > 5 || vwap < -25)) return "15m VWAP already extreme";
        if (rsi != null && rsi > 70) return "15m RSI already overbought";
        return null;
      })();
      if (skip1hReason) {
        log("screening", `${pool.name} — skip 1h fetch: ${skip1hReason}`);
      } else {
        try {
          await new Promise(r => setTimeout(r, 2500)); // delay between OHLCV calls
          const raw1h = await getTechnicalSignals({ pool_address: pool.pool, timeframe: "1h" });
          if (!raw1h?.error) {
            tech1h = raw1h;
            tech1hFetchOk = true;
          }
        } catch { /**/ }
      }

      // Fail-closed: skip pool if BOTH timeframes failed (can't verify trend at all)
      // Single-TF failure is acceptable — at least one direction confirmed
      // Note: skip1hReason path means we intentionally skipped 1h — only fail if 15m also failed
      if (!techFetchOk && !tech1hFetchOk) {
        log("screening", `Filtered ${pool.name} — multi-TF tech check unavailable (OHLCV fetch failed 15m+1h, likely 429 rate limit). Cannot verify trend, skipping for safety.`);
        continue;
      }

      // 2e. Pre-compute bins — bid_ask asymmetric: tight bins_below for fee concentration,
      // wider bins_above for OOR-up protection during pump (1.5× factor)
      const vol = Number(pool.volatility || 3);
      const binsBelowCalc = Math.min(22, Math.max(15, Math.round(15 + (vol / 5) * 7)));
      const atrBins = tech?.suggested_bins_below ?? null;
      const baseBins = atrBins ?? binsBelowCalc;
      pool._bins_below = baseBins;
      pool._bins_above = Math.round(baseBins * 1.5);
      // bid_ask thesis: bearish supertrend + post-dip = OPPORTUNITY, not warning
      // We're LPing, not directional trading. Fees come from frantic dip-buyers at the bottom.
      const _rsi2 = tech?.indicators?.rsi2 ?? 50;
      const _vwapForGate = tech?.indicators?.vwap?.distance_pct ?? 0;
      const _isDipZone = _vwapForGate < -3 && _rsi2 < 55;
      const _rawWarnings = tech?.entry_warnings ?? [];
      const _filteredWarnings = _isDipZone
        ? _rawWarnings.filter(w => !/supertrend|bearish/i.test(w))
        : _rawWarnings;
      pool._tech_ok    = !_filteredWarnings.length;
      pool._tech_warn  = _filteredWarnings;
      pool._exit_signal = tech?.exit_signal ?? false;
      pool._tech_snapshot = tech ? {
        rsi2: tech.indicators?.rsi2 ?? null,
        supertrend: tech.indicators?.supertrend?.direction ?? null,
        supertrend_1h: tech1h?.indicators?.supertrend?.direction ?? null,
        vwap_dist_pct: tech.indicators?.vwap?.distance_pct ?? null,
        volume_spike: tech.indicators?.volume_spike?.is_spike ?? false,
      } : null;

      // 2f. Hard filter — bearish trend or overbought entry
      // Data: 9 losers had no entry filter; supertrend bearish = price likely to drop
      // Supertrend only hard-blocks low-score pools (<60); high-confidence pools (≥60) pass with warning

      // VWAP extreme filter — price stretched far from mean = high reversal/dump risk
      // Data 2026-05-14: CHUD-SOL deployed at peak, dumped -22% in 51m
      const vwapDist = tech?.indicators?.vwap?.distance_pct ?? 0;
      const vwapDist1h = tech1h?.indicators?.vwap?.distance_pct ?? 0;
      const vwapExtremeThreshold = 50;
      if (Math.abs(vwapDist) > vwapExtremeThreshold || Math.abs(vwapDist1h) > vwapExtremeThreshold) {
        log("screening", `Filtered ${pool.name} — VWAP extreme (15m=${vwapDist.toFixed(1)}%, 1h=${vwapDist1h.toFixed(1)}%) — price stretched, reversal risk`);
        continue;
      }

      // bid_ask anti-pump entry filter — thesis = buy-dip-recover, so reject pump entry
      // Thresholds tunable via user-config (2026-05-23): vwapPumpMax, rsi2Overbought, vwapFallingKnife
      const rsi2 = tech?.indicators?.rsi2 ?? null;
      const rsi2Trend = tech?.indicators?.rsi2_trend ?? null;
      const volSpikeNow = tech?.indicators?.volume_spike?.is_spike ?? false;
      const vwapPumpMax = config.screening.vwapPumpMax ?? 8;
      const rsi2Overbought = config.screening.rsi2Overbought ?? 70;
      const vwapFallingKnife = config.screening.vwapFallingKnife ?? -25;
      if (vwapDist > vwapPumpMax) {
        log("screening", `Filtered ${pool.name} — price +${vwapDist.toFixed(1)}% above VWAP (> ${vwapPumpMax}%), pump entry not aligned with bid_ask thesis`);
        continue;
      }
      if (rsi2 !== null && rsi2 > rsi2Overbought) {
        log("screening", `Filtered ${pool.name} — RSI2=${rsi2.toFixed(1)} > ${rsi2Overbought} overbought, wait for cooldown before bid_ask entry`);
        continue;
      }
      // Falling knife guard — too deep below VWAP = no support, dip may continue past range
      if (vwapDist < vwapFallingKnife) {
        log("screening", `Filtered ${pool.name} — price ${vwapDist.toFixed(1)}% below VWAP (< ${vwapFallingKnife}%), falling knife — wait for first bounce`);
        continue;
      }
      // Best Moment filter — added 2026-05-23 from 7-winner pattern analysis (backtest validated)
      // Winners cluster in 2 setups:
      //   Pattern A: RSI2 25-65 + climbing (bounce confirmed) → +4-6% avg PnL
      //   Pattern B: RSI2 < threshold + volume_spike (capitulation + buyer step-in) → +2-4% avg
      //   Pattern B-alt: RSI2 < threshold + established token (age>=X AND mcap>=Y) → can still win
      // Losers: RSI2 < threshold + no volume_spike + fresh/small mcap → "falling knife continues"
      // Backtest: kept 7/7 winners, cut 2/3 losers (DEGEN -3.72%, Embrace -2.48%)
      // Configurable via user-config.json: bestMomentEnabled, extremeOversoldRsiThreshold, extremeOversoldExempt*
      if (config.screening.bestMomentEnabled !== false) {
        const oversoldRsi = config.screening.extremeOversoldRsiThreshold ?? 15;
        const requiresSpike = config.screening.extremeOversoldRequiresSpike ?? true;
        const exemptAge = config.screening.extremeOversoldExemptAgeHours ?? 72;
        const exemptMcap = config.screening.extremeOversoldExemptMcap ?? 1000000;
        if (rsi2 !== null && rsi2 < oversoldRsi && requiresSpike && !volSpikeNow) {
          const tokenAge = pool.token_age_hours ?? 0;
          const tokenMcap = pool.mcap ?? 0;
          const established = tokenAge >= exemptAge && tokenMcap >= exemptMcap;
          if (!established) {
            log("screening", `Filtered ${pool.name} — RSI2=${rsi2.toFixed(1)} < ${oversoldRsi} + no volume_spike + not established (age=${tokenAge}h, mcap=$${(tokenMcap/1e6).toFixed(2)}M) — pure falling knife pattern`);
            continue;
          }
        }
      }
      // Bonus warning (not skip) — RSI 15-25 with negative trend = still falling
      if (rsi2 !== null && rsi2 >= 15 && rsi2 < 25 && rsi2Trend !== null && rsi2Trend < 0 && !volSpikeNow) {
        log("screening", `Warning: ${pool.name} — RSI2=${rsi2.toFixed(1)} still falling (Δ${rsi2Trend.toFixed(1)}), no bounce signal yet. Score-only.`);
      }

      if (pool._exit_signal) {
        log("screening", `Filtered ${pool.name} — overbought at entry (exit signal active)`);
        continue;
      }
      // 2f-bonus. Multi-TF bearish hard-skip: both 15m AND 1h bearish = strong dump signal
      const st15mBearish = tech?.indicators?.supertrend && !tech.indicators.supertrend.is_bullish;
      const st1hBearish = tech1h?.indicators?.supertrend && !tech1h.indicators.supertrend.is_bullish;
      if (st15mBearish && st1hBearish) {
        log("screening", `Filtered ${pool.name} — multi-TF bearish (15m + 1h both bearish supertrend) — strong downtrend, skip`);
        continue;
      }
      if (st15mBearish) {
        log("screening", `Warning: ${pool.name} — 15m bearish supertrend (1h: ${tech1h?.indicators?.supertrend?.direction || "unknown"}), score ${pool.score}. Passing anyway`);
      }

      // 2g. LPer quality signal — lightweight study of top LPers in this pool
      // Cached 1h to avoid API hammering. Adds "elite/good/neutral/weak/none" tier.
      let lperSignal = { tier: "none" };
      try {
        lperSignal = await getLperQualitySignal({ pool_address: pool.pool });
        if (lperSignal.tier === "elite" || lperSignal.tier === "good") {
          log("screening", `${pool.name} — LPer tier=${lperSignal.tier} (${lperSignal.credible_count} credible, avg ROI ${lperSignal.avg_roi_pct}%, win ${lperSignal.avg_win_rate_pct}%)`);
        } else if (lperSignal.tier === "weak") {
          log("screening", `Warning: ${pool.name} — LPer tier=weak (${lperSignal.reason}). Score-only, no confirmation from top LPers.`);
        }
      } catch (e) {
        log("screening", `LPer signal fetch failed for ${pool.name}: ${e.message?.slice(0, 80)}`);
      }
      pool._lper_signal = lperSignal;

      // Cache all signals for this pool so executor can inject signal_snapshot at deploy
      cachePoolSignals(pool.pool, {
        organic_score: pool.organic_score ?? null,
        fee_tvl_ratio: pool.fee_active_tvl_ratio ?? null,
        volatility: Number(pool.volatility || 0),
        volume: pool.volume_window ?? null,
        mcap: pool.mcap ?? null,
        tvl: pool.active_tvl ?? null,
        bin_step: pool.bin_step ?? null,
        bins_below: pool._bins_below ?? null,
        token_age_hours: pool.token_age_hours ?? null,
        price_vs_ath_pct: pool.price_vs_ath_pct ?? null,
        holder_count: ti?.holder_count ?? null,
        top10_holders_pct: ti?.audit?.top_holders_pct != null ? Number(ti.audit.top_holders_pct) : null,
        bot_holders_pct: ti?.audit?.bot_holders_pct != null ? Number(ti.audit.bot_holders_pct) : null,
        bundle_pct: pool.bundle_pct ?? ti?.bundle_pct ?? null,
        smart_wallets_present: pool.smart_wallets_present ?? null,
        global_fees_sol: ti?.global_fees_sol ?? null,  // priority+jito tips — low = bundled/scam, high = legit activity
        // Activity (from Meteora API — best dead pool predictor)
        swap_count: pool.swap_count ?? null,
        unique_traders: pool.unique_traders ?? null,
        // Scoring (for evolution tracking)
        score: pool.score ?? null,
        // Technical (already fetched above)
        rsi2: pool._tech_snapshot?.rsi2 ?? null,
        supertrend_bullish: pool._tech_snapshot?.supertrend === "up" || (tech?.indicators?.supertrend?.is_bullish ?? null),
        vwap_dist_pct: pool._tech_snapshot?.vwap_dist_pct ?? null,
        volume_spike: pool._tech_snapshot?.volume_spike ?? false,
        // LPer quality (new — smart money signal layer)
        lper_tier: lperSignal?.tier ?? "none",
        lper_avg_roi_pct: lperSignal?.avg_roi_pct ?? null,
        lper_avg_win_rate_pct: lperSignal?.avg_win_rate_pct ?? null,
        lper_credible_count: lperSignal?.credible_count ?? 0,
      });

      enriched.push({ pool, ti });
      await new Promise(r => setTimeout(r, 500)); // GeckoTerminal rate limit
    }

    log("cron", `Step 2 done — ${enriched.length} candidates after enrichment filters`);

    if (enriched.length === 0) {
      screenReport = `⛔ NO DEPLOY\n\nAll candidates filtered (launchpad / bot holders).`;
      return screenReport;
    }

    // ── Anti force-deploy: skip LLM if no candidate meets minimum score ────
    const minScore = config.screening.minDeployScore ?? 55;
    const bestScore = Math.max(...enriched.map(({ pool }) => pool.score ?? 0));
    if (bestScore < minScore) {
      const names = enriched.map(({ pool }) => `${pool.name}(${pool.score})`).join(", ");
      log("screening", `All candidates below minDeployScore (${minScore}): ${names} — skipping LLM`);
      screenReport = `⛔ NO DEPLOY\n\nAll ${enriched.length} candidates scored below minimum (${minScore}). Best: ${bestScore}. Skipped LLM to save tokens.\nCandidates: ${names}`;
      return screenReport;
    }

    // ── Step 3: Build candidate blocks for LLM ──────────────────────────────
    const candidateBlocks = enriched.map(({ pool, ti }) => {
      const vol      = Number(pool.volatility || 0);
      const top10    = ti?.audit?.top_holders_pct ?? "?";
      const bots     = ti?.audit?.bot_holders_pct ?? "?";
      const feesSol  = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;

      const okxRisk = [
        pool.risk_level  != null ? `risk=${pool.risk_level}`                    : null,
        pool.bundle_pct  != null ? `bundle=${pool.bundle_pct}%`                 : null,
        pool.sniper_pct  != null ? `sniper=${pool.sniper_pct}%`                 : null,
        pool.is_rugpull  != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}`  : null,
        pool.is_wash     != null ? `wash=${pool.is_wash ? "YES" : "NO"}`        : null,
      ].filter(Boolean).join(", ") || "unavailable";

      const okxTags = [
        pool.smart_money_buy  ? "smart_money_buy"  : null,
        pool.kol_in_clusters  ? "kol_in_clusters"  : null,
        pool.dev_sold_all     ? "dev_sold_all"      : null,
      ].filter(Boolean).join(", ");

      const techStatus = pool._tech_ok
        ? (pool._exit_signal ? "⚠️ exit_signal_active (overbought — avoid)" : "✅ entry_ok")
        : `❌ entry_warnings: ${pool._tech_warn.join("; ")}`;

      const scoreBreakdown = Object.entries(pool.score_breakdown || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n    ");

      // Collect holder count from token info
      const holderCount = ti?.holder_count ?? null;
      const smartWallets = pool.smart_wallets_present ?? null;
      const bundlePct = pool.bundle_pct ?? ti?.bundle_pct ?? null;

      // Multi-TF context
      const fee4h = pool._fee_tvl_4h;
      const feeMultiTF = fee4h != null
        ? `current=${pool.fee_active_tvl_ratio}% | 4h=${fee4h}%`
        : `${pool.fee_active_tvl_ratio}%`;

      // Multi-TF tech (15m + 1h supertrend)
      const st15m = pool._tech_snapshot?.supertrend ?? "?";
      const st1h  = pool._tech_snapshot?.supertrend_1h ?? "?";
      const stMultiTF = st1h !== "?" ? `15m=${st15m}/1h=${st1h}` : `15m=${st15m}`;

      // LPer quality line
      const lper = pool._lper_signal;
      const lperEmoji = { elite: "💎", good: "✓", neutral: "·", weak: "⚠️", none: "?" }[lper?.tier] || "?";
      const lperLine = lper && lper.tier !== "none"
        ? `  LPers:    ${lperEmoji} ${lper.tier} (${lper.credible_count} credible, avg ROI ${lper.avg_roi_pct ?? "?"}%, win ${lper.avg_win_rate_pct ?? "?"}%, hold ${lper.avg_hold_hours ?? "?"}h)`
        : `  LPers:    ? unavailable (${lper?.reason || "no data"})`;

      return [
        `━━━ ${pool.name} ━━━`,
        `  Score:    ${pool.score} [${pool.score_label}]`,
        `  Breakdown:\n    ${scoreBreakdown}`,
        `  Metrics:  fee_tvl=${feeMultiTF} | vol=$${pool.volume_window} | tvl=$${pool.active_tvl} | volatility=${vol} | organic=${pool.organic_score} | mcap=$${pool.mcap}${pool.token_age_hours != null ? ` | age=${pool.token_age_hours}h` : ""}`,
        `  Audit:    top10=${top10}% | bots=${bots}%${bundlePct != null ? ` | bundle=${bundlePct}%` : ""} | fees_sol=${feesSol}${holderCount != null ? ` | holders=${holderCount}` : ""}${launchpad ? ` | launchpad=${launchpad}` : ""}`,
        `  Risk:     ${okxRisk}`,
        okxTags ? `  Tags:     ${okxTags}` : null,
        pool.price_vs_ath_pct != null ? `  ATH:      price_vs_ath=${pool.price_vs_ath_pct}%` : null,
        `  Tech:     ${techStatus} | supertrend ${stMultiTF}`,
        lperLine,
        `  Bins:     below=${pool._bins_below} above=${pool._bins_above} (use as-is, do NOT recalculate)`,
        `  Pool:     ${pool.pool}`,
      ].filter(Boolean).join("\n");
    });

    log("cron", `Step 3 done — ${candidateBlocks.length} blocks built for LLM`);

    // ── Step 4: LLM picks winner and deploys ────────────────────────────────
    const { content } = await agentLoop(`
SCREENING CYCLE
Status: ${positions.total_positions}/${config.risk.maxPositions} positions | ${balance.sol.toFixed(3)} SOL | deploy=${deployAmount} SOL

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CANDIDATES (sorted best → worst)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${candidateBlocks.join("\n\n")}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BID_ASK THESIS (read carefully — this overrides directional intuition)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
We are LPing with bid_ask single-sided SOL. We are NOT directional traders.
Our profit comes from: dip happens → our SOL converts to token at cheap basis → price recovers → we collect fees + capital gain on recovery.

THIS MEANS bearish supertrend + price below VWAP + RSI2 in recovery zone = OPPORTUNITY, not danger.
The "scary" entries that directional traders avoid (post-dip, bearish trend) are EXACTLY where bid_ask LP wins.

GOOD ENTRY (deploy):
- VWAP_dist between -15% and -5% (post-dip recovering — sweet spot)
- RSI2 between 25 and 65 (not overbought, not extreme oversold)
- BONUS: rsi2_trend > 0 (RSI climbing = bounce in progress)
- BONUS: volume_spike = true (active buyer interest at entry)
- Supertrend bearish on 15m is FINE — we want the dip
- Bonus case: 1h supertrend up while 15m bearish = pullback in uptrend (best)

BAD ENTRY (skip):
- VWAP_dist > +5% → pump entry, will reverse against us
- RSI2 > 70 → overbought, wait for cooldown
- VWAP_dist < -25% → falling knife, no support, may break range
- RSI2 < 15 WITHOUT volume_spike + NOT established (age >= 72h + mcap >= $1M) → pure falling knife
- exit_signal_active → momentum already exhausted

DEPLOY RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Pick the highest-score candidate that passes the BID_ASK THESIS judgment above.
   Score ≥ ${config.screening.minDeployScore + 15} = strong deploy if entry zone OK. ${config.screening.minDeployScore}–${config.screening.minDeployScore + 14} = deploy only if entry zone is clearly post-dip. < ${config.screening.minDeployScore} = skip.
2. SKIP only if: exit_signal_active OR VWAP_dist outside [-25%, +5%] OR RSI2 > 70.
   DO NOT skip on bearish supertrend alone — that is the entry, not the exit.
3. Use bins_below/bins_above exactly as pre-computed — do NOT recalculate.
4. Call deploy_position with: strategy="bid_ask", amount_y=${deployAmount}

SCORING GUIDANCE (multi-signal pattern recognition):
- SWEET SPOT: fee_tvl near scoring target + vol 2-4 + organic ≥ 70 + VWAP_dist in [-15%, -5%] + RSI2 in [25, 65] + LPer tier=elite/good → strong deploy
- DEAD POOL RISK: fee_tvl very low OR volatility < 2 OR LPer tier=weak (no credible LPers) → likely zero fees post-deploy
- PUMP TRAP: fee_tvl far above target (e.g. 5×+) + VWAP_dist positive → distribution phase, AVOID
- FALLING KNIFE: RSI2 < 15 + no volume_spike + fresh token → bait pattern, AVOID
- Bot holders near filter cap (${config.screening.maxBotHoldersPct}%) = elevated risk, prefer pools with lower bot %

LPER QUALITY SIGNAL (smart money confirmation layer):
- 💎 elite — top LPers consistently profitable (avg ROI ≥20%, win ≥70%). STRONG confirmation, prefer over high-score-but-weak-LPer pools.
- ✓ good — credible LPers with positive track record (ROI ≥10%, win ≥60%). Solid confirmation.
- · neutral — credible LPers present but mixed results. Score-driven decision.
- ⚠️ weak — no credible LPers (all losing OR sample too small OR bot-dominated). Treat with caution even if score high.
- ? unavailable — API failed. Decide on other signals.
Tie-breaker: between 2 candidates with similar score, ALWAYS prefer higher LPer tier.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REPORT FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
On deploy:
🚀 <pool name> | score=<x> | <below>↓<above>↑ bins
Fee/TVL: <x>% | Vol: $<x> | Organic: <x>
<1 sentence why>

On no deploy:
⛔ <best name> (score=<x>) — <reason in a few words>
Skipped: <comma list>
`, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, config.llm.screeningMaxTokens ?? 4096, {
      onToolStart:  async ({ name })                 => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => {
        if (name === "deploy_position" && success && result?.success !== false) deploySucceeded = true;
        await liveMessage?.toolFinish(name, result, success);
      },
    });

    screenReport = content;

  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    // Refresh position count so management cron picks up newly deployed positions
    getMyPositions({ force: true }).then(r => {
      timers._lastKnownPositionCount = r?.positions?.length ?? 0;
      const vols = (r?.positions || []).map(p => getTrackedPosition(p.position)?.volatility ?? 0);
      timers._lastKnownMaxVolatility = vols.length > 0 ? Math.max(...vols) : 0;
    }).catch(() => {});
    if (!silent && telegramEnabled() && screenReport) {
      const screenFormatted = formatScreenTelegram(screenReport, deploySucceeded);
      if (liveMessage) {
        // Combine into single message — finalize live message with formatted report as footer
        await liveMessage.finalize(screenFormatted || "").catch(() => {});
      } else if (screenFormatted) {
        sendHTML(screenFormatted).catch((e) => log("telegram_warn", `Screening report send failed: ${e.message}`));
      }
    }
  }

  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  // Management cron — runs at clean intervals (:00, :05, :10, etc.)
  // Fast polling for TP/danger zones is handled by the PnL poller below
  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Lightweight 30s PnL poller — updates trailing TP state between management cycles, no LLM
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    if ((timers._lastKnownPositionCount ?? 0) === 0) return; // no positions → skip RPC
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      // Sync count from fetch result — handles case where LLM/manual close happened between cycles
      // without this, poller keeps firing every 30s until next management cycle resets count
      timers._lastKnownPositionCount = result?.positions?.length ?? 0;
      if (!result?.positions?.length) return;
      let hasTPPosition = false;
      let hasDangerPosition = false;
      const dangerThresholdPct = -(config.management.dangerZonePct ?? 2);
      for (const p of result.positions) {
        if (!p.pnl_pct_suspicious && queuePeakConfirmation(p.position, p.pnl_pct)) {
          schedulePeakConfirmation(p.position);
        }
        // Track if any position is in TP zone for faster polling
        if ((p.pnl_pct ?? 0) >= config.management.takeProfitFeePct) {
          hasTPPosition = true;
        }
        // Track if any position is in danger zone for faster polling
        if ((p.pnl_pct ?? 0) <= dangerThresholdPct) {
          hasDangerPosition = true;
        }
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        if (exit) {
          if (exit.action === "TRAILING_TP" && exit.needs_confirmation) {
            if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct)) {
              scheduleTrailingDropConfirmation(p.position);
            }
            continue;
          }
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          // Urgent exits (severe trailing fast-exit, max-duration cap) bypass management cooldown —
          // waiting up to 5min risks major slippage on dumping positions
          const isUrgent = exit.confirmed_recheck === true;
          if (isUrgent || sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason}${isUrgent ? " — URGENT, bypassing cooldown" : ""} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
      }
      // Fast polling — trigger management more frequently for TP/danger/volatile positions
      const fastCooldownMs = (config.management.tpCheckIntervalMin ?? 1) * 60 * 1000;
      const maxVol = timers._lastKnownMaxVolatility ?? 0;
      const volatileCooldownMs = 2 * 60 * 1000; // 2 min for volatile positions
      const needsFast = hasTPPosition || hasDangerPosition;
      const needsVolatileFast = maxVol >= 3;
      if ((needsFast || needsVolatileFast) && !_managementBusy) {
        const cooldown = needsFast ? fastCooldownMs : volatileCooldownMs;
        const sinceLastMgmt = Date.now() - (timers.managementLastRun ?? 0);
        if (sinceLastMgmt >= cooldown) {
          const zone = hasTPPosition ? "TP" : hasDangerPosition ? "DANGER" : "VOLATILE";
          log("state", `[PnL poll] ${zone} zone detected — triggering management (${Math.round(sinceLastMgmt / 1000)}s since last)`);
          runManagementCycle({ silent: false }).catch((e) => log("cron_error", `${zone}-triggered management failed: ${e.message}`));
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, 30_000);

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval ref so stopCronJobs can clear it
  _cronTasks._pnlPollInterval = pnlPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  const positions = await getMyPositions();
  log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface = null;

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;
  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
    } else {
      sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendMessage("No open positions."); return; }
      const cur = config.management.solMode ? "◎" : "$";
      const lines = positions.map((p, i) => {
        const pnl = p.pnl_usd >= 0 ? `+${cur}${p.pnl_usd}` : `-${cur}${Math.abs(p.pnl_usd)}`;
        const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
        const oor = !p.in_range ? " ⚠️OOR" : "";
        return `${i + 1}. ${p.pair} | ${cur}${p.total_value_usd} | PnL: ${pnl} | fees: ${cur}${p.unclaimed_fees_usd} | ${age}${oor}`;
      });
      await sendMessage(`📊 Open Positions (${total_positions}):\n\n${lines.join("\n")}\n\n/close <n> to close | /set <n> <note> to set instruction`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  // /close <n> [reason text...]  — reason optional, free-form
  // Examples:
  //   /close 1
  //   /close 1 trend looks weak
  //   /close 2 reason: capitulation reached
  //   /close 1 — exit on rsi flip
  const closeMatch = text.match(/^\/close\s+(\d+)(?:\s+(?:reason[:\s]*|—\s*|-\s*)?(.+))?$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const userReason = closeMatch[2]?.trim() || null;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      const reasonNote = userReason ? ` — "${userReason}"` : "";
      await sendMessage(`Closing ${pos.pair}${reasonNote}...`);
      const result = await closePosition({ position_address: pos.position, reason: userReason || "Manual close via Telegram /close" });
      if (result.success) {
        // Build close reason: prefer user-provided reason, otherwise fallback to default manual label
        const closeReason = userReason
          ? `Manual close: ${userReason}`
          : "Manual close via Telegram /close";
        // Use same notifyClose format as auto-exit (gas + net PnL displayed)
        await notifyClose({
          pair: result.pool_name || pos.pair || pos.position?.slice(0, 8),
          pnlUsd: result.pnl_usd ?? 0,
          pnlPct: result.pnl_pct ?? 0,
          feesUsd: result.fees_earned_usd ?? 0,
          amountSol: result.amount_sol ?? 0,
          strategy: result.strategy ?? "",
          holdMinutes: result.hold_minutes ?? 0,
          closeReason,
          rangeEfficiency: result.range_efficiency ?? null,
          gasSol: result.estimated_gas_sol ?? 0,
        }).catch(() => {});
      } else {
        await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  busy = true;
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      requireTool: true,
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  let startupCandidates = [];

  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    startupCandidates = candidates;

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    if (!isNaN(pick) && pick >= 1 && pick <= startupCandidates.length) {
      await runBusy(async () => {
        const pool = startupCandidates[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${DEPLOY} SOL. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        startupCandidates = candidates;
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlePct:         ${s.maxBundlePct}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { requireTool: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    // Startup uses the full screening cycle (with all guards: score, enrichment, anti force-deploy)
    try {
      log("startup", "Running startup screening cycle...");
      await runScreeningCycle({ silent: false });
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
