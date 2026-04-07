import "dotenv/config";
import cron from "node-cron";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, closePosition, deployPosition } from "./tools/dlmm.js";
import { getTechnicalSignals } from "./tools/ohlcv.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary } from "./lessons.js";
import { registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, sendHTML, notifyOutOfRange, isEnabled as telegramEnabled, createLiveMessage } from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, setPositionInstruction, updatePnlAndCheckExits, queuePeakConfirmation, resolvePendingPeak, queueTrailingDropConfirmation, resolvePendingTrailingDrop } from "./state.js";
import { recordPositionSnapshot, recallForPool, addPoolNote } from "./pool-memory.js";
import { getTokenInfo } from "./tools/token.js";

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);

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
const TRAILING_DROP_CONFIRM_DELAY_MS = 15_000;
const TRAILING_DROP_CONFIRM_TOLERANCE_PCT = 1.0;

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
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
    if (telegramEnabled()) {
      await sendHTML(briefing);
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
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "No open positions. Triggering screening cycle.";
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      return mgmtReport;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
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
    const actionMap = new Map();
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

      // Rule 1: stop loss
      if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct <= config.management.stopLossPct) {
        actionMap.set(p.position, { action: "CLOSE", rule: 1, reason: "stop loss" });
        continue;
      }
      // Rule 2: take profit
      if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct >= config.management.takeProfitFeePct) {
        actionMap.set(p.position, { action: "CLOSE", rule: 2, reason: "take profit" });
        continue;
      }
      // Rule 3: pumped far above range
      if (p.active_bin != null && p.upper_bin != null &&
          p.active_bin > p.upper_bin + config.management.outOfRangeBinsToClose) {
        actionMap.set(p.position, { action: "CLOSE", rule: 3, reason: "pumped far above range" });
        continue;
      }
      // Rule 4: stale above range
      if (p.active_bin != null && p.upper_bin != null &&
          p.active_bin > p.upper_bin &&
          (p.minutes_out_of_range ?? 0) >= config.management.outOfRangeWaitMinutes) {
        actionMap.set(p.position, { action: "CLOSE", rule: 4, reason: "OOR" });
        continue;
      }
      // Rule 5: fee yield too low
      if (p.fee_per_tvl_24h != null &&
          p.fee_per_tvl_24h < config.management.minFeePerTvl24h &&
          (p.age_minutes ?? 0) >= 60) {
        actionMap.set(p.position, { action: "CLOSE", rule: 5, reason: "low yield" });
        continue;
      }
      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
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

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      log("cron", `Management: ${actionPositions.length} action(s) needed — invoking LLM [model: ${config.llm.managementModel}]`);

      const actionBlocks = actionPositions.map((p) => {
        const act = actionMap.get(p.position);
        return [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  action: ${act.action}${act.rule && act.rule !== "exit" ? ` — Rule ${act.rule}: ${act.reason}` : ""}${act.rule === "exit" ? ` — ⚡ Trailing TP: ${act.reason}` : ""}`,
          `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
          `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
        ].filter(Boolean).join("\n");
      }).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT ACTION REQUIRED — ${actionPositions.length} position(s)

${actionBlocks}

RULES:
- CLOSE: call close_position only — it handles fee claiming internally, do NOT call claim_fees first
- CLAIM: call claim_fees with position address
- INSTRUCTION: evaluate the instruction condition. If met → close_position. If not → HOLD, do nothing.
- ⚡ exit alerts: close immediately, no exceptions

Execute the required actions. Do NOT re-evaluate CLOSE/CLAIM — rules already applied. Just execute.
After executing, write a brief one-line result per position.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });

      mgmtReport += `\n\n${content}`;
    } else {
      log("cron", "Management: all positions STAY — skipping LLM");
      await liveMessage?.note("No tool actions needed.");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
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
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        else sendMessage(`🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch(() => { });
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
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      _screeningBusy = false;
      return screenReport;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun = process.env.DRY_RUN === "true";
    if (!isDryRun && preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      _screeningBusy = false;
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    _screeningBusy = false;
    return screenReport;
  }
  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [AUTO-DEPLOY mode]`);
  try {
    const currentBalance = preBalance;
    const deployAmount = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // ── Step 1: Get scored candidates ───────────────────────────
    const topCandidates = await getTopCandidates({ limit: 10 }).catch(() => null);
    const candidates = (topCandidates?.candidates || []).slice(0, 10);

    if (candidates.length === 0) {
      screenReport = `⛔ NO DEPLOY\n\nNo candidates found after filtering.`;
      return screenReport;
    }

    // ── Step 2: Token recon + launchpad/bot filter ──────────────
    const recon = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [tiResult] = await Promise.allSettled([
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
      ]);
      const ti = tiResult.status === "fulfilled" ? tiResult.value?.results?.[0] : null;

      // Hard filters
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.blockedLaunchpads?.includes(launchpad)) {
        log("screening", `Auto-deploy filter: ${pool.name} — blocked launchpad (${launchpad})`);
        continue;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Auto-deploy filter: ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        continue;
      }

      recon.push({ pool, ti });
      await new Promise(r => setTimeout(r, 100));
    }

    if (recon.length === 0) {
      screenReport = `⛔ NO DEPLOY\n\nAll candidates filtered by launchpad/bot rules.`;
      return screenReport;
    }

    // ── Step 3: Walk candidates by score (highest first) ────────
    const MIN_SCORE = config.screening.autoDeployMinScore ?? 40;
    let deployed = false;

    for (const { pool, ti } of recon) {
      if (pool.score < MIN_SCORE) {
        log("screening", `Auto-deploy skip: ${pool.name} — score ${pool.score} < ${MIN_SCORE}`);
        break; // sorted by score desc, so no need to check further
      }

      // ── Step 3a: Technical entry check ──────────────────────
      let techSignals = null;
      try {
        techSignals = await getTechnicalSignals({ pool_address: pool.pool, timeframe: "15m" });
      } catch (e) {
        log("screening", `Tech signals failed for ${pool.name}: ${e.message} — skipping`);
        continue;
      }

      if (techSignals?.error) {
        log("screening", `Tech signals error for ${pool.name}: ${techSignals.error} — proceeding without`);
        techSignals = null;
      }

      if (techSignals?.entry_warnings?.length > 0) {
        log("screening", `Auto-deploy skip: ${pool.name} — entry warnings: ${techSignals.entry_warnings.join(", ")}`);
        continue;
      }

      // ── Step 3b: Compute bins (centered 50/50) ──────────────
      const vol = Number(pool.volatility || 3);
      const totalBins = Math.min(90, Math.max(35, Math.round(35 + (vol / 5) * 55)));
      const suggestedBins = techSignals?.suggested_bins_below;
      const binsBelow = suggestedBins || Math.round(totalBins * 0.5);
      const binsAbove = suggestedBins || Math.round(totalBins * 0.5);

      // ── Step 3c: Deploy ──────────────────────────────────────
      log("screening", `Auto-deploy: ${pool.name} | score=${pool.score} | bins=${binsBelow}/${binsAbove} | ${deployAmount} SOL`);

      try {
        const result = await deployPosition({
          pool_address: pool.pool,
          amount_y: deployAmount,
          strategy: "bid_ask",
          bins_below: binsBelow,
          bins_above: binsAbove,
          pool_name: pool.name,
          bin_step: pool.bin_step,
          volatility: vol,
          fee_tvl_ratio: pool.fee_active_tvl_ratio,
          organic_score: pool.organic_score,
        });

        if (result?.error || result?.blocked) {
          log("screening", `Auto-deploy failed for ${pool.name}: ${result.error || result.reason}`);
          continue; // try next candidate
        }

        const top10Pct = ti?.audit?.top_holders_pct ?? "?";
        const botPctDisplay = ti?.audit?.bot_holders_pct ?? "?";
        const feesSol = ti?.global_fees_sol ?? "?";

        screenReport = `🚀 DEPLOYED (auto)\n\n${pool.name}\n${pool.pool}\n\n◎ ${deployAmount} SOL | bid_ask | score=${pool.score}\nRange: bins ${binsBelow}↓ ${binsAbove}↑\n\nMARKET\nFee/TVL: ${pool.fee_active_tvl_ratio}%\nVolume: $${pool.volume_window}\nTVL: $${pool.active_tvl}\nVolatility: ${vol}\nOrganic: ${pool.organic_score}\nMcap: $${pool.mcap}\nAge: ${pool.token_age_hours ?? "?"}h\n\nAUDIT\nTop10: ${top10Pct}%\nBots: ${botPctDisplay}%\nFees: ${feesSol} SOL\n\nSCORE BREAKDOWN\n${Object.entries(pool.score_breakdown || {}).map(([k, v]) => `${k}: ${v}`).join("\n")}`;
        deployed = true;
        break;
      } catch (e) {
        log("screening", `Auto-deploy exception for ${pool.name}: ${e.message}`);
        continue;
      }
    }

    if (!deployed) {
      const best = recon[0]?.pool;
      const reasons = recon.slice(0, 3).map(({ pool }) => {
        if (pool.score < MIN_SCORE) return `${pool.name}: score ${pool.score} < ${MIN_SCORE}`;
        return `${pool.name}: score=${pool.score}, tech/entry check failed`;
      }).join("\n");
      screenReport = `⛔ NO DEPLOY\n\nCycle finished with no valid entry.\n\nBEST CANDIDATE: ${best?.name ?? "none"} (score=${best?.score ?? 0})\n\nREJECTED:\n${reasons}`;
    }
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
        else sendMessage(`🔍 Screening Cycle\n\n${stripThink(screenReport)}`).catch(() => { });
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
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
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
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
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
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

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      const result = await closePosition({ position_address: pos.position });
      if (result.success) {
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const claimNote = result.claim_txs?.length ? `\nClaim txs: ${result.claim_txs.join(", ")}` : "";
        await sendMessage(`✅ Closed ${pos.pair}\nPnL: ${config.management.solMode ? "◎" : "$"}${result.pnl_usd ?? "?"} | close txs: ${closeTxs?.join(", ") || "n/a"}${claimNote}`);
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
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
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
    try {
      const startupStep3 = process.env.DRY_RUN === "true"
        ? `3. Ignore wallet SOL threshold in dry run: get_top_candidates then simulate deploy ${DEPLOY} SOL.`
        : `3. If SOL >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${DEPLOY} SOL.`;
      await agentLoop(`
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. ${startupStep3} 4. Report.
      `, config.llm.maxSteps, [], "SCREENER");
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
