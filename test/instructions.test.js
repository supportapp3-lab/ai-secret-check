'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = path.join(__dirname, '..', 'bin', 'ai-secret-check.js');

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-secret-check-instructions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relativePath, content = '') {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function run(args, cwd, envOverrides = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      HOME: path.join(cwd, '.test-home'),
      USERPROFILE: process.env.USERPROFILE || path.join(cwd, '.test-home'),
      CODEX_HOME: '',
      CLAUDE_CONFIG_DIR: '',
      ...envOverrides,
    },
  });
}

function initGit(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const result = spawnSync('git', ['init', directory], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

test('scan-instructions reports target and ancestor metadata without reading file contents', (t) => {
  const fixture = makeFixture(t);
  const repo = path.join(fixture, 'repo');
  const target = path.join(repo, 'a', 'b');
  initGit(repo);

  const dummyContents = [
    'DUMMY_TARGET_AGENT_CONTENT',
    'DUMMY_PARENT_CLAUDE_LOCAL_CONTENT',
    'DUMMY_CLAUDE_DIRECTORY_CONTENT',
    'DUMMY_REPO_CLAUDE_CONTENT',
    'DUMMY_OUTSIDE_GIT_CONTENT',
  ];
  write(target, 'AGENTS.md', dummyContents[0]);
  write(path.join(repo, 'a'), 'CLAUDE.local.md', dummyContents[1]);
  write(path.join(repo, 'a'), '.claude/CLAUDE.md', dummyContents[2]);
  write(repo, 'CLAUDE.md', dummyContents[3]);
  write(fixture, 'AGENTS.override.md', dummyContents[4]);

  const result = run(['scan-instructions', target, '--json'], target);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.gitRoot, repo);
  assert.deepEqual(output.results.map((entry) => entry.path), [
    path.join(target, 'AGENTS.md'),
    path.join(repo, 'a', 'CLAUDE.local.md'),
    path.join(repo, 'a', '.claude', 'CLAUDE.md'),
    path.join(repo, 'CLAUDE.md'),
    path.join(fixture, 'AGENTS.override.md'),
  ]);
  assert.deepEqual(output.results.map((entry) => entry.aboveTarget), [false, true, true, true, true]);
  assert.deepEqual(output.results.map((entry) => entry.outsideGitRoot), [false, false, false, false, true]);
  for (let index = 0; index < dummyContents.length; index += 1) {
    assert.equal(output.results[index].fileName, path.basename(output.results[index].path));
    assert.equal(output.results[index].sizeBytes, Buffer.byteLength(dummyContents[index]));
    assert.ok(!result.stdout.includes(dummyContents[index]));
  }
});

test('scan-instructions defaults to cwd and returns zero when no files are found', (t) => {
  const root = makeFixture(t);
  const result = run(['scan-instructions'], root);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(run(['scan-instructions', root, '--json'], root).stdout);
  assert.deepEqual(output.results, []);
  assert.equal(output.gitRoot, 'Git管理外');

  const textResult = run(['scan-instructions'], root);
  assert.equal(textResult.status, 0);
  assert.match(textResult.stdout, /指示ファイルは見つかりませんでした/);
  assert.match(textResult.stdout, /各ツールの設定と公式ドキュメントを確認/);
});

test('scan-instructions marks files as Git管理外 when the target is not in a repository', (t) => {
  const root = makeFixture(t);
  write(root, 'AGENTS.md', 'DO_NOT_PRINT_THIS_CONTENT');

  const result = run(['scan-instructions', root, '--json'], root);
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.gitRoot, 'Git管理外');
  assert.equal(output.results[0].outsideGitRoot, 'Git管理外');
  assert.doesNotMatch(result.stdout, /DO_NOT_PRINT_THIS_CONTENT/);
});

test('scan-instructions excludes home Claude and Codex configuration directories', (t) => {
  const root = makeFixture(t);
  const home = path.join(root, 'home');
  const target = path.join(home, 'projects', 'repo');
  fs.mkdirSync(target, { recursive: true });
  write(home, '.claude/CLAUDE.md', 'HOME_CLAUDE_CONFIG_CONTENT');
  write(home, '.codex/CLAUDE.md', 'HOME_CODEX_CONFIG_CONTENT');

  const result = run(['scan-instructions', target, '--json'], target, { HOME: home });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.results, []);
  assert.doesNotMatch(result.stdout, /HOME_CLAUDE_CONFIG_CONTENT|HOME_CODEX_CONFIG_CONTENT/);
});

test('scan-instructions rejects invalid paths and extra positional arguments', (t) => {
  const root = makeFixture(t);
  const file = path.join(root, 'not-a-directory');
  fs.writeFileSync(file, '');

  for (const args of [
    ['scan-instructions', path.join(root, 'missing')],
    ['scan-instructions', file],
    ['scan-instructions', root, 'extra'],
    ['scan-instructions', root, '--json', '--json'],
  ]) {
    const result = run(args, root);
    assert.ifError(result.error);
    assert.equal(result.status, 2);
  }
});
