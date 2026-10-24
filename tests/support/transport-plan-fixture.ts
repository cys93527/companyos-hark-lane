/** Only the transport/plan-shape fixtures: owned waits and host-survival listeners. */
import type { Outcome } from './e3-broker-evidence.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const assertObservationComplete = (directory: string): void => {
  const rows = readFileSync(join(directory, 'events.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { event?: string; observationWriteFailures?: number });
  const detached = rows.at(-1);
  if (rows[0]?.event !== 'channel-open' || detached?.event !== 'observer-detached' || detached.observationWriteFailures !== 0) {
    throw new Error('TRANSPORT_PLAN_OBSERVATION_INCOMPLETE');
  }
};

export const boundedExchange = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`exchange did not settle within ${String(ms)}ms`)), ms);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
};

/** A close assertion is meaningful only after this fixture actually received a request. */
export const requireUpstreamArrival = async (
  arrived: Promise<void>, outcome: Promise<Outcome<number>>, ms: number,
): Promise<void> => {
  await boundedExchange(Promise.race([arrived, outcome.then(result => {
    if (!result.ok) throw result.error; // Preserve the actual precondition transport failure.
    throw new Error('UPSTREAM_REQUEST_NOT_OBSERVED_BEFORE_CLIENT_COMPLETION');
  })]), ms);
};

export const captureHostFailures = (sink: string[]) => {
  const exception = (event: unknown): void => { sink.push(`uncaughtException: ${event instanceof Error ? event.message : String(event)}`); };
  const rejection = (event: unknown): void => { sink.push(`unhandledRejection: ${event instanceof Error ? event.message : String(event)}`); };
  let listening = false;
  return {
    attach: (): void => {
      if (listening) return;
      listening = true;
      process.on('uncaughtException', exception);
      process.on('unhandledRejection', rejection);
    },
    detach: (): void => {
      process.off('uncaughtException', exception);
      process.off('unhandledRejection', rejection);
      listening = false;
    },
  };
};
