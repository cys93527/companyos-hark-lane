/**
 * The AUTHORITATIVE durable migration chain list (Sprint 10B.1 §一).
 *
 * Three boundary tests used to hard-code the same `chains: [...]` regex. They now import this
 * fixture instead, so adding a chain is a ONE-line change here (and the tests cannot drift).
 */

/** Every chain the desktop composition root requests, in order. */
export const EXPECTED_COMPOSITION_CHAINS = [
  'core',
  'engine',
  'lifecycle',
  'provider',
  'registry',
  'selection',
  'agent',
  'tools',
  'router',
  'handoff',
  'memory',
  'artifact',
  'pack',
] as const;

/** The canonical `chains: [...]` source pattern the composition root must contain. */
export const expectedChainsRegex = (): RegExp =>
  new RegExp(`chains: \\[${EXPECTED_COMPOSITION_CHAINS.map((chain) => `'${chain}'`).join(', ')}\\]`);

/**
 * Strip JS/TS comments (block + line) so the chain guards match EXECUTABLE code, not
 * comment text. Post-Sprint-12 reconciliation: a frozen pre-Sprint-12 chain comment in
 * main.ts used to satisfy the regex while the real chain list had moved to 11 chains.
 * String literals are deliberately KEPT — the chain names live inside them.
 */
export const sourceWithoutComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ');

/** Sprint 10B.1: the router chain owns exactly this table. */
export const ROUTER_CHAIN_TABLE = 'router_decisions';

/** Sprint 11: the handoff chain owns exactly these tables. */
export const HANDOFF_CHAIN_TABLES = ['handoffs', 'handoff_refs'] as const;
