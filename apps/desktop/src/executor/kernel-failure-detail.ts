/**
 * LIVE-CONTRACT-FILL run 6 (hark-live-goal 42385697784) — the kernel's OWN failure detail.
 *
 * Run 6 lost three attempts to a kernel `turn_end` whose reason was `{kind:"error", error:
 * {message, code}}`, but CompanyOS kept only the slug ("error"): the message, the code, the
 * stderr tail and the last kernel events never reached the attempt record, the goal
 * workspace, the UI or the live summary, so the root cause could not be read from any run
 * output. This module reads that detail from the kernel's JSON stream (bounded, plain data)
 * so every surface can carry it, and builds the compact prior-attempt notes a retry
 * resumes from instead of rediscovering the workspace.
 */
import { earlyStopHintOf } from './attempt-early-stop.js';

export interface KernelTurnError {
  /** The kernel's turn_end reason kind ("error", "max-tokens", "aborted", ...). */
  readonly kind: string;
  /** The kernel's failure code (e.g. CONTEXT_WINDOW_EXCEEDED, UNKNOWN), when it gave one. */
  readonly code: string | null;
  /** The kernel's failure message (bounded), when it gave one. */
  readonly message: string | null;
}

export const KERNEL_ERROR_MESSAGE_MAX = 600;
const bounded = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const oneLine = (text: string): string => text.replace(/\s+/gu, ' ').trim();

const jsonLines = (stdoutText: string): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  for (const line of stdoutText.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch {
      // a non-JSON line is not a kernel event
    }
  }
  return out;
};

const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

/** The LAST non-completed turn_end of the stream with its error message/code (null when none). */
export const kernelTurnErrorOf = (stdoutText: string): KernelTurnError | null => {
  let found: KernelTurnError | null = null;
  for (const event of jsonLines(stdoutText)) {
    if (event['type'] !== 'status' || event['phase'] !== 'turn_end') continue;
    const reason = event['reason'];
    if (typeof reason !== 'object' || reason === null) continue;
    const r = reason as Record<string, unknown>;
    const kind = textOf(r['kind']);
    if (kind === null) continue;
    if (kind === 'completed') { found = null; continue; }
    const error = typeof r['error'] === 'object' && r['error'] !== null ? (r['error'] as Record<string, unknown>) : null;
    const nestedReason = typeof r['reason'] === 'object' && r['reason'] !== null ? (r['reason'] as Record<string, unknown>) : null;
    const message = textOf(error?.['message']) ?? textOf(r['message']) ?? textOf(nestedReason?.['message']) ?? textOf(r['reason']);
    const code = textOf(error?.['code']) ?? textOf(r['code']) ?? textOf(nestedReason?.['code']);
    found = {
      kind,
      code: code === null ? null : bounded(oneLine(code), 80),
      message: message === null ? null : bounded(oneLine(message), KERNEL_ERROR_MESSAGE_MAX),
    };
  }
  return found;
};

/** A compact, bounded view of the kernel's last events (what it was doing when it ended). */
export const kernelEventsTailOf = (stdoutText: string, count = 8): readonly string[] => {
  const events = jsonLines(stdoutText).filter((event) => event['type'] !== 'thinking');
  return events.slice(-count).map((event) => {
    const type = String(event['type'] ?? '?');
    if (type === 'status') {
      const reason = event['reason'];
      const kind = typeof reason === 'object' && reason !== null ? textOf((reason as Record<string, unknown>)['kind']) : null;
      return bounded(`status:${String(event['phase'] ?? '?')}${kind === null ? '' : `:${kind}`}`, 160);
    }
    if (type === 'tool_call') return bounded(`tool_call:${String(event['tool'] ?? '?')} ${oneLine(JSON.stringify(event['input'] ?? null))}`, 200);
    if (type === 'tool_result') return bounded(`tool_result:${String(event['status'] ?? '?')} ${oneLine(String(event['result'] ?? ''))}`, 200);
    if (type === 'text') return bounded(`text:${oneLine(String(event['text'] ?? ''))}`, 200);
    return bounded(type, 80);
  });
};

/** The bounded tail of a text (stderr), one line per entry trimmed. */
export const textTailOf = (text: string, maxChars = 800): string => {
  const trimmed = text.trimEnd();
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-(maxChars - 1))}`;
};

/** The one-line human detail every surface shows: "CODE: message" (bounded). */
export const kernelErrorDetailLine = (error: KernelTurnError | null, max = 300): string | null => {
  if (error === null) return null;
  if (error.message === null && error.code === null) return null;
  const text = error.code === null ? String(error.message) : error.message === null ? error.code : `${error.code}: ${error.message}`;
  return bounded(text, max);
};

/**
 * LIVE-CONTRACT-FILL run 6 — the compact notes of one finished attempt of a step, kept in the
 * step's workspace so the NEXT attempt resumes from them (what was run, what the agent last
 * said, why it ended) instead of replaying the conversation or rediscovering everything.
 */
export interface AttemptNotes {
  readonly schema: 'companyos:attempt-notes:1';
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly outcome: string;
  readonly endReason: string | null;
  readonly kernelError: string | null;
  readonly commands: readonly string[];
  readonly lastAgentText: string | null;
}

const commandOf = (event: Record<string, unknown>): string | null => {
  const tool = textOf(event['tool']);
  if (tool === null) return null;
  const input = typeof event['input'] === 'object' && event['input'] !== null ? (event['input'] as Record<string, unknown>) : {};
  const subject = textOf(input['command']) ?? textOf(input['cmd']) ?? textOf(input['path']) ?? textOf(input['file_path']) ?? textOf(input['filePath']) ?? null;
  return bounded(oneLine(subject === null ? tool : `${tool}: ${subject}`), 160);
};

export const attemptNotesOf = (input: {
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly outcome: string;
  readonly endReason: string | null;
  readonly stdoutText: string;
}): AttemptNotes => {
  const events = jsonLines(input.stdoutText);
  const commands: string[] = [];
  let lastAgentText: string | null = null;
  for (const event of events) {
    if (event['type'] === 'tool_call') {
      const command = commandOf(event);
      if (command !== null) commands.push(command);
    } else if (event['type'] === 'text') {
      const text = textOf(event['text']);
      if (text !== null) lastAgentText = text;
    }
  }
  return {
    schema: 'companyos:attempt-notes:1',
    taskId: input.taskId,
    attemptNumber: input.attemptNumber,
    outcome: input.outcome,
    endReason: input.endReason,
    kernelError: kernelErrorDetailLine(kernelTurnErrorOf(input.stdoutText)),
    commands: commands.slice(-12),
    lastAgentText: lastAgentText === null ? null : bounded(oneLine(lastAgentText), 800),
  };
};

/** The compact prior-attempt summary rendered into a resumed attempt's directive (bounded). */
export const renderAttemptNotes = (notes: AttemptNotes): string =>
  bounded([
    `Summary of attempt ${String(notes.attemptNumber)} (ended ${notes.outcome}${notes.endReason === null ? '' : `, ${notes.endReason}`}${notes.kernelError === null ? '' : `: ${notes.kernelError}`}).`,
    earlyStopHintOf(notes.endReason) ?? '',
    notes.commands.length === 0 ? '' : `Its last actions: ${notes.commands.join(' | ')}.`,
    notes.lastAgentText === null ? '' : `Its last note: "${notes.lastAgentText}".`,
  ].filter((part) => part !== '').join(' '), 2400);

export const parseAttemptNotes = (text: string): AttemptNotes | null => {
  try {
    const value = JSON.parse(text) as Partial<AttemptNotes>;
    if (value.schema !== 'companyos:attempt-notes:1' || typeof value.taskId !== 'string' || typeof value.attemptNumber !== 'number') return null;
    return {
      schema: 'companyos:attempt-notes:1',
      taskId: value.taskId,
      attemptNumber: value.attemptNumber,
      outcome: typeof value.outcome === 'string' ? value.outcome : 'unknown',
      endReason: typeof value.endReason === 'string' ? value.endReason : null,
      kernelError: typeof value.kernelError === 'string' ? value.kernelError : null,
      commands: Array.isArray(value.commands) ? value.commands.filter((c): c is string => typeof c === 'string').slice(-12) : [],
      lastAgentText: typeof value.lastAgentText === 'string' ? value.lastAgentText.slice(0, 800) : null,
    };
  } catch {
    return null;
  }
};
