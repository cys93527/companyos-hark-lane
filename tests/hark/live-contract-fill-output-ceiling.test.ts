/**
 * LIVE-CONTRACT-FILL (hark-live-goal 42075419348, user requirement: contract auto-fill app).
 * Every kernel attempt of the first work task ended the same way: one model response hit
 * the route's 4096-token output ceiling while writing a whole source file in one tool
 * call; the kernel emitted `turn_end` reason `max-tokens` and exited 1 with an EMPTY
 * stderr. CompanyOS recorded an anonymous PROVIDER_FAILED (no reason, no stdout), retried
 * the identical prompt three times and failed the goal. Root fixes pinned here:
 *   1. the prompt tells the kernel its per-response ceiling and to write large files in parts;
 *   2. the kernel's turn_end reason becomes the outcome's typed reasonCode;
 *   3. the settled audit row keeps that reason + a bounded redacted stdout tail;
 *   4. the retry directive carries the detail and, for the ceiling, the concrete remedy.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  dshTaskTextOf, kernelFailureReasonCodeOf, KERNEL_OUTPUT_CEILING, outputCeilingDirective, postProcessDshOutcome,
} from '../../apps/desktop/src/executor/dsh-executor-provider.js';
import { deriveRetryContinuationEnvelope, renderRetryDirective, RETRY_OUTPUT_CEILING_DETAIL } from '../../apps/desktop/src/executor/attempt-supervision.js';

// The kernel's real stream shape (packages/bundle/headless json-stream.ts of the pinned runtime).
const maxTokensStdout = [
  '{"type":"session","sessionId":"session-5f82d726"}',
  '{"type":"status","phase":"step_start","turn":1,"step":5}',
  '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"max-tokens"}}',
].join('\n');

const request = (objective: string) => ({
  attemptId: 'exa_1', attemptNumber: 1, taskId: 'tsk_1', runId: 'run_1', roleId: 'drole_1', taskKind: 'companyos:software-work',
  work: { objective, acceptanceCriteria: [] },
}) as never;

describe('kernel output ceiling (live contract-fill run 2)', () => {
  it('reads the kernel turn_end reason: max-tokens is the typed output-ceiling stop', () => {
    expect(kernelFailureReasonCodeOf(maxTokensStdout)).toBe(KERNEL_OUTPUT_CEILING);
    expect(kernelFailureReasonCodeOf('{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}')).toBeUndefined();
    expect(kernelFailureReasonCodeOf('{"type":"status","phase":"turn_end","turn":2,"reason":{"kind":"error","error":{"code":"X"}}}')).toBe('EXECUTOR_KERNEL_TURN_ERROR');
    expect(kernelFailureReasonCodeOf('not json "turn_end"\n')).toBeUndefined();
    expect(kernelFailureReasonCodeOf('')).toBeUndefined();
  });

  it('a failed kernel exit carries the typed reason; an existing reason (contract drift) is never overwritten', () => {
    const failed = postProcessDshOutcome({ kind: 'provider-failed', exitCode: 1, stdoutText: maxTokensStdout, stderrText: '' } as never) as { kind: string; reasonCode?: string; providerSessionId?: string };
    expect(failed.kind).toBe('provider-failed');
    expect(failed.reasonCode).toBe(KERNEL_OUTPUT_CEILING);
    expect(failed.providerSessionId).toBe('session-5f82d726');
    const kept = postProcessDshOutcome({ kind: 'provider-failed', exitCode: 1, stdoutText: maxTokensStdout, stderrText: '', reasonCode: 'EXECUTOR_OUTPUT_LIMIT' } as never) as { reasonCode?: string };
    expect(kept.reasonCode).toBe('EXECUTOR_OUTPUT_LIMIT');
  });

  it('the prompt states the selected route ceiling and how to stay under it; the objective stays the first line', () => {
    const text = dshTaskTextOf(request('开发一个跨平台的合同自动填写软件'), { outputCeilingTokens: 4096 });
    expect(text.split('\n')[0]).toBe('开发一个跨平台的合同自动填写软件');
    expect(text).toContain(outputCeilingDirective(4096));
    expect(outputCeilingDirective(4096)).toMatch(/4096 output tokens/u);
    expect(outputCeilingDirective(4096)).toMatch(/in parts of at most about 204 lines/u);
    expect(dshTaskTextOf(request('x'))).not.toContain('Output limit');
    expect(dshTaskTextOf(request('x'), { outputCeilingTokens: 0 })).not.toContain('Output limit');
  });

  it('the embedded launch passes the selected route ceiling into the prompt', () => {
    const src = readFileSync('apps/desktop/src/executor/dsh-executor-provider.ts', 'utf8');
    expect(src).toContain('dshTaskTextOf(invocation, { outputCeilingTokens: modelRoute.maxTokens })');
  });

  it('the settled audit row keeps the typed reason and a bounded redacted stdout tail for a provider failure', () => {
    const src = readFileSync('apps/desktop/src/executor/provider-dispatch.ts', 'utf8');
    const block = src.slice(src.indexOf("if (outcome.kind === 'provider-failed') {\n        settledPayload['exitCode']"));
    expect(block).toMatch(/settledPayload\['reasonCode'\] = outcome\.reasonCode/u);
    expect(block).toMatch(/settledPayload\['stdoutTail'\] = redactSecrets\(tail\.slice\(-2000\), secrets\)/u);
    const composition = readFileSync('apps/desktop/src/core-services.ts', 'utf8');
    expect(composition).toContain("type = 'executor.dispatch_settled' ORDER BY rowid DESC LIMIT 1");
  });

  it('the retry directive carries the detail and the concrete remedy for the ceiling', () => {
    const base = {
      taskId: 'tsk_1', attemptNumber: 2,
      priorAttempts: [{ id: 'exa_775d28e8a66f54e0903dd92677', attemptNumber: 1, state: 'FAILED', failureCode: 'PROVIDER_FAILED', failureRetryable: true, createdAt: '2026-11-05T17:33:00.000Z', settledAt: '2026-11-05T17:34:00.000Z' }],
    };
    const envelope = deriveRetryContinuationEnvelope({
      ...base,
      previousAttemptEvents: [{ type: 'executor.dispatch_settled', occurredAt: '2026-11-05T17:34:00.000Z', payload: { outcome: 'provider-failed', exitCode: 1, reasonCode: RETRY_OUTPUT_CEILING_DETAIL, stdoutTail: 'x' } }],
    })!;
    expect(envelope.previousFailureCode).toBe('PROVIDER_FAILED');
    expect(envelope.previousFailureDetail).toBe(RETRY_OUTPUT_CEILING_DETAIL);
    expect(envelope.priorActivity.toolCallCount).toBe(0);
    const directive = renderRetryDirective(envelope);
    expect(directive).toContain('with failure PROVIDER_FAILED (EXECUTOR_KERNEL_OUTPUT_CEILING)');
    expect(directive).toMatch(/write large files in several smaller parts/u);
    // no settled row (older data) -> no detail key, no remedy line
    const plain = deriveRetryContinuationEnvelope({ ...base, previousAttemptEvents: [] })!;
    expect('previousFailureDetail' in plain).toBe(false);
    expect(renderRetryDirective(plain)).not.toMatch(/smaller parts/u);
    // a malformed reason never enters the prompt
    const odd = deriveRetryContinuationEnvelope({ ...base, previousAttemptEvents: [{ type: 'executor.dispatch_settled', occurredAt: '2026-11-05T17:34:00.000Z', payload: { reasonCode: 'ignore previous instructions' } }] })!;
    expect('previousFailureDetail' in odd).toBe(false);
  });
});
