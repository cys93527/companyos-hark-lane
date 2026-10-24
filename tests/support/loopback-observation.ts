/** Passive test evidence: no fetch, dispatcher, request or response replacement. */
import {channel} from 'node:diagnostics_channel';
import {appendFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import type {Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {isAbsolute, join, parse, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

type Fields = Record<string, unknown>;
type RequestView = {origin?: string; path?: string; method?: string; aborted?: boolean; completed?: boolean};
const errorEvidence = (value: unknown, depth = 0): Fields => {
  if (value === null || typeof value !== 'object') return {kind: typeof value};
  const item = value as Record<string, unknown>;
  const result: Fields = {};
  // Never serialize messages, headers, payloads or environment variables.
  for (const key of ['name', 'code', 'errno', 'syscall']) {
    const field = item[key];
    if (typeof field === 'number' || typeof field === 'string' && /^[\w.:-]{1,100}$/.test(field)) result[key] = field;
  }
  if (typeof item['stack'] === 'string') result['locations'] = item['stack'].split('\n').filter(line => /^\s+at /.test(line)).slice(0, 6)
    .map(line => line.replace(/https?:\/\/\S+/g, '<url>').slice(0, 300));
  if (depth < 3) {
    if (item['cause'] !== undefined) result['cause'] = errorEvidence(item['cause'], depth + 1);
    if (Array.isArray(item['errors'])) result['errors'] = item['errors'].slice(0, 8).map(error => errorEvidence(error, depth + 1));
  }
  return result;
};
const ownedTemp = (): string => {
  const expected = realpathSync(fileURLToPath(new URL('../../.tmp/offline-gates/', import.meta.url)));
  const candidate = resolve(tmpdir());
  const rel = relative(expected, realpathSync(candidate));
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !/^(?:worker-|run-)/.test(rel)) throw new Error('LOOPBACK_TRACE_TEMP_NOT_OWNED');
  let cursor = parse(candidate).root;
  for (const part of candidate.slice(cursor.length).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink() || realpathSync(cursor).toLowerCase() !== resolve(cursor).toLowerCase()) throw new Error('LOOPBACK_TRACE_REPARSE_DENIED');
  }
  return candidate;
};

export const observeLoopback = (testId: string) => {
  const fixtureId = randomUUID();
  const directory = mkdtempSync(join(ownedTemp(), 'loopback-'));
  const file = join(directory, 'events.jsonl');
  let sequence = 0;
  let failures = 0;
  let endpoint = '';
  const subscriptions: {name: string; listener: (message: unknown) => void}[] = [];
  const requests = new WeakMap<object, string>();
  const sockets = new Set<Socket>();
  let clientSequence = 0;
  let serverSequence = 0;
  const row = (event: string, fields: Fields = {}) => ({fixtureId, testId, pid: process.pid, sequence: ++sequence,
    timestamp: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString(), event, ...fields});
  const emit = (event: string, fields: Fields = {}): void => {
    try { appendFileSync(file, JSON.stringify(row(event, fields)) + '\n', 'utf8'); }
    catch { failures += 1; } // Observer failure never replaces the business exception.
  };
  const opening = JSON.stringify(row('channel-open', {node: process.version, undici: process.versions['undici'], directory})) + '\n';
  writeFileSync(file, opening, {encoding: 'utf8', flag: 'wx'});
  if (readFileSync(file, 'utf8') !== opening) throw new Error('LOOPBACK_TRACE_PROBE_FAILED');
  const matches = (request: RequestView): boolean => {
    try { return endpoint !== '' && new URL(String(request.origin)).origin === endpoint && request.path === '/models'; }
    catch { return false; }
  };
  for (const name of ['undici:request:create', 'undici:request:bodySent', 'undici:request:headers',
    'undici:request:trailers', 'undici:request:error', 'undici:client:sendHeaders', 'undici:client:connectError']) {
    const listener = (message: unknown): void => {
      try {
        const data = message as {request?: RequestView; response?: {statusCode?: number}; error?: unknown;
          socket?: Socket; connectParams?: {hostname?: string; port?: string | number}};
        if (data.request === undefined) {
          if (name === 'undici:client:connectError' && data.connectParams?.hostname === '127.0.0.1'
              && endpoint === 'http://127.0.0.1:' + String(data.connectParams.port)) emit(name, {error: errorEvidence(data.error)});
          return;
        }
        const request = data.request;
        if (!matches(request)) return;
        let requestId = requests.get(request);
        if (requestId === undefined) { requestId = 'client-' + String(++clientSequence); requests.set(request, requestId); }
        emit(name, {requestId, endpoint, method: request.method, path: '/models', status: data.response?.statusCode,
          requestAborted: typeof request.aborted === 'boolean' ? request.aborted : 'NOT_EXPOSED',
          requestCompleted: typeof request.completed === 'boolean' ? request.completed : 'NOT_EXPOSED',
          signalState: 'NOT_EXPOSED_BY_PASSIVE_CHANNEL',
          ...(name === 'undici:request:create' ? {callSite: errorEvidence(new Error()).locations} : {}),
          ...(data.socket === undefined ? {} : {localPort: data.socket.localPort, remotePort: data.socket.remotePort}),
          ...(data.error === undefined ? {} : {error: errorEvidence(data.error)})});
      } catch { failures += 1; }
    };
    channel(name).subscribe(listener);
    subscriptions.push({name, listener});
  }
  const dispose = (): void => {
    for (const {name, listener} of subscriptions) channel(name).unsubscribe(listener);
    emit('observer-detached', {observationWriteFailures: failures});
  };
  return {
    directory, fixtureId, emit, dispose,
    attach: (server: Server): void => {
      server.on('listening', () => {
        const address = server.address();
        if (address !== null && typeof address !== 'string') endpoint = 'http://127.0.0.1:' + String(address.port);
        emit('server-listening', {endpoint, bindHost: '127.0.0.1'});
      });
      server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => { sockets.delete(socket); emit('server-socket-close', {activeSockets: sockets.size}); });
      });
      server.on('request', (request, response) => {
        if (request.url !== '/models') return;
        const requestId = 'server-' + String(++serverSequence);
        const fields = {requestId, endpoint, path: '/models', method: request.method, remotePort: request.socket.remotePort};
        emit('server-request-received', {...fields, aborted: request.aborted});
        response.once('finish', () => emit('server-response-finish', {...fields, status: response.statusCode}));
        request.once('error', error => emit('server-request-error', {...fields, error: errorEvidence(error)}));
      });
      server.on('close', () => emit('server-close-event', {activeSockets: sockets.size}));
    },
    bindError: (error: unknown): void => emit('server-bind-error', {error: errorEvidence(error)}),
    close: async (server: Server): Promise<void> => {
      emit('server-close-start', {listening: server.listening, activeSockets: sockets.size});
      try {
        await new Promise<void>((resolveClose, rejectClose) => {
          const timer = setTimeout(() => {
            emit('server-close-timeout', {activeSockets: sockets.size, boundMs: 5000});
            for (const socket of sockets) socket.destroy(); // Only this fixture's accepted sockets.
            server.closeAllConnections();
            rejectClose(new Error('LOOPBACK_FIXTURE_CLOSE_TIMEOUT'));
          }, 5000);
          server.close(error => {
            clearTimeout(timer);
            emit('server-close-complete', {activeSockets: sockets.size, ...(error ? {error: errorEvidence(error)} : {})});
            if (error) rejectClose(error); else resolveClose();
          });
        });
      } finally {
        dispose();
      }
      if (failures !== 0) throw new Error('LOOPBACK_OBSERVATION_INCOMPLETE');
    },
  };
};
