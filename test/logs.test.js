'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const cliPath = path.join(__dirname, '..', 'bin', 'ai-secret-check.js');

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-secret-check-logs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function scan(home, codexHome) {
  return spawnSync(process.execPath, [cliPath, 'scan-logs'], {
    encoding: 'utf8',
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome ?? '',
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    },
  });
}

test('scan-logs scans Codex sessions and archived rollout files without printing values', (t) => {
  const home = makeFixture(t);
  const codexHome = path.join(home, 'codex-state');
  const dummy = 'sk-proj-DUMMY000000000000';
  write(codexHome, 'sessions/2026/11/28/rollout-x.jsonl', `${JSON.stringify({ prompt: dummy })}\n`);
  write(codexHome, 'archived_sessions/rollout-y.jsonl', `${JSON.stringify({ prompt: dummy })}\n`);
  write(codexHome, 'archived_sessions/nested/rollout-ignored.jsonl', `${JSON.stringify({ prompt: dummy })}\n`);
  write(codexHome, 'sessions/2026/11/28/other.jsonl', `${JSON.stringify({ prompt: dummy })}\n`);

  const result = scan(home, codexHome);
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Codex CLI\/sessions\/2026\/11\/28\/rollout-x\.jsonl: APIキー形式 \(sk-\) 1件/);
  assert.match(result.stdout, /Codex CLI\/archived_sessions\/rollout-y\.jsonl: APIキー形式 \(sk-\) 1件/);
  assert.doesNotMatch(result.stdout, /rollout-ignored|other\.jsonl/);
  assert.doesNotMatch(result.stdout, /sk-proj-DUMMY/);
});

test('scan-logs falls back to HOME/.codex when CODEX_HOME is unset', (t) => {
  const home = makeFixture(t);
  const dummy = 'sk-proj-DUMMY000000000000';
  write(home, '.codex/sessions/2026/11/28/rollout-home.jsonl', `${JSON.stringify({ prompt: dummy })}\n`);

  const result = scan(home, '');
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Codex CLI\/sessions\/2026\/11\/28\/rollout-home\.jsonl: APIキー形式 \(sk-\) 1件/);
  assert.doesNotMatch(result.stdout, /sk-proj-DUMMY/);
});

test('scan-logs treats absent Claude and Codex directories and clean Codex JSONL as zero findings', (t) => {
  const home = makeFixture(t);
  const missing = scan(home, path.join(home, 'missing-codex'));
  assert.ifError(missing.error);
  assert.equal(missing.status, 0);
  assert.match(missing.stdout, /JSONL 0件/);

  const codexHome = path.join(home, 'codex-state');
  write(codexHome, 'sessions/2026/11/28/rollout-clean.jsonl', `${JSON.stringify({ prompt: 'ordinary text only' })}\n`);
  const clean = scan(home, codexHome);
  assert.ifError(clean.error);
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /JSONL 1件/);
});
