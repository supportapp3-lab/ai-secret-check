'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { version } = require('../package.json');

const cliPath = path.join(__dirname, '..', 'bin', 'github-qiita-x.js');

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'github-qiita-x-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relativePath, content = '') {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function run(args, cwd, envOverrides = {}) {
  const env = {
    ...process.env,
    HOME: path.join(os.tmpdir(), 'github-qiita-x-empty-home'),
    CLAUDE_CONFIG_DIR: '',
    ...envOverrides,
  };
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    cwd,
    env,
  });
}

test('--version prints the package version and exits successfully', () => {
  const result = run(['--version'], os.tmpdir());

  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${version}\n`);
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

test('Codex reports project config presence only without reading its contents', (t) => {
  const root = makeFixture(t);
  write(root, '.env', 'CODEX_SECRET');
  write(root, '.codex/config.toml', 'token = "CODEX_CONFIG_SECRET"');

  const result = run(['scan', root, '--json'], os.tmpdir());
  const output = JSON.parse(result.stdout);
  assert.match(output.results[0].agents.codex, /\.codex\/config\.toml を検出/);
  assert.match(output.results[0].agents.codex, /設定で防ぐ方法が未確認/);
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

