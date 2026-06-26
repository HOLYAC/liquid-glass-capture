// Rate-match production to the registration burn, read off the oracle pool.
// Pure: (stats, config, history) -> {delayMs, reason}. The Swift engine mirrors
// this exactly (parity fixtures) so background adaptation matches foreground.
//
// Tokens die in ~max_age_s (oracle default 100s), so deep-buffering is wasteful:
// the goal is "keep just enough fresh", not "mint as fast as possible".

import type { MintConfig, OracleStats, StatsHistory, Decision } from "./types";

export function computeNextDelayMs(
  stats: OracleStats,
  cfg: Pick<MintConfig, "baseIntervalMs" | "minIntervalMs" | "maxIntervalMs">,
  hist: StatsHistory
): Decision {
  const clamp = (ms: number): number =>
    Math.max(cfg.minIntervalMs, Math.min(cfg.maxIntervalMs, Math.round(ms)));

  // Pool starving while registrations consume → mint as fast as allowed.
  if (stats.pool_size <= 1 && hist.recentConsumedRate > 0) {
    return { delayMs: cfg.minIntervalMs, reason: "pool-starved" };
  }

  // Tokens expiring unused → we're overproducing; slow down to stop the waste.
  if (hist.recentExpiredRate > 0) {
    const factor = 1 + Math.min(2, hist.recentExpiredRate / 5);
    return { delayMs: clamp(cfg.baseIntervalMs * factor), reason: "expired-waste" };
  }

  // Healthy buffer, no waste → hold the base cadence.
  return { delayMs: clamp(cfg.baseIntervalMs), reason: "steady" };
}

// Derive per-poll rates from two successive /stats reads (monotonic counters).
export function deriveHistory(prev: OracleStats | null, cur: OracleStats): StatsHistory {
  if (!prev) return { recentExpiredRate: 0, recentConsumedRate: 0 };
  return {
    recentExpiredRate: Math.max(0, cur.expired - prev.expired),
    recentConsumedRate: Math.max(0, cur.consumed - prev.consumed),
  };
}
