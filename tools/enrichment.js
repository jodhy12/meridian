/**
 * Unified token enrichment adapter — picks provider based on env config.
 *
 * Provider priority:
 *   1. GMGN (if GMGN_API_KEY set) — Solana-native, KOL/smart money strong
 *   2. OKX  (if OKX_API_KEY set)  — multi-chain, requires auth (public access closed since Apr 2026)
 *   3. None (silent fallback) — bot operates with degraded scoring
 *
 * Same export shape as okx.js / gmgn.js for drop-in usage.
 */
import { log } from "../logger.js";

const HAS_GMGN = !!process.env.GMGN_API_KEY;
const HAS_OKX  = !!process.env.OKX_API_KEY;

let provider = null;
let providerName = "none";

async function getProvider() {
  if (provider) return provider;
  if (HAS_GMGN) {
    provider = await import("./gmgn.js");
    providerName = "gmgn";
  } else if (HAS_OKX) {
    provider = await import("./okx.js");
    providerName = "okx";
  } else {
    provider = null;
    providerName = "none";
  }
  log("enrichment", `Provider initialized: ${providerName}`);
  return provider;
}

const NULL_RESULT = {
  advanced: null,
  clusters: [],
  price: null,
};

export async function getRiskFlags(tokenAddress, chain) {
  const p = await getProvider();
  if (!p) return null;
  return p.getRiskFlags(tokenAddress, chain);
}

export async function getAdvancedInfo(tokenAddress, chain) {
  const p = await getProvider();
  if (!p) return null;
  return p.getAdvancedInfo(tokenAddress, chain);
}

export async function getClusterList(tokenAddress, chain, limit) {
  const p = await getProvider();
  if (!p) return [];
  return p.getClusterList(tokenAddress, chain, limit);
}

export async function getPriceInfo(tokenAddress, chain) {
  const p = await getProvider();
  if (!p) return null;
  return p.getPriceInfo(tokenAddress, chain);
}

export async function getFullTokenAnalysis(tokenAddress, chain) {
  const p = await getProvider();
  if (!p) return NULL_RESULT;
  return p.getFullTokenAnalysis(tokenAddress, chain);
}

export function getProviderName() {
  return providerName;
}

export function hasEnrichmentProvider() {
  return HAS_GMGN || HAS_OKX;
}
