'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cli = path.resolve(__dirname, '../bin/ai-secret-check.js');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-history-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(!fs.lstatSync(root).isSymbolicLink());
    fs.rmSync(root, { recursive: true });
  });
  return root;
}
function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}
function snapshot(root) {
  const entries = {};
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    entries[name] = { mtime: stat.mtimeMs, type: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'file' };
    if (stat.isFile()) entries[name].contents = fs.readFileSync(file).toString('base64');
    if (stat.isSymbolicLink()) entries[name].target = fs.readlinkSync(file);
  }
  return entries;
}
function run(root, { args = [], histfile = '', preload = [], hidden = [] } = {}) {
  const before = snapshot(root);
  const result = spawnSync(process.execPath, [...preload.flatMap((p) => ['--require', p]), cli, 'scan-shell-history', ...args], {
    cwd: root, env: { ...process.env, HOME: root, HISTFILE: histfile, CODEX_HOME: '', CLAUDE_CONFIG_DIR: '' },
    encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.deepEqual(snapshot(root), before, 'file contents, mtime and directory entries must remain unchanged');
  const output = result.stdout + result.stderr;
  for (const value of [root, ...hidden]) assert.ok(!output.includes(value), 'must not expose a value, command, path or raw error');
  return result;
}

test('shell history: bash assignments count lines and never expose values or commands', (t) => {
  const root = fixture(t);
  const value = 'sk-dummy-AAAA1111';
  const command = `export DEMO_API_KEY=${value}`;
  write(root, '.bash_history', `${command}\nls\n`);
  const result = run(root, { hidden: [value, command, 'DEMO_API_KEY='] });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /~\/\.bash_history: 秘密情報らしい行 1件（KEY=値形式 1件）/);
  assert.match(result.stdout, /ローテーション/);
  assert.match(result.stdout, /すべての端末を閉じて/);
  assert.match(result.stdout, /read -rs/);
  assert.match(result.stdout, /ignorespace.*ignoreboth/);
  assert.match(result.stdout, /Read\(~\/\.bash_history\)/);
});

test('shell history: zsh extended history counts one line across multiple kinds', (t) => {
  const root = fixture(t);
  const value = 'ghp_' + 'A'.repeat(20);
  write(root, '.zsh_history', `: 1700000000:0;export GITHUB_TOKEN=${value}\r\n`);
  const result = run(root, { hidden: [value, 'GITHUB_TOKEN=', '1700000000'] });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /~\/\.zsh_history: 秘密情報らしい行 1件/);
  assert.match(result.stdout, /KEY=値形式 1件/);
  assert.match(result.stdout, /GitHubトークン形式 \(ghp_\) 1件/);
});

test('shell history: custom HISTFILE hides its path and Bearer value', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'custom-history');
  const command = 'curl -H "Authorization: Bearer dummy-token-value"';
  write(root, 'custom-history', command);
  const result = run(root, { histfile: file, hidden: ['custom-history', command, 'dummy-token-value'] });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /HISTFILE: 秘密情報らしい行 1件（Authorization: Bearer形式 1件）/);
});

test('shell history: resolved duplicate HISTFILE is scanned once under the standard label', (t) => {
  const root = fixture(t);
  write(root, '.bash_history', 'GITHUB_TOKEN=dummy-dedup\n');
  const result = run(root, { histfile: path.join(root, 'sub/../.bash_history'), hidden: ['dummy-dedup'] });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.split('秘密情報らしい行 1件').length - 1, 1);
  assert.doesNotMatch(result.stdout, /^HISTFILE:/m);
});

test('shell history: ordinary commands, read input, empty assignments and empty Bearer are clean', (t) => {
  const root = fixture(t);
  write(root, '.bash_history', 'ls\nexport PATH=/dummy\nread -rs OPENAI_API_KEY\nAPI_KEY=\nAPI_KEY=""\nAPI_KEY=\'\'\nTOKEN="" NEXT=ordinary\ncurl -H "Authorization: Bearer "\n');
  const result = run(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /一致なし（確認したファイル 1件）/);
});

test('shell history: no existing histories is clean and explains the coverage limit', (t) => {
  const result = run(fixture(t));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /~\/\.bash_history: なし/);
  assert.match(result.stdout, /~\/\.zsh_history: なし/);
  assert.match(result.stdout, /一致なし（確認したファイル 0件）/);
  assert.match(result.stdout, /既知の形式.*安全の保証.*fish/);
});

test('shell history: assignments include exact and mixed-case names, PASSWD, quotes and command prefixes', (t) => {
  const root = fixture(t);
  write(root, '.bash_history', 'KEY=one\nTOKEN=two cmd\napp_secret="three"\nDB_PASSWORD=\'four\'\nPASSWD=five\n');
  const result = run(root, { hidden: ['KEY=one', 'TOKEN=two', 'app_secret=', 'DB_PASSWORD=', 'PASSWD='] });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /秘密情報らしい行 5件（KEY=値形式 5件）/);
});

test('shell history: all six known prefixes use scan-logs conditions and line-based counts', (t) => {
  const root = fixture(t);
  const values = ['sk-ant-' + 'A'.repeat(10), 'sk-' + 'B'.repeat(20), 'ghp_' + 'C'.repeat(20),
    'github_pat_' + 'D'.repeat(20), 'AKIA' + 'E'.repeat(16), 'xoxb-' + 'F'.repeat(10)];
  write(root, '.bash_history', values.map((v) => `echo ${v} ${v}`).join('\n'));
  const result = run(root, { hidden: values });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /秘密情報らしい行 6件/);
  for (const kind of ['Anthropic APIキー形式', 'APIキー形式 (sk-)', 'GitHubトークン形式 (ghp_)',
    'GitHubトークン形式 (github_pat_)', 'AWSアクセスキーID形式', 'Slackトークン形式']) assert.ok(result.stdout.includes(kind + ' 1件'));
});

test('shell history: short prefixes are not promoted into full key matches', (t) => {
  const root = fixture(t);
  write(root, '.bash_history', 'echo sk-ant-short sk-short ghp_short github_pat_short AKIA123 xoxb-short\n');
  assert.equal(run(root).status, 0);
});

test('shell history: invalid arguments and JSON are rejected before reading files', (t) => {
  const root = fixture(t);
  write(root, '.bash_history', 'SECRET=dummy-unused');
  for (const arg of ['extra', '--json', '--help']) {
    const result = run(root, { args: [arg], hidden: ['dummy-unused'] });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Usage: ai-secret-check/);
  }
});

test('shell history: symlink files are rejected without following their target', (t) => {
  const root = fixture(t);
  write(root, 'actual-history', 'SECRET=dummy-symlink-target');
  try { fs.symlinkSync(path.join(root, 'actual-history'), path.join(root, '.bash_history'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('file links unavailable'); return; } throw error; }
  const result = run(root, { hidden: ['dummy-symlink-target', 'actual-history'] });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /~\/\.bash_history: 確認できません/);
});

test('shell history: directory HISTFILE and linked parents are rejected', (t) => {
  const root = fixture(t);
  assert.equal(run(root, { histfile: root }).status, 2);
  const target = fixture(t);
  write(target, 'history', 'SECRET=dummy-parent-target');
  try { fs.symlinkSync(target, path.join(root, 'parent-link'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('directory links unavailable'); return; } throw error; }
  const result = run(root, { histfile: path.join(root, 'parent-link/history'), hidden: ['dummy-parent-target', target] });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /HISTFILE: 確認できません/);
});

test('shell history: safe read errors take precedence over findings', (t) => {
  const root = fixture(t);
  write(root, '.bash_history', 'SECRET=dummy-known-value');
  fs.mkdirSync(path.join(root, '.zsh_history'));
  const result = run(root, { hidden: ['dummy-known-value'] });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /秘密情報らしい行 1件/);
  assert.match(result.stdout, /~\/\.zsh_history: 確認できません/);
});

test('shell history: scans never write, execute commands or access the network, and hide raw errors', (t) => {
  const root = fixture(t);
  write(root, '.bash_history', 'echo ordinary\n');
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
  assert.equal(run(root, { preload: [guard], hidden: ['DUMMY_RAW_ERROR_NEVER_PRINT'] }).status, 0);
  write(root, 'fail-read.cjs', `const fs = require('node:fs'); const read = fs.readFileSync; fs.readFileSync = function(file, ...rest) { if (typeof file === 'number') throw new Error('DUMMY_RAW_READ_ERROR'); return read.call(this, file, ...rest); };`);
  const result = run(root, { preload: [guard, path.join(root, 'fail-read.cjs')], hidden: ['DUMMY_RAW_READ_ERROR'] });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /確認できません/);
  assert.equal(result.stderr, '');
});
