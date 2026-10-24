/**
 * Contract versioning.
 *
 * `major` bumps require every producer and consumer to be updated together;
 * `minor` bumps are additive and must be tolerated by older consumers.
 * Sprint 0 ships 0.1.0 — pre-stable, no compatibility guarantee yet.
 */
export const CONTRACT_VERSION = '0.1.0' as const;

export interface ContractVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export const CONTRACT_COMPATIBILITY = {
  /** A consumer older than the producer tolerates added fields. */
  forwardTolerant: true,
  /** A payload without a contract version is rejected at the IPC boundary. */
  requireVersionOnWire: false,
  notes:
    'Sprint 0: schema evolution is additive-only. Tighten by setting requireVersionOnWire=true in Sprint 1 (P0).',
} as const;
