/** Test-only observations and owned cleanup. No fetch/dispatcher or production replacement. */
import { Server, type ClientRequest } from 'node:http';
import type { Socket } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Logger, LogFields } from '@companyos/observability';

export type Emit = (event: string, fields?: Record<string, unknown>) => void;
export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
export const safeError = (error: unknown, secrets: readonly string[] = [], depth = 0): Record<string, unknown> => {
  const scrub = (text: string): string => {
    for (const secret of secrets) if (secret) text = text.split(secret).join('<redacted>');
    return text.replace(/https?:\/\/\S+/g, '<url>')
      .replace(/(?:Bearer\s+|(?:api[-_]?key|authorization|cookie|password|token)\s*[:=]\s*)[^\s,;]+/gi, '<redacted>')
      .slice(0, 1500);
  };
  if (typeof error === 'string') return { message: scrub(error) };
  if (!error || typeof error !== 'object') return { kind: typeof error };
  const item = error as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['name', 'code', 'errno', 'syscall', 'message']) {
    const value = item[key];
    if (typeof value === 'string') result[key] = scrub(value);
    else if (typeof value === 'number') result[key] = value;
  }
  if (typeof item['stack'] === 'string') result['locations'] = item['stack'].split('\n').filter(line => /^\s+at /.test(line)).slice(0, 6).map(scrub);
  if (depth < 3) {
    if (item['cause'] !== undefined) result['cause'] = safeError(item['cause'], secrets, depth + 1);
    if (Array.isArray(item['errors'])) result['errors'] = item['errors'].slice(0, 8).map(value => safeError(value, secrets, depth + 1));
  }
  return result;
};

export const compositionEvidence = (emit: Emit, secrets: readonly string[] = []) => {
  const records: Record<string, unknown>[] = [];
  let writeFailures = 0;
  const record: Emit = (event, fields = {}) => {
    const row = { event, ...fields };
    records.push(row);
    if (records.length > 64) records.shift();
    try { emit(event, fields); } catch { writeFailures++; }
  };
  const logger = (bound: LogFields = {}): Logger => {
    const log = (level: string, message: string, fields: LogFields = {}): void => {
      const selected: Record<string, unknown> = {};
      const input = { ...bound, ...fields };
      for (const key of ['code', 'error', 'cause', 'phase']) if (input[key] !== undefined) selected[key] = safeError(input[key], secrets);
      record('composition-log', { level, message: safeError(message, secrets), ...selected });
    };
    return { debug: (m, f) => log('debug', m, f), info: (m, f) => log('info', m, f),
      warn: (m, f) => log('warn', m, f), error: (m, f) => log('error', m, f),
      child: fields => logger({ ...bound, ...fields }) };
  };
  // Existing database injection seam: observe the relevant store operations while
  // preserving receivers, arguments, returned values and thrown error identities.
  const database = <T extends object>(input: T): T => {
    const cache = new Map<PropertyKey, object>();
    const stores = new Set(['roles', 'roleAssignments', 'toolRecords', 'events']);
    return new Proxy(input, { get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof key !== 'string' || !stores.has(key) || !value || typeof value !== 'object') return value;
      if (cache.has(key)) return cache.get(key);
      const observed = new Proxy(value, { get(store, method) {
        const fn: unknown = Reflect.get(store, method, store);
        if (typeof fn !== 'function' || typeof method !== 'string') return fn;
        return (...args: unknown[]) => {
          const phase = `${key}.${method}`;
          record('composition-store-start', { phase });
          const finish = (result: unknown): unknown => {
            const outcome = result as { ok?: boolean; error?: unknown } | null;
            record('composition-store-return', { phase, result: outcome?.ok === false ? 'ERROR' : 'RETURNED',
              ...(outcome?.ok === false ? { error: safeError(outcome.error, secrets) } : {}) });
            return result;
          };
          const fail = (error: unknown): never => { record('composition-store-error', { phase, error: safeError(error, secrets) }); throw error; };
          try {
            const result: unknown = Reflect.apply(fn, store, args);
            return result instanceof Promise ? result.then(finish, fail) : finish(result);
          } catch (error) { return fail(error); }
        };
      } });
      cache.set(key, observed);
      return observed;
    } });
  };
  return { logger: logger(), database, records, record, writeFailures: () => writeFailures,
    failure: (): Error => new Error('E3 composition returned null; evidence write failures: ' + String(writeFailures) + '; observed boundaries: ' + JSON.stringify(records)) };
};

export const trackOwnedServer = (server: Server, emit: Emit) => {
  const sockets = new Set<Socket>();
  const socketCloses: Promise<void>[] = [];
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  server.on('connection', socket => {
    sockets.add(socket);
    emit('tcp-accepted', { activeSockets: sockets.size, localPort: socket.localPort, remotePort: socket.remotePort });
    socketCloses.push(new Promise<void>(resolve => {
      socket.once('close', () => { sockets.delete(socket); emit('tcp-closed', { activeSockets: sockets.size }); resolve(); });
    }));
    socket.once('error', error => emit('tcp-error', { error: safeError(error) }));
  });
  server.on('request', (request, response) => {
    // Never record the broker capability path, headers, body or credential values.
    emit('http-server-received', { method: request.method, requestId: `${process.pid}:${request.socket.remotePort}:${request.socket.localPort}`, aborted: request.aborted });
    request.once('aborted', () => emit('http-server-aborted', { aborted: request.aborted }));
    response.once('finish', () => emit('http-response', { status: response.statusCode }));
  });
  server.on('error', error => emit('http-server-error', { error: safeError(error) }));
  let closed = false;
  server.once('close', () => { closed = true; emit('owned-server-close-event'); });
  return {
    close: async (stop?: () => void, boundMs = 5000): Promise<void> => {
      emit('owned-server-close-start', { activeSockets: sockets.size, listening: server.listening });
      const deadline = Date.now() + boundMs;
      try {
        if (!closed) await new Promise<void>((resolve, reject) => {
          const done = (): void => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => {
            server.removeListener('close', done);
            for (const socket of sockets) socket.destroy();
            server.closeAllConnections();
            emit('owned-server-close-timeout', { boundMs, activeSockets: sockets.size });
            reject(new Error('OWNED_SERVER_CLOSE_TIMEOUT'));
          }, boundMs);
          server.once('close', done);
          try {
            if (stop) stop();
            else {
              server.close(error => {
                if (error) { clearTimeout(timer); server.removeListener('close', done); reject(error); }
              });
              // Only accepted connections of this fixture's server.
              for (const socket of sockets) socket.destroy();
            }
          } catch (error) { clearTimeout(timer); server.removeListener('close', done); reject(error); }
        });
        // Server close can precede the sockets' JS close callbacks. Observe both.
        await waitOwnedCompletion(Promise.all(socketCloses), Math.max(1, deadline - Date.now()));
        emit('owned-server-close-complete', { activeSockets: sockets.size });
      } finally {
        emit('event-loop-delay', { meanMs: Number.isFinite(delay.mean) ? delay.mean / 1e6 : 'NOT_OBSERVED',
          maxMs: delay.max / 1e6, samples: delay.count });
        delay.disable();
      }
    },
  };
};

// Read-only Node handle observation. Fail closed if a uniquely owned listening
// HTTP server cannot be proven; this is not an OS-wide process guarantee.
const handles = (): unknown[] => (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
export const activeHandleSnapshot = (): ReadonlySet<unknown> => new Set(handles());
export const identifyOwnedBrokerServer = (url: string, before: ReadonlySet<unknown>): Server => {
  const target = new URL(url);
  if (target.hostname !== '127.0.0.1') throw new Error('BROKER_SERVER_NOT_LOOPBACK');
  const matches = handles().filter((handle): handle is Server => {
    if (before.has(handle) || !(handle instanceof Server)) return false;
    const address = handle.address();
    return address !== null && typeof address !== 'string' && address.address === '127.0.0.1' && address.port === Number(target.port);
  });
  if (matches.length !== 1) throw new Error('BROKER_SERVER_OWNERSHIP_NOT_CONFIRMED');
  return matches[0]!;
};

export const ownRequests = (emit: Emit) => {
  const requests: { id: string; outcome: Promise<Outcome<number>>; close: Promise<void>; cancel: () => void; closeObserved: boolean }[] = [];
  return {
    register: (request: ClientRequest | undefined, promise: Promise<number>) => {
      const entry = { id: `request-${requests.length + 1}`, outcome: null as unknown as Promise<Outcome<number>>,
        cancel: () => request?.destroy(new Error('FIXTURE_REQUEST_CLEANUP')), close: Promise.resolve(), closeObserved: request === undefined };
      if (request !== undefined) entry.close = new Promise<void>(resolve => {
        request.once('close', () => { entry.closeObserved = true; emit('client-request-close', { requestId: entry.id, destroyed: request.destroyed }); resolve(); });
      });
      // Attach the rejection handler in the same synchronous turn as creation.
      entry.outcome = promise.then(value => { emit('client-request-end', { requestId: entry.id, status: value }); return { ok: true as const, value }; },
        error => { emit('client-request-error', { requestId: entry.id, error: safeError(error) }); return { ok: false as const, error }; });
      requests.push(entry);
      emit('client-request-start', { requestId: entry.id, abortSignal: 'NOT_OBSERVED_NO_SIGNAL_SUPPLIED' });
      request?.once('socket', socket => socket.once('connect', () => emit('client-connected', { requestId: entry.id, localPort: socket.localPort, remotePort: socket.remotePort })));
      return { outcome: entry.outcome, value: async (): Promise<number> => {
        const outcome = await entry.outcome;
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      } };
    },
    close: async (boundMs = 5000): Promise<void> => {
      for (const request of requests) if (!request.closeObserved) request.cancel();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.all(requests.map(request => Promise.all([request.outcome, request.close]))), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('FIXTURE_PENDING_REQUEST_TIMEOUT')), boundMs);
        })]);
        emit('client-requests-settled', { count: requests.length, closeObserved: requests.every(request => request.closeObserved) });
      } finally { if (timer !== undefined) clearTimeout(timer); }
    },
  };
};

/** Await owned callbacks, without claiming cancellation or altering their Results. */
export const waitOwnedCompletion = async (completion: Promise<unknown>, boundMs = 5000): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([completion, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('FIXTURE_OWNED_CALLBACK_TIMEOUT')), boundMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
};
