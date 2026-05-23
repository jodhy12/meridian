import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 3000,   // raised 2026-05-22 from 500 — winners median $14k volume, dead pools $5k; 3000 cuts 1-2 dead per 30 closes without losing winners
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
    minVolatility:      u.minVolatility      ?? 2,    // hard-skip pools with volatility below this (data: vol<2 avg -0.37% PnL)
    maxVolatility:      u.maxVolatility      ?? 5.0,  // raised 2026-05-22 from 3.5 — extended data: vol 3.5-4 zone +0.82% avg/19% WR; vol 4-5 with safety nets caps catastrophic losses to -7%
    minDeployScore:     u.minDeployScore     ?? 55,   // minimum screening score to allow deploy (safety check in executor)
    minSwapCount:       u.minSwapCount       ?? 20,   // hard-skip pools with fewer swaps in timeframe (dead pool pre-filter)
    minUniqueTraders:   u.minUniqueTraders   ?? 15,   // hard-skip pools with fewer unique traders (bot-only activity)
    solOnlyPairs:       u.solOnlyPairs       ?? true, // only consider pools with SOL as quote token
    // Quality post-filter (applied after API, before LLM sees candidates)
    qualityMinOrganic:  u.qualityMinOrganic  ?? 70,
    qualityMinHolders:  u.qualityMinHolders  ?? 500,
    qualityMinFeeRatio: u.qualityMinFeeRatio ?? 0.5,
    qualityTopN:        u.qualityTopN        ?? 5,

    // ─── Pump trap multi-TF threshold (2026-05-23, MOVED to screening section) ───
    pumpTrapMultiTfRatio:    u.pumpTrapMultiTfRatio    ?? 12,

    // ─── VWAP / RSI entry-zone thresholds (2026-05-23) ───
    vwapPumpMax:             u.vwapPumpMax             ?? 8,    // SKIP if price > X% above VWAP
    rsi2Overbought:          u.rsi2Overbought          ?? 70,   // SKIP if RSI2 > X (overbought zone)
    vwapFallingKnife:        u.vwapFallingKnife        ?? -25,  // SKIP if price < X% below VWAP (no support)

    // ─── Best Moment filter (2026-05-23) — Pattern A/B entry detection ───
    bestMomentEnabled:               u.bestMomentEnabled               ?? true,
    extremeOversoldRsiThreshold:     u.extremeOversoldRsiThreshold     ?? 15,
    extremeOversoldRequiresSpike:    u.extremeOversoldRequiresSpike    ?? true,
    extremeOversoldExemptAgeHours:   u.extremeOversoldExemptAgeHours   ?? 72,
    extremeOversoldExemptMcap:       u.extremeOversoldExemptMcap       ?? 1000000,

    // ─── ATH-proximity bin skew (2026-05-23) — flip asymmetric bins when entry near ATH ───
    // If price_vs_ath_pct > threshold (e.g. >-10 = within 10% of ATH), skew bins_below>above
    // Rationale: near ATH = limited upside, more dump risk → catch dip aggressively
    athProximityThresholdPct: u.athProximityThresholdPct ?? -10,
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -7,  // safety fallback — never leave a position unprotected
    takeProfitFeePct:      u.takeProfitFeePct      ?? 3,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 45, // minutes before low yield can trigger close (data: 87% positions $0 fees)
    maxILPct:              u.maxILPct              ?? -7,    // max IL% (position value drop excl. fees) before force close — safety fallback, never leave unprotected
    maxHoldNegativeMinutes: u.maxHoldNegativeMinutes ?? 90,  // force close negative PnL positions after this many minutes (default: 90)
    maxHoldFlatMinutes:    u.maxHoldFlatMinutes    ?? 120,  // force close if held > X min and peak < 1% (data: 74% positions flat, avg hold 77m)
    maxTrailingDurationMin: u.maxTrailingDurationMin ?? 180, // max minutes trailing TP can run (data: BURNIE 393m -7.73%, BabyTrump 346m -1.43%)
    tpCheckIntervalMin:    u.tpCheckIntervalMin    ?? 1,    // management cycle interval when position is in TP/danger zone (faster than normal)
    dangerZonePct:         u.dangerZonePct         ?? 2,    // trigger fast polling when PnL drops below -X%
    // Adaptive PnL poll interval (2026-05-23): fast when TP/danger active, normal otherwise
    pnlPollNormalSec:      u.pnlPollNormalSec      ?? 30,   // standard poll cadence (was 30s fixed before)
    pnlPollFastSec:        u.pnlPollFastSec        ?? 5,    // fast poll when TP/danger zone active — reduces SL/TP slippage
    tokenCooldownHours:    u.tokenCooldownHours    ?? 2,    // fallback if close-reason doesn't match any category
    cooldownCriticalHours: u.cooldownCriticalHours ?? 12,   // dead pool, repeated OOR — structural broken
    cooldownILHours:       u.cooldownILHours       ?? 1.5,  // IL stop / stop loss / Early IL — V-shape window
    cooldownDirectionHours:u.cooldownDirectionHours?? 0.5,  // pumped / OOR — price moved, fresh state
    cooldownYieldHours:    u.cooldownYieldHours    ?? 3,    // low yield / stale flat — quiet pool
    cooldownFlatHours:     u.cooldownFlatHours     ?? 2,    // max hold negative / flat exit
    cooldownBypassEnabled: u.cooldownBypassEnabled ?? true, // allow bypass if pool currently scoring high in screening
    cooldownBypassMinScore:u.cooldownBypassMinScore?? 75,   // min cached score to bypass cooldown
    trailingFastExitMultiplier: u.trailingFastExitMultiplier ?? 1.3, // skip confirmation when drop >= X * trailingDropPct (lowered 2→1.3: Embrace-SOL 2026-05-21 lost -4% to slippage — drop 3.48% missed 5% fast threshold, sat 15s in confirmation while price cratered)
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 2.5,  // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 2.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // Early IL detection — catch fast dumps before IL stop triggers
    earlyILMaxAgeMin:      u.earlyILMaxAgeMin      ?? 20,   // only check within first X minutes
    earlyILRatePerMin:     u.earlyILRatePerMin     ?? 0.15, // close if IL rate >= X %/min (data: traps avg 0.15-0.27%/min)
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
    // Bins width control — narrow strategy is data-backed positive-net bucket
    binsBelow:             u.binsBelow             ?? 18,
    maxBinsBelow:          u.maxBinsBelow          ?? 25,
    maxBinsAbove:          u.maxBinsAbove          ?? 25,
    // Auto-evolve gate — false respects user-tuned config (avoids scarcity-relax overriding manual tuning)
    autoEvolveEnabled:     u.autoEvolveEnabled     ?? false,

    // ─── Pause-and-learn (auto-pause on rolling negative PnL) ───
    pauseLearnEnabled:     u.pauseLearnEnabled     ?? true,
    pauseLearnWindowDays:  u.pauseLearnWindowDays  ?? 5,
    pauseLearnMinSamples:  u.pauseLearnMinSamples  ?? 10,
    pauseLearnMinAvgPnlPct: u.pauseLearnMinAvgPnlPct ?? -0.5,  // trigger if rolling avg < this
    pauseLearnDurationHours: u.pauseLearnDurationHours ?? 24,

    // ─── Consecutive-loss cooldown ───
    consecutiveLossThreshold:    u.consecutiveLossThreshold    ?? 3,
    consecutiveLossWindowMin:    u.consecutiveLossWindowMin    ?? 60,
    consecutiveLossPctCutoff:    u.consecutiveLossPctCutoff    ?? -0.5,
    consecutiveLossCooldownMin:  u.consecutiveLossCooldownMin  ?? 30,

    // ─── Recovery guards (peak-aware exit skip) ───
    recoveryGracePeakPct:  u.recoveryGracePeakPct  ?? 0.5,
    maxHoldFlatPeakPct:    u.maxHoldFlatPeakPct    ?? 0.5,
    flatExitPeakSkipPct:   u.flatExitPeakSkipPct   ?? 0.5,
    flatExitMinAgeMin:     u.flatExitMinAgeMin     ?? 60,    // lowered 2026-05-22 from 120 — capital throughput +50% on dead deploys
    flatExitMaxFeeYieldPct: u.flatExitMaxFeeYieldPct ?? 0.3,
    flatExitPnlBandPct:    u.flatExitPnlBandPct    ?? 1.0,

    // ─── Rule 7b: Early-dead detection via fee-rate (2026-05-22) ───
    // Data-derived: winners avg fee rate ~0.00015 SOL/min at 30-60m, marginals ~0.00009/min, dead ~0.00005/min
    // Threshold catches dead/marginal patterns 30+ min earlier than rule 7 flat-fee check
    earlyDeadEnabled:        u.earlyDeadEnabled        ?? true,
    earlyDeadMinAge:         u.earlyDeadMinAge         ?? 25,    // start checking at age 25m
    earlyDeadMaxAge:         u.earlyDeadMaxAge         ?? 45,    // stop checking at 45m (rule 7 takes over)
    earlyDeadFeeRatePerMin:  u.earlyDeadFeeRatePerMin  ?? 0.00005, // SOL/min — below this = dead trajectory

    // ─── Rule 8 (max hold negative) refined thresholds ───
    maxHoldNegativePnlPct:      u.maxHoldNegativePnlPct      ?? -1.5,
    maxHoldNegativePeakSkipPct: u.maxHoldNegativePeakSkipPct ?? 0.5,

    // ─── Rule 8b (lost gains) ───
    lostGainsPeakMinPct:   u.lostGainsPeakMinPct   ?? 1.0,
    lostGainsMinAgeMin:    u.lostGainsMinAgeMin    ?? 30,

    // ─── Confidence sizing (currently disabled per user data analysis) ───
    sizingByScore:         u.sizingByScore         ?? false,
    scoreSizingTiers:      u.scoreSizingTiers      ?? null,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:  u.strategy  ?? "bid_ask",
    binsBelow: u.binsBelow ?? 18,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    screeningMaxTokens: u.screeningMaxTokens ?? 4096,  // verbose models (deepseek-v4-pro) need more headroom
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Darwinian Signal Weighting ───────
  // Read from nested u.darwin.* (current user-config format), fall back to flat u.darwin* (legacy), then defaults
  darwin: {
    enabled:        u.darwin?.enabled         ?? u.darwinEnabled     ?? true,
    windowDays:     u.darwin?.windowDays      ?? u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwin?.recalcEvery     ?? u.darwinRecalcEvery ?? 5,
    boostFactor:    u.darwin?.boostFactor     ?? u.darwinBoost       ?? 1.02,  // post-fix slow learning
    decayFactor:    u.darwin?.decayFactor     ?? u.darwinDecay       ?? 0.98,
    weightFloor:    u.darwin?.weightFloor     ?? u.darwinFloor       ?? 0.5,
    weightCeiling:  u.darwin?.weightCeiling   ?? u.darwinCeiling     ?? 1.8,
    minSamples:     u.darwin?.minSamples      ?? u.darwinMinSamples  ?? 10,
    liftDeadband:   u.darwin?.liftDeadband    ?? 0.05,                          // anti-noise
    winThresholdPct: u.darwin?.winThresholdPct ?? 0.5,                          // pnl_pct threshold to count as win
    dataCutoffISO:  u.darwin?.dataCutoffISO   ?? null,                          // hard cutoff to skip corrupt-signal records (e.g. pre-OHLCV-fix era)
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol, score = null) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  let dynamic    = deployable * pct;

  // Confidence-based sizing: scale by conviction score.
  // Data-driven: high-score pools historically outperform — bet bigger when edge is clearer.
  if (config.management.sizingByScore && score != null) {
    const tiers = config.management.scoreSizingTiers || [
      { minScore: 80, multiplier: 1.7 },
      { minScore: 65, multiplier: 1.4 },
      { minScore: 50, multiplier: 1.0 },
      { minScore: 35, multiplier: 0.6 },
    ];
    const tier = tiers.find((t) => score >= t.minScore);
    if (tier) dynamic *= tier.multiplier;
  }

  const result   = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return;
  try {
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    if (fresh.solOnlyPairs      !== undefined) s.solOnlyPairs      = fresh.solOnlyPairs;
    if (fresh.minVolatility     != null) s.minVolatility     = fresh.minVolatility;
    if (fresh.maxVolatility     != null) s.maxVolatility     = fresh.maxVolatility;
    if (fresh.minSwapCount     != null) s.minSwapCount     = fresh.minSwapCount;
    if (fresh.minUniqueTraders != null) s.minUniqueTraders = fresh.minUniqueTraders;
    // Best Moment filter keys
    if (fresh.bestMomentEnabled !== undefined) s.bestMomentEnabled = fresh.bestMomentEnabled;
    if (fresh.extremeOversoldRsiThreshold != null) s.extremeOversoldRsiThreshold = fresh.extremeOversoldRsiThreshold;
    if (fresh.extremeOversoldRequiresSpike !== undefined) s.extremeOversoldRequiresSpike = fresh.extremeOversoldRequiresSpike;
    if (fresh.extremeOversoldExemptAgeHours != null) s.extremeOversoldExemptAgeHours = fresh.extremeOversoldExemptAgeHours;
    if (fresh.extremeOversoldExemptMcap != null) s.extremeOversoldExemptMcap = fresh.extremeOversoldExemptMcap;
    if (fresh.pumpTrapMultiTfRatio != null) s.pumpTrapMultiTfRatio = fresh.pumpTrapMultiTfRatio;
    if (fresh.vwapPumpMax != null) s.vwapPumpMax = fresh.vwapPumpMax;
    if (fresh.rsi2Overbought != null) s.rsi2Overbought = fresh.rsi2Overbought;
    if (fresh.vwapFallingKnife != null) s.vwapFallingKnife = fresh.vwapFallingKnife;
    if (fresh.athProximityThresholdPct != null) s.athProximityThresholdPct = fresh.athProximityThresholdPct;
  } catch { /* ignore */ }
}
