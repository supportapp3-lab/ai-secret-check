'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cli = path.resolve(__dirname, '../bin/ai-secret-check.js');
const secret = 'DUMMY_DIST_SECRET_DO_NOT_PRINT';
const publicValue = 'https://public.example.invalid';

function write(root, name, contents) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-scan-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(!fs.lstatSync(root).isSymbolicLink());
    fs.rmSync(root, { recursive: true });
  });
  write(root, '.env', `DB_PASSWORD=${secret}\n`);
  write(root, 'dist/assets/index.js', '// no match\n');
  return root;
}

function snapshot(root, relative = '') {
  const result = {};
  for (const name of fs.readdirSync(path.join(root, relative))) {
    const file = path.join(relative, name);
    const stat = fs.lstatSync(path.join(root, file));
    if (stat.isSymbolicLink()) result[file] = 'link:' + fs.readlinkSync(path.join(root, file));
    else if (stat.isDirectory()) Object.assign(result, snapshot(root, file));
    else result[file] = fs.readFileSync(path.join(root, file)).toString('base64');
  }
  return result;
}

function run(root, args = ['scan-dist', root], nodeArgs = []) {
  const before = snapshot(root);
  const result = spawnSync(process.execPath, [...nodeArgs, cli, ...args], {
    cwd: root, encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.deepEqual(snapshot(root), before, 'the scanner must not alter the target');
  for (const value of [secret, publicValue, 'CONTEXT_BEFORE', 'CONTEXT_AFTER']) {
    assert.ok(!(result.stdout + result.stderr).includes(value), 'must not expose values or surrounding contents');
  }
  return result;
}

test('scan-dist: absent value exits zero without findings', (t) => {
  const result = run(fixture(t));
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /FINDING|INFO/);
  assert.equal(result.stderr, '');
});

test('scan-dist: private value reports key and nested path, never value or context', (t) => {
  const root = fixture(t);
  write(root, 'dist/assets/index.js', `CONTEXT_BEFORE '${secret}' CONTEXT_AFTER`);
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FINDING \| "DB_PASSWORD" \| "dist\/assets\/index.js"/);
  assert.match(result.stdout, /修正の目安:.*define.*loadEnv/);
});

test('scan-dist: VITE_ values are INFO only and exit zero', (t) => {
  const root = fixture(t);
  write(root, '.env.local', `VITE_API_URL=${publicValue}\n`);
  write(root, 'dist/assets/index.js', publicValue);
  const result = run(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /INFO \| "VITE_API_URL"/);
  assert.doesNotMatch(result.stdout, /FINDING|修正の目安/);
});

test('scan-dist: sample-only matches are ignored while a usable env value exists', (t) => {
  const root = fixture(t);
  for (const name of ['.env.example', '.env.sample', '.env.template']) write(root, name, 'SAMPLE=EXCLUDED_SAMPLE_VALUE\n');
  write(root, 'dist/assets/index.js', 'EXCLUDED_SAMPLE_VALUE');
  const result = run(root);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /SAMPLE|EXCLUDED_SAMPLE_VALUE/);
});

test('scan-dist: empty and short values are ignored while a usable env value exists', (t) => {
  const root = fixture(t);
  write(root, '.env.local', 'EMPTY=\nSHORT=seven77\n');
  write(root, 'dist/assets/index.js', 'seven77');
  const result = run(root);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /EMPTY|SHORT|seven77/);
});

test('scan-dist: missing dist exits two with a useful safe error', (t) => {
  const root = fixture(t);
  fs.renameSync(path.join(root, 'dist'), path.join(root, 'build'));
  const result = run(root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ビルド出力ディレクトリ.*--out/);
});

test('scan-dist: missing env, samples only, empty/short only are unable to check', (t) => {
  const root = fixture(t);
  fs.unlinkSync(path.join(root, '.env'));
  write(root, '.env.example', `DB_PASSWORD=${secret}\n`);
  assert.equal(run(root).status, 2);
  write(root, '.env', 'EMPTY=\nSHORT=1234567\n');
  const result = run(root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /8文字以上/);
});

test('scan-dist: cwd, --out in either order, eight-character and binary matches', (t) => {
  const root = fixture(t);
  write(root, '.env.local', 'EIGHT=12345678\n');
  write(root, 'build/deep/data.bin', Buffer.concat([Buffer.from([0, 255]), Buffer.from('12345678'), Buffer.from([0])]));
  for (const args of [['scan-dist', '--out', 'build'], ['scan-dist', root, '--out', 'build'], ['scan-dist', '--out', 'build', root]]) {
    const result = run(root, args);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /EIGHT.*build\/deep\/data.bin/);
    assert.doesNotMatch(result.stdout, /12345678/);
  }
  assert.equal(run(root, ['scan-dist']).status, 0);
});

test('scan-dist: quotes, export, comments, multiline and multiple env files', (t) => {
  const root = fixture(t);
  write(root, '.env.production', `# comment\nexport TOKEN="${secret}" # comment\nSINGLE='${secret}'\nMULTI="first\\nsecond"\nLITERAL='line one\nline two'\n`);
  write(root, 'dist/assets/index.js', secret + '\nfirst\nsecond\nline one\nline two');
  const result = run(root);
  assert.equal(result.status, 1);
  for (const key of ['DB_PASSWORD', 'TOKEN', 'SINGLE', 'MULTI', 'LITERAL']) assert.ok(result.stdout.includes('"' + key + '"'));
  assert.doesNotMatch(result.stdout, /first|second|line one|line two/);
});

test('scan-dist: duplicate keys retain matches from different env files, private wins over INFO', (t) => {
  const root = fixture(t);
  write(root, '.env.local', `DB_PASSWORD=OTHER_DUMMY_VALUE\nVITE_SHARED=${secret}\n`);
  write(root, 'dist/assets/index.js', secret);
  const result = run(root);
  assert.equal(result.status, 1);
  assert.equal((result.stdout.match(/"DB_PASSWORD"/g) || []).length, 1);
  assert.match(result.stdout, /INFO \| "VITE_SHARED"/);
});

test('scan-dist: no shell expansion, nested env ignored and encoded-only values do not match', (t) => {
  const root = fixture(t);
  write(root, 'nested/.env', `NESTED=${secret}\n`);
  write(root, '.env', 'EXPANSION=${UNEXPANDED}\n');
  write(root, 'dist/assets/index.js', Buffer.from(secret).toString('base64'));
  assert.equal(run(root).status, 0);
});

test('scan-dist: secret values in filenames and key names are redacted', (t) => {
  const root = fixture(t);
  write(root, '.env', `DB_PASSWORD=${secret}\n${secret}=ANOTHER_DUMMY_VALUE\n`);
  write(root, `dist/${secret}.js`, `${secret} ANOTHER_DUMMY_VALUE`);
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[REDACTED\]/);
  assert.doesNotMatch(result.stdout, /ANOTHER_DUMMY_VALUE/);
});

test('scan-dist: bad arguments, malformed env and missing root do not print raw input', (t) => {
  const root = fixture(t);
  for (const args of [['scan-dist', '--json'], ['scan-dist', '--out'], ['scan-dist', root, 'extra'],
    ['scan-dist', '--out', 'build', '--out', 'dist'], ['scan-dist', '--out', '../outside'],
    ['scan-dist', path.join(root, secret)]]) assert.equal(run(root, args).status, 2);
  for (const content of [secret, `TOKEN="${secret}`, `TOKEN="${secret}"unexpected`]) {
    write(root, '.env', content);
    const result = run(root);
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stderr, /Error:|ENOENT|at .*\.js/);
  }
});

test('scan-dist: output and env links are not followed', (t) => {
  const root = fixture(t);
  const outside = fixture(t);
  const link = path.join(root, 'dist/link');
  try { fs.symlinkSync(outside, link, 'junction'); } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('links unavailable'); return; }
    throw error;
  }
  assert.equal(run(root).status, 2);
  fs.unlinkSync(link);
  fs.renameSync(path.join(root, '.env'), path.join(root, 'actual-env'));
  try { fs.symlinkSync(path.join(root, 'actual-env'), path.join(root, '.env'), 'file'); } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return;
    throw error;
  }
  assert.equal(run(root).status, 2);
});

test('scan-dist: raw read errors are hidden and scans never launch commands or network', (t) => {
  const root = fixture(t);
  const guard = path.join(root, 'guard.cjs');
  write(root, 'guard.cjs', `
const fs = require('node:fs');
const fail = () => { throw new Error(${JSON.stringify(secret)}); };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) require('node:child_process')[name] = fail;
for (const name of ['http', 'https']) { require('node:' + name).request = fail; require('node:' + name).get = fail; }
require('node:net').connect = fail;
global.fetch = fail;
if (process.env.DIST_TEST_READ_ERROR === '1') { const read = fs.readFileSync; fs.readFileSync = function(file, ...args) { if (String(file).endsWith('.env')) fail(); return read.call(this, file, ...args); }; }
`);
  assert.equal(run(root, ['scan-dist', root], ['--require', guard]).status, 0);
  // Separate preload flips an environment flag only within the scanned subprocess.
  write(root, 'fail.cjs', "process.env.DIST_TEST_READ_ERROR = '1';\n");
  const result = run(root, ['scan-dist', root], ['--require', path.join(root, 'fail.cjs'), '--require', guard]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /読み取り権限/);
});
