import { describe, expect, it } from 'vitest';

import {
  allResults,
  canonicalJson,
  contentHash,
  err,
  isErr,
  isUlid,
  isOk,
  mapError,
  mapResult,
  ok,
  shortHash,
  UlidFactory,
  SequenceIdFactory,
  unwrap,
  unwrapOr,
  FixedClock,
  DomainError,
  NotImplementedError,
  InMemoryEventBus,
  defineEvent,
} from '@companyos/core';

import { makeClock, makeIds } from './support/fixtures.js';

describe('Result', () => {
  it('carries success and failure without throwing', () => {
    const good = ok(21);
    const bad = err(new DomainError('NOT_FOUND', 'missing'));
    expect(isOk(good)).toBe(true);
    expect(isErr(bad)).toBe(true);
    expect(unwrap(good)).toBe(21);
    expect(unwrapOr(err('x'), 7)).toBe(7);
    expect(mapResult(good, (n) => n * 2)).toEqual(ok(42));
    expect(mapError(bad, (e) => e.code)).toEqual(err('NOT_FOUND'));
    expect(mapResult(bad, (n: number) => n)).toBe(bad);
  });

  it('collects results and fails fast', () => {
    expect(allResults([ok(1), ok(2)]).ok).toBe(true);
    const collected = allResults([ok(1), err('boom')]);
    expect(collected.ok).toBe(false);
    if (!collected.ok) expect(collected.error).toBe('boom');
  });

  it('unwrapping an error throws the underlying error', () => {
    const failure = err(new DomainError('CONFLICT', 'nope'));
    expect(() => unwrap(failure)).toThrowError('nope');
  });
});

describe('canonical hashing', () => {
  it('sorts keys recursively so key order never changes the fingerprint', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: true } })).toBe('{"a":{"c":true,"d":[1,2]},"b":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson([1, 'two', null])).toBe('[1,"two",null]');
  });

  it('produces the same contentHash for structurally equal payloads', () => {
    const first = contentHash({ nodes: [{ id: 'n1' }], edges: [] });
    const second = contentHash({ edges: [], nodes: [{ id: 'n1' }] });
    expect(first).toBe(second);
    expect(first).toHaveLength(64);
    expect(shortHash(first)).toBe(first.slice(0, 8));
  });

  it('refuses non-canonical values', () => {
    expect(() => canonicalJson(Number.NaN)).toThrowError(/non-finite/);
    expect(() => canonicalJson(() => 1)).toThrowError(/unsupported/);
  });
});

describe('identifiers', () => {
  it('mints lexicographically sortable ULIDs', () => {
    const ids = new UlidFactory(makeClock());
    const first = ids.ulid();
    const second = ids.ulid();
    expect(first).toHaveLength(26);
    expect(isUlid(first)).toBe(true);
    expect(second > first).toBe(true);
    expect(ids.id('tpl').startsWith('tpl_')).toBe(true);
  });

  it('is monotonic inside the same millisecond and stable across the sequence factory', () => {
    const clock = new FixedClock(1_800_000_000_000);
    const ids = new UlidFactory(clock);
    const batch = [ids.ulid(), ids.ulid(), ids.ulid()];
    expect([...batch].sort()).toEqual(batch);
    expect(new Set(batch).size).toBe(3);

    const sequence = new SequenceIdFactory();
    expect(sequence.id('ver')).toMatch(/^ver_/);
    expect(sequence.ulid()).toHaveLength(26);
  });
});

describe('events and error taxonomy', () => {
  it('wraps payloads in a traceable envelope', () => {
    const ids = makeIds();
    const clock = makeClock();
    const event = defineEvent(
      {
        type: 'workflow.template.created',
        aggregateId: 'tpl_1',
        aggregateType: 'WorkflowTemplate',
        traceId: 'trace_1',
        actorId: 'user_owner',
        payload: { name: 'SOP' },
      },
      ids,
      clock.nowIso(),
    );
    expect(event.eventId.startsWith('evt_')).toBe(true);
    expect(event.version).toBe(1);
    expect(event.occurredAt).toBe(clock.nowIso());
    expect(event.payload).toEqual({ name: 'SOP' });
  });

  it('fans out to typed and wildcard subscribers with unsubscribe', () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    const stopTyped = bus.subscribe('a', (event) => seen.push(`typed:${event.type}`));
    bus.subscribeAll((event) => seen.push(`all:${event.type}`));
    const event = defineEvent(
      { type: 'a', aggregateId: 'x', aggregateType: 'X', traceId: 't', actorId: 'u', payload: {} },
      makeIds(),
      new Date().toISOString(),
    );
    bus.publish(event);
    stopTyped();
    bus.publish(event);
    expect(seen).toEqual(['typed:a', 'all:a', 'all:a']);
  });

  it('serialises domain errors and marks unimplemented Sprint 0 capabilities', () => {
    const error = new DomainError('VALIDATION_FAILED', 'bad input', { details: { field: 'name' } });
    expect(error.toJSON()).toEqual({
      name: 'DomainError',
      code: 'VALIDATION_FAILED',
      message: 'bad input',
      details: { field: 'name' },
    });
    const notImplemented = new NotImplementedError('Model Router', 'Sprint 7 (P2)');
    expect(notImplemented.code).toBe('NOT_IMPLEMENTED');
    expect(notImplemented.message).toContain('Sprint 7');
  });
});
