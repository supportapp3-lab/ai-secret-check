'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const CLI = path.join(__dirname, '../bin/github-qiita-x.js');
const SECRET = 'HISTORY_SECRET_SHOULD_NOT_APPEAR';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-test-'));
  t.after(() => {
    // Only delete our uniquely created fixture, never a caller-supplied path.
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'history-test-')));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function git(root, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args],
  { encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'fixture Git command succeeds');
  return result.stdout.trim();
}

function init(root) { git(root, 'init', '-b', 'main'); }
function write(root, name, contents = `DUMMY_API_KEY=${SECRET}\n`) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), contents);
}
function commit(root) {
  git(root, 'add', '--all');
  git(root, 'commit', '-m', 'fixture');
  return git(root, 'rev-parse', 'HEAD');
}

function snapshot(root) {
  const probe = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD'], { encoding: 'utf8' });
  return { head: probe.stdout, refs: git(root, 'for-each-ref'),
    status: git(root, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all'),
    index: fs.existsSync(path.join(root, '.git/index')) ? fs.readFileSync(path.join(root, '.git/index')).toString('hex') : null };
}

function scan(root, json, env = {}) {
  const result = spawnSync(process.execPath, [CLI, 'scan-history', root, ...(json ? ['--json'] : [])],
    { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
  assert.ifError(result.error);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SECRET));
  return result;
}

function both(root, status, check, env = {}) {
  const before = snapshot(root);
  for (const json of [false, true]) {
    const result = scan(root, json, env);
    assert.equal(result.status, status, result.stdout + result.stderr);
    check(result, json ? JSON.parse(result.stdout) : null);
  }
  assert.deepEqual(snapshot(root), before, 'HEAD, refs, worktree and index remain unchanged');
}

test('history reports removed root/nested env paths and addition commits, without values or blob hashes', (t) => {
  const root = fixture(t);
  init(root);
  write(root, '.env');
  write(root, 'config/.env.local');
  const added = commit(root);
  const blobs = [git(root, 'rev-parse', 'HEAD:.env'), git(root, 'rev-parse', 'HEAD:config/.env.local')];
  git(root, 'rm', '--cached', '.env', 'config/.env.local');
  write(root, '.gitignore', '.env\nconfig/.env.local\n');
  const removed = commit(root);
  both(root, 1, (result, data) => {
    for (const blob of blobs) assert.ok(!result.stdout.includes(blob));
    assert.ok(!result.stdout.includes(removed.slice(0, 12)));
    assert.match(result.stdout, new RegExp(added.slice(0, 12)));
    if (data) {
      assert.deepEqual(data.results.map((r) => r.path), ['.env', 'config/.env.local']);
      assert.ok(data.results.every((r) => !r.inHead && !r.sample && r.commitCount === 1));
      assert.match(data.guidance[0], /最初に.*再発行/);
      assert.match(data.guidance[1], /新しく取ったクローン.*git filter-repo/);
      assert.match(data.guidance.at(-1), /https:\/\/docs.github.com/);
    } else assert.match(result.stdout, /HEAD にはない/);
  });
});

test('ignored uncommitted env is not historical; empty repositories work', (t) => {
  const root = fixture(t);
  init(root);
  both(root, 0, (_, data) => { if (data) assert.deepEqual(data.results, []); });
  write(root, '.gitignore', '.env\n');
  write(root, '.env');
  commit(root);
  both(root, 0, (_, data) => { if (data) assert.deepEqual(data.results, []); });
});

test('branch-only and stash-only files are included by --all', (t) => {
  const root = fixture(t);
  init(root);
  write(root, 'readme.txt', 'dummy');
  commit(root);
  git(root, 'switch', '-c', 'other');
  write(root, '.env.branch');
  const added = commit(root);
  git(root, 'switch', 'main');
  write(root, '.env.stash');
  git(root, 'stash', 'push', '--all', '-m', 'dummy stash');
  both(root, 1, (_, data) => {
    if (!data) return;
    assert.deepEqual(data.results.map((r) => r.path), ['.env.branch', '.env.stash']);
    assert.deepEqual(data.results[0].commits, [added.slice(0, 12)]);
    assert.ok(data.results.every((r) => !r.inHead));
  });
});

test('samples alone are INFO and do not fail; HEAD presence is reported', (t) => {
  const root = fixture(t);
  init(root);
  for (const name of ['.env.example', 'config/.env.sample', '.env.template']) write(root, name);
  commit(root);
  both(root, 0, (result, data) => {
    if (data) assert.ok(data.results.length === 3 && data.results.every((r) => r.sample && r.inHead));
    else assert.match(result.stdout, /サンプル・INFO/);
  });
});

test('re-additions report all adding commits; modifications/deletions are not additions', (t) => {
  const root = fixture(t);
  init(root);
  write(root, '.env');
  const first = commit(root);
  write(root, '.env', SECRET + '-modified');
  commit(root);
  git(root, 'rm', '.env');
  commit(root);
  write(root, '.env');
  const second = commit(root);
  both(root, 1, (_, data) => {
    if (!data) return;
    assert.equal(data.results[0].commitCount, 2);
    assert.deepEqual(new Set(data.results[0].commits), new Set([first, second].map((v) => v.slice(0, 12))));
  });
});

test('renaming a file to an env name counts as adding the path', (t) => {
  const root = fixture(t);
  init(root);
  write(root, 'old.txt');
  commit(root);
  git(root, 'mv', 'old.txt', '.env');
  const added = commit(root);
  both(root, 1, (_, data) => {
    if (data) assert.deepEqual(data.results[0].commits, [added.slice(0, 12)]);
  });
});

test('paths are NUL separated and scoped to repository root even from a subdirectory', (t) => {
  const root = fixture(t);
  init(root);
  write(root, '日本語 space; $()/.env.local');
  write(root, '.env');
  write(root, 'ignore.env', 'outside filename scope');
  if (process.platform !== 'win32') write(root, '\nline\nbreak/.env');
  commit(root);
  const subdir = path.join(root, 'subdir');
  fs.mkdirSync(subdir);
  const before = snapshot(root);
  for (const json of [false, true]) {
    const result = scan(subdir, json);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    if (json) {
      const rows = JSON.parse(result.stdout).results;
      assert.ok(rows.some((r) => r.path === '.env' && r.inHead));
      assert.ok(rows.some((r) => r.path === '日本語 space; $()/.env.local' && r.inHead));
      assert.ok(!rows.some((r) => r.path === 'ignore.env'));
    } else assert.ok(!result.stdout.includes('\nline\nbreak'));
  }
  assert.deepEqual(snapshot(root), before);
});

test('non-repository directory exits zero in both formats', (t) => {
  const root = fixture(t);
  write(root, '.env');
  for (const json of [false, true]) {
    const result = scan(root, json);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /gitリポジトリではないため履歴は確認できません/);
    if (json) assert.deepEqual(JSON.parse(result.stdout).results, []);
  }
});

test('missing git is an error without echoing configuration or values', (t) => {
  const root = fixture(t);
  const emptyPath = fixture(t);
  for (const json of [false, true]) {
    const result = scan(root, json, { PATH: emptyPath, Path: emptyPath });
    assert.equal(result.status, 2);
    assert.match(result.stdout + result.stderr, /git コマンドが見つかりません/);
  }
});

test('Git failures, invalid directories and arguments exit two safely', (t) => {
  const root = fixture(t);
  init(root);
  write(root, 'dummy.txt', 'dummy');
  commit(root);
  fs.writeFileSync(path.join(root, '.git/HEAD'), 'invalid head');
  for (const json of [false, true]) {
    assert.equal(scan(root, json).status, 2);
    assert.equal(scan(path.join(root, 'missing'), json).status, 2);
    assert.equal(scan(path.join(root, 'dummy.txt'), json).status, 2);
  }
  for (const args of [['scan-history', '--unknown'], ['scan-history', root, 'other'],
    ['scan-history', '--json', '--json']]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:.*scan-history/);
  }
});

test('omitting the directory scans the current directory', (t) => {
  const root = fixture(t);
  init(root);
  write(root, '.env');
  commit(root);
  const result = spawnSync(process.execPath, [CLI, 'scan-history', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).results[0].path, '.env');
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SECRET));
});
