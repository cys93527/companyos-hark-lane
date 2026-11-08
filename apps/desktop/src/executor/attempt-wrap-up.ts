/**
 * LIVE-CONTRACT-FILL run 9 (hark-live-goal 42429421366) — WRAP-UP IS A MECHANISM, NOT A PROMPT.
 *
 * Step 1 ran its whole 30-minute attempt (178 model calls) without ever giving a final answer,
 * although its tests passed: the run-8 directive "answer as soon as the criteria are met" was
 * prompt-only, and the kernel never knew how much time or money its attempt had left. The retry
 * then started over and the step's spend share ran out (GOAL_STEP_SPEND_CAP_REACHED).
 *
 * Now every model request the kernel sends through the loopback broker carries a short
 * CompanyOS status note (time left in this attempt, spend left in this step). When either falls
 * below its threshold the note becomes a forced WRAP-UP instruction (stop new work, run the
 * tests, give the final answer with what is done and what remains), and after a bounded number
 * of wrap-up turns the broker stops admitting calls (the attempt ends as a resumable timeout and
 * its verified work can be credited — see verified-work-credit.ts). Thresholds are configurable:
 *   COS_WRAPUP_STEP_SPEND_LEFT_RATIO  share of the step cap left that forces wrap-up (default 0.2)
 *   COS_WRAPUP_ATTEMPT_MS_LEFT        attempt time left (ms) that forces wrap-up (default 300000)
 *   COS_WRAPUP_MAX_TURNS              wrap-up turns admitted before the attempt is drained (default 12)
 *
 * The same module detects the external tools a generated project may rely on (LibreOffice
 * `soffice` for PDF conversion) so the task text says up front what exists on this machine —
 * run 9's kernel chased an absent soffice for most of its attempt.
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface WrapUpThresholds {
  /** Wrap-up is forced when the step's spend left is at or below this share of its cap. */
  readonly stepSpendLeftRatio: number;
  /** Wrap-up is forced when the attempt's time left is at or below this (ms). */
  readonly attemptMsLeft: number;
  /** Wrap-up turns admitted before the broker stops admitting (the attempt drains). */
  readonly maxWrapUpTurns: number;
}

export const DEFAULT_WRAP_UP_THRESHOLDS: WrapUpThresholds = {
  stepSpendLeftRatio: 0.2,
  attemptMsLeft: 300_000,
  maxWrapUpTurns: 12,
};

const numberOf = (raw: string | undefined): number => (raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw));

/** Thresholds from the environment; an absent or invalid value keeps its default. */
export const wrapUpThresholdsOf = (env: Readonly<Record<string, string | undefined>>): WrapUpThresholds => {
  const ratio = numberOf(env['COS_WRAPUP_STEP_SPEND_LEFT_RATIO']);
  const ms = numberOf(env['COS_WRAPUP_ATTEMPT_MS_LEFT']);
  const turns = numberOf(env['COS_WRAPUP_MAX_TURNS']);
  return {
    stepSpendLeftRatio: Number.isFinite(ratio) && ratio >= 0 && ratio < 1 ? ratio : DEFAULT_WRAP_UP_THRESHOLDS.stepSpendLeftRatio,
    attemptMsLeft: Number.isSafeInteger(ms) && ms >= 0 ? ms : DEFAULT_WRAP_UP_THRESHOLDS.attemptMsLeft,
    maxWrapUpTurns: Number.isSafeInteger(turns) && turns >= 1 ? turns : DEFAULT_WRAP_UP_THRESHOLDS.maxWrapUpTurns,
  };
};

/** What CompanyOS knows about this attempt's remaining resources at one model turn. */
export interface TurnBudgetStatus {
  /** Milliseconds left until the attempt deadline (may be <= 0). */
  readonly attemptMsLeft: number;
  /** The step's spend so far (settled KNOWN cost + open/UNKNOWN bounds), when a step cap applies. */
  readonly stepSpentMicros?: number;
  /** The step's spend cap, when one applies (> 0). */
  readonly stepCapMicros?: number;
}

export type WrapUpTrigger = 'time' | 'spend' | 'time+spend';

export interface TurnNote {
  readonly wrapUp: boolean;
  readonly trigger: WrapUpTrigger | null;
  readonly text: string;
}

const cny = (micros: number): string => (Math.max(0, micros) / 1_000_000).toFixed(2);
const minutes = (ms: number): string => String(Math.max(0, Math.round(ms / 60_000)));

/** The status note for one turn; becomes the forced WRAP-UP instruction below a threshold. */
export const turnNoteOf = (status: TurnBudgetStatus, thresholds: WrapUpThresholds): TurnNote => {
  const hasStep = status.stepCapMicros !== undefined && status.stepCapMicros > 0 && status.stepSpentMicros !== undefined;
  const spendLeft = hasStep ? status.stepCapMicros! - status.stepSpentMicros! : null;
  const timeLow = status.attemptMsLeft <= thresholds.attemptMsLeft;
  const spendLow = spendLeft !== null && spendLeft <= status.stepCapMicros! * thresholds.stepSpendLeftRatio;
  const timeText = `about ${minutes(status.attemptMsLeft)} min left in this attempt`;
  const spendText = spendLeft === null ? null : `CNY ${cny(spendLeft)} of this step's CNY ${cny(status.stepCapMicros!)} budget left`;
  const resources = spendText === null ? timeText : `${timeText}, ${spendText}`;
  if (!timeLow && !spendLow) {
    return {
      wrapUp: false,
      trigger: null,
      text: `[CompanyOS status] ${resources}. CompanyOS forces a wrap-up at ${minutes(thresholds.attemptMsLeft)} min` +
        `${spendText === null ? '' : ` or ${String(Math.round(thresholds.stepSpendLeftRatio * 100))}% of the step budget`} left; finish before that.`,
    };
  }
  const trigger: WrapUpTrigger = timeLow && spendLow ? 'time+spend' : timeLow ? 'time' : 'spend';
  return {
    wrapUp: true,
    trigger,
    text: `[CompanyOS WRAP-UP — mandatory] This attempt is about to run out (${resources}). Stop all new work now: ` +
      'no new features, no installs, no searching for tools, no further probing or polishing. Run the project\'s tests once, ' +
      'then give your final answer immediately: what is done (which acceptance criteria are met and how the tests prove it) ' +
      'and what remains or cannot be done in this environment. The files you wrote are kept. CompanyOS stops admitting model ' +
      'calls shortly after this point.',
  };
};

/**
 * Appends the note to the LAST message of an OpenAI-compatible chat request (its text content),
 * never adding a message, never touching the system prompt or earlier messages: the provider's
 * prefix cache stays valid (run 7 cache-hit pricing) and no role ordering rule can be violated.
 * Returns null when the body is not a chat request it can safely change, or when the changed
 * body would exceed `maxBytes` (the admission's proven input bound) — the original is sent then.
 */
export const injectTurnNote = (body: Uint8Array, note: string, maxBytes?: number): Buffer | null => {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(body).toString('utf8')); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const messages = (parsed as Record<string, unknown>)['messages'];
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as unknown;
  if (typeof last !== 'object' || last === null) return null;
  const message = last as Record<string, unknown>;
  const role = message['role'];
  const content = message['content'];
  const suffix = `\n\n${note}`;
  if (role === 'user' || role === 'tool') {
    if (typeof content === 'string') message['content'] = `${content}${suffix}`;
    else if (Array.isArray(content)) message['content'] = [...content, { type: 'text', text: note }];
    else return null;
  } else if (role === 'assistant') {
    messages.push({ role: 'user', content: note });
  } else {
    return null;
  }
  const out = Buffer.from(JSON.stringify(parsed), 'utf8');
  if (maxBytes !== undefined && out.byteLength > maxBytes) return null;
  return out;
};

/**
 * Per-attempt turn-note state: counts wrap-up turns so the caller can drain the attempt once
 * the bounded wrap-up window is used up (`exhausted`).
 */
export const createTurnNoter = (input: {
  readonly thresholds: WrapUpThresholds;
  readonly status: () => Promise<TurnBudgetStatus>;
}) => {
  let wrapUpTurns = 0;
  let firstTrigger: WrapUpTrigger | null = null;
  return {
    /** The note for the next model request, plus whether the wrap-up window is now used up. */
    async next(): Promise<{ readonly note: TurnNote; readonly exhausted: boolean }> {
      const note = turnNoteOf(await input.status(), input.thresholds);
      if (note.wrapUp) {
        wrapUpTurns += 1;
        firstTrigger ??= note.trigger;
      }
      return { note, exhausted: note.wrapUp && wrapUpTurns > input.thresholds.maxWrapUpTurns };
    },
    wrapUpTurns: () => wrapUpTurns,
    trigger: () => firstTrigger,
  };
};

/* ------------------------------------------------------------- external tools */

export interface ExternalToolSpec {
  readonly id: string;
  readonly label: string;
  /** Executable file names tried on PATH, in order. */
  readonly executables: readonly string[];
  /** Well-known install directories tried when PATH has none. */
  readonly knownDirs: readonly string[];
  /** What the generated project may use it for. */
  readonly purpose: string;
}

export const EXTERNAL_TOOLS: readonly ExternalToolSpec[] = [
  {
    id: 'soffice',
    label: 'LibreOffice (soffice)',
    executables: ['soffice.com', 'soffice.exe', 'soffice'],
    knownDirs: ['C:\\Program Files\\LibreOffice\\program', 'C:\\Program Files (x86)\\LibreOffice\\program', '/usr/bin', '/usr/local/bin', '/opt/libreoffice/program', '/Applications/LibreOffice.app/Contents/MacOS'],
    purpose: 'headless document conversion, e.g. soffice --headless --convert-to pdf',
  },
];

export interface ExternalToolStatus {
  readonly id: string;
  readonly label: string;
  readonly purpose: string;
  /** Absolute path of the executable found, or null when absent. */
  readonly path: string | null;
  /** True when it was found through PATH (callable by its bare name). */
  readonly onPath: boolean;
}

export const detectExternalTools = (
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean = existsSync,
  tools: readonly ExternalToolSpec[] = EXTERNAL_TOOLS,
  pathDelimiter: string = delimiter,
): readonly ExternalToolStatus[] => {
  const pathDirs = (env['PATH'] ?? env['Path'] ?? '').split(pathDelimiter).map((dir) => dir.trim()).filter((dir) => dir !== '');
  const find = (dirs: readonly string[], spec: ExternalToolSpec): string | null => {
    for (const dir of dirs) {
      for (const executable of spec.executables) {
        const candidate = join(dir, executable);
        try { if (exists(candidate)) return candidate; } catch { /* unreadable entry */ }
      }
    }
    return null;
  };
  return tools.map((spec) => {
    const onPath = find(pathDirs, spec);
    const known = onPath === null ? find(spec.knownDirs, spec) : null;
    return { id: spec.id, label: spec.label, purpose: spec.purpose, path: onPath ?? known, onPath: onPath !== null };
  });
};

/** The task-text line that tells the kernel which external tools exist (and which do not). */
export const externalToolsLineOf = (tools: readonly ExternalToolStatus[]): string | null => {
  if (tools.length === 0) return null;
  const parts = tools.map((tool) => {
    if (tool.path === null) {
      return `${tool.label} is NOT installed on this machine — do not search for it, install it or wait for it; ` +
        `for ${tool.purpose} use a maintained library that needs no external program, or make the feature detect the missing ` +
        'tool and report a clear message, test that path, and say so in your final answer';
    }
    return tool.onPath
      ? `${tool.label} is installed and on PATH (${tool.path}) — available for ${tool.purpose}`
      : `${tool.label} is installed at ${tool.path} but not on PATH — call it by that absolute path for ${tool.purpose}`;
  });
  return `Environment (detected by CompanyOS on this machine): ${parts.join('; ')}.`;
};
