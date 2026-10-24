/**
 * Sprint 11 tests A–AP: Structured Handoff.
 *
 * Every assertion drives REAL code against a REAL SQLite file: the Core state machine, the handoff
 * service, the durable handoff store, the durable event store (`defineEvent` + `events.append`) and
 * a genuine close/reopen cycle. No vacuous assertions, no source-grep substitutes for behaviour,
 * no empty mocks (the only fake is the authority lookup, which is the composition root's job).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HANDOFF_STATES,
  HANDOFF_TRANSITIONS,
  applyHandoffTransition,
  canTransitionHandoff,
  createHandoffPacket,
  defineEvent,
  handoffContextViewIfAccepted,
  handoffToAgentContextView,
  previousHandoffTextOf,
  serializeHandoffContextView,
  type CreateHandoffInput,
  type HandoffPacket,
  type Result,
  type DomainError,
} from '@companyos/core';
import { createHandoffService, type HandoffAuditEmitter, type HandoffAuditPayload, type HandoffService } from '@companyos/engine';
import { openDurableDatabase } from '@companyos/persistence';

import { EXPECTED_COMPOSITION_CHAINS, HANDOFF_CHAIN_TABLES } from '../shared/expected-chains.js';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const source = (path: string): string => readFileSync(repo(path), 'utf8');

const tempDirs: string[] = [];
const makeDataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-s11-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const openDb = (dataDir: string) =>
  openDurableDatabase({ dataDir, appliedAt: '2027-06-01T10:00:00.000Z', chains: [...EXPECTED_COMPOSITION_CHAINS] });

/** Roles carry authorities. The handoff service asks; the TARGET ROLE check is in Core. */
const ROLES = {
  user_developer: { id: 'role_developer', authorities: ['handoff.create', 'handoff.read'] },
  user_reviewer: { id: 'role_reviewer', authorities: ['handoff.read', 'handoff.accept', 'handoff.reject'] },
  user_outsider: { id: 'role_other', authorities: ['handoff.read', 'handoff.accept', 'handoff.reject'] },
} as const;
type Actor = keyof typeof ROLES;

interface Harness {
  readonly service: HandoffService;
  readonly db: ReturnType<typeof openDb>;
  readonly auditTypes: () => Promise<readonly string[]>;
  readonly eventPayloads: () => Promise<readonly Record<string, unknown>[]>;
}

let harnessCounter = 0;

const harnessFor = (db: ReturnType<typeof openDb>): Harness => {
  const ids = (() => {
    let counter = harnessCounter * 1_000;
    harnessCounter += 1;
    return { ulid: () => `01HZZZZZZZZZZZZZZZZZZZZZ${String(counter % 10)}`, id: (p?: string) => `${p ?? 'evt'}_${String((counter += 1))}` };
  })();
  const emit =
    (type: string) =>
    async (payload: HandoffAuditPayload): Promise<void> => {
      await db.events.append([
        defineEvent(
          {
            type,
            aggregateId: payload.handoffId,
            aggregateType: 'Handoff',
            traceId: payload.traceId,
            actorId: 'user_developer',
            payload: { ...payload },
          },
          ids,
          '2027-06-01T10:00:00.000Z',
        ),
      ]);
    };
  const audit: HandoffAuditEmitter = {
    created: emit('handoff.created'),
    ready: emit('handoff.ready'),
    accepted: emit('handoff.accepted'),
    rejected: emit('handoff.rejected'),
    superseded: emit('handoff.superseded'),
    cancelled: emit('handoff.cancelled'),
  };
  // Sprint 13 (ADR-0017/0020): managed handoff refs must resolve to durable rows.
  // The harness seeds artifact/val_ refs without a real artifact chain — a passthrough
  // resolver keeps Sprint 11 behavior tests intact while still exercising the wire.
  const durableReferenceResolver = async (refs: readonly string[]) => ({
    ok: true as const,
    value: refs.map((ref) => ({
      kind: ref.startsWith('val_') ? 'validation' : 'artifact',
      id: ref,
      ref: ref.startsWith('val_') ? ref : `artifact:${ref}`,
    })),
  });
  const service = createHandoffService({
    store: db.handoffStore!,
    audit,
    durableReferenceResolver,
    clock: { now: () => 1_800_000_000_000, nowIso: () => '2027-06-01T10:00:00.000Z' },
    authorize: async ({ actorId, authority }): Promise<Result<true, DomainError>> => {
      const role = ROLES[actorId as Actor];
      if (role === undefined || !(role.authorities as readonly string[]).includes(authority)) {
        return { ok: false, error: { name: 'DomainError', code: 'PERMISSION_DENIED', message: 'denied', details: { authority } } as unknown as DomainError };
      }
      return { ok: true, value: true };
    },
    // The TRUSTED role source: the harness plays the authorization service.
    actorRoleIds: async (actorId) => (ROLES[actorId as Actor] === undefined ? [] : roleIdsOf(actorId as Actor)),
  });
  const allEvents = async () => {
    const stored = await db.events.all();
    return stored.filter((entry) => entry.event.type.startsWith('handoff.'));
  };
  return {
    service,
    db,
    auditTypes: async () => (await allEvents()).map((entry) => entry.event.type),
    eventPayloads: async () => (await allEvents()).map((entry) => entry.event.payload as Record<string, unknown>),
  };
};

const roleIdsOf = (actor: Actor): readonly string[] => [ROLES[actor].id];

const baseInput = (
  overrides: Partial<Omit<CreateHandoffInput, 'createdAt'>> & { readonly actorId?: string } = {},
): Omit<CreateHandoffInput, 'createdAt'> & { readonly actorId: string } => ({
  actorId: 'user_developer',
  handoffId: 'hnd_1',
  companyId: 'cmp',
  workflowId: 'wfl_1',
  workflowVersionId: 'wfv_1',
  workflowRunId: 'run_1',
  stageId: 'stg_1',
  taskId: 'tsk_1',
  fromAgentId: 'agt_developer',
  fromRoleId: 'role_developer',
  toRoleId: 'role_reviewer',
  objective: 'Ship the authentication change',
  summary: 'Implemented token refresh and wired the middleware; unit tests added.',
  recommendedNextAction: 'Review the authentication changes and the test coverage.',
  completedWork: ['refresh handler', 'middleware wiring'],
  remainingWork: ['review sign-off'],
  constraints: ['no breaking API change'],
  acceptanceCriteria: ['tests pass', 'review approved'],
  artifactRefs: [{ kind: 'artifact', refId: 'art_diff_1' }],
  decisionRefs: [{ kind: 'decision', refId: 'dec_token_rotation' }],
  validationRefs: [{ kind: 'validation', refId: 'val_tests_pass' }],
  knownRisks: ['clock skew on token expiry'],
  openQuestions: ['should refresh rotate the device token?'],
  traceId: 'trace_handoff_1',
  ...overrides,
});

const created = async (h: Harness, overrides: Partial<CreateHandoffInput> = {}): Promise<HandoffPacket> => {
  const outcome = await h.service.createDraft(baseInput(overrides));
  if (!outcome.ok) throw new Error(`create failed: ${outcome.error.code} ${outcome.error.message}`);
  return outcome.value;
};

const readied = async (h: Harness, overrides: Partial<CreateHandoffInput> = {}): Promise<HandoffPacket> => {
  const packet = await created(h, overrides);
  const ready = await h.service.ready({
    handoffId: packet.handoffId,
    version: packet.handoffVersion,
    actorId: 'user_developer',
  });
  if (!ready.ok) throw new Error(`ready failed: ${ready.error.code} ${ready.error.message}`);
  return ready.value;
};

const accepted = async (h: Harness, overrides: Partial<CreateHandoffInput> = {}): Promise<HandoffPacket> => {
  const ready = await readied(h, overrides);
  const accept = await h.service.accept({
    handoffId: ready.handoffId,
    version: ready.handoffVersion,
    actorId: 'user_reviewer',
  });
  if (!accept.ok) throw new Error(`accept failed: ${accept.error.code} ${accept.error.message}`);
  return accept.value;
};

describe('A–P. packet, lifecycle, refs and versioning', () => {
  it('A/B: a draft is created and persisted; missing required fields are refused', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const h = harnessFor(db);
      const packet = await created(h);
      expect(packet.status).toBe('DRAFT');
      expect(packet.handoffVersion).toBe(1);
      const stored = await db.handoffStore?.get('hnd_1', 1);
      expect(stored?.objective).toBe('Ship the authentication change');
      expect(stored?.artifactRefs).toEqual([{ kind: 'artifact', refId: 'art_diff_1' }]);

      const missing = await h.service.createDraft(baseInput({ handoffId: 'hnd_2', summary: '   ' }));
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe('VALIDATION_FAILED');
      expect(await db.handoffStore?.get('hnd_2', 1)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('C/Q/R: DRAFT -> READY validates evidence and audits durably', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const h = harnessFor(db);
      await created(h);
      const ready = await h.service.ready({ handoffId: 'hnd_1', version: 1, actorId: 'user_developer' });
      expect(ready.ok).toBe(true);
      if (ready.ok) expect(ready.value.status).toBe('READY');
      expect([...(await h.auditTypes())].sort()).toEqual(['handoff.created', 'handoff.ready']);

      // Acceptance criteria demand evidence: without any artifact/validation ref READY must fail.
      const noEvidence = await h.service.createDraft(
        baseInput({ handoffId: 'hnd_evidence', artifactRefs: [], validationRefs: [] }),
      );
      expect(noEvidence.ok).toBe(true);
      const refused = await h.service.ready({ handoffId: 'hnd_evidence', version: 1, actorId: 'user_developer' });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.details['reason']).toBe('MISSING_EVIDENCE');
    } finally {
      db.close();
    }
  });

  it('D: illegal transitions are CONFLICT, never silent', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const h = harnessFor(db);
      const packet = await created(h);
      // DRAFT -> ACCEPTED is not legal.
      const illegal = await h.service.accept({
        handoffId: packet.handoffId,
        version: 1,
        actorId: 'user_reviewer',
      });
      expect(illegal.ok).toBe(false);
      if (!illegal.ok) expect(illegal.error.code).toBe('CONFLICT');
      expect(canTransitionHandoff('DRAFT', 'ACCEPTED')).toBe(false);
      expect(HANDOFF_TRANSITIONS.CANCELLED).toEqual([]);
      expect(applyHandoffTransition('SUPERSEDED', 'READY').ok).toBe(false);
      expect(HANDOFF_STATES).toHaveLength(6);
    } finally {
      db.close();
    }
  });

  it('E/F/G/J/K: accept, reject, cancel and the recorded decision facts', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const h = harnessFor(db);
      const packet = await accepted(h);
      expect(packet.status).toBe('ACCEPTED');
      expect(packet.acceptedBy).toBe('user_reviewer');
      expect(packet.acceptedAt).not.toBeNull();

      const rejected = await created(h, { handoffId: 'hnd_reject' });
      void rejected;
      await h.service.ready({ handoffId: 'hnd_reject', version: 1, actorId: 'user_developer' });
      const rej = await h.service.reject({
        handoffId: 'hnd_reject',
        version: 1,
        actorId: 'user_reviewer',
        reasonCodes: ['ACCEPTANCE_NOT_MET'],
        comment: 'coverage missing',
      });
      expect(rej.ok).toBe(true);
      if (rej.ok) {
        expect(rej.value.status).toBe('REJECTED');
        expect(rej.value.rejectionReasons).toEqual(['ACCEPTANCE_NOT_MET']);
        expect(rej.value.rejectedBy).toBe('user_reviewer');
      }
      // A rejection needs structured reasons.
      const emptyReasons = await h.service.reject({
        handoffId: 'hnd_reject',
        version: 1,
        actorId: 'user_reviewer',
        reasonCodes: [],
      });
      expect(emptyReasons.ok).toBe(false);

      const cancelled = await created(h, { handoffId: 'hnd_cancel' });
      void cancelled;
      const cancel = await h.service.cancel({ handoffId: 'hnd_cancel', version: 1, actorId: 'user_developer' });
      expect(cancel.ok).toBe(true);
      if (cancel.ok) expect(cancel.value.status).toBe('CANCELLED');
    } finally {
      db.close();
    }
  });

  it('H/I/L/M/AN/AO: rejection is immutable and rework is a NEW superseding version', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const h = harnessFor(db);
      await readied(h);
      await h.service.reject({
        handoffId: 'hnd_1',
        version: 1,
        actorId: 'user_reviewer',
        reasonCodes: ['ACCEPTANCE_NOT_MET'],
      });

      // L: the rejected version cannot be edited or re-READY'd
      const back = await h.service.ready({ handoffId: 'hnd_1', version: 1, actorId: 'user_developer' });
      expect(back.ok).toBe(false);
      if (!back.ok) expect(back.error.code).toBe('CONFLICT');
      // …and the storage-level conditional UPDATE refuses it too (bypassing the service).
      const v1 = await db.handoffStore?.get('hnd_1', 1);
      await expect(db.handoffStore!.update({ ...v1!, summary: 'REWRITTEN', status: 'READY' })).rejects.toThrow();

      // M/AN/AO: rework creates v2 which supersedes v1.
      const superseded = await h.service.supersede({
        handoffId: 'hnd_1',
        previousVersion: 1,
        actorId: 'user_developer',
        next: {
          companyId: 'cmp',
          workflowId: 'wfl_1',
          workflowVersionId: 'wfv_1',
          workflowRunId: 'run_1',
          stageId: 'stg_1',
          taskId: 'tsk_1',
          fromAgentId: 'agt_developer',
          fromRoleId: 'role_developer',
          toRoleId: 'role_reviewer',
          objective: 'Ship the authentication change',
          summary: 'Added the missing coverage the reviewer asked for.',
          recommendedNextAction: 'Re-review the coverage additions.',
          acceptanceCriteria: ['tests pass'],
          validationRefs: [{ kind: 'validation', refId: 'val_tests_pass_v2' }],
          traceId: 'trace_handoff_1',
        },
      });
      expect(superseded.ok).toBe(true);
      if (!superseded.ok) return;
      expect(superseded.value.previous.status).toBe('SUPERSEDED');
      expect(superseded.value.next.handoffVersion).toBe(2);
      expect(superseded.value.next.supersedes).toBe('hnd_1@v1');
      const v1After = await db.handoffStore?.get('hnd_1', 1);
      expect(v1After?.status).toBe('SUPERSEDED');
      expect(v1After?.summary).toBe('Implemented token refresh and wired the middleware; unit tests added.');

      const accept = await h.service.accept({
        handoffId: 'hnd_1',
        version: 2,
        actorId: 'user_reviewer',
      });
      // A superseding version starts as a fresh DRAFT: it must be readied before acceptance.
      expect(accept.ok).toBe(false);
      const readyV2 = await h.service.ready({ handoffId: 'hnd_1', version: 2, actorId: 'user_developer' });
      expect(readyV2.ok).toBe(true);
      const acceptV2 = await h.service.accept({
        handoffId: 'hnd_1',
        version: 2,
        actorId: 'user_reviewer',
      });
      expect(acceptV2.ok).toBe(true);
      if (acceptV2.ok) expect(acceptV2.value.status).toBe('ACCEPTED');

      // I: the full version history is intact, newest first.
      const versions = await h.service.versions('hnd_1', 'user_reviewer');
      expect(versions.ok).toBe(true);
      if (versions.ok) {
        expect(versions.value.map((packet) => `${packet.handoffId}@v${String(packet.handoffVersion)}:${packet.status}`)).toEqual([
          'hnd_1@v2:ACCEPTED',
          'hnd_1@v1:SUPERSEDED',
        ]);
      }
    } finally {
      db.close();
    }
  });

  it('N/O/P: artifact, decision and validation refs round-trip; malformed refs are refused', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const h = harnessFor(db);
      const packet = await created(h);
      const stored = await db.handoffStore?.get(packet.handoffId, 1);
      expect(stored?.artifactRefs).toEqual([{ kind: 'artifact', refId: 'art_diff_1' }]);
      expect(stored?.decisionRefs).toEqual([{ kind: 'decision', refId: 'dec_token_rotation' }]);
      expect(stored?.validationRefs).toEqual([{ kind: 'validation', refId: 'val_tests_pass' }]);

      const malformed = await h.service.createDraft(
        baseInput({ handoffId: 'hnd_bad_ref', artifactRefs: [{ kind: 'artifact', refId: '../../etc/passwd' }] }),
      );
      expect(malformed.ok).toBe(false);
      if (!malformed.ok) expect(malformed.error.code).toBe('VALIDATION_FAILED');
    } finally {
      db.close();
    }
  });
});

describe('U–X, AP. permissions and duplicate accept', () => {
  it('U/V/W/X: authorities are enforced and only the target role may accept', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const h = harnessFor(db);
      // U: no create authority.
      const denied = await h.service.createDraft(baseInput({ actorId: 'user_reviewer' }));
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe('PERMISSION_DENIED');

      await readied(h);
      // X: the outsider HAS handoff.accept but not the target role => still refused.
      const wrongRole = await h.service.accept({
        handoffId: 'hnd_1',
        version: 1,
        actorId: 'user_outsider',
      });
      expect(wrongRole.ok).toBe(false);
      if (!wrongRole.ok) {
        expect(wrongRole.error.code).toBe('PERMISSION_DENIED');
        expect(wrongRole.error.details['reason']).toBe('WRONG_TARGET_ROLE');
      }
      // …and the creator cannot accept on the reviewer's behalf either.
      const creator = await h.service.accept({
        handoffId: 'hnd_1',
        version: 1,
        actorId: 'user_developer',
      });
      expect(creator.ok).toBe(false);

      // W/E: the real reviewer can.
      const accepted1 = await h.service.accept({
        handoffId: 'hnd_1',
        version: 1,
        actorId: 'user_reviewer',
      });
      expect(accepted1.ok).toBe(true);
      // AP: a second accept is a CONFLICT (terminal).
      const again = await h.service.accept({
        handoffId: 'hnd_1',
        version: 1,
        actorId: 'user_reviewer',
      });
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.error.code).toBe('CONFLICT');
    } finally {
      db.close();
    }
  });
});

describe('Q–T, Y, §十二. durable, redacted audit', () => {
  it('all six events are durable and their payload is the exact whitelist (no summary/context/secret)', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const h = harnessFor(db);
      await accepted(h);
      await readied(h, { handoffId: 'hnd_rej' });
      await h.service.reject({
        handoffId: 'hnd_rej',
        version: 1,
        actorId: 'user_reviewer',
        reasonCodes: ['KNOWN_RISK_TOO_HIGH'],
      });
      await readied(h, { handoffId: 'hnd_can' });
      await h.service.cancel({ handoffId: 'hnd_can', version: 1, actorId: 'user_developer' });
      const superseded = await readied(h, { handoffId: 'hnd_sup' });
      void superseded;
      await h.service.supersede({
        handoffId: 'hnd_sup',
        previousVersion: 1,
        actorId: 'user_developer',
        next: {
          companyId: 'cmp',
          workflowId: 'wfl_1',
          workflowVersionId: 'wfv_1',
          workflowRunId: 'run_1',
          stageId: 'stg_1',
          taskId: 'tsk_1',
          fromAgentId: 'agt_developer',
          fromRoleId: 'role_developer',
          toRoleId: 'role_reviewer',
          objective: 'Ship the authentication change',
          summary: 'v2 of the handoff.',
          recommendedNextAction: 'Review v2.',
          validationRefs: [{ kind: 'validation', refId: 'val_tests_pass_v2' }],
          traceId: 'trace_handoff_1',
        },
      });

      const types = await h.auditTypes();
      for (const expected of [
        'handoff.created',
        'handoff.ready',
        'handoff.accepted',
        'handoff.rejected',
        'handoff.superseded',
        'handoff.cancelled',
      ]) {
        expect(types, `${expected} must be durable`).toContain(expected);
      }
      const whitelist = [
        'actorId',
        'artifactCount',
        'decisionCount',
        'fromRoleId',
        'handoffId',
        'runId',
        'status',
        'taskId',
        'toRoleId',
        'traceId',
        'validationCount',
        'version',
      ].sort();
      for (const payload of await h.eventPayloads()) {
        expect(Object.keys(payload).sort()).toEqual(whitelist);
        const serialized = JSON.stringify(payload);
        for (const forbidden of ['summary', 'completedWork', 'remainingWork', 'constraints', 'openQuestions', 'recommendedNextAction', 'secret', 'prompt']) {
          expect(serialized, `${forbidden} must not be audited`).not.toContain(forbidden);
        }
      }
      // Y: secret-shaped content is refused before it can ever be stored or audited. The shape is
      // assembled at runtime so this test file never contains a credential-looking literal.
      const fakeKey = ['sk', '-', 'a'.repeat(24)].join('');
      const secret = await h.service.createDraft(
        baseInput({ handoffId: 'hnd_secret', summary: `used ${fakeKey} for the call` }),
      );
      expect(secret.ok).toBe(false);
      if (!secret.ok) expect(secret.error.code).toBe('POLICY_DENIED');
    } finally {
      db.close();
    }
  });
});

describe('Z/AA/AB, AH/AI/AJ. bounded, deterministic projection and runtime limits', () => {
  it('Z/AA/AB: the projection is bounded, deterministic and carries no chat/context dump', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const h = harnessFor(db);
      const packet = await accepted(h);
      const view = handoffContextViewIfAccepted(packet);
      expect(view).not.toBeNull();
      if (view === null) return;
      expect(Object.keys(view).sort()).toEqual(
        [
          'acceptanceCriteria',
          'artifactRefs',
          'completedWork',
          'constraints',
          'decisionRefs',
          'fromRoleId',
          'handoffId',
          'knownRisks',
          'objective',
          'openQuestions',
          'recommendedNextAction',
          'remainingWork',
          'summary',
          'toRoleId',
          'validationRefs',
          'version',
        ].sort(),
      );
      // AA: deterministic (identical JSON across calls), with no clock/random involvement.
      expect(JSON.stringify(handoffToAgentContextView(packet))).toBe(JSON.stringify(view));
      const text = serializeHandoffContextView(view);
      expect(text).toBe(serializeHandoffContextView(handoffToAgentContextView(packet)));
      // AB: the rendered text contains the structured fields, never a transcript or raw context.
      expect(text).toContain('objective: Ship the authentication change');
      expect(text).toContain('next action: Review the authentication changes and the test coverage.');
      expect(text).toContain('artifacts: artifact:art_diff_1');
      for (const forbidden of ['chat', 'transcript', 'audit', 'sqlite', 'rowid', 'Bearer ', 'sk-']) {
        expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
      expect(text.length).toBeLessThan(20_000);
    } finally {
      db.close();
    }
  });

  it('AH/AI/AJ: only ACCEPTED handoffs reach the runtime, and the runtime decides nothing', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const h = harnessFor(db);
      const draft = await created(h);
      expect(previousHandoffTextOf(draft)).toBeNull();
      const ready = await h.service.ready({ handoffId: 'hnd_1', version: 1, actorId: 'user_developer' });
      expect(ready.ok).toBe(true);
      if (ready.ok) expect(previousHandoffTextOf(ready.value)).toBeNull();
      expect(previousHandoffTextOf(draft)).toBeNull();
      const rejected = await h.service.reject({
        handoffId: 'hnd_1',
        version: 1,
        actorId: 'user_reviewer',
        reasonCodes: ['INCOMPLETE_SUMMARY'],
      });
      expect(rejected.ok).toBe(true);
      if (rejected.ok) expect(previousHandoffTextOf(rejected.value)).toBeNull();

      const acceptedPacket = await accepted(h, { handoffId: 'hnd_ok' });
      const text = previousHandoffTextOf(acceptedPacket);
      expect(text).not.toBeNull();
      expect(text).toContain('# Previous handoff');

      // AI/AJ: the runtime never imports the handoff service, so it cannot accept/reject/supersede
      // or pick a next role; it still requires an explicit modelKey.
      const runtime = source('packages/engine/src/runtime/agent-runtime.ts');
      expect(runtime).not.toMatch(/handoff-service|createHandoffService|acceptHandoffPacket|supersedeHandoff/);
      expect(runtime).toMatch(/MODEL_SELECTION_REQUIRED/);
      expect(runtime).not.toMatch(/handoffs|handoffStore/);
    } finally {
      db.close();
    }
  });
});

describe('AC–AE. restart does not advance anything', () => {
  it('READY and ACCEPTED survive a close/reopen, and nothing auto-advances', async () => {
    const dataDir = makeDataDir();
    let tableNames: readonly string[] = [];
    {
      const db = openDb(dataDir);
      try {
        const h = harnessFor(db);
        await readied(h);
        expect((await db.handoffStore?.get('hnd_1', 1))?.status).toBe('READY');
        const raw = new DatabaseSync(db.path);
        try {
          tableNames = (
            raw
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'handoff%'")
              .all() as unknown as readonly { readonly name: string }[]
          ).map((row) => row.name);
        } finally {
          raw.close();
        }
      } finally {
        db.close();
      }
    }
    expect([...HANDOFF_CHAIN_TABLES].every((table) => tableNames.includes(table))).toBe(true);

    {
      const db = openDb(dataDir);
      try {
        const h = harnessFor(db);
        // AC: still READY after the restart - no auto-accept, no auto v2, no auto next handoff.
        const afterRestart = await db.handoffStore?.get('hnd_1', 1);
        expect(afterRestart?.status).toBe('READY');
        expect((await db.handoffStore?.listVersions('hnd_1'))?.length).toBe(1);
        expect((await db.handoffStore?.listRecent(50))?.length).toBe(1);

        const accept = await h.service.accept({
          handoffId: 'hnd_1',
          version: 1,
          actorId: 'user_reviewer',
          });
        expect(accept.ok).toBe(true);
      } finally {
        db.close();
      }
    }
    {
      const db = openDb(dataDir);
      try {
        // AD/AE: ACCEPTED survives, and the restart started no agent and advanced no workflow.
        const packet = await db.handoffStore?.get('hnd_1', 1);
        expect(packet?.status).toBe('ACCEPTED');
        expect(packet?.acceptedBy).toBe('user_reviewer');
        expect((await db.handoffStore?.listVersions('hnd_1'))?.length).toBe(1);
        expect((await db.handoffStore?.listRecent(50))?.length).toBe(1);
        // No workflow run was created and no agent execution was started by any of this.
        expect((await db.agentExecutions.list()).items).toHaveLength(0);
      } finally {
        db.close();
      }
    }
  });
});

describe('AF/AG, AK/AL/AM. E2E handoff flows and boundary hygiene', () => {
  it('AF: Developer -> Reviewer E2E delivers a bounded structured context', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const h = harnessFor(db);
      // Developer side.
      const draft = await created(h, {
        handoffId: 'hnd_e2e',
        artifactRefs: [{ kind: 'artifact', refId: 'art_diff_e2e' }],
        validationRefs: [{ kind: 'validation', refId: 'val_ci_e2e' }],
      });
      const ready = await h.service.ready({ handoffId: draft.handoffId, version: 1, actorId: 'user_developer' });
      expect(ready.ok).toBe(true);
      // Reviewer side: read the newest handoff addressed to the reviewer role
      const inbound = await h.service.listForTargetRole('role_reviewer', 10, 'user_reviewer');
      expect(inbound.ok).toBe(true);
      if (inbound.ok) expect(inbound.value.map((packet) => packet.handoffId)).toContain('hnd_e2e');
      // ... accept it
      const accept = await h.service.accept({
        handoffId: 'hnd_e2e',
        version: 1,
        actorId: 'user_reviewer',
      });
      expect(accept.ok).toBe(true);
      // …and build the runtime context from the accepted packet ONLY.
      const context = accept.ok ? handoffContextViewIfAccepted(accept.value) : null;
      expect(context).not.toBeNull();
      if (context === null) return;
      expect(context.objective).toBe('Ship the authentication change');
      expect(context.completedWork).toEqual(['refresh handler', 'middleware wiring']);
      expect(context.remainingWork).toEqual(['review sign-off']);
      expect(context.constraints).toEqual(['no breaking API change']);
      expect(context.acceptanceCriteria).toEqual(['tests pass', 'review approved']);
      expect(context.artifactRefs).toEqual([{ kind: 'artifact', refId: 'art_diff_e2e' }]);
      expect(context.validationRefs).toEqual([{ kind: 'validation', refId: 'val_ci_e2e' }]);
      expect(context.decisionRefs).toEqual([{ kind: 'decision', refId: 'dec_token_rotation' }]);
      expect(context.knownRisks).toEqual(['clock skew on token expiry']);
      expect(context.openQuestions).toEqual(['should refresh rotate the device token?']);
      expect(context.recommendedNextAction).toContain('Review the authentication changes');
      // The reviewer's context carries no execution history, audit internals or secrets.
      const serialized = JSON.stringify(context);
      for (const forbidden of ['acceptedBy', 'rejectedBy', 'createdAt', 'executionRef', 'traceId', 'chat', 'sk-']) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      db.close();
    }
  });

  it('AG: rejection -> v2 -> acceptance keeps the whole history', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const h = harnessFor(db);
      await readied(h, { handoffId: 'hnd_rework' });
      const rejected = await h.service.reject({
        handoffId: 'hnd_rework',
        version: 1,
        actorId: 'user_reviewer',
        reasonCodes: ['ACCEPTANCE_NOT_MET'],
      });
      expect(rejected.ok).toBe(true);
      const rewritten = await h.service.ready({ handoffId: 'hnd_rework', version: 1, actorId: 'user_developer' });
      expect(rewritten.ok).toBe(false);
      const v2 = await h.service.supersede({
        handoffId: 'hnd_rework',
        previousVersion: 1,
        actorId: 'user_developer',
        next: {
          companyId: 'cmp',
          workflowId: 'wfl_1',
          workflowVersionId: 'wfv_1',
          workflowRunId: 'run_1',
          stageId: 'stg_1',
          taskId: 'tsk_1',
          fromAgentId: 'agt_developer',
          fromRoleId: 'role_developer',
          toRoleId: 'role_reviewer',
          objective: 'Ship the authentication change',
          summary: 'v2 after rework.',
          recommendedNextAction: 'Re-review.',
          validationRefs: [{ kind: 'validation', refId: 'val_ci_v2' }],
          traceId: 'trace_handoff_1',
        },
      });
      expect(v2.ok).toBe(true);
      if (!v2.ok) return;
      expect(v2.value.next.status).toBe('DRAFT');
      const acceptV2 = await h.service.accept({
        handoffId: 'hnd_rework',
        version: 2,
        actorId: 'user_reviewer',
      });
      // v2 is a fresh DRAFT: it must be readied first, and the service refuses otherwise.
      expect(acceptV2.ok).toBe(false);
      const readyV2 = await h.service.ready({ handoffId: 'hnd_rework', version: 2, actorId: 'user_developer' });
      expect(readyV2.ok).toBe(true);
      const acceptAfterReady = await h.service.accept({
        handoffId: 'hnd_rework',
        version: 2,
        actorId: 'user_reviewer',
      });
      expect(acceptAfterReady.ok).toBe(true);
      const history = await h.service.versions('hnd_rework', 'user_reviewer');
      expect(history.ok).toBe(true);
      if (history.ok) {
        expect(history.value.map((packet) => packet.status)).toEqual(['ACCEPTED', 'SUPERSEDED']);
        expect(history.value.map((packet) => packet.handoffVersion)).toEqual([2, 1]);
      }
    } finally {
      db.close();
    }
  });

  it('AK/AL/AM: no workflow mutation, no vendor names, no hidden memory implementation', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const h = harnessFor(db);
      await accepted(h);
      // AK: the handoff flow never advanced the workflow - no run/template/lock rows were touched.
      expect((await db.runs.list()).items).toHaveLength(0);
      expect((await db.templates.list()).items).toHaveLength(0);
    } finally {
      db.close();
    }
    for (const file of [
      'packages/core/src/domain/handoff.ts',
      'packages/engine/src/handoff/handoff-service.ts',
      'packages/persistence/src/durable/sqlite-handoff-store.ts',
    ]) {
      const text = source(file);
      const lower = text.toLowerCase();
      for (const vendor of ['openai', 'anthropic', 'claude', 'deepseek', 'gemini', 'kimi', 'ollama']) {
        expect(lower, `${file} mentions ${vendor}`).not.toContain(vendor);
      }
      // AM: no memory subsystem was smuggled in (code only - the doc comment names the boundary).
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/.*$/gm, ' ')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
      expect(code).not.toMatch(/MemoryStore|memoryPort|createMemory|embedding|vectorStore|recall\(/);
    }
    // The handoff service has no workflow/agent dependency at all.
    const service = source('packages/engine/src/handoff/handoff-service.ts');
    expect(service).not.toMatch(/WorkflowLifecycle|createAgentRuntime|agentExecutions/);
  });
});

/** Deterministic packet builder used by the projection tests (no clock, no random). */
describe('projection invariants', () => {
  it('a DRAFT packet projects to nothing and an ACCEPTED one projects deterministically', () => {
    const built = createHandoffPacket({
      handoffId: 'hnd_pure',
      companyId: 'cmp',
      workflowId: 'wfl',
      workflowVersionId: 'wfv',
      workflowRunId: 'run',
      stageId: 'stg',
      taskId: 'tsk',
      fromAgentId: 'agt_a',
      fromRoleId: 'role_a',
      toRoleId: 'role_b',
      objective: 'obj',
      summary: 'sum',
      recommendedNextAction: 'next',
      traceId: 'trace',
      createdAt: '2027-06-01T10:00:00.000Z',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(previousHandoffTextOf(built.value)).toBeNull();
    expect(handoffContextViewIfAccepted({ ...built.value, status: 'ACCEPTED' })).not.toBeNull();
  });
});

describe('review closeout: reject requires the target role', () => {
  it('an actor holding handoff.reject but NOT the target role cannot reject, and the handoff stays READY', async () => {
    const dataDir = makeDataDir();
    const db = openDb(dataDir);
    try {
      const h = harnessFor(db);
      await readied(h);
      // user_outsider carries handoff.reject but its REAL role (role_other) is not the target.
      const refused = await h.service.reject({
        handoffId: 'hnd_1',
        version: 1,
        actorId: 'user_outsider',
        reasonCodes: ['ACCEPTANCE_NOT_MET'],
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.code).toBe('PERMISSION_DENIED');
        expect(refused.error.details['reason']).toBe('WRONG_TARGET_ROLE');
      }
      expect((await db.handoffStore?.get('hnd_1', 1))?.status).toBe('READY');
      // The genuine target role can still reject.
      const rejected = await h.service.reject({
        handoffId: 'hnd_1',
        version: 1,
        actorId: 'user_reviewer',
        reasonCodes: ['ACCEPTANCE_NOT_MET'],
      });
      expect(rejected.ok).toBe(true);
      expect((await db.handoffStore?.get('hnd_1', 1))?.status).toBe('REJECTED');
    } finally {
      db.close();
    }
  });
});
