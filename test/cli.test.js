'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { version } = require('../package.json');

const cliPath = path.join(__dirname, '..', 'bin', 'ai-secret-check.js');

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-secret-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relativePath, content = '') {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function run(args, cwd, envOverrides = {}, entry = cliPath) {
  const env = {
    ...process.env,
    HOME: path.join(os.tmpdir(), 'ai-secret-check-empty-home'),
    CODEX_HOME: '',
    CLAUDE_CONFIG_DIR: '',
    ...envOverrides,
  };
  return spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    cwd,
    env,
  });
}


test('scan text ends with the exact Star notice once for clean and finding results', (t) => {
  const root = makeFixture(t);
  const notice = '\n\nhttps://github.com/supportapp3-lab/ai-secret-check\n役に立ったら Star をお願いします\n';
  for (const expected of [0, 1]) {
    if (expected) write(root, '.env', 'DUMMY_VALUE_NOT_FOR_OUTPUT');
    const result = run(['scan', root], root, { HOME: root });
    assert.ifError(result.error);
    assert.equal(result.status, expected);
    assert.ok(result.stdout.endsWith(notice));
    assert.equal(result.stdout.split('役に立ったら Star をお願いします').length - 1, 1);
    const alias = run(['scan', root], root, { HOME: root }, path.join(__dirname, '../bin/legacy-command.js'));
    assert.equal(alias.stdout, result.stdout);
    assert.equal(alias.status, result.status);
  }
});

test('scan JSON preserves the result structure and omits the notice', (t) => {
  const root = makeFixture(t);
  write(root, '.env', 'DUMMY_VALUE_NOT_FOR_OUTPUT');
  const result = run(['scan', root, '--json'], root, { HOME: root });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ['results', 'warnings']);
  assert.ok(Array.isArray(output.results) && Array.isArray(output.warnings));
  assert.doesNotMatch(result.stdout, /github\.com\/supportapp3-lab\/ai-secret-check|Star/);
});

test('scan invalid directory and invalid arguments omit the notice from both streams', (t) => {
  const root = makeFixture(t);
  for (const args of [['scan', path.join(root, 'missing')], ['scan', root, 'extra']]) {
    const result = run(args, root, { HOME: root });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout + result.stderr, /github\.com\/supportapp3-lab\/ai-secret-check|Star/);
  }
});

test('scan-logs reports secret kinds and counts without exposing dummy values', (t) => {
  const configDir = makeFixture(t);
  const dummySecrets = [
    'sk-ant-0123456789abcdefghijkl',
    'sk-proj-0123456789abcdefghijkl',
    'ghp_0123456789abcdefghijklmnopqrst',
    'AKIA1234567890ABCDEF',
    'API_KEY=do-not-print-this-api-value',
  ];
  write(configDir, 'projects/sample/session.jsonl', JSON.stringify({ message: dummySecrets.join(' ') }) + '\n');

  const result = run(['scan-logs'], os.tmpdir(), { CLAUDE_CONFIG_DIR: configDir });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Anthropic APIキー形式 1件/);
  assert.match(result.stdout, /APIキー形式 \(sk-\) 1件/);
  assert.match(result.stdout, /GitHubトークン形式 \(ghp_\) 1件/);
  assert.match(result.stdout, /AWSアクセスキーID形式 1件/);
  assert.match(result.stdout, /KEY=値形式 1件/);
  for (const secret of dummySecrets) assert.ok(!result.stdout.includes(secret));
  assert.match(result.stdout, /Codex の会話ログは保存場所を確認していないため対象外/);
});

test('scan-logs treats a missing configuration directory as a clean, non-crashing scan', (t) => {
  const configDir = path.join(makeFixture(t), 'missing');
  const result = run(['scan-logs'], os.tmpdir(), { CLAUDE_CONFIG_DIR: configDir });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /JSONL 0件/);
  assert.match(result.stdout, /Codex の会話ログは保存場所を確認していないため対象外/);
  assert.doesNotMatch(result.stdout, /undefined|null/);
});

test('--version prints the package version and exits successfully', () => {
  const result = run(['--version'], os.tmpdir());

  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${version}\n`);
});

test('--help describes all commands and supported output options without scanning', () => {
  const result = run(['--help'], os.tmpdir());
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Usage: ai-secret-check/);
  for (const command of ['scan', 'scan-history', 'scan-logs', 'scan-shell-history']) {
    assert.match(result.stdout, new RegExp(`^  ${command}[^\\n]+`, 'm'));
  }
  for (const option of ['--json', '--version', '--help']) assert.ok(result.stdout.includes(option));
  const noArgs = run([], os.tmpdir());
  assert.equal(noArgs.status, 0);
  assert.equal(noArgs.stdout, result.stdout);
  assert.equal(noArgs.stderr, '');
});

test('deprecated command alias adds one stderr line while preserving stdout and exit codes', (t) => {
  const root = makeFixture(t);
  write(root, '.env', 'ALIAS_DUMMY_SECRET_DO_NOT_PRINT');
  const alias = path.join(__dirname, '..', 'bin', 'legacy-command.js');
  const warning = 'github-qiita-x は非推奨です。ai-secret-check を使ってください\n';
  const packageInfo = require('../package.json');
  assert.equal(packageInfo.bin['github-qiita-x'], 'bin/legacy-command.js');
  assert.equal(packageInfo.bin['ai-secret-check'], 'bin/ai-secret-check.js');
  for (const args of [['--version'], ['--help'], ['scan', root, '--json'], ['--unknown']]) {
    const current = run(args, os.tmpdir());
    const old = run(args, os.tmpdir(), {}, alias);
    assert.ifError(old.error);
    assert.equal(old.status, current.status);
    assert.equal(old.stdout, current.stdout);
    assert.equal(old.stderr, warning + current.stderr);
    assert.doesNotMatch(old.stdout + old.stderr, /ALIAS_DUMMY_SECRET_DO_NOT_PRINT/);
  }
});

test('scan finds secret-like names without reading file values and skips excluded paths', (t) => {
  const root = makeFixture(t);
  write(root, '.env', 'SECRET_VALUE_SHOULD_NOT_APPEAR');
  write(root, 'nested/.env.production', 'SECRET_VALUE_SHOULD_NOT_APPEAR');
  write(root, '.env.example', 'EXAMPLE_VALUE');
  write(root, 'keys/server.pem', 'PRIVATE_KEY_VALUE');
  write(root, 'keys/id_ed25519', 'PRIVATE_KEY_VALUE');
  write(root, 'keys/server.pem.pub', 'PUBLIC_KEY_VALUE');
  write(root, 'node_modules/pkg/.env', 'DEPENDENCY_SECRET');
  write(root, '.git/config.key', 'GIT_SECRET');

  const result = run(['scan', root], os.tmpdir());
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\.env\.example\s+\[サンプル・INFO\]/);
  assert.match(result.stdout, /nested\/\.env\.production/);
  assert.match(result.stdout, /keys\/server\.pem/);
  assert.match(result.stdout, /keys\/id_ed25519/);
  assert.doesNotMatch(result.stdout, /node_modules|\.git\/|\.pub|SECRET_VALUE_SHOULD_NOT_APPEAR|PRIVATE_KEY_VALUE|PUBLIC_KEY_VALUE|DEPENDENCY_SECRET|GIT_SECRET/);

  const sampleOnly = makeFixture(t);
  write(sampleOnly, '.env.sample', 'SAMPLE_SECRET');
  const sampleResult = run(['scan', sampleOnly], os.tmpdir());
  assert.equal(sampleResult.status, 0);
});

test('scan skips symlinks without following them', (t) => {
  const root = makeFixture(t);
  const outside = makeFixture(t);
  write(outside, '.env', 'OUTSIDE_SECRET');
  try {
    fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('symlink creation is unavailable in this environment');
      return;
    }
    throw error;
  }

  const result = run(['scan', root], os.tmpdir());
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /linked|OUTSIDE_SECRET/);
});

test('Claude Code deny rules distinguish matching from non-matching paths', (t) => {
  const root = makeFixture(t);
  write(root, '.env', 'SECRET_VALUE_SHOULD_NOT_APPEAR');
  write(root, '.env.public', 'PUBLIC_ENV_VALUE');
  write(root, 'secrets/token.key', 'KEY_VALUE');
  write(root, '.claude/settings.json', JSON.stringify({
    permissions: { deny: ['Read(./.env)', 'Read(./secrets/**)'] },
  }));

  const result = run(['scan', root, '--json'], os.tmpdir());
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  const deniedEnv = output.results.find((item) => item.path === '.env');
  assert.equal(deniedEnv.agents.claudeCode, '拒否設定あり（.claude/settings.json）');
  assert.equal(deniedEnv.suggestions.claudeCode, null);
  assert.equal(output.results.find((item) => item.path === '.env.public').agents.claudeCode, '拒否設定なし → 読める可能性あり');
  assert.equal(output.results.find((item) => item.path === 'secrets/token.key').agents.claudeCode, '拒否設定あり（.claude/settings.json）');
  assert.equal(output.results.find((item) => item.path === '.env.public').suggestions.claudeCode, '"Read(./.env.public)" を permissions.deny に追加');
  assert.doesNotMatch(result.stdout, /Read\(\.\/\.env\)|SECRET_VALUE_SHOULD_NOT_APPEAR|PUBLIC_ENV_VALUE|KEY_VALUE/);

  const textResult = run(['scan', root], os.tmpdir());
  assert.equal(textResult.status, 1);
  assert.doesNotMatch(textResult.stdout, /修正例: Claude Code: "Read\(\.\/\.env\)"/);
});

test('text output labels Cursor correction examples when the Claude Code example is omitted', (t) => {
  const root = makeFixture(t);
  write(root, '.env', 'SECRET_VALUE_SHOULD_NOT_APPEAR');
  write(root, '.claude/settings.json', JSON.stringify({
    permissions: { deny: ['Read(./.env)'] },
  }));

  const result = run(['scan', root], os.tmpdir());
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /修正例: Claude Code:/);
  assert.match(result.stdout, /修正例: Cursor: \.\/\.env を \.cursorignore に追加/);
});

test('user Claude deny rules are merged and their source is reported', (t) => {
  const root = makeFixture(t);
  const home = makeFixture(t);
  write(root, '.env', 'SECRET_VALUE_SHOULD_NOT_APPEAR');
  write(home, '.claude/settings.json', JSON.stringify({
    permissions: { deny: ['Read(./.env)'] },
  }));

  const result = run(['scan', root, '--json'], os.tmpdir(), { HOME: home });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  const item = output.results.find((entry) => entry.path === '.env');
  assert.equal(item.agents.claudeCode, '拒否設定あり（~/.claude/settings.json）');
  assert.equal(item.suggestions.claudeCode, null);
  assert.doesNotMatch(result.stdout, /Read\(\.\/\.env\)|SECRET_VALUE_SHOULD_NOT_APPEAR/);
});

test('CLAUDE_CONFIG_DIR selects the user settings file', (t) => {
  const root = makeFixture(t);
  const home = makeFixture(t);
  const configDir = makeFixture(t);
  write(root, '.env', 'SECRET_VALUE_SHOULD_NOT_APPEAR');
  write(home, '.claude/settings.json', JSON.stringify({
    permissions: { deny: ['Read(./.env.local)'] },
  }));
  write(configDir, 'settings.json', JSON.stringify({
    permissions: { deny: ['Read(./.env)'] },
  }));

  const result = run(['scan', root, '--json'], os.tmpdir(), { HOME: home, CLAUDE_CONFIG_DIR: configDir });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  const item = output.results.find((entry) => entry.path === '.env');
  assert.equal(item.agents.claudeCode, '拒否設定あり（CLAUDE_CONFIG_DIR/settings.json）');
  assert.equal(item.suggestions.claudeCode, null);
});

test('missing user settings are silent while invalid settings still warn without changing exit codes', (t) => {
  const emptyRoot = makeFixture(t);
  const missingHome = makeFixture(t);
  const missing = run(['scan', emptyRoot, '--json'], os.tmpdir(), { HOME: missingHome });
  assert.equal(missing.status, 0);
  assert.deepEqual(JSON.parse(missing.stdout).warnings, []);

  const configDir = makeFixture(t);
  const missingConfig = run(['scan', emptyRoot, '--json'], os.tmpdir(), { HOME: missingHome, CLAUDE_CONFIG_DIR: configDir });
  assert.equal(missingConfig.status, 0);
  assert.deepEqual(JSON.parse(missingConfig.stdout).warnings, []);

  const root = makeFixture(t);
  const invalidHome = makeFixture(t);
  write(root, '.env', 'SECRET_VALUE_SHOULD_NOT_APPEAR');
  write(invalidHome, '.claude/settings.json', '{ invalid json');
  const invalid = run(['scan', root, '--json'], os.tmpdir(), { HOME: invalidHome });
  assert.equal(invalid.status, 1);
  assert.match(JSON.parse(invalid.stdout).warnings.join(' '), /~\/\.claude\/settings\.json はJSONとして読めず/);

  const nonFileHome = makeFixture(t);
  fs.mkdirSync(path.join(nonFileHome, '.claude', 'settings.json'), { recursive: true });
  const unreadable = run(['scan', emptyRoot, '--json'], os.tmpdir(), { HOME: nonFileHome });
  assert.equal(unreadable.status, 0);
  assert.match(JSON.parse(unreadable.stdout).warnings.join(' '), /~\/\.claude\/settings\.json を確認できません/);
});

test('project-local Claude deny rules and .claudeignore warning are reported', (t) => {
  const root = makeFixture(t);
  write(root, '.env.local', 'LOCAL_SECRET');
  write(root, '.claude/settings.local.json', JSON.stringify({
    permissions: { deny: ['Read(./.env.*)'] },
  }));
  write(root, '.claudeignore', '.env*\n');

  const result = run(['scan', root, '--json'], os.tmpdir());
  const output = JSON.parse(result.stdout);
  const item = output.results.find((entry) => entry.path === '.env.local');
  assert.equal(item.agents.claudeCode, '拒否設定あり（.claude/settings.local.json）');
  assert.match(item.warnings.join(' '), /\.claudeignore/);
  assert.doesNotMatch(result.stdout, /LOCAL_SECRET/);
});

test('.cursorignore matches gitignore-style patterns and documents its limit', (t) => {
  const root = makeFixture(t);
  write(root, '.env', 'CURSOR_SECRET');
  write(root, 'config/production.pem', 'PRIVATE_KEY');
  write(root, '.cursorignore', '.env\nconfig/*.pem\n');

  const result = run(['scan', root, '--json'], os.tmpdir());
  const output = JSON.parse(result.stdout);
  assert.equal(output.results.find((item) => item.path === '.env').agents.cursor, '除外設定あり（ただし完全ではない可能性）');
  assert.equal(output.results.find((item) => item.path === 'config/production.pem').agents.cursor, '除外設定あり（ただし完全ではない可能性）');
  assert.doesNotMatch(result.stdout, /CURSOR_SECRET|PRIVATE_KEY/);
});

test('text output omits Cursor correction for excluded paths but retains it for other paths', (t) => {
  const ignoredRoot = makeFixture(t);
  write(ignoredRoot, '.env', 'CURSOR_SECRET');
  write(ignoredRoot, '.cursorignore', '.env\n');

  const ignored = run(['scan', ignoredRoot], os.tmpdir());
  assert.equal(ignored.status, 1);
  assert.match(ignored.stdout, /Cursor: 除外設定あり/);
  assert.doesNotMatch(ignored.stdout, /修正例: Cursor: \.\/\.env/);

  const ordinaryRoot = makeFixture(t);
  write(ordinaryRoot, '.env', 'CURSOR_SECRET');
  const ordinary = run(['scan', ordinaryRoot], os.tmpdir());
  assert.equal(ordinary.status, 1);
  assert.match(ordinary.stdout, /修正例: Cursor: \.\/\.env を \.cursorignore に追加/);
});

test('Codex reads project configuration without exposing unrelated values', (t) => {
  const root = makeFixture(t);
  write(root, '.env', 'CODEX_SECRET');
  write(root, '.codex/config.toml', 'token = "CODEX_CONFIG_SECRET"');

  const result = run(['scan', root, '--json'], os.tmpdir());
  const output = JSON.parse(result.stdout);
  assert.match(output.results[0].agents.codex, /拒否設定なし/);
  assert.match(output.warnings.join(' '), /プロジェクト設定は信頼済みプロジェクトでのみ有効/);
  assert.doesNotMatch(result.stdout, /CODEX_SECRET|CODEX_CONFIG_SECRET|token/);
});

test('scan validates arguments and returns the documented exit codes', (t) => {
  const root = makeFixture(t);
  const empty = run(['scan', root], os.tmpdir());
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /見つかりませんでした/);

  const invalid = run(['scan', root, 'another-dir'], os.tmpdir());
  assert.equal(invalid.status, 2);
  assert.notEqual(invalid.stderr, '');

  const unknown = run(['--unknown'], os.tmpdir());
  assert.equal(unknown.status, 2);

  const file = path.join(root, 'not-a-directory');
  fs.writeFileSync(file, '');
  const nonDirectory = run(['scan', file], os.tmpdir());
  assert.equal(nonDirectory.status, 2);
});

