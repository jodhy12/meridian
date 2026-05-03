import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "state.json");
const LESSONS_FILE = path.join(__dirname, "lessons.json");

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance Activity (from performance log)
  // Filter out positions held <5min (false same-cycle "wins" with no real fee accrual)
  const perfLast24h = (lessonsData.performance || []).filter(p =>
    new Date(p.recorded_at) > last24h && (p.minutes_held ?? 0) >= 5
  );
  const totalPnL = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFees = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);
  const cur = config.management?.solMode ? "◎" : "$";

  // 3. Lessons Learned
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  // 5. Format Message
  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${openedLast24h.length}`,
    `📤 Positions Closed: ${closedLast24h.length}`,
    "",
    `<b>Performance:</b>`,
    `💰 Net PnL: ${totalPnL >= 0 ? "+" : ""}${cur}${totalPnL.toFixed(4)}`,
    `💎 Fees Earned: ${cur}${totalFees.toFixed(4)}`,
    perfLast24h.length > 0
      ? `📈 Win Rate (24h): ${Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)}% (${perfLast24h.length} positions ≥5min)`
      : "📈 Win Rate (24h): N/A",
    "",
    `<b>Lessons Learned:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${l.rule}`).join("\n")
      : "• No new lessons recorded overnight.",
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.length}`,
    perfSummary
      ? `📊 All-time PnL: ${cur}${perfSummary.total_pnl_usd.toFixed(4)} (${perfSummary.win_rate_pct}% win)`
      : "",
    "────────────────"
  ];

  return lines.join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
