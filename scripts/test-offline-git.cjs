/* Test-only Git admission. No shell, remote transport, hooks, filters or user config. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const real = file => fs.realpathSync.native(path.resolve(file));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const within = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const identity = file => { const stat = fs.statSync(file, {bigint:true}); return {path:real(file),dev:String(stat.dev),ino:String(stat.ino),hash:stat.isFile()?hash(file):null}; };
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
// Platform paths are derived from this installed script, never CI or a supplied
// environment root. Linux temp belongs to the existing wrapper/setup profile.
function createPlatformPaths(refuse, protectedPath, repositoryRoot = path.resolve(__dirname, '..')) {
  if (!['win32','linux'].includes(process.platform)) refuse('unsupported-offline-platform');
  const same = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  function directory(input) {
    if (typeof input !== 'string' || !path.isAbsolute(input) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(input)) refuse('offline-path-not-absolute-or-traversal');
    const requested = path.resolve(input), full = real(input);
    if (!same(requested, full) || protectedPath(full) || !fs.statSync(full).isDirectory()) refuse('offline-path-alias-or-boundary');
    for (let current=requested;current!==path.parse(current).root;current=path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) refuse('offline-path-reparse-parent');
    }
    return full;
  }
  const installed = directory(path.resolve(__dirname,'..'));
  if (!same(directory(repositoryRoot), installed)) refuse('unknown-offline-repository');
  if (process.platform === 'win32' && !/^F:/i.test(installed)) refuse('offline-repository-must-be-f-drive');
  const pinned = identity(installed);
  function repository() {
    if (!equal(identity(directory(repositoryRoot)), pinned)) refuse('offline-repository-identity-drift');
    return installed;
  }
  function temporary() {
    const root = repository(), temp = directory(os.tmpdir());
    if (process.platform === 'win32') {
      if (!/^F:/i.test(temp)) refuse('offline-temp-must-be-f-drive');
    } else {
      if (typeof process.getuid !== 'function' || fs.statSync(temp).uid !== process.getuid()
          || (fs.statSync(temp).mode & 0o022)) refuse('linux-temp-not-private-owned-directory');
      const parent = directory(path.join(root,'.tmp','offline-gates'));
      const rel = path.relative(parent,temp);
      // mkdtemp-owned run, worker and node:safety profiles only; not all /tmp,
      // not the parent itself and not an environment-selected external root.
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)
          || !/^(?:run|worker|node-safety)-[a-zA-Z0-9_-]+$/.test(rel.split(path.sep)[0])) refuse('linux-temp-not-owned-offline-profile');
    }
    return temp;
  }
  return {repository, temporary, directory};
}
function createGitPolicy(refuse, protectedPath, inherited = [], repositoryRoot = null) {
  const paths = createPlatformPaths(refuse, protectedPath, repositoryRoot ?? path.resolve(__dirname,'..'));
  const roots = new Map(inherited.map(row => [row.root.path, row]));
  const findGit = () => {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      const file = path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git');
      if (path.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile()) return real(file);
    }
    return refuse('git-binary-not-found');
  };
  function register(root) {
    const dir = paths.directory(root), temp = paths.temporary();
    if (process.platform === 'win32' && !/^F:/i.test(dir)) refuse('git-fixture-must-be-f-drive');
    if (dir === temp || !within(temp, dir) || protectedPath(dir) || !fs.statSync(dir).isDirectory()) refuse('git-fixture-must-be-owned-temp');
    // Registration records a real directory identity; it cannot be switched to a junction.
    if (path.resolve(root).toLowerCase() !== dir.toLowerCase()) refuse('git-fixture-reparse-alias');
    const hooks = fs.mkdtempSync(path.join(temp, 'offline-empty-hooks-'));
    if (fs.readdirSync(hooks).length) refuse('git-hooks-directory-not-empty');
    const row = {root:identity(dir), binary:identity(findGit()), hooks:identity(hooks)};
    roots.set(dir, row); return row;
  }
  function registerReadOnlyRepository() {
    if (!repositoryRoot) refuse('read-only-repository-unavailable');
    const dir = paths.repository();
    const hooks = fs.mkdtempSync(path.join(paths.temporary(), 'offline-readonly-hooks-'));
    const row = {root:identity(dir), binary:identity(findGit()), hooks:identity(hooks), readOnly:true};
    roots.set(dir, row); return row;
  }
  function request(file, argv, options = {}) {
    if (!/^(?:git|git\.exe)$/i.test(path.basename(file))) return null;
    if (!path.isAbsolute(file) && !/^(?:git|git\.exe)$/i.test(file)) refuse('git-relative-executable-override');
    paths.repository();
    const cwd = paths.directory(options.cwd ?? process.cwd());
    const row = roots.get(cwd) ?? [...roots.values()].find(entry=>within(entry.root.path,cwd));
    if (!row || !equal(identity(row.root.path), row.root)) refuse('unregistered-or-changed-git-workspace');
    if (!row.readOnly && !within(paths.temporary(), cwd)) refuse('git-workspace-outside-owned-temp');
    if (row.readOnly && (cwd !== paths.repository() || cwd !== row.root.path || ![
      ['rev-parse','--verify','refs/tags/sprint-11.0.0'],
      ['ls-files','packs/dev-company'],
    ].some(approved=>JSON.stringify(argv)===JSON.stringify(approved)))) refuse('unapproved-read-only-repository-query');
    // A bare command is replaced with the registered absolute binary before spawn.
    if (path.isAbsolute(file) && real(file) !== row.binary.path) refuse('git-binary-override');
    if (!equal(identity(row.binary.path), row.binary)) refuse('git-binary-identity-drift');
    if (!equal(identity(row.hooks.path), row.hooks) || fs.readdirSync(row.hooks.path).length) refuse('git-hooks-directory-changed');
    if (argv.some(arg => typeof arg !== 'string' || /[\r\n\0]/.test(arg))) refuse('malformed-git-arguments');
    let args = [...argv];
    if (args[0] === '--no-pager') args.shift();
    while (args[0] === '-c') {
      if (!['core.fsmonitor=false','core.untrackedCache=false'].includes(args[1])) refuse('git-config-override');
      args.splice(0,2);
    }
    const command = args.shift();
    if (command === 'worktree') {
      if (args.length!==4 || args[0]!=='add' || args[2]!=='-b' || !/^[a-z][a-z0-9-]*$/i.test(args[3])) refuse('unapproved-git-worktree');
      const target=path.resolve(args[1]), temp=paths.temporary();
      if (!path.isAbsolute(args[1]) || !within(temp,target) || target===temp || protectedPath(target) || fs.existsSync(target)) refuse('git-worktree-outside-owned-temp');
      fs.mkdirSync(target); register(target);
    }
    const flags = {
      init:['-q','--bare'], config:[], add:['-A','.','--'], commit:['-m','-qm','--no-gpg-sign'],
      'rev-parse':['HEAD','--is-bare-repository','--show-toplevel','--absolute-git-dir','--git-dir','--verify'],
      status:['--porcelain','--porcelain=v2','-z','--branch'], 'ls-files':['--stage','-z'],
      diff:['--no-ext-diff','--no-textconv','--no-color','-z','--cached','--name-only','--'],
      'hash-object':['-w','--stdin'], 'update-index':['--add','--cacheinfo','--chmod=+x'],
      mv:[], checkout:['--detach'], 'write-tree':[], 'for-each-ref':['--format=%(refname) %(objectname)'], '--version':[], worktree:[],
    };
    // Only the owned-temp worktree construction above is admitted; other
    // worktree operations and unknown commands remain denied.
    if (!(command in flags)) refuse('unapproved-git-command');
    if (command === 'config') {
      if (args.length !== 2 || !['user.name','user.email','core.autocrlf','diff.external','core.fsmonitor','core.pager'].includes(args[0])) refuse('unapproved-git-config');
    } else if (command !== 'worktree') {
      for (let i=0;i<args.length;i++) {
        const arg=args[i];
        if (command === 'commit' && ['-m','-qm'].includes(arg)) { if (typeof args[++i] !== 'string') refuse('missing-commit-message'); continue; }
        if (arg.startsWith('-') && !flags[command].includes(arg)) refuse('unapproved-git-option');
        if (path.isAbsolute(arg) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(arg) || protectedPath(path.resolve(cwd,arg))) refuse('git-path-outside-fixture');
      }
    }
    // Git may launch native helpers without Node's guard. Deny executable filters
    // and config includes; fixed argv below suppresses hooks/fsmonitor/pagers/diff.
    const gitDir = path.join(cwd,'.git');
    const linked=fs.existsSync(gitDir) && !fs.statSync(gitDir).isDirectory();
    if (linked) {
      const text=fs.readFileSync(gitDir,'utf8').trim();
      if (!text.startsWith('gitdir: ') || command!=='rev-parse') refuse('unreviewed-gitdir-indirection');
      const metadata=real(path.resolve(cwd,text.slice(8)));
      if (![...roots.values()].some(entry=>within(path.join(entry.root.path,'.git','worktrees'),metadata))) refuse('foreign-gitdir-indirection');
    }
    if (fs.existsSync(gitDir) && fs.lstatSync(gitDir).isSymbolicLink()) refuse('git-metadata-reparse');
    for (const name of ['config','index','objects','refs','info']) {
      const entry=path.join(fs.existsSync(gitDir)?gitDir:cwd,name);
      if (fs.existsSync(entry) && (!within(cwd,real(entry)) || fs.lstatSync(entry).isSymbolicLink())) refuse('git-metadata-reparse');
    }
    if (fs.existsSync(path.join(fs.existsSync(gitDir)?gitDir:cwd,'objects','info','alternates'))) refuse('git-alternate-object-store');
    const config = path.join(fs.existsSync(gitDir)&&!linked?gitDir:cwd,'config');
    if (fs.existsSync(config) && /\[\s*(?:filter\b|include\b|includeIf\b)/i.test(fs.readFileSync(config,'utf8'))) refuse('git-external-filter-or-include');
    const env = {...options.env};
    for (const key of Object.keys(env)) if (/^GIT_/i.test(key) && !/^GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL|DATE)$/.test(key)) delete env[key];
    Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_CEILING_DIRECTORIES:path.dirname(row.root.path)});
    const commandIndex = argv.length-args.length-1;
    const safeArgs = command === 'diff' ? [...argv.slice(0,commandIndex+1),'--no-ext-diff','--no-textconv','--no-color',...argv.slice(commandIndex+1)] : argv;
    return {file:row.binary.path,argv:['--no-pager','-c',`core.hooksPath=${row.hooks.path}`,'-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','core.pager=','-c','diff.external=','-c','protocol.allow=never','-c',`init.templateDir=${row.hooks.path}`,...safeArgs],options:{...options,cwd,env}};
  }
  return {register, registerReadOnlyRepository, request, ledger:()=>[...roots.values()]};
}
module.exports = {createGitPolicy, createPlatformPaths};
