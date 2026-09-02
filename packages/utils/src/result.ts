/**
 * A tiny Result type for domain operations that fail for business reasons
 * rather than exceptional ones. Business rejections (offer below floor,
 * illegal state transition) are values, not thrown errors — they are expected
 * outcomes and every caller must handle them.
 */
export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw new Error(`Attempted to unwrap a failed Result: ${JSON.stringify(result.error)}`);
}

/** Deterministic sleep helper for retry/backoff paths. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Exponential backoff with full jitter. Used for provider calls (payments,
 * maps) where a Nigerian mobile network hiccup is far more likely than a real
 * outage.
 */
export async function retry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number; onRetry?: (attempt: number, error: unknown) => void } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 4000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      options.onRetry?.(attempt, error);
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(Math.random() * ceiling);
    }
  }
  throw lastError;
}
