// Randomise the scheduling interval so the cadence isn't a constant 8.000s
// metronome (a fixed beat is a bot tell). RNG is injected so this stays a pure,
// deterministic function the tests (and the Swift mirror) can pin exactly.

export function applyJitter(baseMs: number, pct: number, rnd: () => number): number {
  if (pct <= 0) return baseMs;
  const clampedPct = Math.min(1, pct);
  const span = baseMs * clampedPct;          // rnd in [0,1) maps to [-span, +span]
  return Math.max(0, Math.round(baseMs - span + rnd() * 2 * span));
}
