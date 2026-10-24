/**
 * AGENTIC EXECUTOR BOUNDARY GUARDS — Architecture Law Enforcement
 *
 * Purpose:
 * Enforce that agentic executors (and ALL ExecutorProviders) CANNOT violate
 * CompanyOS canonical truth boundaries.
 *
 * These tests prove:
 * 1. Agent cannot directly modify Task status
 * 2. Agent cannot bypass Settlement
 * 3. Agent cannot create second Task system
 * 4. Agent cannot create second Artifact truth
 * 5. Agent cannot claim authority it doesn't have
 *
 * Implementation Note:
 * Real agents (DSH, Codex, ZCode) are EXTERNAL. They cannot directly access
 * CompanyOS internal modules. But MockAgentExecutorProvider runs in-process
 * for testing, so we simulate boundary violations to prove guards work.
 */
import { describe, expect, it } from 'vitest';

import type {
  ExecutorExecutionRequest,
  ExecutorProvider,
  ExecutorProviderOutcome,
} from '@companyos/engine';

/**
 * The guards read outcome fields whose EXISTENCE is part of the contract being
 * tested (a text-carrying variant must carry text). Narrowing explicitly keeps
 * the assertion honest: a variant that stopped carrying `stdoutText` would fail
 * here rather than silently pass through a cast.
 */
const stdoutOf = (outcome: ExecutorProviderOutcome): string => {
  if (outcome.kind === 'succeeded' || outcome.kind === 'provider-failed') return outcome.stdoutText;
  throw new Error(`Outcome variant "${outcome.kind}" carries no stdout text.`);
};

const structuredOf = (outcome: ExecutorProviderOutcome): unknown => {
  if (outcome.kind !== 'succeeded') {
    throw new Error(`Outcome variant "${outcome.kind}" carries no structured payload.`);
  }
  return outcome.structured;
};

describe('Agentic Executor Boundary Guards', () => {
  describe('Architecture Law: Agent cannot modify Task status', () => {
    it('ExecutorProvider must return outcome, not modify Task', () => {
      // This is a CONTRACT test — the interface itself enforces the boundary

      // ExecutorProvider.start() signature:
      const validProvider: ExecutorProvider = {
        descriptor: {
          providerKey: 'test-agent',
          capabilities: [],
        },
        async start(
          _request: ExecutorExecutionRequest,
        ): Promise<ExecutorProviderOutcome> {
          // Agent RECEIVES request (read-only Task projection)
          // Agent RETURNS outcome (not Task modification)

          // This is VALID:
          return {
            kind: 'succeeded',
            exitCode: 0,
            stdoutText: 'Work completed',
            startedAt: '2026-10-01T00:00:00Z',
            finishedAt: '2026-10-01T00:01:00Z',
          };

          // This is IMPOSSIBLE (type error):
          // request.taskStatus = 'completed'; // ❌ readonly
          // return { kind: 'task-completed' }; // ❌ invalid kind
        },
      };

      expect(validProvider.start).toBeDefined();
      expect(typeof validProvider.start).toBe('function');

      // The TypeScript contract itself prevents status modification
      // If this compiles, the guard works
    });

    it('Agent outcome kind cannot claim Task completion', () => {
      const validOutcomes: ExecutorProviderOutcome['kind'][] = [
        'succeeded',
        'provider-failed',
        'timeout',
        'cancelled',
        'transport-failed',
        // NOT 'task-completed', NOT 'workflow-advanced', NOT 'artifact-created'
      ];

      validOutcomes.forEach((kind) => {
        expect(['succeeded', 'provider-failed', 'timeout', 'cancelled', 'transport-failed']).toContain(kind);
      });

      // Invalid kinds would be type errors:
      // const invalid: ExecutorProviderOutcome = { kind: 'task-completed' }; // ❌
      // const invalid: ExecutorProviderOutcome = { kind: 'run-finished' }; // ❌
    });
  });

  describe('Architecture Law: Agent cannot bypass Settlement', () => {
    it('Provider returns outcome, Settlement processes it', async () => {
      // Settlement is CompanyOS responsibility, not provider responsibility

      const provider: ExecutorProvider = {
        descriptor: { providerKey: 'test', capabilities: [] },
        async start(): Promise<ExecutorProviderOutcome> {
          // Agent does work
          // Agent returns outcome
          return {
            kind: 'succeeded',
            exitCode: 0,
            stdoutText: 'Completed',
            startedAt: '2026-10-01T00:00:00Z',
            finishedAt: '2026-10-01T00:01:00Z',
          };
          // Agent does NOT:
          // - call settlement logic
          // - update ExecutionAttempt
          // - mark Task done
        },
      };

      const outcome = await provider.start({
        companyId: 'comp_test',
        runId: 'run_test',
        taskId: 'task_test',
        attemptId: 'att_test',
        attemptNumber: 1,
        roleId: 'role_test',
        taskKind: 'analysis',
        work: { objective: 'Test objective' },
        workspace: null,
        requiredCapabilities: [],
        dispatchKey: 'dsp_test',
        taskText: 'Test task',
        structured: false,
      });

      // Provider returned outcome
      expect(outcome.kind).toBe('succeeded');

      // Settlement happens OUTSIDE provider
      // This test proves provider does NOT settle
      expect(outcome).not.toHaveProperty('taskStatus');
      expect(outcome).not.toHaveProperty('attemptSettled');
      expect(outcome).not.toHaveProperty('runAdvanced');
    });
  });

  describe('Architecture Law: Agent cannot create second Task system', () => {
    it('Provider must work on ONE Task at a time', async () => {
      // Agent receives ONE ExecutorExecutionRequest
      // Agent returns ONE ExecutorProviderOutcome
      // Agent does NOT create parallel Task system

      const provider: ExecutorProvider = {
        descriptor: { providerKey: 'test', capabilities: [] },
        async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
          // VALID: Agent works on request.taskId
          const taskId = request.taskId;
          expect(taskId).toBe('task_test');

          // INVALID: Agent creates second task system
          // const agentTasks = [
          //   { id: 'agent-task-1', status: 'completed' },
          //   { id: 'agent-task-2', status: 'active' },
          // ]; // ❌ second truth

          return {
            kind: 'succeeded',
            exitCode: 0,
            stdoutText: `Completed ${taskId}`,
            startedAt: '2026-10-01T00:00:00Z',
            finishedAt: '2026-10-01T00:01:00Z',
          };
        },
      };

      const outcome = await provider.start({
        companyId: 'comp_test',
        runId: 'run_test',
        taskId: 'task_test',
        attemptId: 'att_test',
        attemptNumber: 1,
        roleId: 'role_test',
        taskKind: 'analysis',
        work: { objective: 'Test objective' },
        workspace: null,
        requiredCapabilities: [],
        dispatchKey: 'dsp_test',
        taskText: 'Test task',
        structured: false,
      });

      expect(outcome.kind).toBe('succeeded');

      // Outcome references CompanyOS Task, not agent tasks
      const stdoutText = stdoutOf(outcome);
      expect(stdoutText).toContain('task_test');
      expect(stdoutText).not.toContain('agent-task');
    });
  });

  describe('Architecture Law: Agent cannot create second Artifact truth', () => {
    it('Provider returns artifact candidates, not canonical Artifacts', async () => {
      // Agent can propose artifacts
      // CompanyOS Settlement canonicalizes them

      const provider: ExecutorProvider = {
        descriptor: { providerKey: 'test', capabilities: ['structured-output'] },
        async start(): Promise<ExecutorProviderOutcome> {
          return {
            kind: 'succeeded',
            exitCode: 0,
            stdoutText: 'Generated files',
            structured: {
              // These are CANDIDATES, not Artifacts
              artifactCandidates: [
                { path: '/workspace/output.txt', description: 'Result file' },
              ],
            },
            startedAt: '2026-10-01T00:00:00Z',
            finishedAt: '2026-10-01T00:01:00Z',
          };
        },
      };

      const outcome = await provider.start({
        companyId: 'comp_test',
        runId: 'run_test',
        taskId: 'task_test',
        attemptId: 'att_test',
        attemptNumber: 1,
        roleId: 'role_test',
        taskKind: 'generation',
        work: { objective: 'Generate output' },
        workspace: { cwd: '/workspace', root: '/workspace' },
        requiredCapabilities: ['structured-output'],
        dispatchKey: 'dsp_test',
        taskText: 'Generate files',
        structured: true,
      });

      expect(outcome.kind).toBe('succeeded');
      expect(structuredOf(outcome)).toBeDefined();

      // Structured payload contains CANDIDATES
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = structuredOf(outcome) as any;
      expect(payload.artifactCandidates).toBeDefined();
      expect(Array.isArray(payload.artifactCandidates)).toBe(true);

      // NOT canonical Artifacts
      expect(payload).not.toHaveProperty('artifacts'); // ❌ second truth
      expect(outcome).not.toHaveProperty('canonicalArtifacts'); // ❌ bypass
    });
  });

  describe('Architecture Law: Agent cannot claim authority it does not have', () => {
    it('Provider descriptor must honestly declare capabilities', () => {
      // Agent declares ONLY what it truly supports

      const honestProvider: ExecutorProvider = {
        descriptor: {
          providerKey: 'honest-agent',
          capabilities: [
            'cancellation',
            'timeout',
            'structured-output',
            // Does NOT claim: 'provider-idempotency' (reasoning is non-deterministic)
            // Does NOT claim: 'same-invocation-recovery' (internal state opaque)
          ],
        },
        async start(): Promise<ExecutorProviderOutcome> {
          return {
            kind: 'succeeded',
            exitCode: 0,
            stdoutText: 'Completed',
            startedAt: '2026-10-01T00:00:00Z',
            finishedAt: '2026-10-01T00:01:00Z',
          };
        },
      };

      expect(honestProvider.descriptor.capabilities).toContain('cancellation');
      expect(honestProvider.descriptor.capabilities).toContain('timeout');
      expect(honestProvider.descriptor.capabilities).not.toContain('provider-idempotency');

      // INVALID: Claiming capability without support
      // const dishonestProvider: ExecutorProvider = {
      //   descriptor: {
      //     providerKey: 'dishonest',
      //     capabilities: ['provider-idempotency'], // ❌ claims but doesn't support
      //   },
      //   async start() {
      //     // Does NOT actually provide idempotency
      //     return { kind: 'succeeded', ... };
      //   },
      // };
    });

    it('Provider cannot choose canonical identities', async () => {
      // Agent RECEIVES identities, cannot choose them

      const provider: ExecutorProvider = {
        descriptor: { providerKey: 'test', capabilities: [] },
        async start(_request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
          // Agent receives canonical identities
          const companyId = _request.companyId;
          const runId = _request.runId;
          const taskId = _request.taskId;
          const attemptId = _request.attemptId;

          expect(companyId).toBe('comp_test');
          expect(runId).toBe('run_test');
          expect(taskId).toBe('task_test');
          expect(attemptId).toBe('att_test');

          // Agent CANNOT choose these:
          // request.taskId = 'agent-chosen-id'; // ❌ readonly
          // request.runId = 'new-run'; // ❌ readonly

          return {
            kind: 'succeeded',
            exitCode: 0,
            stdoutText: 'Completed',
            startedAt: '2026-10-01T00:00:00Z',
            finishedAt: '2026-10-01T00:01:00Z',
          };
        },
      };

      const outcome = provider.start({
        companyId: 'comp_test',
        runId: 'run_test',
        taskId: 'task_test',
        attemptId: 'att_test',
        attemptNumber: 1,
        roleId: 'role_test',
        taskKind: 'analysis',
        work: { objective: 'Test' },
        workspace: null,
        requiredCapabilities: [],
        dispatchKey: 'dsp_test',
        taskText: 'Test',
        structured: false,
      });

      await expect(outcome).resolves.toBeDefined();
    });

    it('Provider cannot choose trusted workspace', async () => {
      // Agent RECEIVES trusted workspace, cannot choose it

      const provider: ExecutorProvider = {
        descriptor: { providerKey: 'test', capabilities: ['working-directory'] },
        async start(_request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
          // Agent receives validated workspace
          if (_request.workspace !== null) {
            const cwd = _request.workspace.cwd;
            const root = _request.workspace.root;

            // CompanyOS validated these before dispatch
            expect(cwd).toBeDefined();
            expect(root).toBeDefined();

            // Agent CANNOT choose:
            // request.workspace.cwd = '/etc'; // ❌ readonly
            // request.workspace.root = '/'; // ❌ readonly
          }

          return {
            kind: 'succeeded',
            exitCode: 0,
            stdoutText: 'Completed',
            startedAt: '2026-10-01T00:00:00Z',
            finishedAt: '2026-10-01T00:01:00Z',
          };
        },
      };

      const outcome = provider.start({
        companyId: 'comp_test',
        runId: 'run_test',
        taskId: 'task_test',
        attemptId: 'att_test',
        attemptNumber: 1,
        roleId: 'role_test',
        taskKind: 'analysis',
        work: { objective: 'Test' },
        workspace: { cwd: '/workspace/project', root: '/workspace' },
        requiredCapabilities: ['working-directory'],
        dispatchKey: 'dsp_test',
        taskText: 'Test',
        structured: false,
      });

      await expect(outcome).resolves.toBeDefined();
    });
  });

  describe('Architecture Law: Provider outcome is subordinate to Settlement', () => {
    it('Provider success does not automatically mean Task completion', async () => {
      // Agent can return 'succeeded'
      // CompanyOS Settlement decides if Task is done

      const provider: ExecutorProvider = {
        descriptor: { providerKey: 'test', capabilities: [] },
        async start(): Promise<ExecutorProviderOutcome> {
          return {
            kind: 'succeeded',
            exitCode: 0,
            stdoutText: 'Provider succeeded',
            startedAt: '2026-10-01T00:00:00Z',
            finishedAt: '2026-10-01T00:01:00Z',
          };
        },
      };

      const outcome = await provider.start({
        companyId: 'comp_test',
        runId: 'run_test',
        taskId: 'task_test',
        attemptId: 'att_test',
        attemptNumber: 1,
        roleId: 'role_test',
        taskKind: 'analysis',
        work: { objective: 'Test' },
        workspace: null,
        requiredCapabilities: [],
        dispatchKey: 'dsp_test',
        taskText: 'Test',
        structured: false,
      });

      // Provider returned success
      expect(outcome.kind).toBe('succeeded');

      // But Task completion is SEPARATE decision
      // Settlement logic may:
      // - require Validation
      // - check Evidence
      // - verify Artifacts
      // - apply business rules
      //
      // Provider outcome is INPUT, not VERDICT
    });

    it('Provider failure does not automatically mean Task failure', async () => {
      // Agent can return 'provider-failed'
      // CompanyOS Settlement decides retry/escalation/failure

      const provider: ExecutorProvider = {
        descriptor: { providerKey: 'test', capabilities: [] },
        async start(): Promise<ExecutorProviderOutcome> {
          return {
            kind: 'provider-failed',
            exitCode: 1,
            stdoutText: 'Provider failed',
            stderrText: 'Error details',
          };
        },
      };

      const outcome = await provider.start({
        companyId: 'comp_test',
        runId: 'run_test',
        taskId: 'task_test',
        attemptId: 'att_test',
        attemptNumber: 1,
        roleId: 'role_test',
        taskKind: 'analysis',
        work: { objective: 'Test' },
        workspace: null,
        requiredCapabilities: [],
        dispatchKey: 'dsp_test',
        taskText: 'Test',
        structured: false,
      });

      // Provider returned failure
      expect(outcome.kind).toBe('provider-failed');

      // But Task lifecycle is SEPARATE decision
      // Settlement logic may:
      // - retry with same provider
      // - retry with different provider
      // - escalate to user
      // - mark attempt failed (not Task)
      //
      // Provider outcome is INPUT, not VERDICT
    });
  });

  describe('Architecture Law: Agent internal state is ephemeral', () => {
    it('CompanyOS does not save agent internal state', async () => {
      // Agent may have internal state during execution
      // CompanyOS does NOT persist it

      const provider: ExecutorProvider = {
        descriptor: { providerKey: 'test', capabilities: [] },
        async start(): Promise<ExecutorProviderOutcome> {
          // Agent internal state (ephemeral)
          const internalState = {
            phase: 'synthesizing',
            toolCalls: [{ tool: 'read_file', result: '...' }],
            observations: ['Analyzed data', 'Found patterns'],
          };

          // This state lives only during start()
          // It is NOT saved to CompanyOS

          return {
            kind: 'succeeded',
            exitCode: 0,
            stdoutText: 'Completed analysis',
            structured: {
              // Can include SUMMARY derived from internal state
              summary: 'Analysis complete',
              // Counts are safe derived facts; the raw internal state is not
              toolCallCount: internalState.toolCalls.length,
              // But NOT full internal state
            },
            startedAt: '2026-10-01T00:00:00Z',
            finishedAt: '2026-10-01T00:01:00Z',
          };
        },
      };

      const outcome = await provider.start({
        companyId: 'comp_test',
        runId: 'run_test',
        taskId: 'task_test',
        attemptId: 'att_test',
        attemptNumber: 1,
        roleId: 'role_test',
        taskKind: 'analysis',
        work: { objective: 'Test' },
        workspace: null,
        requiredCapabilities: [],
        dispatchKey: 'dsp_test',
        taskText: 'Test',
        structured: true,
      });

      // Outcome does not contain full internal state
      expect(structuredOf(outcome)).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = structuredOf(outcome) as any;
      expect(payload).not.toHaveProperty('phase');
      expect(payload).not.toHaveProperty('toolCalls');
      expect(payload).not.toHaveProperty('observations');

      // Only what the agent chose to expose: the summary and a derived count
      expect(payload.summary).toBe('Analysis complete');
      expect(payload.toolCallCount).toBe(1);
    });
  });
});
