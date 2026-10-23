'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cli = path.resolve(__dirname, '../bin/ai-secret-check.js');
const site = '.venv/lib/python3.13/site-packages';
const dummy = 'DUMMY_MARK_VALUE';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'python-startup-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(!fs.lstatSync(root).isSymbolicLink());
    fs.rmSync(root, { recursive: true });
  });
  return root;
}
function write(root, file, text = dummy) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}
function snapshot(root) {
  const entries = {};
  function visit(relative) {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    entries[relative] = { mtime: stat.mtimeMs, type: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'file' };
    if (stat.isFile()) entries[relative].contents = fs.readFileSync(file).toString('base64');
    if (stat.isSymbolicLink()) entries[relative].target = fs.readlinkSync(file);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
    }
  }
  visit('');
  return entries;
}
function run(root, { args = [], virtualEnv = '', preload = [], env = {}, hidden = [], command = 'scan-python-startup' } = {}) {
  const before = snapshot(root);
  const result = spawnSync(process.execPath, [...preload.flatMap((p) => ['--require', p]), cli, command, ...args], {
    cwd: root, env: { ...process.env, HOME: root, VIRTUAL_ENV: virtualEnv, CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', ...env },
    encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.deepEqual(snapshot(root), before, 'contents, mtime and directory entries must remain unchanged recursively');
  for (const value of [root, dummy, ...hidden]) assert.ok(!(result.stdout + result.stderr).includes(value), 'must not expose contents, full paths or raw errors');
  return result;
}

test('Python startup: pth import lines report only label, filename, kind and count', (t) => {
  const root = fixture(t);
  write(root, `${site}/demo.pth`, `import os; ${dummy}\n`);
  const r = run(root);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /\.\/\.venv: demo\.pth（import 行 1件）/);
  assert.match(r.stdout, /\*\.dist-info\/RECORD/);
  assert.match(r.stdout, /distutils-precedence\.pth/);
  assert.match(r.stdout, /pip uninstall.*キーを再発行/);
  assert.match(r.stdout, /正規のパッケージでも該当.*怪しいかどうかは判定しません.*安全の保証/);
});

test('Python startup: paths, indented imports and other import spellings do not count', (t) => {
  const root = fixture(t);
  write(root, `${site}/paths.pth`, `/some/dir\n  import x\n\timport x\nimport\nimportx\n#import x\n`);
  const r = run(root);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /起動時に実行されるものはありません（確認した場所 1 か所）/);
});

test('Python startup: tab, space, repeated import lines and all newline styles count exactly', (t) => {
  const root = fixture(t);
  write(root, `${site}/multi.pth`, `import\tos; ${dummy}\r\nimport x\rimport x\nimport\vx\n`);
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /multi\.pth（import 行 3件）/);
});

test('Python startup: start files count files, without evaluating their contents', (t) => {
  const root = fixture(t);
  write(root, `${site}/foo.start`, `${dummy}\n${dummy}\n`);
  write(root, `${site}/empty.start`, '');
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /foo\.start（\.start ファイル 1件）/);
  assert.match(r.stdout, /empty\.start（\.start ファイル 1件）/);
});

test('Python startup: home usercustomize and local venv sitecustomize are counted', (t) => {
  const root = fixture(t);
  write(root, '.local/lib/python3.12/site-packages/usercustomize.py');
  write(root, 'venv/lib/python3.13/site-packages/sitecustomize.py');
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /~\/\.local: usercustomize\.py（customize ファイル 1件）/);
  assert.match(r.stdout, /\.\/venv: sitecustomize\.py（customize ファイル 1件）/);
});

test('Python startup: VIRTUAL_ENV is labeled without its path and resolved duplicates count once', (t) => {
  const root = fixture(t);
  write(root, `${site}/demo.pth`, 'import x');
  const r = run(root, { virtualEnv: path.join(root, 'unused/../.venv') });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\$VIRTUAL_ENV: demo\.pth（import 行 1件）/);
  assert.equal(r.stdout.split('demo.pth').length - 1, 1);
  assert.doesNotMatch(r.stdout, /\.\/\.venv:/);
});

test('Python startup: discovery includes python3 variants and multiple environments only at specified depth', (t) => {
  const root = fixture(t);
  for (const v of ['python3.12', 'python3.13t']) write(root, `.venv/lib/${v}/site-packages/demo.pth`, 'import x');
  write(root, 'external/lib/python3.15/site-packages/extra.start');
  for (const file of ['.venv/Lib/site-packages/windows.pth', '.venv/lib/python2.7/site-packages/old.pth',
    '.venv/lib/python3.13t/site-packages/nested/hidden.pth', '.local/Library/Python/3.13/site-packages/mac.pth',
    '.venv/lib/python3.13t/site-packages/other.py']) write(root, file, 'import x');
  const r = run(root, { virtualEnv: path.join(root, 'external') });
  assert.equal(r.status, 1);
  assert.equal(r.stdout.split('demo.pth').length - 1, 2);
  assert.match(r.stdout, /\$VIRTUAL_ENV: extra\.start/);
  for (const name of ['windows.pth', 'old.pth', 'hidden.pth', 'mac.pth', 'other.py']) assert.ok(!r.stdout.includes(name));
});

test('Python startup: no site-packages is clean with zero checked locations', (t) => {
  const r = run(fixture(t));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /起動時に実行されるものはありません（確認した場所 0 か所）/);
});

test('Python startup: PATH is unnecessary and cannot trigger python or pip', (t) => {
  const root = fixture(t);
  write(root, `${site}/demo.pth`, `import os; ${dummy}`);
  const ordinary = run(root);
  const emptyPath = run(root, { env: { PATH: '' } });
  assert.equal(emptyPath.status, 1);
  assert.equal(emptyPath.stdout, ordinary.stdout);
  assert.equal(emptyPath.stderr, ordinary.stderr);
});

test('Python startup: extra arguments and JSON exit 2 before scanning', (t) => {
  const root = fixture(t);
  write(root, `${site}/demo.pth`, `import os; ${dummy}`);
  for (const arg of ['extra', '--json', '--help']) {
    const r = run(root, { args: [arg] });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^Usage: ai-secret-check .*scan-python-startup/);
  }
});

test('Python startup: global help includes the command and JSON limitation', (t) => {
  const r = run(fixture(t), { command: '--help' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /scan-python-startup\s+Python.*JSON出力非対応/);
});

test('Python startup: linked pth outside the fixture is skipped without reading the target', (t) => {
  const root = fixture(t);
  const external = fixture(t);
  write(external, 'outside.pth', `import os; ${dummy}`);
  fs.mkdirSync(path.join(root, site), { recursive: true });
  try { fs.symlinkSync(path.join(external, 'outside.pth'), path.join(root, site, 'linked.pth'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('file links unavailable'); return; } throw error; }
  const before = snapshot(external);
  const r = run(root, { hidden: [external] });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /linked\.pth/);
  assert.deepEqual(snapshot(external), before);
});

test('Python startup: linked ancestors at each discovery level are skipped', (t) => {
  for (const level of ['.venv', '.venv/lib', '.venv/lib/python3.13', site]) {
    const root = fixture(t);
    const external = fixture(t);
    const suffix = site.slice(level.length).replace(/^\//, '');
    write(external, path.posix.join(suffix, 'outside.pth'), `import x; ${dummy}`);
    fs.mkdirSync(path.dirname(path.join(root, level)), { recursive: true });
    try { fs.symlinkSync(external, path.join(root, level), 'junction'); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('directory links unavailable'); return; } throw error; }
    const before = snapshot(external);
    const r = run(root, { hidden: [external] });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /確認した場所 0 か所/);
    assert.deepEqual(snapshot(external), before);
  }
});

test('Python startup: named directories are not read or counted as startup files', (t) => {
  const root = fixture(t);
  for (const name of ['demo.pth', 'foo.start', 'sitecustomize.py', 'usercustomize.py']) {
    fs.mkdirSync(path.join(root, site, name), { recursive: true });
  }
  assert.equal(run(root).status, 0);
});

test('Python startup: no writes, subprocesses or network; sanitized read failures take precedence', (t) => {
  const root = fixture(t);
  write(root, `${site}/demo.pth`, `import os; ${dummy}`);
  write(root, `${site}/foo.start`);
  write(root, `${site}/sitecustomize.py`);
  write(root, 'guard.cjs', `
const fs = require('node:fs');
const fail = () => { throw new Error('DUMMY_RAW_ERROR_NEVER_PRINT'); };
for (const name of ['writeFileSync', 'appendFileSync', 'unlinkSync', 'renameSync', 'mkdirSync', 'rmSync', 'truncateSync', 'writeSync']) fs[name] = fail;
const open = fs.openSync;
fs.openSync = function(file, flags, ...rest) { if (typeof flags === 'number' ? flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC) : flags !== 'r') fail(); return open.call(this, file, flags, ...rest); };
for (const name of ['exec', 'execSync', 'spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) require('node:child_process')[name] = fail;
for (const name of ['request', 'get']) { require('node:http')[name] = fail; require('node:https')[name] = fail; }
require('node:net').connect = fail; require('node:net').createConnection = fail; global.fetch = fail;
`);
  const guard = path.join(root, 'guard.cjs');
  assert.equal(run(root, { preload: [guard], hidden: ['DUMMY_RAW_ERROR_NEVER_PRINT'] }).status, 1);
  write(root, 'fail-read.cjs', `const fs = require('node:fs'); const read = fs.readFileSync; fs.readFileSync = function(file, ...rest) { if (typeof file === 'number') throw new Error('DUMMY_RAW_READ_ERROR'); return read.call(this, file, ...rest); };`);
  const r = run(root, { preload: [guard, path.join(root, 'fail-read.cjs')], hidden: ['DUMMY_RAW_READ_ERROR'] });
  assert.equal(r.status, 2);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /\.\/\.venv: 確認できません/);
  assert.match(r.stdout, /foo\.start/);
});

test('Python startup: directory enumeration failure is not reported as clean', (t) => {
  const root = fixture(t);
  write(root, `${site}/demo.pth`, 'import x');
  write(root, 'fail-directory.cjs', `const fs = require('node:fs'); const read = fs.readdirSync; fs.readdirSync = function(file, ...rest) { if (file.endsWith('site-packages')) throw new Error('DUMMY_RAW_DIRECTORY_ERROR'); return read.call(this, file, ...rest); };`);
  const r = run(root, { preload: [path.join(root, 'fail-directory.cjs')], hidden: ['DUMMY_RAW_DIRECTORY_ERROR'] });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /確認できません/);
  assert.doesNotMatch(r.stdout, /起動時に実行されるものはありません/);
});
