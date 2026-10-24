import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const cwd = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd });

test('DRA-01 lint exclusions apply only to the two sealed historical entrypoints', async () => {
  for (const path of ['tmp-e2e/minimal-app/main.js', 'tmp-e2e/probe/main.js']) {
    assert.equal(await eslint.isPathIgnored(path), true, path);
  }
  for (const path of ['tmp-e2e/other/main.js', 'tmp-e2e/minimal-app/new.js', 'apps/renderer/src/App.tsx', 'tests/security-agent-attack.test.ts']) {
    assert.equal(await eslint.isPathIgnored(path), false, path);
  }
});

test('diagnostic exceptions preserve undefined-global, CommonJS import and Core boundary rules', async () => {
  for (const filePath of ['tmp-e2e/other/main.js', 'apps/renderer/src/lint-scope-probe.js']) {
    const [result] = await eslint.lintText('require("node:fs");', { filePath });
    assert.ok(result.messages.some(({ ruleId }) => ruleId === 'no-undef'));
    assert.ok(result.messages.some(({ ruleId }) => ruleId === '@typescript-eslint/no-require-imports'));
  }
  const [result] = await eslint.lintText('export const CodingProbe = 1;', { filePath: 'packages/core/src/lint-scope-probe.ts' });
  assert.ok(result.messages.some(({ ruleId }) => ruleId === 'no-restricted-syntax'));
});
