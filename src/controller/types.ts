// The farm's data contract. Pure types — no RN/native imports, so this file
// (and the whole controller/) type-checks and reasons in isolation.

export type ProviderId =
  | "hcaptcha"        // PROVEN portable bearer token (413 minted live)
  | "friendly"        // PoW token — portability likely, needs a spike
  | "geetest"         // behavioural — portability per-site, needs a spike
  | "tencent"
  | "netease"
  | "recaptcha_ent";  // action/score-bound — portability weak, needs a spike

// One thing the farm mints for: a provider + its sitekey + where tokens go.
export type SiteTarget = {
  provider: ProviderId;
  sitekey: string;
  oracleUrl: string;     // POST /collect endpoint for this target's tokens
  weight: number;        // relative share in the rotation (>=1)
  enabled: boolean;
};

// The whole tunable surface of the farm. One shape, persisted + pushed to native.
export type MintConfig = {
  version: 1;
  targets: SiteTarget[];
  baseIntervalMs: number;   // native floors this at 2000
  minIntervalMs: number;    // adaptive/quota floor
  maxIntervalMs: number;    // adaptive ceiling
  jitterPct: number;        // 0..1 — randomises cadence (anti fixed-tell)
  adaptive: boolean;        // poll /stats and rate-match
};

// The oracle /stats shape the controller consumes (subset we actually read).
export type OracleStats = {
  pool_size: number;
  consumed: number;
  expired: number;
  max_age_s: number;
};

// Inter-poll deltas the adaptive controller derives from successive /stats reads.
export type StatsHistory = {
  recentExpiredRate: number;   // expired tokens per poll interval
  recentConsumedRate: number;  // consumed tokens per poll interval
};

// What the adaptive controller decides, with a human-readable why (for the log).
export type Decision = {
  delayMs: number;
  reason: string;
};
