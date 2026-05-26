import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons, getRecentLossCount, getRollingPnl } from "../lessons.js";
import { setPositionInstruction, getTrackedPositions, getTrackedPosition, getPauseRemainingMs, setPauseUntil } from "../state.js";
import { computeDeployAmount } from "../config.js";

import { getPoolMemory, addPoolNote, getCooldownByReason } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { getTechnicalSignals } from "./ohlcv.js";
import { getCachedPoolSignals } from "../screening-cache.js";
import { config, reloadScreeningThresholds } from "../config.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";
import { appendDecision } from "../decision-log.js";
import { trackILRecovery } from "../il-recovery-tracker.js";

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  get_technical_signals: getTechnicalSignals,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
        });
        child.unref();
        process.exit(0);
      }, 3000);
      return { success: true, updated: true, message: `Updated! Restarting in 3s...\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Reject empty changes immediately — saves a useless LLM tool call
    if (!changes || typeof changes !== "object" || Object.keys(changes).length === 0) {
      log("config", `update_config rejected: empty changes object — do not call this tool with no changes`);
      return {
        success: false,
        error: "Empty changes object. Do not call update_config without changes. If 0 candidates found, just report 'no deploy' and stop.",
      };
    }
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      maxBundlePct:     ["screening", "maxBundlePct"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      athFilterPct:     ["screening", "athFilterPct"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minSwapCount: ["screening", "minSwapCount"],
      minUniqueTraders: ["screening", "minUniqueTraders"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitFeePct: ["management", "takeProfitFeePct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule — locked, cannot be changed via update_config
      // managementIntervalMin: ["schedule", "managementIntervalMin"],
      // screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      // strategy
      binsBelow: ["strategy", "binsBelow"],
    };

    const applied = {};
    const unknown = [];
    const blocked = [];

    // LOCKED KEYS — LLM is not allowed to modify these (user-managed only)
    // Strategy must remain STABLE. LLM should pick from candidates, not change rules.
    const LOCKED_KEYS = new Set([
      // Risk / strategy core
      "stopLossPct", "takeProfitFeePct", "maxILPct",
      "maxHoldNegativeMinutes", "maxHoldFlatMinutes",
      "trailingTriggerPct", "trailingDropPct", "maxTrailingDurationMin",
      "minDeployScore", "timeframe",
      // Capital management
      "deployAmountSol", "maxPositions", "minSolToOpen",
      "gasReserve", "maxDeployAmount", "positionSizePct",
      // Screening filters (all user-tuned per market regime)
      "minFeeActiveTvlRatio", "minVolume", "minOrganic", "minQuoteOrganic",
      "minHolders", "minMcap", "maxMcap",
      "minTvl", "maxTvl",
      "minBinStep", "maxBinStep",
      "minVolatility", "maxVolatility",
      "minTokenFeesSol", "minTokenAgeHours", "maxTokenAgeHours",
      "minSwapCount", "minUniqueTraders",
      "maxBotHoldersPct", "maxTop10Pct", "maxBundlePct",
      "qualityMinOrganic", "qualityMinHolders", "qualityMinFeeRatio", "qualityTopN",
      "athFilterPct",
      // Operational thresholds
      "minClaimAmount", "minFeePerTvl24h",
      "outOfRangeWaitMinutes", "outOfRangeBinsToClose",
    ]);

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    const MODEL_KEYS = new Set(["managementModel", "screeningModel", "generalModel"]);
    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      // Block LLM from modifying user-managed strategy keys
      if (LOCKED_KEYS.has(match[0])) {
        log("config", `update_config BLOCKED: ${match[0]} is user-locked (cannot be modified by LLM)`);
        blocked.push(match[0]);
        continue;
      }
      // Validate model IDs — must contain "/" (e.g. "minimax/minimax-m2.5")
      if (MODEL_KEYS.has(match[0]) && (typeof val !== "string" || !val.includes("/"))) {
        log("config", `update_config rejected: "${val}" is not a valid model ID for ${match[0]} (must contain "/")`);
        unknown.push(key);
        continue;
      }
      applied[match[0]] = val;
    }

    if (Object.keys(applied).length === 0) {
      const reasonMsg = blocked.length
        ? `Cannot modify locked keys: ${blocked.join(", ")} (user-managed only)`
        : "Unknown config keys";
      log("config", `update_config failed — ${reasonMsg}. blocked: ${JSON.stringify(blocked)}, unknown: ${JSON.stringify(unknown)}`);
      return { success: false, unknown, blocked, reason: reasonMsg };
    }

    // Apply to live config immediately
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }

    // Persist to user-config.json
    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /**/ }
    }
    Object.assign(userConfig, applied);
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Save as a lesson — but skip ephemeral per-deploy interval changes
    // (managementIntervalMin / screeningIntervalMin change every deploy based on volatility;
    //  the rule is already in the system prompt, storing it 75+ times is pure noise)
    const lessonsKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Pre-execute enrichment ────────────────
  // Build signal_snapshot from screening cache (primary) + LLM args (fallback) + fresh tech fetch
  if (name === "deploy_position" && args.pool_address) {
    // 1. Start from screening cache (has all signals, no LLM dependency)
    const cached = getCachedPoolSignals(args.pool_address) || {};
    const snap = { ...cached };

    // 2. Fill gaps from LLM args (fallback for manual deploys or cache miss)
    const fallbacks = {
      organic_score: args.organic_score, fee_tvl_ratio: args.fee_tvl_ratio,
      volatility: args.volatility, bin_step: args.bin_step, bins_below: args.bins_below,
      volume: args.volume, mcap: args.mcap, tvl: args.tvl, holder_count: args.holder_count,
      token_age_hours: args.token_age_hours, price_vs_ath_pct: args.price_vs_ath_pct,
      top10_holders_pct: args.top10_holders_pct, bot_holders_pct: args.bot_holders_pct,
      bundle_pct: args.bundle_pct,
    };
    for (const [k, v] of Object.entries(fallbacks)) {
      if (snap[k] == null && v != null) snap[k] = Number(v);
    }
    if (snap.smart_wallets_present == null && args.smart_wallets_present != null) {
      snap.smart_wallets_present = Boolean(args.smart_wallets_present);
    }

    // 3. Fetch fresh technical signals if not in cache
    if (snap.rsi2 == null) {
      try {
        const tech = await getTechnicalSignals({ pool_address: args.pool_address, timeframe: "15m" });
        if (tech && !tech.error) {
          snap.rsi2 = tech.indicators?.rsi2 ?? null;
          snap.supertrend_bullish = tech.indicators?.supertrend?.is_bullish ?? null;
          snap.vwap_dist_pct = tech.indicators?.vwap?.distance_pct ?? null;
          snap.volume_spike = tech.indicators?.volume_spike?.is_spike ?? false;
        }
      } catch { /* best effort */ }
    }

    args.signal_snapshot = snap;

    // 3b. Backfill top-level args from snap so trackPosition gets full data
    //     (state.json stores volatility for OOR vol-scaling, fee_tvl/organic for lessons)
    if (args.volatility == null && snap.volatility != null) args.volatility = snap.volatility;
    if (args.fee_tvl_ratio == null && snap.fee_tvl_ratio != null) args.fee_tvl_ratio = snap.fee_tvl_ratio;
    if (args.organic_score == null && snap.organic_score != null) args.organic_score = snap.organic_score;
    if (args.bin_step == null && snap.bin_step != null) args.bin_step = snap.bin_step;

    // 4. Auto-fill critical deploy params if LLM didn't provide them
    //    This prevents failed deploys from unreliable models (minimax, etc.)
    if (!args.amount_y && !args.amount_sol) {
      const bal = await getWalletBalances().catch(() => null);
      const walletSol = bal?.sol ?? 0;
      // Pass pool score for confidence-based sizing (P1)
      const poolScore = snap?.score ?? args.signal_snapshot?.score ?? null;
      args.amount_y = computeDeployAmount(walletSol, poolScore);
      log("executor", `Auto-filled amount_y=${args.amount_y} SOL (wallet: ${walletSol}, score: ${poolScore ?? "n/a"})`);
    }
    // Normalize: ensure amount_y is set (some LLMs send amount_sol instead)
    if (!args.amount_y && args.amount_sol) {
      args.amount_y = args.amount_sol;
    }

    // Force bid_ask — user-locked strategy for dip-then-recover thesis on meme pairs
    if (args.strategy !== "bid_ask") {
      log("executor", `Overriding strategy "${args.strategy ?? "?"}" → "bid_ask" (user-locked)`);
      args.strategy = "bid_ask";
    }

    if (!args.bins_below || args.bins_below <= 0) {
      const vol = snap.volatility ?? args.volatility ?? 3;
      // bid_ask thesis: SOL piled in corner waits for dip → swap to token cheap → recover
      // Needs room for dip to play out. Vol-scaled: low vol → 15, high vol → 22.
      args.bins_below = Math.round(Math.min(Math.max(15 + (vol / 5) * 7, 15), 22));
      log("executor", `Auto-filled bins_below=${args.bins_below} (volatility: ${vol}, bid_ask thesis)`);
    } else if (args.bins_below > (config.management.maxBinsBelow ?? 25)) {
      const capped = config.management.maxBinsBelow ?? 25;
      log("executor", `Clamped LLM bins_below ${args.bins_below} → ${capped}`);
      args.bins_below = capped;
    }
    if (!args.bins_above || args.bins_above <= 0) {
      // Mirror bins_below — symmetric narrow gives room for price to recover after dip
      // Previously asymmetric (×0.2 floor 6) → caused chronic OOR-up exits on meme pumps
      args.bins_above = args.bins_below;
      log("executor", `Auto-filled bins_above=${args.bins_above} (mirror bins_below)`);
    } else {
      const maxAbove = config.management.maxBinsAbove ?? 15;
      if (args.bins_above > maxAbove) {
        log("executor", `Clamped LLM bins_above ${args.bins_above} → ${maxAbove}`);
        args.bins_above = maxAbove;
      }
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, binStep: result.bin_step, baseFee: result.base_fee, score: args.signal_snapshot?.score ?? null, strategy: args.strategy ?? null, binsBelow: args.bins_below ?? null, binsAbove: args.bins_above ?? null }).catch(() => {});
        appendDecision({
          type: "deploy",
          actor: "SCREENER",
          pool: args.pool_address,
          pool_name: result.pool_name || args.pool_name,
          position: result.position,
          summary: `Deployed ${args.amount_y ?? args.amount_sol ?? 0} SOL into ${result.pool_name || args.pool_address?.slice(0, 8)}`,
          reason: args.reason || args.rationale || null,
          metrics: {
            score: args.signal_snapshot?.score ?? null,
            fee_tvl_ratio: args.signal_snapshot?.fee_tvl_ratio ?? null,
            volatility: args.signal_snapshot?.volatility ?? null,
            organic_score: args.signal_snapshot?.organic_score ?? null,
            bin_step: result.bin_step ?? args.bin_step ?? null,
          },
        });
      } else if (name === "close_position") {
        // force=true so notification fires even during management cycle (live message active)
        // Otherwise Wallet Δ + Slip data invisible for rule-based closes
        notifyClose({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlPct: result.pnl_pct ?? 0, feesUsd: result.fees_earned_usd ?? 0, amountSol: result.amount_sol ?? 0, strategy: result.strategy ?? "", holdMinutes: result.hold_minutes ?? 0, closeReason: args.reason ?? "", rangeEfficiency: result.range_efficiency ?? null, gasSol: result.estimated_gas_sol ?? 0, realizedPnlSol: result.realized_pnl_sol ?? null, execSlipPct: result.execution_slippage_pct ?? null, force: true }).catch(() => {});
        appendDecision({
          type: "close",
          actor: "MANAGER",
          pool: result.pool || args.pool_address,
          pool_name: result.pool_name || args.position_address?.slice(0, 8),
          position: args.position_address,
          summary: `Closed ${result.pool_name || args.position_address?.slice(0, 8)} | PnL ${result.pnl_pct >= 0 ? "+" : ""}${(result.pnl_pct ?? 0).toFixed(2)}%`,
          reason: args.reason || null,
          metrics: {
            pnl_pct: result.pnl_pct ?? null,
            pnl_usd: result.pnl_usd ?? null,
            fees_earned_usd: result.fees_earned_usd ?? null,
            hold_minutes: result.hold_minutes ?? null,
            range_efficiency: result.range_efficiency ?? null,
          },
        });
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Track post-close price recovery for IL/stop-loss exits (data collection for Use Case B)
        if (args.reason && /IL stop|Stop loss|stop loss|Early IL/i.test(args.reason)) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) {
            trackILRecovery({
              pool: poolAddr,
              poolName: result.pool_name || args.position_address?.slice(0, 8) || "?",
              closeReason: args.reason,
              exitPnlPct: result.pnl_pct ?? null,
              closedAt: new Date().toISOString(),
            });
          }
        }
        // NOTE: auto-swap of base token → SOL is now performed inside closePosition()
        // (dlmm.js) BEFORE walletSolAfter capture, so realized_pnl_sol / slippage
        // numbers correctly include the swap output. result.auto_swapped is set by
        // dlmm.js when the swap fires; do NOT swap here again.
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        try {
          const balances = await getWalletBalances({});
          const token = balances.tokens?.find(t => t.mint === result.base_mint);
          if (token && token.usd >= 0.10) {
            log("executor", `Auto-swapping claimed ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
            await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
          }
        } catch (e) {
          log("executor_warn", `Auto-swap after claim failed: ${e.message}`);
        }
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      // Pause-and-learn mode: if rolling PnL negative over window, pause deploys for cooldown
      // Prevents bleeding capital during adverse market regimes.
      // Re-evaluates condition on EACH check — auto-clears stale pauses if condition resolves.
      if (config.management.pauseLearnEnabled !== false) {
        const winDays = config.management.pauseLearnWindowDays ?? 5;
        const minSamples = config.management.pauseLearnMinSamples ?? 10;
        const minAvgPnl = config.management.pauseLearnMinAvgPnlPct ?? 0.0;
        const durationHrs = config.management.pauseLearnDurationHours ?? 24;
        const rolling = getRollingPnl({ windowDays: winDays, minSamples });

        // Check existing pause — but RE-EVALUATE current rolling against current threshold
        // If condition no longer met, auto-clear (stale pauses from old config don't lock bot)
        const pauseMs = getPauseRemainingMs();
        if (pauseMs > 0) {
          if (rolling && rolling.avgPnlPct >= minAvgPnl) {
            // Condition resolved — clear stale pause early
            const { clearPause } = await import("../state.js");
            clearPause();
            log("executor", `Pause auto-cleared: rolling avgPnL ${rolling.avgPnlPct.toFixed(3)}% >= ${minAvgPnl}% threshold (was paused under stale config)`);
          } else {
            const remainingHr = Math.ceil(pauseMs / 3600000);
            return {
              pass: false,
              reason: `Pause-and-learn active: bot paused ${remainingHr}h more (rolling PnL ${rolling?.avgPnlPct?.toFixed(2) ?? "?"}% < ${minAvgPnl}% threshold). Resume manual or wait timer.`,
            };
          }
        }

        // Trigger new pause if condition met
        if (rolling && rolling.avgPnlPct < minAvgPnl) {
          const until = new Date(Date.now() + durationHrs * 3600000).toISOString();
          const reason = `Rolling ${winDays}d PnL ${rolling.avgPnlPct.toFixed(2)}% < ${minAvgPnl}% threshold over ${rolling.sampleSize} closes (net ◎${rolling.totalPnlSol.toFixed(4)})`;
          setPauseUntil(until, reason);
          return {
            pass: false,
            reason: `Pause-and-learn activated: ${reason}. Bot paused ${durationHrs}h to avoid bleed. Review strategy.`,
          };
        }
      }

      // Consecutive-loss cooldown (P5): pause deploys after multiple losses in short window
      // Likely macro regime change (SOL dump → all memecoins dump) — wait for market to settle
      const lossThreshold = config.management.consecutiveLossThreshold ?? 3;
      const lossWindowMin = config.management.consecutiveLossWindowMin ?? 60;
      const lossPctCutoff = config.management.consecutiveLossPctCutoff ?? -0.5;
      if (lossThreshold > 0) {
        const lossInfo = getRecentLossCount({
          windowMs: lossWindowMin * 60000,
          lossThresholdPct: lossPctCutoff,
        });
        if (lossInfo.losses >= lossThreshold) {
          const cooldownMin = config.management.consecutiveLossCooldownMin ?? 30;
          const lastLossMs = lossInfo.lastLossAt ? Date.parse(lossInfo.lastLossAt) : 0;
          const cooldownEndsMs = lastLossMs + cooldownMin * 60000;
          if (Date.now() < cooldownEndsMs) {
            const remainingMin = Math.ceil((cooldownEndsMs - Date.now()) / 60000);
            return {
              pass: false,
              reason: `Consecutive loss cooldown: ${lossInfo.losses} losses in ${lossWindowMin}m — pausing ${remainingMin}m more. Market regime may be dumping; let it settle.`,
            };
          }
        }
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Token cooldown: block re-deploy into same token after a loss.
      // Uses per-reason cooldown durations (1.5h IL, 0.5h direction, 3h yield, 12h critical, etc).
      // Bypass: if pool currently scoring ≥ cooldownBypassMinScore in screening cache, allow re-entry.
      if (args.pool_name || args.base_mint) {
        const allPositions = getTrackedPositions();
        let blockingClose = null;
        let blockingCooldownHours = 0;
        for (const p of allPositions) {
          if (!p.closed || !p.closed_at) continue;
          const nameMatch = args.pool_name && p.pool_name &&
            p.pool_name.replace(/-SOL$/, "").toLowerCase() === args.pool_name.replace(/-SOL$/, "").toLowerCase();
          const mintMatch = args.base_mint && p.base_mint && p.base_mint === args.base_mint;
          if (!nameMatch && !mintMatch) continue;
          // Get this close's specific cooldown duration based on its reason
          const lastNote = p.notes?.[p.notes.length - 1] || "";
          const peakLow = (p.peak_pnl_pct ?? 0) < 1;
          // Only treat as loss if note matches loss patterns OR peak was very low
          const wasLoss = /il stop|stop loss|stale|low yield|dead pool|no fees|early il|max hold|oor|flat exit|out of range/i.test(lastNote);
          if (!wasLoss && !peakLow) continue;
          const reasonCooldownHours = getCooldownByReason(lastNote);
          const cooldownMs = reasonCooldownHours * 60 * 60 * 1000;
          const closedAgo = Date.now() - new Date(p.closed_at).getTime();
          if (closedAgo > cooldownMs) continue;
          // Within cooldown window — this is a blocking close
          if (!blockingClose || closedAgo < (Date.now() - new Date(blockingClose.closed_at).getTime())) {
            blockingClose = p;
            blockingCooldownHours = reasonCooldownHours;
          }
        }
        if (blockingClose) {
          // Check bypass: pool re-screened with strong score = V-shape opportunity, allow re-entry
          const bypassEnabled = config.management.cooldownBypassEnabled ?? true;
          const bypassMinScore = config.management.cooldownBypassMinScore ?? 75;
          const cachedSignals = getCachedPoolSignals(args.pool_address);
          const currentScore = cachedSignals?.score ?? args.signal_snapshot?.score ?? 0;
          if (bypassEnabled && currentScore >= bypassMinScore) {
            log("executor", `Cooldown bypassed for ${args.pool_name || args.pool_address?.slice(0, 8)} — current score ${currentScore} ≥ ${bypassMinScore} (was: ${blockingClose.pool_name} cooldown ${blockingCooldownHours}h)`);
          } else {
            const hoursAgo = Math.round((Date.now() - new Date(blockingClose.closed_at).getTime()) / 360000) / 10;
            return {
              pass: false,
              reason: `Token cooldown: ${blockingClose.pool_name} closed ${hoursAgo}h ago. Wait ${blockingCooldownHours}h (close reason: ${(blockingClose.notes?.[blockingClose.notes.length - 1] || "").slice(0, 50)}). Bypass needs score ≥ ${bypassMinScore}, current ${currentScore}.`,
            };
          }
        }
      }

      // Minimum score guard: prevent LLM from deploying low-conviction candidates
      // Data: 10 deploys with score=null bypassed this check — now blocks null scores too
      const cachedSignalsForScore = getCachedPoolSignals(args.pool_address);
      const cachedScore = cachedSignalsForScore?.score;
      const minDeployScore = config.screening.minDeployScore ?? 55;
      if (cachedScore == null) {
        // Block deploy without score — prevents startup bypass and unscored pools
        return {
          pass: false,
          reason: `No screening score for this pool (cache ${cachedSignalsForScore != null ? "exists but score null" : "empty"}). Cannot deploy without conviction score ≥ ${minDeployScore}. Run screening first.`,
        };
      } else if (cachedScore < minDeployScore) {
        return {
          pass: false,
          reason: `Pool score ${cachedScore} is below minimum deploy threshold (${minDeployScore}). Need stronger conviction.`,
        };
      }

      // Dead pool guard: check recent swap activity from screening cache
      // Data: pools with <30 swaps or <15 traders in timeframe consistently produce zero fees
      const cachedSignals = getCachedPoolSignals(args.pool_address);
      if (cachedSignals) {
        const swaps = Number(cachedSignals.swap_count ?? 0);
        const traders = Number(cachedSignals.unique_traders ?? 0);
        const minSwaps = config.screening.minSwapCount ?? 30;
        const minTraders = config.screening.minUniqueTraders ?? 15;
        if (swaps < minSwaps || traders < minTraders) {
          return {
            pass: false,
            reason: `Pool has low activity (${swaps} swaps, ${traders} traders) — likely dead pool. Need ≥${minSwaps} swaps and ≥${minTraders} traders.`,
          };
        }
      }

      // Rug protection: block deploy when critical data is missing
      // MOGMAN-SOL: holder_count=null, rsi2=null, supertrend=null → rugged -83% in 5 min
      if (cachedSignals) {
        if (cachedSignals.holder_count == null && cachedSignals.bot_holders_pct == null) {
          return {
            pass: false,
            reason: `Missing holder data (holder_count and bot_holders_pct both null). Cannot assess rug risk — skipping.`,
          };
        }
      }

      // Check amount limits
      const amountY = args.amount_y ?? args.amount_sol ?? 0;
      if (amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = Math.max(0.1, config.management.deployAmountSol);
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      // Weighted bid-ask safety: auto-correct bins_above if too one-sided.
      // Minimum bins_above = 20% of bins_below to ensure upside buffer against OOR.
      const binsBelow = args.bins_below ?? 0;
      const binsAbove = args.bins_above ?? 0;
      const minAbove = Math.max(5, Math.round(binsBelow * 0.2));
      if (binsBelow >= 20 && binsAbove < minAbove) {
        log("executor", `bins_above=${binsAbove} too one-sided — auto-correcting to ${minAbove} (20% of bins_below=${binsBelow})`);
        args.bins_above = minAbove;
      }

      return { pass: true };
    }

    case "close_position": {
      // Gas break-even guard: prevent closing positions where PnL is positive
      // but too small to cover actual tx fees (~0.002 SOL per cycle, verified on-chain).
      // Rent deposit (0.06-0.10 SOL) is refundable — not a real cost.
      // Only applies to discretionary closes — rule-based exits always allowed through.
      const reason = (args.reason || "").toLowerCase();
      const isRuleBased = /stop.?loss|oor|out.?of.?range|trailing|il.?stop|early.?il|instruction|stale|dead|technical|exit_signal/i.test(reason);

      // Smart dump check — for trail-fast / IL-stop / early-IL / stop-loss exits, do quick tech read
      // If recovery signals strong (RSI climbing + volume spike), DEFER close one cycle
      // for potential V-shape bounce. Limited to 1 defer per position to prevent infinite hold.
      // Added 2026-05-24 from Poor-SOL disaster analysis (-10% wallet vs -1.12% reported)
      const isUrgentExit = /trailing tp \(fast\)|il stop|early il|stop loss/i.test(reason);
      const dumpCheckEnabled = config.management.smartDumpCheckEnabled !== false;
      if (isUrgentExit && dumpCheckEnabled && args.position_address) {
        try {
          const tracked = getTrackedPosition(args.position_address);
          const deferKey = `_dumpDefer_${args.position_address}`;
          const alreadyDeferred = tracked?.[deferKey] === true;
          if (tracked?.pool_address && !alreadyDeferred) {
            // Race tech fetch against 2s timeout — don't risk waiting too long during dump
            const tech = await Promise.race([
              getTechnicalSignals({ pool_address: tracked.pool_address, timeframe: "15m" }),
              new Promise((_, rej) => setTimeout(() => rej(new Error("tech-timeout")), 2500)),
            ]).catch(() => null);
            if (tech && !tech.error) {
              const rsi = tech?.indicators?.rsi2 ?? null;
              const rsiTrend = tech?.indicators?.rsi2_trend ?? null;
              const volSpike = tech?.indicators?.volume_spike?.is_spike ?? false;
              // Recovery signals: RSI bouncing back OR volume spike on recovery (buyer step-in)
              const recoveryDetected =
                (rsiTrend != null && rsiTrend >= 5) ||
                (volSpike && rsi != null && rsi >= 15 && rsiTrend != null && rsiTrend > 0);
              if (recoveryDetected) {
                // Mark deferred so next trigger fires close (no infinite defer)
                if (tracked) tracked[deferKey] = true;
                return {
                  pass: false,
                  reason: `Smart dump defer: recovery signal detected (RSI=${rsi?.toFixed(1)}, Δ${rsiTrend?.toFixed(1)}, spike=${volSpike}). One-cycle defer for V-shape bounce. Next trigger will fire close.`,
                };
              }
            }
          }
        } catch { /* best-effort — don't block urgent close on tech fetch error */ }
      }

      if (!isRuleBased && args.position_address) {
        try {
          const tracked = getTrackedPosition(args.position_address);
          if (tracked?.pool_address) {
            const pnl = await getPositionPnl({
              pool_address: tracked.pool_address,
              position_address: args.position_address,
            });
            if (pnl && !pnl.error) {
              // Use estimated_close_gas_pct from PnL (computed per autoSwap setting)
              // Fallback to legacy hardcoded if not available.
              const gasCostPct = pnl.estimated_close_gas_pct ?? (() => {
                const deployAmt = config.management.deployAmountSol ?? 0.5;
                return (0.002 / deployAmt) * 100;
              })();
              if (pnl.pnl_pct > 0 && pnl.pnl_pct < gasCostPct) {
                const deployAmt = config.management.deployAmountSol ?? 0.5;
                return {
                  pass: false,
                  reason: `Gas break-even guard: PnL +${pnl.pnl_pct}% is below gas cost (~${gasCostPct.toFixed(1)}% on ${deployAmt} SOL deploy). Not worth closing — let it run toward TP.`,
                };
              }
            }
          }
        } catch { /* best effort — don't block close on fetch error */ }
      }
      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
