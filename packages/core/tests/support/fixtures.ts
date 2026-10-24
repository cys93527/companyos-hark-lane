/** Shared fixtures for the Core test-suite. Not a test file itself. */
import {
  FixedClock,
  SequenceIdFactory,
  type CommandContext,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from '@companyos/core';

export const EPOCH = Date.parse('2026-02-01T00:00:00.000Z');

export const makeClock = (): FixedClock => new FixedClock(EPOCH);

export const makeIds = (): SequenceIdFactory => new SequenceIdFactory();

export interface HarnessOptions {
  readonly actorId?: string;
  readonly traceId?: string;
  readonly now?: string;
}

export const makeCtx = (options: HarnessOptions = {}): CommandContext => ({
  actorId: options.actorId ?? 'user_owner',
  now: options.now ?? new Date(EPOCH).toISOString(),
  ids: makeIds(),
  traceId: options.traceId ?? 'trace_0001',
});

export const node = (id: string, kind = 'core.noop'): WorkflowNode => ({
  id,
  kind,
  title: `Node ${id}`,
  config: {},
});

export const edge = (from: string, to: string): WorkflowEdge => ({ from, to });

export const simpleGraph = (): WorkflowGraph => ({
  nodes: [node('n1'), node('n2')],
  edges: [edge('n1', 'n2')],
});

export const singleNodeGraph = (id = 'n1'): WorkflowGraph => ({
  nodes: [node(id)],
  edges: [],
});
