/**
 * In-memory cache of screening enrichment data per pool.
 * Populated during screening cycle, consumed by executor at deploy time
 * to build signal_snapshot without relying on LLM to pass fields.
 *
 * TTL: 30 minutes (matches screening interval).
 */

const CACHE_TTL_MS = 30 * 60_000;

/** @type {Map<string, { data: object, ts: number }>} */
const _cache = new Map();

/**
 * Store enrichment data for a pool address.
 * @param {string} poolAddress
 * @param {object} data - All screening signals for this pool
 */
export function cachePoolSignals(poolAddress, data) {
  _cache.set(poolAddress, { data, ts: Date.now() });
}

/**
 * Retrieve cached signals for a pool. Returns null if expired or missing.
 * @param {string} poolAddress
 * @returns {object|null}
 */
export function getCachedPoolSignals(poolAddress) {
  const entry = _cache.get(poolAddress);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _cache.delete(poolAddress);
    return null;
  }
  return entry.data;
}

/**
 * Clear all cached signals (e.g. on restart).
 */
export function clearPoolSignalsCache() {
  _cache.clear();
}
