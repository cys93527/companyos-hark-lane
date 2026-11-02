/**
 * AUDIT-D7 (+ R7 main side) — the trusted main-process wrapper around the control-plane and
 * workflow IPC channels.
 *
 *   - A handler that THROWS (a store bug, an unexpected rejection) used to reject the renderer's
 *     invoke with a raw Error; the renderer now always gets the typed envelope: a DomainError keeps
 *     its code, anything else is INTERNAL_ERROR reason CONTROL_PLANE_HANDLER_FAILED (the renderer
 *     treats INTERNAL_ERROR as "outcome unknown" and never clears a pending submission on it).
 *   - Approving a pending decision used to leave the Goal without a driver (the autonomy driver
 *     exits with USER_DECISION_REQUIRED and only goal.create started one), so nothing advanced
 *     after 批准. A successful approve now resumes every non-terminal Goal run (single-flight;
 *     a Goal whose driver is alive is not started twice).
 */
export interface ControlPlaneAutonomy {
  readonly start: (companyId: string, runId: string) => unknown;
  readonly resumeNonTerminalGoalRuns: () => Promise<readonly string[]>;
}

export interface ControlPlaneIpcDeps {
  readonly companyId: string;
  readonly handle: (request: unknown) => Promise<unknown>;
  readonly autonomy: () => ControlPlaneAutonomy | null;
  readonly logger?: { warn(msg: string, fields?: Record<string, unknown>): void; error(msg: string, fields?: Record<string, unknown>): void };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const DOMAIN_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;

/** A thrown value as the typed failure envelope (never a rejection). */
export const handlerFailureEnvelope = (error: unknown, reason: string): { ok: false; error: { code: string; message: string; details: Record<string, unknown> } } => {
  if (isRecord(error) && typeof error['code'] === 'string' && DOMAIN_CODE.test(error['code']) && typeof error['message'] === 'string') {
    return { ok: false, error: { code: error['code'], message: error['message'], details: isRecord(error['details']) ? error['details'] : {} } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: 'INTERNAL_ERROR', message: `内部错误：${message.slice(0, 300)}`, details: { reason } } };
};

/** Runs any IPC handler so that it never rejects. */
export const neverReject = async (run: () => Promise<unknown>, reason: string, logger?: ControlPlaneIpcDeps['logger']): Promise<unknown> => {
  try {
    return await run();
  } catch (error) {
    logger?.error('ipc handler threw; answered with a typed envelope', { reason, error: error instanceof Error ? error.message : String(error) });
    return handlerFailureEnvelope(error, reason);
  }
};

export const createControlPlaneIpcHandler = (deps: ControlPlaneIpcDeps): ((request: unknown) => Promise<unknown>) => {
  let resuming: Promise<unknown> | null = null;
  const resumeAfterApproval = (): void => {
    const autonomy = deps.autonomy();
    if (autonomy === null || resuming !== null) return;
    resuming = autonomy.resumeNonTerminalGoalRuns()
      .catch((error: unknown) => {
        deps.logger?.warn('autonomy resume after approval failed', { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => { resuming = null; });
  };
  return (request: unknown) => neverReject(async () => {
    const response = await deps.handle(request);
    const ok = isRecord(response) && response['ok'] === true;
    const operation = isRecord(request) ? request['operation'] : undefined;
    if (ok && operation === 'goal.create' && isRecord(response['value']) && typeof response['value']['runId'] === 'string') {
      // STAGE 2 — the driver starts with the Goal; the renderer never presses 继续.
      deps.autonomy()?.start(deps.companyId, response['value']['runId']);
    }
    if (ok && operation === 'approval.respond' && isRecord(response['value']) && response['value']['decision'] === 'approve') {
      resumeAfterApproval();
    }
    return response;
  }, 'CONTROL_PLANE_HANDLER_FAILED', deps.logger);
};
