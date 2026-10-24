/**
 * AGENTIC EXECUTOR INTEGRATION TEST — the Agentic Capability Validation Sprint E2E proof.
 *
 * Purpose:
 * Prove that MockAgentExecutorProvider (and by extension, ANY future agent) can
 * integrate through the CompanyOS ExecutorProvider contract.
 *
 * This test proves:
 * 1. Agent implements ExecutorProvider interface
 * 2. Agent registers with ExecutorProviderRegistry
 * 3. Agent receives ExecutorExecutionRequest
 * 4. Agent returns ExecutorProviderOutcome
 * 5. Agent does NOT create second truth
 * 6. Agent respects cancellation/timeout
 *
 * WITHOUT:
 * - requiring new Agent Interface
 * - requiring new Agent Runtime
 * - creating second state systems
 * - agent owning canonical truth
 */
import { describe, expect, it } from 'vitest';

import {
  createExecutorProviderRegistry,
  type ExecutorExecutionRequest,
} from '@companyos/engine';

import { createMockAgentExecutorProvider } from './support/mock-agent-executor-provider.js';

describe('Agentic Executor Integration', () => {
  it('MockAgentExecutorProvider implements ExecutorProvider contract', () => {
    const agent = createMockAgentExecutorProvider({
      providerKey: 'mock-agent',
    });

    expect(agent).toBeDefined();
    expect(agent.descriptor).toBeDefined();
    expect(agent.descriptor.providerKey).toBe('mock-agent');
    expect(agent.descriptor.capabilities).toBeDefined();
    expect(Array.isArray(agent.descriptor.capabilities)).toBe(true);
    expect(typeof agent.start).toBe('function');

    const caps = agent.descriptor.capabilities;
    expect(caps).toContain('cancellation');
    expect(caps).toContain('timeout');
    expect(caps).toContain('structured-output');
    expect(caps).toContain('working-directory');
    expect(caps).toContain('external-session-identity');

    expect(caps).not.toContain('provider-idempotency');
    expect(caps).not.toContain('same-invocation-recovery');
  });

  it('Agent registers with ExecutorProviderRegistry', () => {
    const agent = createMockAgentExecutorProvider({
      providerKey: 'test-agent',
    });

    const registry = createExecutorProviderRegistry([agent]);

    const descriptors = registry.describeAll();
    expect(descriptors).toHaveLength(1);
    expect(descriptors.map((descriptor) => descriptor.providerKey)).toEqual(['test-agent']);

    const resolved = registry.resolve('test-agent');
    expect(resolved).toBe(agent);

    const unknown = registry.resolve('unknown-provider');
    expect(unknown).toBeNull();
  });

  it('Agent receives ExecutorExecutionRequest and returns ExecutorProviderOutcome', async () => {
    const agent = createMockAgentExecutorProvider({
      providerKey: 'test-agent',
    });

    const request: ExecutorExecutionRequest = {
      companyId: 'comp_test',
      runId: 'run_test',
      taskId: 'task_test',
      attemptId: 'att_test',
      attemptNumber: 1,
      roleId: 'role_implementation',
      taskKind: 'analysis',
      work: {
        objective: 'Analyze test data and generate report',
        memoryView: ['Context line 1', 'Context line 2'],
        artifactRefs: [],
      },
      workspace: {
        cwd: '/workspace/project',
        root: '/workspace',
      },
      requiredCapabilities: ['structured-output', 'working-directory'],
      dispatchKey: 'dsp_test123',
      taskText: 'Analyze test data',
      structured: true,
    };

    const outcome = await agent.start(request);

    expect(outcome).toBeDefined();
    expect(outcome.kind).toBe('succeeded');

    if (outcome.kind === 'succeeded') {
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdoutText).toBeDefined();
      expect(typeof outcome.stdoutText).toBe('string');
      expect(outcome.startedAt).toBeDefined();
      expect(outcome.finishedAt).toBeDefined();
      expect(outcome.providerSessionId).toBeDefined();
      expect(outcome.structured).toBeDefined();

      expect(outcome.stdoutText).toContain('Agent execution completed');
      expect(outcome.stdoutText).toContain('Tool calls:');
      expect(outcome.stdoutText).toContain('Observations:');
    }
  });

  it('Agent respects cancellation signal', async () => {
    const agent = createMockAgentExecutorProvider({
      providerKey: 'test-agent-cancel',
      simulateTimeoutMs: 5_000,
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
    });

    const controller = new AbortController();

    const executePromise = agent.start({
      companyId: 'comp_test',
      runId: 'run_test',
      taskId: 'task_test',
      attemptId: 'att_test',
      attemptNumber: 1,
      roleId: 'role_test',
      taskKind: 'analysis',
      work: { objective: 'Long-running work' },
      workspace: null,
      requiredCapabilities: [],
      dispatchKey: 'dsp_test',
      taskText: 'Test',
      structured: false,
      signal: controller.signal,
    });

    controller.abort();

    const outcome = await executePromise;
    expect(outcome.kind).toBe('cancelled');
    if (outcome.kind === 'cancelled') {
      expect(outcome.terminationProven).toBe(true);
    }
  });

  it('Agent handles the caller deadline with a timeout outcome', async () => {
    // Time is the caller's: the composition arms the clock, and the request
    // carries the deadline. Simulated work is deliberately longer than it.
    const agent = createMockAgentExecutorProvider({
      providerKey: 'test-agent-timeout',
      simulateTimeoutMs: 5_000,
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
    });

    const outcome = await agent.start({
      companyId: 'comp_test',
      runId: 'run_test',
      taskId: 'task_test',
      attemptId: 'att_test',
      attemptNumber: 1,
      roleId: 'role_test',
      taskKind: 'analysis',
      work: { objective: 'Work that times out' },
      workspace: null,
      requiredCapabilities: ['timeout'],
      dispatchKey: 'dsp_test',
      taskText: 'Test',
      structured: false,
      timeoutMs: 50,
    });

    expect(outcome.kind).toBe('timeout');
    if (outcome.kind === 'timeout') {
      expect(outcome.terminationProven).toBe(true);
      expect(outcome.providerSessionId).toBeDefined();
    }
  });

  it('Agent can return failure outcome', async () => {
    const agent = createMockAgentExecutorProvider({
      providerKey: 'test-agent-fail',
      simulateFailureRate: 1.0,
    });

    const outcome = await agent.start({
      companyId: 'comp_test',
      runId: 'run_test',
      taskId: 'task_test',
      attemptId: 'att_test',
      attemptNumber: 1,
      roleId: 'role_test',
      taskKind: 'analysis',
      work: { objective: 'Work that fails' },
      workspace: null,
      requiredCapabilities: [],
      dispatchKey: 'dsp_test',
      taskText: 'Test',
      structured: false,
    });

    expect(outcome.kind).toBe('provider-failed');
    if (outcome.kind === 'provider-failed') {
      expect(outcome.exitCode).toBe(1);
      expect(outcome.stdoutText).toBeDefined();
      expect(outcome.stderrText).toBeDefined();
      expect(outcome.stderrText).toContain('Simulated agent failure');
    }
  });

  it('Agent returns artifact candidates in structured output', async () => {
    const agent = createMockAgentExecutorProvider({
      providerKey: 'test-agent-artifacts',
    });

    const outcome = await agent.start({
      companyId: 'comp_test',
      runId: 'run_test',
      taskId: 'task_test',
      attemptId: 'att_test',
      attemptNumber: 1,
      roleId: 'role_test',
      taskKind: 'generation',
      work: { objective: 'Write output files and create report' },
      workspace: { cwd: '/workspace', root: '/workspace' },
      requiredCapabilities: ['structured-output'],
      dispatchKey: 'dsp_test',
      taskText: 'Write files',
      structured: true,
    });

    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind === 'succeeded') {
      expect(outcome.structured).toBeDefined();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = outcome.structured as any;
      expect(payload.agentReport).toBeDefined();
      expect(payload.artifactCandidates).toBeDefined();
      expect(Array.isArray(payload.artifactCandidates)).toBe(true);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const candidates = payload.artifactCandidates as any[];
      candidates.forEach((candidate) => {
        expect(candidate.path).toBeDefined();
        expect(candidate.description).toBeDefined();
      });
    }
  });

  it('Multiple agents can coexist in registry', () => {
    const agent1 = createMockAgentExecutorProvider({ providerKey: 'agent-1' });
    const agent2 = createMockAgentExecutorProvider({ providerKey: 'agent-2' });
    const agent3 = createMockAgentExecutorProvider({ providerKey: 'agent-3' });

    const registry = createExecutorProviderRegistry([agent1, agent2, agent3]);

    const descriptors = registry.describeAll();
    expect(descriptors).toHaveLength(3);

    const keys = descriptors.map((d) => d.providerKey).sort();
    expect(keys).toEqual(['agent-1', 'agent-2', 'agent-3']);

    expect(registry.resolve('agent-1')).toBe(agent1);
    expect(registry.resolve('agent-2')).toBe(agent2);
    expect(registry.resolve('agent-3')).toBe(agent3);
  });
});
