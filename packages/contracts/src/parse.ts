/**
 * Parse helpers — every contract failure must be reported with a JSON-pointer
 * path so an audit trail can say exactly which field was rejected.
 */
import type { ZodError, ZodType } from 'zod';

export class ContractError extends Error {
  public readonly issues: string;

  public constructor(label: string, error: ZodError) {
    const issues = formatIssues(error);
    super(`${label} failed contract validation: ${issues}`);
    this.name = 'ContractError';
    this.issues = issues;
  }
}

/** Render zod issues as JSON-pointer-ish paths: `/payload/items/0: Expected string`. */
export function formatIssues(error: ZodError): string {
  return error.issues
    .map((issue) => `/${issue.path.map((segment) => String(segment)).join('/')}: ${issue.message}`)
    .join('; ');
}

export function parseOrThrow<T>(schema: ZodType<T>, input: unknown, label = 'contract'): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ContractError(label, result.error);
  return result.data;
}
