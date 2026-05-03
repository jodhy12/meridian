// Backtest new scoring against historical performance data.
// Usage: node backtest-scoring.js
import fs from "fs";
import { scoreCandidate } from "./tools/screening.js";

const lessons = JSON.parse(fs.readFileSync("./lessons.json", "utf8"));
const performance = lessons.performance || [];

console.log(`\n=== BACKTEST: New scoring vs ${performance.length} historical positions ===\n`);

// Reconstruct pool objects from signal_snapshot for scoring
const results = [];
let skipped = 0;

for (const p of performance) {
  const snap = p.signal_snapshot;
  if (!snap) { skipped++; continue; }

  // Build pool object that matches what scoreCandidate expects
  const pool = {
    name: p.pool_name,
    pool: p.pool,
    fee_active_tvl_ratio: snap.fee_tvl_ratio,
    organic_score: snap.organic_score,
    volatility: snap.volatility,
    token_age_hours: snap.token_age_hours,
    price_change_pct: snap.price_change_pct ?? 0,
    top10_pct: snap.top10_holders_pct,
    bot_holders_pct: snap.bot_holders_pct,
    holder_count: snap.holder_count,
    volume_spike: snap.volume_spike,
    swap_count: snap.swap_count,
    unique_traders: snap.unique_traders,
    smart_wallets_present: snap.smart_wallets_present,
    bin_step: snap.bin_step,
  };

  const oldScore = snap.score; // score recorded at deploy time
  const { score: newScore, breakdown } = scoreCandidate(pool, !!snap.smart_wallets_present);

  results.push({
    name: p.pool_name,
    pnl_pct: p.pnl_pct,
    won: p.pnl_pct > 0,
    profitable: p.pnl_pct > 0.5, // >0.5% covers gas
    loser: p.pnl_pct < -2,
    catastrophic: p.pnl_pct < -10,
    oldScore,
    newScore,
    delta: newScore - (oldScore ?? 0),
    breakdown,
  });
}

console.log(`Analyzed: ${results.length} (skipped ${skipped} without signal_snapshot)\n`);

// === Distribution stats ===
const winners = results.filter(r => r.profitable);
const losers = results.filter(r => r.loser);
const catastrophes = results.filter(r => r.catastrophic);
const neutral = results.filter(r => !r.profitable && !r.loser);

const stats = (arr, key) => {
  if (!arr.length) return { n: 0 };
  const vals = arr.map(r => r[key]).filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const sum = vals.reduce((a, b) => a + b, 0);
  return {
    n: vals.length,
    mean: (sum / vals.length).toFixed(1),
    median: vals[Math.floor(vals.length / 2)]?.toFixed(1),
    p10: vals[Math.floor(vals.length * 0.1)]?.toFixed(1),
    p90: vals[Math.floor(vals.length * 0.9)]?.toFixed(1),
    min: vals[0]?.toFixed(1),
    max: vals[vals.length - 1]?.toFixed(1),
  };
};

console.log("=== Score Distribution ===\n");
console.log("Group           N    Mean Median  P10  P90  Min  Max  (NEW scoring)");
console.log("-".repeat(75));
const printStats = (label, arr) => {
  const s = stats(arr, "newScore");
  console.log(`${label.padEnd(15)} ${String(s.n).padStart(3)}  ${String(s.mean).padStart(5)} ${String(s.median).padStart(6)} ${String(s.p10).padStart(4)} ${String(s.p90).padStart(4)} ${String(s.min).padStart(4)} ${String(s.max).padStart(4)}`);
};
printStats("Profitable", winners);
printStats("Neutral", neutral);
printStats("Losers", losers);
printStats("Catastrophic", catastrophes);

console.log("\n=== Old vs New Scoring (same groups) ===\n");
console.log("Group           Old Mean  New Mean  Delta");
console.log("-".repeat(45));
const printDelta = (label, arr) => {
  const oldS = stats(arr, "oldScore");
  const newS = stats(arr, "newScore");
  const delta = (Number(newS.mean) - Number(oldS.mean)).toFixed(1);
  console.log(`${label.padEnd(15)} ${String(oldS.mean).padStart(8)} ${String(newS.mean).padStart(8)}  ${delta >= 0 ? "+" : ""}${delta}`);
};
printDelta("Profitable", winners);
printDelta("Neutral", neutral);
printDelta("Losers", losers);
printDelta("Catastrophic", catastrophes);

// === Threshold analysis ===
console.log("\n=== Threshold Analysis (NEW scoring) ===\n");
console.log("Threshold  Deploy%  WinRate%  AvgPnL%  Captured Winners%  Captured Losers%");
console.log("-".repeat(85));

const totalWinners = winners.length;
const totalLosers = losers.length;

for (let t = -10; t <= 80; t += 5) {
  const passed = results.filter(r => r.newScore >= t);
  if (passed.length === 0) continue;
  const passedWinners = passed.filter(r => r.profitable).length;
  const passedLosers = passed.filter(r => r.loser).length;
  const winRate = (passedWinners / passed.length * 100).toFixed(1);
  const avgPnl = (passed.reduce((a, b) => a + b.pnl_pct, 0) / passed.length).toFixed(2);
  const capturedWin = (passedWinners / totalWinners * 100).toFixed(0);
  const capturedLoss = (passedLosers / totalLosers * 100).toFixed(0);
  const deployPct = (passed.length / results.length * 100).toFixed(0);
  const marker = winRate >= 40 && passed.length >= 10 ? " ⭐" : "";
  console.log(`${String(t).padStart(5)}    ${String(deployPct).padStart(5)}%   ${String(winRate).padStart(5)}%   ${String(avgPnl).padStart(6)}     ${String(capturedWin).padStart(8)}%       ${String(capturedLoss).padStart(8)}%${marker}`);
}

// === Worst losers — did new scoring catch them? ===
console.log("\n=== Top 10 Catastrophic Losses ===\n");
console.log("Pool                  PnL%      OldScore  NewScore  Delta");
console.log("-".repeat(65));
results
  .filter(r => r.pnl_pct < -5)
  .sort((a, b) => a.pnl_pct - b.pnl_pct)
  .slice(0, 10)
  .forEach(r => {
    const delta = r.delta >= 0 ? `+${r.delta}` : String(r.delta);
    console.log(`${(r.name || "?").padEnd(20).slice(0, 20)}  ${String(r.pnl_pct.toFixed(2)).padStart(7)}   ${String(r.oldScore ?? "?").padStart(7)}   ${String(r.newScore).padStart(7)}   ${delta.padStart(5)}`);
  });

// === Top winners — does new scoring still rank them? ===
console.log("\n=== Top 10 Winners ===\n");
console.log("Pool                  PnL%      OldScore  NewScore  Delta");
console.log("-".repeat(65));
results
  .filter(r => r.pnl_pct > 0)
  .sort((a, b) => b.pnl_pct - a.pnl_pct)
  .slice(0, 10)
  .forEach(r => {
    const delta = r.delta >= 0 ? `+${r.delta}` : String(r.delta);
    console.log(`${(r.name || "?").padEnd(20).slice(0, 20)}  ${String(r.pnl_pct.toFixed(2)).padStart(7)}   ${String(r.oldScore ?? "?").padStart(7)}   ${String(r.newScore).padStart(7)}   ${delta.padStart(5)}`);
  });

// === Recommendation ===
console.log("\n=== Recommendation ===\n");

// Find optimal threshold: maximize (winRate × deploy_count)
let bestThresh = null, bestScore = 0;
for (let t = 0; t <= 70; t += 5) {
  const passed = results.filter(r => r.newScore >= t);
  if (passed.length < 10) continue;
  const passedWinners = passed.filter(r => r.profitable).length;
  const winRate = passedWinners / passed.length;
  const score = winRate * Math.log(passed.length); // balance precision and volume
  if (score > bestScore) {
    bestScore = score;
    bestThresh = t;
  }
}

if (bestThresh !== null) {
  const passed = results.filter(r => r.newScore >= bestThresh);
  const winRate = (passed.filter(r => r.profitable).length / passed.length * 100).toFixed(1);
  const avgPnl = (passed.reduce((a, b) => a + b.pnl_pct, 0) / passed.length).toFixed(2);
  console.log(`Optimal minDeployScore: ${bestThresh}`);
  console.log(`  → ${passed.length} deploys (${(passed.length / results.length * 100).toFixed(0)}% of historical pool)`);
  console.log(`  → Win rate: ${winRate}%`);
  console.log(`  → Avg PnL: ${avgPnl}%`);
} else {
  console.log("No threshold passes 10-deploy minimum sample size.");
}
