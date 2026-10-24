#!/usr/bin/env node
// Hark lane H9: ONE tiny live model call through the INSTALLED app's own OpenAI-compatible
// adapter, run on the app's bundled runtime (CompanyOS.exe with ELECTRON_RUN_AS_NODE=1).
// Tiny project: the model writes a one-function ES module; we save it into a scratch
// workspace and run its check locally. Hard caps: 1 call, max 300 output tokens, 60 s.
// The API key is read from env by the adapter's resolver and is never printed or written.
// Usage: CompanyOS.exe live-model-smoke.mjs <installDir> <evidenceDir>
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [installDir, evidence] = process.argv.slice(2);
mkdirSync(evidence, { recursive: true });
const out = { startedAt: new Date().toISOString(), runtime: { node: process.versions.node, electron: process.versions.electron ?? null }, calls: 0 };
const finish = (code) => { out.finishedAt = new Date().toISOString(); writeFileSync(join(evidence, 'live-model-smoke.json'), JSON.stringify(out, null, 2)); console.log(JSON.stringify(out, null, 2)); process.exit(code); };

const mod = await import(pathToFileURL(join(installDir, 'resources/app/apps/desktop/dist/models/openai-compatible-provider.js')).href);
const config = mod.resolveOpenAiCompatibleConfig(process.env);
if (!config.ok || config.value === null) { out.result = 'CONFIG_INVALID'; out.detail = config.ok ? 'not configured' : config.error.message; finish(2); }
out.config = { providerId: config.value.providerId, baseUrl: config.value.baseUrl, modelId: config.value.modelId, timeoutMs: config.value.timeoutMs, apiKeyEnv: config.value.apiKeyEnv };
const keyPresent = (process.env[config.value.apiKeyEnv] ?? '').trim() !== '';
out.apiKeyPresent = keyPresent;
if (!keyPresent) { out.result = 'BLOCKED_NO_SECRET'; finish(3); }

const provider = mod.createOpenAiCompatibleProvider({
  config: config.value,
  resolveSecret: async (ref) => process.env[ref.envName] ?? null,
});
const t0 = Date.now();
out.calls = 1;
const res = await provider.invoke({
  modelId: config.value.modelId,
  temperature: 0,
  maxOutputTokens: 300,
  responseFormat: { mode: 'json_object' },
  signal: AbortSignal.timeout(60_000),
  messages: [
    { role: 'system', content: 'You write tiny JavaScript files. Reply with one json object only.' },
    { role: 'user', content: 'Return json {"filename":"add.mjs","code":"<source>"} where <source> is an ES module that exports function add(a, b) returning a + b. No comments, no other keys.' },
  ],
});
out.latencyMs = Date.now() - t0;
if (!res.ok) { out.result = 'PROVIDER_ERROR'; out.error = { code: res.error.code, message: res.error.message }; finish(4); }
const v = res.value;
out.model = { modelId: v.modelId, finishReason: v.finishReason, usage: v.usage };
const s = v.structured;
if (!s || typeof s.code !== 'string' || s.filename !== 'add.mjs') { out.result = 'MALFORMED_OUTPUT'; out.outputText = String(v.outputText).slice(0, 500); finish(5); }

const ws = mkdtempSync(join(tmpdir(), 'companyos-h9-'));
writeFileSync(join(ws, 'add.mjs'), s.code);
writeFileSync(join(evidence, 'generated-add.mjs'), s.code);
out.workspace = ws;
try {
  const { add } = await import(pathToFileURL(join(ws, 'add.mjs')).href);
  const checks = [[2, 3, 5], [-1, 1, 0], [10, 32, 42]].map(([a, b, e]) => ({ a, b, expected: e, got: add(a, b) }));
  out.checks = checks;
  out.result = checks.every((c) => c.got === c.expected) ? 'PASS' : 'CHECK_FAILED';
} catch (e) { out.result = 'GENERATED_CODE_FAILED'; out.error = String(e?.message ?? e); }
finish(out.result === 'PASS' ? 0 : 6);
