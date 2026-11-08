/**
 * LIVE-CONTRACT-FILL run 9 (hark-live-goal 42429421366) — CREDIT A TIMED-OUT ATTEMPT'S VERIFIED WORK.
 *
 * Step 1's first attempt ran out of time with its tests passing (5 pass, 0 fail), but because the
 * kernel never gave a final answer the attempt was a plain TIMEOUT: the retry re-read the project,
 * the step's spend share ran out and the goal blocked with nothing finished. A step whose work is
 * already verified must not be thrown away or blindly retried.
 *
 * CompanyOS never runs kernel-written code itself (that would leave the kernel sandbox and the
 * Windows isolation). It reads the kernel's OWN stream instead: every `tool_call` / `tool_result`
 * line of the attempt is observed live. The attempt is credited only when ALL of these hold:
 *  - it ended by its time budget or the step's spend cap (timeout, or the broker's deadline/budget
 *    refusal), not by cancellation or a transport failure;
 *  - its LAST test run (npm/pnpm/yarn test, node --test, vitest, jest, mocha, pytest, …) completed
 *    with a recognised summary of >= 1 passed and 0 failed tests;
 *  - nothing that can change the workspace ran after that test run;
 *  - every acceptance criterion of the step is proven by a passing test named with its id in
 *    brackets (`[criterion-id] …`) and by no failing or skipped one;
 *  - the step does not require a declared file delivery (that needs the kernel's own JSON report).
 * Otherwise the attempt stays a resumable timeout and the retry continues from the attempt notes.
 */

export const TEST_COMMAND_PATTERN =
  /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bnpx\s+(?:vitest|jest|mocha)\b|\bnode\s+(?:--[\w-]+(?:=\S+)?\s+)*--test\b|\bvitest\b|\bjest\b|\bmocha\b|\bpytest\b|\bpython3?\s+-m\s+(?:pytest|unittest)\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b/iu;

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read', 'read_file', 'view', 'glob', 'grep', 'ls', 'list', 'list_dir', 'find', 'search', 'todo', 'todoread', 'todowrite', 'todo_read', 'todo_write', 'think',
]);
const READ_ONLY_COMMAND = /^\s*(?:Get-Content|gc|cat|type|Get-ChildItem|gci|ls|dir|Select-String|sls|Test-Path|Get-Item|Resolve-Path|pwd|Get-Location|echo|Write-Output|Write-Host|git\s+(?:status|diff|log|show)|node\s+(?:-v|--version)|npm\s+(?:ls|view|-v|--version))\b/iu;
const WRITING_COMMAND = />|\b(?:Set-Content|Add-Content|Out-File|Remove-Item|New-Item|Copy-Item|Move-Item|Rename-Item|rm|del|mv|cp|mkdir|npm\s+(?:i|install|ci|uninstall)|git\s+(?:checkout|reset|apply|commit))\b/iu;

export interface TestRunSummary {
  readonly command: string;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

const firstInt = (text: string, patterns: readonly RegExp[]): number | null => {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return null;
};
/** The largest count any pattern reports (runners print one summary; only zero vs non-zero gates). */
const maxInts = (text: string, patterns: readonly RegExp[]): number => {
  let max = 0;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1] !== undefined) max = Math.max(max, Number(match[1]));
  }
  return max;
};

/** Pass/fail counts from a recognised test-runner summary; null when no summary is recognised. */
export const testRunCountsOf = (output: string): { readonly passed: number; readonly failed: number; readonly skipped: number } | null => {
  const passed = firstInt(output, [
    /^\s*(?:ℹ|#)\s*pass\s+(\d+)\s*$/mu, // node:test (spec + tap)
    /^\s*Tests\s+(?:\d+\s+failed\s*\|\s*)?(\d+)\s+passed/mu, // vitest
    /^\s*Tests:\s+(?:\d+\s+failed,\s*)?(?:\d+\s+skipped,\s*)?(?:\d+\s+todo,\s*)?(\d+)\s+passed/mu, // jest
    /^\s*(\d+)\s+passing\b/mu, // mocha
    /^=*\s*(?:.*?,\s*)?(\d+)\s+passed\b/mu, // pytest
  ]);
  if (passed === null) return null;
  const failed = maxInts(output, [
    /^\s*(?:ℹ|#)\s*fail\s+(\d+)\s*$/mu,
    /^\s*(?:ℹ|#)\s*cancelled\s+(\d+)\s*$/mu,
    /^\s*(\d+)\s+failing\b/mu,
    /\b(\d+)\s+failed\b/u,
    /\b(\d+)\s+errors?\b/u,
  ]);
  const skipped = maxInts(output, [/^\s*(?:ℹ|#)\s*skipped\s+(\d+)\s*$/mu, /^\s*(\d+)\s+pending\b/mu, /\b(\d+)\s+skipped\b/u]);
  return { passed, failed, skipped };
};

export type CriterionTestState = 'pass' | 'fail' | 'skip';
const LEAD_PASS = /^\s*(?:✔|✓|√|ok\s+\d+\b)/u;
const LEAD_FAIL = /^\s*(?:✖|✗|×|✕|not ok\b|\d+\)\s)/u;
const LEAD_SKIP = /^\s*(?:﹣|↓|○|-\s)/u;
const SKIP_DIRECTIVE = /#\s*(?:SKIP|TODO)\b|\bSKIPPED\b/u;
const FAIL_WORD = /\bFAIL(?:ED)?\b/u;
const PASS_WORD = /\bPASS(?:ED)?\b/u;

/** One test line's verdict: the runner's leading marker first, then pytest-style status words. */
const lineVerdictOf = (line: string): CriterionTestState | null => {
  if (LEAD_FAIL.test(line)) return 'fail';
  if (LEAD_SKIP.test(line)) return 'skip';
  if (LEAD_PASS.test(line)) return SKIP_DIRECTIVE.test(line) ? 'skip' : 'pass';
  if (FAIL_WORD.test(line)) return 'fail';
  if (SKIP_DIRECTIVE.test(line)) return 'skip';
  if (PASS_WORD.test(line)) return 'pass';
  return null;
};

/** Each criterion id named in brackets on a test line, with that line's verdict(s). */
export const criterionTestStatesOf = (output: string, criterionIds: readonly string[]): ReadonlyMap<string, readonly CriterionTestState[]> => {
  const states = new Map<string, CriterionTestState[]>();
  for (const line of output.split(/\r?\n/u)) {
    for (const id of criterionIds) {
      if (!line.includes(`[${id}]`)) continue;
      const state = lineVerdictOf(line);
      if (state === null) continue;
      states.set(id, [...(states.get(id) ?? []), state]);
    }
  }
  return states;
};

export interface VerifiedTestRun extends TestRunSummary {
  /** The test run's output (bounded) — the criterion mapping reads it. */
  readonly output: string;
}

export interface VerifiedWorkEvidence {
  /** The last test run of the attempt when it passed; null when none passed or the last one failed. */
  readonly lastPassingRun: VerifiedTestRun | null;
  /** True when something that can change the workspace ran after that passing test run. */
  readonly changedSinceRun: boolean;
  /** Test runs observed in the attempt (any verdict). */
  readonly testRuns: number;
}

type CallKind = 'test' | 'read-only' | 'mutating';
const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const callKindOf = (tool: string, input: Record<string, unknown>): { readonly kind: CallKind; readonly command: string } => {
  const command = textOf(input['command']) ?? textOf(input['cmd']) ?? textOf(input['script']);
  if (command !== null) {
    if (TEST_COMMAND_PATTERN.test(command) && !/\b(?:npm|pnpm|yarn)\s+(?:i|install|add|ci)\b/iu.test(command)) return { kind: 'test', command };
    if (READ_ONLY_COMMAND.test(command) && !WRITING_COMMAND.test(command)) return { kind: 'read-only', command };
    return { kind: 'mutating', command };
  }
  return { kind: READ_ONLY_TOOLS.has(tool.toLowerCase()) ? 'read-only' : 'mutating', command: tool };
};

const OUTPUT_MAX = 64 * 1024;
const resultTextOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
};

/** Observes the kernel's JSON stream line by line for one attempt (live tap; bounded state). */
export const createVerifiedWorkTracker = () => {
  const pending = new Map<string, { readonly kind: CallKind; readonly command: string }>();
  let lastPendingId: string | null = null;
  let anonymous = 0;
  let lastPassingRun: VerifiedTestRun | null = null;
  let changedSinceRun = false;
  let testRuns = 0;
  const observe = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || (!trimmed.includes('tool_call') && !trimmed.includes('tool_result'))) return;
    let event: Record<string, unknown>;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
      event = value as Record<string, unknown>;
    } catch { return; }
    if (event['type'] === 'tool_call') {
      const tool = textOf(event['tool']) ?? '?';
      const input = typeof event['input'] === 'object' && event['input'] !== null ? (event['input'] as Record<string, unknown>) : {};
      const call = callKindOf(tool, input);
      const id = textOf(event['callId']) ?? textOf(event['id']) ?? `anon-${String(++anonymous)}`;
      pending.set(id, call);
      lastPendingId = id;
      // A call that can change the workspace invalidates the last passing run at once (even if it never returns).
      if (call.kind === 'mutating') changedSinceRun = true;
      return;
    }
    if (event['type'] === 'tool_result') {
      const id = textOf(event['callId']) ?? textOf(event['id']) ?? lastPendingId;
      if (id === null) return;
      const call = pending.get(id);
      pending.delete(id);
      if (call === undefined || call.kind !== 'test') return;
      testRuns += 1;
      const output = resultTextOf(event['result']).slice(-OUTPUT_MAX);
      const counts = testRunCountsOf(output);
      const statusOk = event['status'] === undefined || event['status'] === 'completed' || event['status'] === 'success' || event['status'] === 'ok';
      if (statusOk && counts !== null && counts.passed > 0 && counts.failed === 0) {
        lastPassingRun = { command: call.command, ...counts, output };
        changedSinceRun = false;
      } else {
        lastPassingRun = null;
      }
    }
  };
  return {
    observe,
    evidence: (): VerifiedWorkEvidence => ({ lastPassingRun, changedSinceRun, testRuns }),
  };
};

/** Did the attempt end by its time budget or the step/goal spend cap (the creditable endings)? */
export const endedByTimeOrCap = (outcome: { readonly kind: string; readonly stdoutText?: string; readonly stderrText?: string }): boolean => {
  if (outcome.kind === 'timeout') return true;
  if (outcome.kind !== 'provider-failed') return false;
  const text = `${outcome.stderrText ?? ''}\n${(outcome.stdoutText ?? '').slice(-16_384)}`;
  return /\b403\b[^\n]{0,40}(?:budget admission refused|attempt deadline reached)/u.test(text);
};

export interface VerifiedWorkCredit {
  readonly finalText: string;
  readonly criteria: readonly string[];
  readonly run: TestRunSummary;
}

/** The credit decision (pure). Null = not creditable; the attempt keeps its own outcome. */
export const verifiedWorkCreditOf = (input: {
  readonly outcome: { readonly kind: string; readonly stdoutText?: string; readonly stderrText?: string };
  readonly evidence: VerifiedWorkEvidence;
  readonly criteria: readonly { readonly criterionId: string; readonly requirement: string }[];
  readonly requiresFileDelivery: boolean;
  readonly files: readonly { readonly path: string; readonly bytes: number }[];
  readonly filesTruncated: boolean;
}): VerifiedWorkCredit | null => {
  if (!endedByTimeOrCap(input.outcome)) return null;
  if (input.requiresFileDelivery || input.criteria.length === 0) return null;
  const run = input.evidence.lastPassingRun;
  if (run === null || input.evidence.changedSinceRun) return null;
  const ids = input.criteria.map((criterion) => criterion.criterionId);
  const states = criterionTestStatesOf(run.output, ids);
  for (const id of ids) {
    const verdicts = states.get(id) ?? [];
    if (verdicts.length === 0 || verdicts.some((state) => state !== 'pass')) return null;
  }
  const ending = input.outcome.kind === 'timeout' ? 'its time budget ran out' : 'its spend budget was used up';
  const files = input.files.length === 0 ? '' : ` Files kept in the workspace: ${input.files.map((file) => file.path).join(', ')}${input.filesTruncated ? ', …' : ''}.`;
  const finalText = [
    `CompanyOS credited this step's verified work: the attempt ended because ${ending} before the agent gave its final answer, ` +
      'but its last test run passed and nothing changed the workspace after it.',
    `Verification: \`${run.command.replace(/\s+/gu, ' ').trim().slice(0, 200)}\` — ${String(run.passed)} passed, 0 failed${run.skipped > 0 ? `, ${String(run.skipped)} skipped` : ''}.`,
    `Acceptance criteria proven by passing tests: ${input.criteria.map((criterion) => `[${criterion.criterionId}] ${criterion.requirement}`).join('; ')}.${files}`,
  ].join(' ');
  return { finalText, criteria: ids, run: { command: run.command, passed: run.passed, failed: run.failed, skipped: run.skipped } };
};
