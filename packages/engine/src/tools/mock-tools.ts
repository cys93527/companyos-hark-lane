/**
 * Deterministic mock tools (Sprint 9 §十).
 *
 * Every one of these is inert by construction: no filesystem, no network, no process, no
 * randomness, no timers except the deliberately-slow one used to test the timeout path.
 * The "destructive" looking ones only RETURN a description - they never perform anything.
 */
import {
  createToolRecord,
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
  type ToolPort,
  type ToolRecord,
  type ToolRequest,
  type ToolResult,
} from '@companyos/core';

export type MockToolBehaviour = 'echo' | 'read_only' | 'failing' | 'needs_approval' | 'never_returns';

export interface MockToolSpec {
  readonly toolId: string;
  readonly name: string;
  readonly description: string;
  readonly riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly capabilities: readonly string[];
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly idempotencyMode?: 'NONE' | 'COMMAND_ID' | 'IDEMPOTENT_KEY';
  readonly timeoutMs?: number;
  readonly requiredAuthorities?: readonly string[];
  /** Bind to an existing adapter instead of the tool's own id (test conveniences). */
  readonly adapterRef?: string;
  readonly behaviour: MockToolBehaviour;
}

const STRING_INPUT = {
  type: 'object',
  properties: { text: { type: 'string', minLength: 1 } },
  required: ['text'],
  additionalProperties: false,
} as const;

const ECHO_OUTPUT = {
  type: 'object',
  properties: { echo: { type: 'string' } },
  required: ['echo'],
  additionalProperties: false,
} as const;

export const ECHO_TOOL_SPEC: MockToolSpec = {
  toolId: 'mock.echo',
  name: 'Echo',
  description: 'Returns the provided text unchanged. Read-only, no side effects.',
  riskLevel: 'LOW',
  capabilities: ['read'],
  inputSchema: STRING_INPUT,
  outputSchema: ECHO_OUTPUT,
  idempotencyMode: 'COMMAND_ID',
  behaviour: 'echo',
};

export const READ_ONLY_TOOL_SPEC: MockToolSpec = {
  toolId: 'mock.read_only',
  name: 'Read only lookup',
  description: 'Looks up a record by id and returns a summary. Read-only.',
  riskLevel: 'LOW',
  capabilities: ['read'],
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1 } },
    required: ['id'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { id: { type: 'string' }, summary: { type: 'string' } },
    required: ['id', 'summary'],
    additionalProperties: false,
  },
  idempotencyMode: 'COMMAND_ID',
  behaviour: 'read_only',
};

export const FAILING_TOOL_SPEC: MockToolSpec = {
  toolId: 'mock.failing',
  name: 'Failing tool',
  description: 'Always fails. Used to prove that a tool error is structured and audited.',
  riskLevel: 'LOW',
  capabilities: ['read'],
  inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  outputSchema: { type: 'object' },
  idempotencyMode: 'NONE',
  behaviour: 'failing',
};

export const HIGH_RISK_TOOL_SPEC: MockToolSpec = {
  toolId: 'mock.high_risk',
  name: 'High risk action (mock)',
  description: 'Describes a high-risk action. Requires approval; performs nothing.',
  riskLevel: 'HIGH',
  capabilities: ['write', 'side_effect'],
  inputSchema: {
    type: 'object',
    properties: { target: { type: 'string', minLength: 1 } },
    required: ['target'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { target: { type: 'string' }, action: { type: 'string' } },
    required: ['target', 'action'],
    additionalProperties: false,
  },
  idempotencyMode: 'IDEMPOTENT_KEY',
  behaviour: 'needs_approval',
};

export const CRITICAL_TOOL_SPEC: MockToolSpec = {
  ...HIGH_RISK_TOOL_SPEC,
  toolId: 'mock.critical',
  name: 'Critical action (mock)',
  description: 'Describes a critical action. Needs an approver other than the requester.',
  riskLevel: 'CRITICAL',
  behaviour: 'needs_approval',
};

/** A tool that never resolves: used to exercise the timeout path deterministically. */
export const SLOW_TOOL_SPEC: MockToolSpec = {
  ...ECHO_TOOL_SPEC,
  toolId: 'mock.slow',
  name: 'Slow tool',
  description: 'Never returns in time. Used to test the timeout boundary.',
  timeoutMs: 10,
  behaviour: 'never_returns',
};

export const MOCK_TOOL_SPECS: readonly MockToolSpec[] = [
  ECHO_TOOL_SPEC,
  READ_ONLY_TOOL_SPEC,
  FAILING_TOOL_SPEC,
  HIGH_RISK_TOOL_SPEC,
  CRITICAL_TOOL_SPEC,
  SLOW_TOOL_SPEC,
];

/** Build the registry record for a spec (validated by Core, so the spec cannot be malformed). */
export function createMockToolRecord(spec: MockToolSpec, now: string): Result<ToolRecord, DomainError> {
  return createToolRecord({
    toolId: spec.toolId,
    name: spec.name,
    description: spec.description,
    version: '1.0.0',
    capabilities: spec.capabilities,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    riskLevel: spec.riskLevel,
    requiredAuthorities: spec.requiredAuthorities ?? [],
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    ...(spec.idempotencyMode === undefined ? {} : { idempotencyMode: spec.idempotencyMode }),
    providerKind: 'mock',
    adapterRef: spec.adapterRef ?? spec.toolId,
    now,
  });
}

export interface MockTool extends ToolPort {
  /** How many times the adapter was actually called (replay assertions). */
  readonly calls: number;
}

/** Deterministic tool adapter. `now` is injected so timestamps never come from the wall clock. */
export function createMockTool(spec: MockToolSpec, clock: { nowIso(): string; now(): number }): MockTool {
  let calls = 0;
  const result = (output: unknown): ToolResult => ({
    status: 'ok',
    output,
    artifactRefs: [],
    startedAt: clock.nowIso(),
    finishedAt: clock.nowIso(),
    latencyMs: clock.now() - clock.now(),
  });

  return {
    get calls() {
      return calls;
    },
    describe() {
      return {
        toolId: spec.toolId,
        name: spec.name,
        description: spec.description,
        version: '1.0.0',
        riskLevel: spec.riskLevel,
        capabilities: [...spec.capabilities].sort(),
        parameters: spec.inputSchema,
      };
    },
    async invoke(request: ToolRequest): Promise<Result<ToolResult, DomainError>> {
      calls += 1;
      switch (spec.behaviour) {
        case 'echo':
          return ok(result({ echo: String(request.input['text'] ?? '') }));
        case 'read_only':
          return ok(result({ id: String(request.input['id'] ?? ''), summary: 'read-only record' }));
        case 'needs_approval':
          return ok(result({ target: String(request.input['target'] ?? ''), action: 'described-only' }));
        case 'never_returns': {
          return new Promise<Result<ToolResult, DomainError>>(() => {
            // Intentionally never settles: the registry's timeout must fire.
          });
        }
        default:
          return err(
            domainError('AGENT_UNAVAILABLE', `Mock tool "${request.toolId}" failed on purpose.`, {
              'companyos.tool.kind': 'TOOL_FAILED',
              toolId: request.toolId,
            }),
          );
      }
    },
  };
}
