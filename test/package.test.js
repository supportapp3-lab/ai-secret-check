'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');
const { packPaths } = require('../bin/scan-package');

const cli = path.resolve(__dirname, '../bin/ai-secret-check.js');
const dummy = 'DUMMY_PACKAGE_SECRET_VALUE_MUST_NOT_APPEAR';

function write(root, name, content = dummy) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture(t, manifest = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'package.json', JSON.stringify({ name: 'package-scan-fixture', version: '1.0.0', ...manifest }));
  write(root, '.env');
  write(root, 'index.js', '// fixture\n');
  return root;
}

function snapshot(root, prefix = '') {
  const result = {};
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const name = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, snapshot(root, name));
    else result[name] = fs.readFileSync(path.join(root, name)).toString('base64');
  }
  return result;
}

function run(root, args = ['scan-package', root], env = {}) {
  const before = snapshot(root);
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 65000,
  });
  assert.ifError(result.error);
  assert.deepEqual(snapshot(root), before, 'dry-run must not create a tarball or alter the target');
  assert.ok(!result.stdout.includes(dummy) && !result.stderr.includes(dummy));
  return result;
}

test('scan-package: .gitignore excludes .env when .npmignore is absent', (t) => {
  const root = fixture(t);
  write(root, '.gitignore', '.env\n');
  const result = run(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /0件/);
  assert.equal(result.stderr, '');
});

test('scan-package: .npmignore replaces .gitignore and exposes env/pem names only', (t) => {
  const root = fixture(t);
  write(root, '.gitignore', '.env\n*.pem\n');
  write(root, '.npmignore', 'test/\n');
  write(root, 'secret.pem');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"\.env"/);
  assert.match(result.stdout, /"secret\.pem"/);
  assert.match(result.stdout, /原因の目安:.*ルートに.npmignore/);
  assert.match(result.stdout, /修正例:.*\.env\*.*\*\.pem/);
});

test('scan-package: files directories include nested .env.production', (t) => {
  const root = fixture(t, { files: ['src', 'config'] });
  write(root, '.gitignore', '.env*\n');
  write(root, 'src/index.js', '// source');
  write(root, 'config/.env.production');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"config\/\.env\.production"/);
  assert.match(result.stdout, /原因の目安:.*files/);
});

test('scan-package: .npmignore .env* and *.pem produce no findings', (t) => {
  const root = fixture(t);
  write(root, 'secret.pem');
  write(root, '.npmignore', '.env*\n*.pem\n');
  assert.equal(run(root).status, 0);
});

test('scan-package: samples are excluded and requested key patterns work at any depth', (t) => {
  const root = fixture(t);
  fs.unlinkSync(path.join(root, '.env'));
  for (const name of ['.env.example', 'nested/.env.sample', 'nested/.env.template']) write(root, name);
  assert.equal(run(root).status, 0);
  for (const name of ['nested/.env.local', 'config/test.key', 'config/id_rsa.backup', 'key.pem']) write(root, name);
  const result = run(root);
  assert.equal(result.status, 1);
  for (const name of ['nested/.env.local', 'config/test.key', 'config/id_rsa.backup', 'key.pem']) {
    assert.ok(result.stdout.includes(JSON.stringify(name)));
  }
  assert.doesNotMatch(result.stdout, /\.env\.(?:example|sample|template)/);
});

test('scan-package: prepack/prepare/postpack cannot execute or change target files', (t) => {
  const script = 'node -e "require(\'fs\').writeFileSync(\'ran-script\',\'unexpected\')"';
  const root = fixture(t, { scripts: { prepack: script, prepare: script, postpack: script } });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.ok(!fs.existsSync(path.join(root, 'ran-script')));
});

test('scan-package: missing/invalid package.json, directory and npm exit two safely', (t) => {
  const root = fixture(t);
  const noNpm = run(root, ['scan-package', root], { PATH: '', Path: '' });
  assert.equal(noNpm.status, 2);
  assert.match(noNpm.stderr, /npm.*見つかりません/);
  fs.unlinkSync(path.join(root, 'package.json'));
  assert.equal(run(root).status, 2);
  write(root, 'package.json', dummy);
  assert.equal(run(root).status, 2);
  assert.equal(run(root, ['scan-package', path.join(root, 'missing')]).status, 2);
});

test('scan-package: npm errors do not print raw stderr, stdout or manifest values', (t) => {
  const root = fixture(t);
  const fakeNpm = path.join(root, 'fake-npm');
  if (process.platform === 'win32') {
    write(fakeNpm, 'npm.cmd', '@echo off\n');
    write(fakeNpm, 'node_modules/npm/bin/npm-cli.js',
      `process.stdout.write(${JSON.stringify(dummy)}); process.stderr.write(${JSON.stringify(dummy)}); process.exit(1);`);
  } else {
    write(fakeNpm, 'npm', `#!/bin/sh\nprintf '%s' '${dummy}'\nprintf '%s' '${dummy}' >&2\nexit 1\n`);
    fs.chmodSync(path.join(fakeNpm, 'npm'), 0o755);
  }
  const result = run(root, ['scan-package', root], { PATH: fakeNpm, Path: fakeNpm });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /npm pack --dry-runを実行できません/);
});

test('scan-package: no directory uses cwd; unknown flags and extra arguments exit two', (t) => {
  const root = fixture(t);
  assert.equal(run(root, ['scan-package']).status, 1);
  for (const args of [['scan-package', '--json'], ['scan-package', '--publish'],
    ['scan-package', root, 'extra']]) {
    assert.equal(run(root, args).status, 2);
  }
});

test('scan-package: pack-list validation fails closed without echoing unexpected data', () => {
  for (const data of [dummy, '{}', '[{}]', '[{"files":[{}]}]',
    '[{"files":[{"path":"../.env"}]}]', '[{"files":[{"path":"/tmp/.env"}]}]']) {
    assert.throws(() => packPaths(data), (error) => !error.message.includes(dummy));
  }
});

test('scan-package: offline dry-run never contacts the configured registry', async (t) => {
  let requests = 0;
  const server = http.createServer((req, res) => { requests += 1; res.writeHead(500); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = fixture(t);
  const before = snapshot(root);
  const registry = `http://127.0.0.1:${server.address().port}/`;
  // execFile rejects expected exit 1, so preserve its stdout/stderr for assertions.
  const result = await promisify(execFile)(process.execPath, [cli, 'scan-package', root], {
    cwd: root, env: { ...process.env, npm_config_registry: registry,
      npm_config_update_notifier: 'true', npm_config_offline: 'false', npm_config_ignore_scripts: 'false' },
    timeout: 65000,
  }).catch((error) => error);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /"\.env"/);
  assert.ok(!result.stdout.includes(dummy) && !result.stderr.includes(dummy));
  assert.equal(requests, 0);
  assert.deepEqual(snapshot(root), before);
});
