/**
 * UI-AUDIT-2 (user report 2026-11-11): the conversation printed the raw run timeline —
 * `run.transition · IDLE → INITIALIZING (START)`, `event.run.snapshot_pinned · …` — as the
 * main text. The timeline is canonical evidence and stays available (behind 技术记录), but
 * what a normal user reads is one plain Chinese line per meaningful step. Pure: tested
 * without a DOM.
 */

export interface TimelineLike {
  readonly key: string;
  readonly kind: string;
  readonly summary: string;
  readonly occurredAt?: string | null;
}

const RUN_STATE_STEP: Readonly<Record<string, string>> = {
  INITIALIZING: '开始运行',
  PLANNING: '开始规划',
  ROUTING: '分配执行方式',
  EXECUTING: '开始执行',
  RUNNING: '开始执行',
  VALIDATING: '开始验证结果',
  CORRECTING: '开始修正',
  WAITING_APPROVAL: '等待你的批准',
  PAUSED: '已暂停',
  BLOCKED: '已阻塞',
  COMPLETED: '已完成',
  FAILED: '运行失败',
  CANCELLED: '已取消',
  TIMED_OUT: '已超时',
};

const ATTEMPT_STATE_WORDS: Readonly<Record<string, string>> = {
  COMPLETED: '完成',
  SUCCEEDED: '完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  INTERRUPTED: '中断',
  TIMED_OUT: '超时',
};

const STATIC_STEPS: Readonly<Record<string, string>> = {
  'task.created': '创建了一个任务',
  'corrective.created': '创建了一个修正任务',
  'reassessment.created': '重新评估结果',
  'executionattempt.claimed': '开始执行任务',
  'finding.reported': '审查发现了问题',
  'decision.recorded': '记录了一个决定',
  'validation.recorded': '记录了验证结果',
  'artifact.created': '生成了产物',
  'event.run.started': '运行已开始',
  'event.run.snapshot_pinned': '已锁定本次运行的配置',
};

/** The plain line for one timeline entry; null = technical only (shown under 技术记录). */
export const activityText = (entry: TimelineLike): string | null => {
  if (entry.kind === 'run.transition') {
    const match = /→\s*([A-Z_]+)/u.exec(entry.summary);
    return match === null ? null : RUN_STATE_STEP[match[1]!] ?? null;
  }
  if (entry.kind === 'executionattempt.settled') {
    const match = /settled\s+([A-Z_]+)/u.exec(entry.summary);
    const word = match === null ? null : ATTEMPT_STATE_WORDS[match[1]!] ?? null;
    return word === null ? '任务的一次执行结束' : `任务的一次执行${word}`;
  }
  return STATIC_STEPS[entry.kind] ?? null;
};

/** The plain lines in order, consecutive duplicates folded (e.g. two artifact rows of one step). */
export const plainActivity = (entries: readonly TimelineLike[]): readonly { readonly key: string; readonly text: string; readonly occurredAt: string | null }[] => {
  const out: { key: string; text: string; occurredAt: string | null }[] = [];
  for (const entry of entries) {
    const text = activityText(entry);
    if (text === null) continue;
    if (out.length > 0 && out[out.length - 1]!.text === text) continue;
    out.push({ key: entry.key, text, occurredAt: entry.occurredAt ?? null });
  }
  return out;
};
