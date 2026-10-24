/**
 * Correlation ids — the thread that ties an event, a log line, a cost record and
 * a handoff together (planning-document §四十四 Audit: 谁做的 / 什么时候 / 用哪
 * 个模型 / 哪套 Workflow Version / 调了什么工具 / 花了多少钱).
 */
import { z } from 'zod';

export const correlationIdsSchema = z.object({
  /** Required on EVERY event and log line. */
  traceId: z.string().min(1),
  /** Present once a workflow run exists. */
  runId: z.string().min(1).optional(),
  /** Present once an organisation/company exists. */
  orgId: z.string().min(1).optional(),
});

export type CorrelationIds = z.infer<typeof correlationIdsSchema>;

export const withCorrelation = (base: CorrelationIds, extra: CorrelationIds): CorrelationIds => ({
  ...base,
  ...extra,
});
