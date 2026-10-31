#!/usr/bin/env node
/**
 * H16b-3b — print the PRODUCTION start-time isolation decision and launch plan for an installed layout
 * (requires the desktop dist). Usage: node decide-smoke.mjs <resources/isolation> <userData> <workspace>
 * Prints one JSON line {decision, plan}; never spawns anything. CI only (installed-pong.ps1 negatives).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const [resourcesDir, userDataDir, workspace] = process.argv.slice(2);
if (!resourcesDir || !userDataDir || !workspace) { console.error('usage: decide-smoke.mjs <resources/isolation> <userData> <workspace>'); process.exit(2); }
const runner = await import(pathToFileURL(join(root, 'apps/desktop/dist/executor/isolation/isolation-status-runner.js')).href);
const { planIsolatedLaunch } = await import(pathToFileURL(join(root, 'apps/desktop/dist/executor/isolation/isolated-launch-seam.js')).href);
const layout = { resourcesDir, userDataDir };
const decision = await runner.decideIsolation({ layout });
const paths = runner.isolationPaths(layout);
const plan = planIsolatedLaunch({ decision, config: { launcherPath: paths.launcher, credentialPath: paths.credentialPath }, workspaceRoot: workspace, childExecutable: process.execPath, childArgv: ['--version'] });
// The zh-CN label is judged here (PowerShell 5.1 reads node's UTF-8 stdout through the OEM code page).
console.log(JSON.stringify({ decision, unisolatedLabelZh: plan.kind === 'unisolated' && plan.label === '\u672a\u9694\u79bb', plan: plan.kind === 'isolated' ? { kind: plan.kind, account: plan.account, brokerPort: plan.brokerPort } : plan }));
