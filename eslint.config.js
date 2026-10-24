// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Industry-Pack vocabulary that MUST NOT appear as an identifier inside
 * `@companyos/core` (and `@companyos/contracts`). See docs/CORE_BOUNDARIES.md
 * and ADR-0002. The automated twin of this rule lives in
 * scripts/check-boundaries.mjs (which also strips comments/strings).
 */
export const FORBIDDEN_CORE_IDENTIFIERS = [
  'Coding',
  'Git',
  'Repository',
  'Developer',
  'CTO',
  'Article',
  'Video',
  'Ecommerce',
];

const forbiddenCoreSelectors = FORBIDDEN_CORE_IDENTIFIERS.map((word) => ({
  selector: `Identifier[name=/^${word}/i]`,
  message:
    `Industry-Pack vocabulary "${word}" is forbidden inside Core (ADR-0002). ` +
    'Use neutral domain words instead (EntityStore, WorkRole, WorkProduct, ...) ' +
    'and move the vertical concept into a @companyos/pack-* package.',
}));

/** Node/Electron globals for tooling, scripts and the sandboxed preload. */
const NODE_GLOBALS = {
  console: 'readonly',
  process: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Buffer: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  structuredClone: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  global: 'readonly',
  globalThis: 'readonly',
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/out/**',
      '**/release/**',
      '.data/**',
      '.planning/**',
      // STAGE 4: the materialized embedded agent kernel is GENERATED third-party
      // runtime (official pinned upstream, gitignored) — never CompanyOS source.
      '.companyos-embedded/**',
      // Owned offline-test outputs include deliberately invalid negative fixtures.
      '.tmp/offline-gates/**',
      // DRA-01 historical diagnostic entrypoints, preserved byte-for-byte.
      // Exclude only these two files; other tmp-e2e and product files stay linted.
      'tmp-e2e/minimal-app/main.js',
      'tmp-e2e/probe/main.js',
      'packages/*/src/**/generated/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': ['error', 'always'],
      'no-console': ['warn', { allow: ['error', 'warn'] }],
    },
  },

  // --- the Core boundary rule (architecture law, machine-enforced) ---
  {
    files: ['packages/core/src/**/*.ts', 'packages/contracts/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@companyos/pack-*',
                '@companyos/desktop',
                '@companyos/renderer',
                '@companyos/persistence',
                '@companyos/observability',
                'electron',
                'react',
                'react-dom',
              ],
              message:
                'Core/Contracts may only depend on themselves and Node built-ins. ' +
                'Packs, UI, Electron and adapters live in the outer ring (ADR-0002/ADR-0005).',
            },
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...forbiddenCoreSelectors],
    },
  },

  // --- tests & tooling may be pragmatic ---
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/tests/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  // Node-side tooling (scripts, config files) is not browser code: declare the Node
  // globals explicitly rather than adding a runtime-globals dependency.
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.config.js', '**/*.config.ts'],
    languageOptions: { globals: NODE_GLOBALS },
    rules: { 'no-console': 'off' },
  },
  // Sandboxed Electron preload scripts are CommonJS by necessity, not by choice.
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: NODE_GLOBALS },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
