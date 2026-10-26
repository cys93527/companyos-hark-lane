/**
 * STAGE 4 — development EMBEDDED DSH RUNTIME MATERIALIZATION.
 *
 * Builds the CompanyOS-managed agent kernel from the OFFICIAL pinned upstream source
 * into a gitignored directory (default `<repo>/.companyos-embedded/dsh-runtime/`):
 *
 *   official pinned source (repo @ exact SHA, verified clean)
 *     → pnpm install --frozen-lockfile
 *     → official host build (tsc -b + tsdown, UNMODIFIED upstream)
 *     → CompanyOS-minimal profile scaffold
 *     → immutable manifest.json (kernel id / repo / SHA / tag / node range /
 *       profile identity / transport / protocol version / entry checksums)
 *
 * The generated runtime is NOT CompanyOS canonical source (gitignored); the final
 * packaged-resource form ships the same manifest contract (Stage 3 distribution spec).
 * The local modified DSH installation, its node_modules, its config and its
 * credentials are NEVER consulted.
 *
 * Usage: node scripts/materialize-embedded-dsh.mjs [--target <dir>] [--source <existing fresh clone>]
 *   --source: reuse an existing clone ONLY when it is clean and pinned at the exact
 *             SHA (research convenience; never a modified tree).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { deriveRuntimeExecutionClosure } from './lib/runtime-execution-closure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** The frozen implementation baseline (Stage 3 reproducibility gate). */
export const PINNED = {
  kernelId: 'dsh-managed-minimal-v1',
  upstreamRepo: 'https://github.com/deepseek-ai/deepseek-harness',
  upstreamSha: '639ed015397290b3745d163aafe02ffee4aa3f84',
  upstreamTag: 'dsh-v0.2.0-rc.2',
  profileName: 'companyos-minimal',
  transport: 'one-shot-ndjson',
  protocolVersion: 's24-ndjson/1',
  cliEntry: 'apps/cli/lib/bin.js',
  nodeRange: '^22.19.0 || >=24.0.0',
} ;

const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const run = (command, args, cwd, label, shell = false) => {
  console.log(`[materialize] ${label ?? `${command} ${args.join(' ')}`}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell });
  if (result.status !== 0) {
    console.error(`[materialize] FAILED (${label ?? command}) exit=${String(result.status)}`);
    process.exit(1);
  }
};

const sha256OfFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const gitIs = (cwd, args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  return out.status === 0 ? out.stdout.trim() : null;
};

const materialize = () => {
  const target = resolve(arg('target') ?? join(REPO_ROOT, '.companyos-embedded', 'dsh-runtime'));
  const runtime = join(target, 'runtime');
  mkdirSync(target, { recursive: true });

  /* ---- 1. official pinned source, verified clean ---- */
  if (arg('source') !== undefined) {
    const source = resolve(arg('source'));
    if (gitIs(source, ['rev-parse', 'HEAD']) !== PINNED.upstreamSha) {
      console.error(`[materialize] source clone is not at the pinned SHA (${PINNED.upstreamSha}); refusing.`);
      process.exit(1);
    }
    if (gitIs(source, ['status', '--porcelain']) !== '') {
      console.error('[materialize] source clone has a dirty working tree; refusing (no modified trees).');
      process.exit(1);
    }
    if (!existsSync(runtime)) {
      console.log(`[materialize] cloning verified source ${source} -> ${runtime}`);
      run('git', ['clone', source, runtime], target, 'clone verified source');
    }
  } else if (!existsSync(join(runtime, '.git'))) {
    run('git', ['clone', PINNED.upstreamRepo, runtime], target, 'clone official repo');
  }
  run('git', ['checkout', PINNED.upstreamSha], runtime, `checkout pinned SHA ${PINNED.upstreamSha.slice(0, 12)}`);
  const dirty = gitIs(runtime, ['status', '--porcelain']);
  if (dirty !== '') {
    console.error('[materialize] runtime tree is dirty after checkout; refusing.');
    process.exit(1);
  }
  const engines = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')).engines ?? {};
  const packageManager = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')).packageManager ?? '';

  /* ---- 2. install + official host build (unmodified) ---- */
  if (!existsSync(join(runtime, 'node_modules', '.pnpm'))) {
    run('pnpm', ['install', '--frozen-lockfile'], runtime, 'install (frozen lockfile)', process.platform === 'win32');
  }
  const cliEntry = join(runtime, ...PINNED.cliEntry.split('/'));
  if (!existsSync(cliEntry)) {
    // Exactly the upstream build:lib:host invocation (package.json @639ed015): tsc runs under
    // `node --max-old-space-size=4096`. Running tsc with the default heap OOMs on the
    // 2 GiB-default Windows runner (hark-installer 40254706132, evidence lane H15-ci).
    run(process.execPath, ['--max-old-space-size=4096', join('node_modules', 'typescript', 'bin', 'tsc'), '-b', 'tsconfig.host.json'], runtime, 'official host typecheck+emit (upstream build:lib:host heap)');
    run('pnpm', ['exec', 'tsdown', '--env.DSH_BUILD_FACE', 'host'], runtime, 'official host bundle', process.platform === 'win32');
  }
  if (!existsSync(cliEntry)) {
    console.error(`[materialize] build did not produce ${PINNED.cliEntry}`);
    process.exit(1);
  }

  /* ---- 3. CompanyOS-minimal profile scaffold (the embedded dsh-home template) ---- */
  const profileDir = join(target, 'dsh-home-template', 'profiles', PINNED.profileName);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n', 'utf8');
  writeFileSync(
    join(profileDir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    'utf8',
  );
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify(
      {
        name: `dsh-profile-${PINNED.profileName}`,
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-sdk-minimal'] } },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  // The patch layer is rendered per invocation by the adapter (model route + workspace
  // root are per-attempt facts); the template keeps the static skeleton.
  writeFileSync(
    join(target, 'profile-patch-template.yml'),
    [
      '# Rendered per invocation by the CompanyOS embedded-dsh adapter.',
      '# Structural exclusions (never present in any rendered tree):',
      '#   dsh goal / plan / workflow / agent-team / api / web / client / host / desktop /',
      '#   settings / telemetry / commands / llm-deepseek-account / authorization (OAuth) /',
      '#   plugin discovery — these packages are NOT in this composition.',
      '- id: llm-deepseek',
      '  disabled: true',
      '- id: sdk-jsonrpc-server',
      '  disabled: true',
      '- id: sdk-app-startup',
      '  disabled: true',
      '# H15: the official sdk-minimal bundle also mounts DeepSeek account/telemetry-adjacent',
      '# rows that DSH_DEFAULT_KERNEL_PROFILE_SPEC §3.4 excludes; they are disabled here and',
      '# therefore never shipped (the execution closure drops disabled rows).',
      '- id: deepseek-llm-api-extensions',
      '  disabled: true',
      '- id: session-log-deepseek',
      '  disabled: true',
      '- id: plugin-package-inventory-deepseek',
      '  disabled: true',
      '- id: sandbox-policy',
      '  config:',
      '    mode: workspace-write',
      '    workspaceRoot: "{{WORKSPACE_ROOT}}"',
      '- insert:',
      '    - id: fs-sandbox',
      "      name: '@deepseek-ai/dsh-fs-sandbox'",
      '    - id: tool-fs',
      "      name: '@deepseek-ai/dsh-tool-fs'",
      '    - id: llm-pi-ai',
      "      name: '@deepseek-ai/dsh-llm-pi-ai'",
      '      config:',
      '        providers:',
      '          "{{ROUTE_PROVIDER}}":',
      '            displayName: CompanyOS Model Pool route',
      '            apiKeyEnv: "{{ROUTE_API_KEY_ENV}}"',
      '            api: openai-completions',
      '            baseURL: "{{ROUTE_BASE_URL}}"',
      '            {{ROUTE_COMPAT}}',
      '            models:',
      '              - id: "{{ROUTE_MODEL}}"',
      '                name: CompanyOS selected model',
      '                contextWindow: {{ROUTE_CONTEXT_WINDOW}}',
      '                maxTokens: {{ROUTE_MAX_TOKENS}}',
      '    - id: agent-default-model',
      "      name: '@deepseek-ai/dsh-agent-default-model'",
      '      config:',
      '        provider: "{{ROUTE_PROVIDER}}"',
      '        model: "{{ROUTE_MODEL}}"',
      '    - id: headless-startup',
      "      name: '@deepseek-ai/dsh-headless/startup'",
      '    - id: headless-runner',
      "      name: '@deepseek-ai/dsh-headless'",
      '      inject: [headlessStartup]',
      '      config:',
      '        task: !!js ctx.headlessStartup.task',
      '        sessionId: !!js ctx.headlessStartup.sessionId',
      '        json: !!js ctx.headlessStartup.json',
      '',
    ].join('\n') +
    // LIVE-SMOKE-FIX-08B - TOP-LEVEL config on the EXISTING win32 terminal row (the
    // same pattern the sandbox-policy entry uses): the persistent pwsh terminal loads
    // the CompanyOS headless shell guard at startup. Original keys are restated so the
    // entry stays correct under either patch-merge semantic.
    [
      '# LIVE-SMOKE-FIX-08B: the persistent pwsh terminal loads the CompanyOS headless',
      '# shell guard at startup (functions `cmd`/`cmd.exe` reject WSH-associated script',
      '# dispatch in the cmd /c|/k command position; everything else forwards verbatim).',
      '- id: terminal-pwsh',
      '  config:',
      '    shellDialect: pwsh',
      '    timeoutMs: 300000',
      '    shellArgs:',
      '      - -NoLogo',
      '      - -NoProfile',
      '      - -NoExit',
      '      - -ExecutionPolicy',
      '      - Bypass',
      '      - -File',
      "      - '{{DSH_SHELL_GUARD}}'",
      '',
    ].join('\n'),
    'utf8',
  );

  /*
   * LIVE-SMOKE-FIX-08B - the HEADLESS SHELL GUARD bootstrap. The embedded kernel's
   * persistent pwsh tool spawns the shell with `-NoLogo -NoProfile`; we refine that
   * argv (per-attempt, via the rendered cordis patch below) to
   * `-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File <guard>`: the guard
   * script runs once at shell startup, installs `cmd` / `cmd.exe` FUNCTIONS
   * (PowerShell command discovery resolves functions before applications), and
   * rejects only the WSH-associated script family in the COMMAND position of a
   * cmd /c|/k invocation - `cmd /c node app.js` (explicit runtime + script
   * argument) passes; `cmd /c app.js` (script treated as executable through the
   * Windows desktop association) fails fast with actionable text. No registry,
   * no global association change, no runtime guessing.
   */
  writeFileSync(
    join(target, 'headless-shell-guard.ps1'),
    [
      '# CompanyOS headless shell guard (LIVE-SMOKE-FIX-08B) - staged template, loaded at pwsh startup.',
      '# Accidental desktop-association dispatch of WSH-hosted scripts inside the unattended',
      '# DSH shell fails fast; every other command form forwards to the real cmd.exe verbatim.',
      "$script:CompanyOSWshExts = @('.js', '.jse', '.vbs', '.vbe', '.wsf', '.wsh')",
      '$CompanyOSCmdBody = {',
      '  $switchSeen = $false; $payload = $null',
      '  foreach ($a in $args) {',
      "    if (-not $switchSeen) { if (([string]$a) -match '^/[ck]($|:)') { $switchSeen = $true }; continue }",
      '    $payload = [string]$a; break',
      '  }',
      '  if ($null -ne $payload) {',
      '    $first = ((($payload.Trim()).Trim(\'"\')).Trim("\'") -split \'\\s+\', 2)[0]',
      '    $ext = [System.IO.Path]::GetExtension($first)',
      '    if ($ext -and ($script:CompanyOSWshExts -contains $ext.ToLowerInvariant())) {',
      '      [Console]::Error.WriteLine(\'companyos: refusing WSH desktop-association dispatch of "\' + $first + \'"; explicit runtime required (e.g. node <script>)\')',
      '      $global:LASTEXITCODE = 1',
      '      return',
      '    }',
      '  }',
      '  & "$env:SystemRoot\\System32\\cmd.exe" @args',
      '}',
      "New-Item -Path Function: -Name 'global:cmd' -Value $CompanyOSCmdBody -Force | Out-Null",
      "New-Item -Path Function: -Name 'global:cmd.exe' -Value $CompanyOSCmdBody -Force | Out-Null",
      '# H15c: readiness-ordered prompt. The kernel recognises an idle pwsh only when its OSC 133;D',
      '# marker is followed by exactly the printable prompt. Windows ConPTY passes OSC sequences',
      '# through at once but paints buffered screen text on its own render frame, so text written',
      '# just before the prompt (the echoed bootstrap line, command output) can arrive AFTER the',
      '# marker and invalidate it; the kernel then waits for a marker that never comes. This prompt',
      '# lets ConPTY paint pending text first, then emits marker + prompt with the same bytes and',
      '# exit-code semantics as the kernel bootstrap. An alias outranks functions in command lookup,',
      "# so the kernel's own `function prompt` definition stays valid but is never the one invoked.",
      'function global:CompanyOSOrderedPrompt {',
      '  $code = [int]$global:LASTEXITCODE',
      '  [Console]::Out.Flush()',
      '  [System.Threading.Thread]::Sleep(120)',
      "  [Console]::Write([char]27 + ']133;D;' + $code + [char]7)",
      "  'dsh> '",
      '}',
      'Set-Alias -Name prompt -Value CompanyOSOrderedPrompt -Scope Global -Option ReadOnly -Force',
      '',
    ].join('\n'),
    'utf8',
  );

  /* ---- 3b. RUNTIME EXECUTION CLOSURE manifest (STAGE 5B) ---- */
  // Derives the execution closure from the REAL package/runtime graph (CLI
  // chunks + composition-declared packages + static import trace over build
  // output) and records a sha256 for EVERY EXECUTABLE/CONFIG/NATIVE_CRITICAL
  // file — 100% cryptographic coverage, NO sampling. Docs/licenses/maps/tests
  // are classified NON_EXECUTION_ASSET and are deliberately not verified.
  // Binding is one-directional: manifest.json records sha256(closure bytes) as
  // closureGeneration — editing the closure alone fails the resolve; editing
  // BOTH the tree and both artifacts is the replace-CompanyOS platform boundary.
  const manifestDraft = {
    kernelId: PINNED.kernelId,
    upstreamRepo: PINNED.upstreamRepo,
    upstreamSha: PINNED.upstreamSha,
    upstreamTag: PINNED.upstreamTag,
    runtimeRoot: runtime,
    cliEntry: PINNED.cliEntry,
    nodeRange: engines.node ?? PINNED.nodeRange,
    packageManager,
    profileName: PINNED.profileName,
    dshHomeTemplateDir: join(target, 'dsh-home-template'),
    profilePatchTemplate: join(target, 'profile-patch-template.yml'),
    shellGuardScript: join(target, 'headless-shell-guard.ps1'),
    transport: PINNED.transport,
    protocolVersion: PINNED.protocolVersion,
    license: 'MIT (per-package; see runtime THIRD_PARTY_NOTICES.md and package LICENSE files)',
    checksums: {
      [PINNED.cliEntry]: sha256OfFile(cliEntry),
      'packages/bundle/sdk-minimal/cordis.patch.yml': sha256OfFile(
        join(runtime, 'packages', 'bundle', 'sdk-minimal', 'cordis.patch.yml'),
      ),
    },
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifestDraft, null, 2) + '\n', 'utf8');
  const closure = deriveRuntimeExecutionClosure({
    managedRoot: target,
    manifest: { ...manifestDraft, runtimeRoot: runtime },
  });
  writeFileSync(join(target, 'closure-manifest.json'), JSON.stringify(closure), 'utf8');
  console.log(
    `[materialize] execution closure: ${String(closure.counts.totalCritical)} critical files`
    + ` (exec ${String(closure.counts.EXECUTABLE_CRITICAL)} / config ${String(closure.counts.CONFIG_CRITICAL)}`
    + ` / native ${String(closure.counts.NATIVE_CRITICAL)}), samplingUsed=false`,
  );

  /* ---- 4. immutable manifest ---- */
  const manifest = {
    ...manifestDraft,
    // sha256(closure-manifest.json bytes): the resolver re-derives BOTH artifacts on
    // every resolve and rejects a closure edited out-of-band.
    closureGeneration: createHash('sha256').update(
      readFileSync(join(target, 'closure-manifest.json')),
    ).digest('hex'),
  };
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('[materialize] manifest written:');
  console.log(JSON.stringify({ ...manifest, checksums: Object.keys(manifest.checksums) }, null, 2));
  console.log(`[materialize] DONE -> ${target}`);
};

materialize();
