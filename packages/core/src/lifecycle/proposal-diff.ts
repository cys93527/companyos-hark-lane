/** Structural diff primitives shared by ChangeProposal and templates. */
export type ChangeOpKind = 'add_node' | 'remove_node' | 'update_node' | 'add_edge' | 'remove_edge';

export interface ChangeOp {
  readonly op: ChangeOpKind;
  readonly path: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export type { JsonValue } from '../kernel/hash.js';
