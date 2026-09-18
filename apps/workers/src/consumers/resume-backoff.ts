/** Backoff de `RESUME_ERROR` en el poll de jobs aplazados. Sin VPS ni DB. */

/** 30s → 2m → 10m. Tras agotar la lista el job pasa a `failed`. */
export const RESUME_ERROR_BACKOFF_MS = [30_000, 120_000, 600_000] as const;

export type ResumeErrorDecision =
  | {
      status: "pending";
      attempt: number;
      delayMs: number;
      nextRetryAt: Date;
    }
  | {
      status: "failed";
      attempt: number;
    };

function nextAttempt(previousAttempts: unknown): number {
  const prior = Number(previousAttempts ?? 0);
  if (!Number.isFinite(prior) || prior < 0) return 1;
  return Math.floor(prior) + 1;
}

/**
 * Tras un fallo al reanudar un job (`RESUME_ERROR`), no dejarlo `pending`
 * con `next_retry_at` ya vencido: el poll lo volvería a coger en el mismo
 * ciclo. Aplaza 30s → 2m → 10m y marca `failed` al cuarto error.
 */
export function planResumeErrorRetry(
  previousAttempts: unknown,
  now: Date,
): ResumeErrorDecision {
  const attempt = nextAttempt(previousAttempts);
  const delayMs = RESUME_ERROR_BACKOFF_MS[attempt - 1];
  if (delayMs === undefined) {
    return { status: "failed", attempt };
  }
  return {
    status: "pending",
    attempt,
    delayMs,
    nextRetryAt: new Date(now.getTime() + delayMs),
  };
}
