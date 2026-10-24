/** Port: identifier minting. Implemented by `UlidFactory` / `SequenceIdFactory`. */
export interface IdFactory {
  /** A bare 26-character ULID. */
  ulid(): string;
  /** A prefixed identifier, e.g. `tpl_01J...`. */
  id(prefix?: string): string;
}

/** Canonical identifier prefixes. Adapters MUST use these so ids stay greppable. */
export const ID_PREFIX = {
  organisation: 'org',
  company: 'cmp',
  template: 'tpl',
  version: 'ver',
  run: 'run',
  snapshot: 'snp',
  lock: 'lck',
  proposal: 'chp',
  role: 'rol',
  agent: 'agt',
  workflow: 'wfl',
  stage: 'stg',
  task: 'tsk',
  artifact: 'art',
  validation: 'val',
  approval: 'apr',
  decision: 'dec',
  handoff: 'hnd',
  /** Engine-internal command envelope ids (Sprint 2 idempotency keys). */
  command: 'cmd',
  event: 'evt',
  memory: 'mem',
  pack: 'pak',
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];
