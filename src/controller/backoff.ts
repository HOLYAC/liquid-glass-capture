// Exponential backoff for consecutive failures (the WebView-process-terminate
// storm the on-device log showed). Pure: state in, state out, no timers here.

export type BackoffState = { attempt: number };

export function resetBackoff(): BackoffState {
  return { attempt: 0 };
}

// On failure: advance the attempt (capped) and return the next delay.
// On success: reset to baseMs. Cap keeps a long outage from parking forever.
export function nextBackoff(
  state: BackoffState,
  ok: boolean,
  baseMs: number,
  capMs: number
): { state: BackoffState; delayMs: number } {
  if (ok) return { state: resetBackoff(), delayMs: baseMs };
  const attempt = Math.min(state.attempt + 1, 5);
  const delayMs = Math.min(baseMs * 2 ** attempt, capMs);
  return { state: { attempt }, delayMs };
}
