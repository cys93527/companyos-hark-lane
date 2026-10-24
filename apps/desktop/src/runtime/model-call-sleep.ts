/**
 * LIVE-SMOKE-FIX-03 — the production cancelable backoff sleep for control-plane
 * model-call retries. Lives in the DESKTOP composition layer (the engine boundary
 * law forbids timers/schedulers inside the engine); injected into the AgentRuntime
 * so backoff waits are real but always cancelable by the caller's abort signal.
 */
export const abortableSleep = (delayMs: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new Error('cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('cancelled'));
    };
    signal?.addEventListener('abort', onAbort, {once: true});
  });
