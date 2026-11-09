'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { main } = require('../bin/ai-secret-check');
const { detect, MAX_BYTES, PREFIX_BYTES } = require('../bin/scan-code');
const cli = path.resolve(__dirname, '../bin/ai-secret-check.js');
const marker = 'DUMMY_MARKER_ONLY';
const url = `https://example.invalid/path?api_key=${marker}`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-scan-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(!fs.lstatSync(root).isSymbolicLink());
    fs.rmSync(root, { recursive: true });
  });
  return root;
}
function write(root, name, contents) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}
function snapshot(root) {
  const output = {};
  function visit(file) {
    const stat = fs.lstatSync(file);
    output[path.relative(root, file)] = [stat.mtimeMs, stat.isSymbolicLink() ? fs.readlinkSync(file)
      : stat.isFile() ? fs.readFileSync(file).toString('base64') : 'directory'];
    if (stat.isDirectory() && !stat.isSymbolicLink()) for (const name of fs.readdirSync(file)) visit(path.join(file, name));
  }
  visit(root);
  return output;
}
function run(root, args = ['scan-code', root, '--json']) {
  const before = snapshot(root);
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', PATH: '' },
  });
  assert.ifError(r.error);
  assert.deepEqual(snapshot(root), before, 'no file/mtime/entry changes or source execution');
  for (const hidden of [marker, url, root, `x = "${url}"`]) assert.ok(!(r.stdout + r.stderr).includes(hidden));
  return r;
}
function inProcess(t, args, patches = {}) {
  let stdout = '', stderr = '';
  const log = console.log, error = console.error;
  console.log = (value) => { stdout += `${value}\n`; };
  console.error = (value) => { stderr += `${value}\n`; };
  const originals = {};
  for (const [name, replacement] of Object.entries(patches)) {
    originals[name] = fs[name];
    fs[name] = (...args) => replacement(originals[name], ...args);
  }
  let status;
  try { status = main(args); }
  finally {
    Object.assign(fs, originals);
    console.log = log; console.error = error;
  }
  assert.ok(!(stdout + stderr).includes(marker));
  return { stdout, stderr, status };
}

test('scan-code: whole error object calls in every JS/TS extension, text and JSON keep fixed fields only', (t) => {
  const root = fixture(t);
  const source = [
    `const privateValue = '${marker}';`,
    'try {} catch (err) { console.log(err); }',
    'try {} catch (error) { console.error(error); }',
    'promise.catch(e => { console.warn(e); });',
    'promise.catch(err => console.info(err));',
    'promise.catch(function(error) { console.debug(error); });',
    'promise.catch(err => JSON.stringify(err));',
    'console \t. log ( error )',
    'JSON . stringify ( e )',
    'console.log(err); console.error(error);',
  ].join('\r\n');
  const expected = [];
  for (const ext of ['cjs', 'js', 'jsx', 'mjs', 'ts', 'tsx']) {
    write(root, `src/example.${ext}`, source);
    for (let line = 2; line <= 10; line++) expected.push({ path: `src/example.${ext}`, line, type: 'js_error_object_output' });
  }
  const json = run(root);
  assert.equal(json.status, 1);
  assert.equal(json.stderr, '');
  assert.equal(JSON.parse(json.stdout).complete, true);
  assert.deepEqual(JSON.parse(json.stdout).findings, expected);
  const text = run(root, ['scan-code', root]);
  assert.equal(text.status, 1);
  assert.equal(text.stderr, '');
  assert.deepEqual(text.stdout.split('\n').filter((line) => line.includes('js_error_object_output')),
    expected.map((f) => `${JSON.stringify(f.path)}:${f.line} ${f.type}`));
  for (const output of [json.stdout, text.stdout]) {
    assert.doesNotMatch(output, /console|JSON\.stringify|privateValue|promise|catch/);
  }
});

test('scan-code: properties, interpolation, unrelated names and extra arguments do not flag error objects', (t) => {
  const root = fixture(t);
  write(root, 'safe.ts', [
    'try {} catch (err) { console.log(err.message); }',
    'console.error(err.response?.status)',
    'console.log(`${err.message}`)',
    'console.log(data)', 'JSON.stringify(data)',
    'console.warn(err, data)', 'JSON.stringify(error, null, 2)',
    'console.log({err})', 'console.log(...err)', 'console.log(err || data)',
    'other.console.log(err)', 'myconsole.log(err)', '$console.log(err)',
    'notJSON.stringify(err)', 'console.table(err)', 'console.LOG(err)',
    'console.log(\nerr\n)', 'console["log"](err)',
  ].join('\n'));
  write(root, 'not-javascript.py', 'console.log(err)\nJSON.stringify(error)');
  for (const args of [['scan-code', root], ['scan-code', root, '--json']]) {
    const r = run(root, args);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout + r.stderr, /js_error_object_output/);
    if (args.includes('--json')) assert.deepEqual(JSON.parse(r.stdout).findings, []);
  }
});

test('scan-code: name-heuristic false positives and misses agree with documented limits', () => {
  const source = [
    'const err = {}; console.log(err);',
    '// console.error(error)',
    'const example = "JSON.stringify(e)";',
    'try {} catch (failure) { console.log(failure); }',
  ].join('\n');
  assert.deepEqual(detect(source, 'demo.JS'), [1, 2, 3].map((line) => ({
    path: 'demo.JS', line, type: 'js_error_object_output',
  })));
});

test('scan-code: Python assignments/call keywords, relative paths and 1-based lines', (t) => {
  const root = fixture(t);
  write(root, 'src/demo.py', '\nhttp.client.HTTPConnection.debuglevel = 1\r\nf(debuglevel=1)\rx(debuglevel\t=\t1, other=2)\n');
  const r = run(root);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  assert.deepEqual(JSON.parse(r.stdout).findings, [2, 3, 4].map((line) => ({ path: 'src/demo.py', line, type: 'python_debuglevel_1' })));
});

test('scan-code: debuglevel 0/10/comparisons/other identifiers and logging do not match', (t) => {
  const root = fixture(t);
  write(root, 'safe.py', 'debuglevel=0\ndebuglevel=10\ndebuglevel == 1\nnotdebuglevel=1\nlogging.basicConfig(level=logging.DEBUG)\ndebuglevel=1.0\ndebuglevel=1e2\ndebuglevel=1+2\n');
  write(root, 'other.ts', 'debuglevel=1');
  const r = run(root);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).findings, []);
});

test('scan-code: URL query matches all allowed extensions, only path/line/type is returned', (t) => {
  const root = fixture(t);
  const extensions = ['py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'];
  for (const ext of extensions) write(root, `demo.${ext}`, `x = "${url}"\ny = 'http://example.invalid/?x=1&api_key=${marker}#section'\n`);
  const r = run(root);
  const output = JSON.parse(r.stdout);
  assert.equal(r.status, 1);
  assert.equal(output.complete, true);
  assert.equal(output.findings.length, extensions.length * 2);
  for (const finding of output.findings) {
    assert.deepEqual(Object.keys(finding), ['path', 'line', 'type']);
    assert.equal(finding.type, 'url_query_api_key');
    assert.ok([1, 2].includes(finding.line));
  }
  const text = run(root, ['scan-code', root]);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /"demo\.py":1 url_query_api_key/);
});

test('scan-code: empty/other keys/non-URLs/fragments/dynamic placeholders are not matches', (t) => {
  const root = fixture(t);
  write(root, 'safe.js', [
    'api_key = "DUMMY_MARKER_ONLY"', '?api_key=DUMMY_MARKER_ONLY',
    '"https://example.invalid/?api_key="', 'f(https://example.invalid/?api_key=)',
    '"https://example.invalid/?my_api_key=DUMMY_MARKER_ONLY"',
    '"https://example.invalid/#?api_key=DUMMY_MARKER_ONLY"',
    '"https://example.invalid/?api_key=${variable}"',
    '"https://example.invalid/?api_key=" + value',
    '"https://example.invalid/?" + "api_key=DUMMY_MARKER_ONLY"',
    '"https://example.invalid/?api_key={variable}"',
    '"https://example.invalid/?%61pi_key=DUMMY_MARKER_ONLY"',
    '"https://example.invalid/?API_KEY=DUMMY_MARKER_ONLY"',
  ].join('\n'));
  assert.equal(run(root).status, 0);
});

test('scan-code: comments/examples can match; dynamic/encoded/multiline expressions can be missed', () => {
  assert.deepEqual(detect('# debuglevel=1\n"debuglevel=1"\n', 'x.py').map((f) => f.line), [1]);
  assert.equal(detect(`# example: ${url}\n"${url}"`, 'x.py').length, 2);
  assert.equal(detect('debuglevel = \\\n1\nf(debuglevel=int("1"))\n', 'x.py').length, 0);
  assert.equal(detect('"https://example.invalid/?api_key=" + key', 'x.py').length, 0);
});

test('scan-code: exclusions prevent opening forbidden content; binary probe and total reads are bounded', (t) => {
  const root = fixture(t);
  const forbidden = ['.env', '.env.example', '.env.backup.py', '.ENV.sample.ts', 'prod.env', 'prod.env.bak.js',
    'id_rsa.py', 'private.key.js', 'service.pem.py', 'credentials.ts', 'token.js',
    ...['.git', '.hg', '.svn', 'node_modules', 'vendor', '.venv', 'venv', 'dist', 'build', '.ssh', '.aws', '.codex']
      .map((name) => `${name}/inside.py`), 'unsupported.txt', 'large.py'];
  for (const name of forbidden) write(root, name, name === 'large.py' ? 'a'.repeat(MAX_BYTES + 1) : url);
  const binaryFile = write(root, 'binary.py', Buffer.concat([Buffer.from([0]), Buffer.from(url), Buffer.alloc(20000)]));
  const exact = write(root, 'exact.js', Buffer.from(' '.repeat(MAX_BYTES)));
  const opened = new Map(), reads = new Map();
  const r = inProcess(t, ['scan-code', root, '--json'], {
    openSync(original, file, ...args) {
      assert.ok(!forbidden.some((name) => file === path.join(root, name)), 'forbidden content must never open');
      const fd = original(file, ...args); opened.set(fd, file); return fd;
    },
    readFileSync() { assert.fail('no unbounded reads'); },
    readSync(original, fd, buffer, offset, length, position) {
      const file = opened.get(fd);
      assert.ok(length <= 65536);
      const count = original(fd, buffer, offset, length, position);
      reads.set(file, (reads.get(file) || 0) + count);
      return count;
    },
  });
  assert.equal(r.status, 0);
  assert.ok(JSON.parse(r.stdout).excluded >= forbidden.length + 1);
  assert.equal(reads.get(binaryFile), PREFIX_BYTES);
  assert.ok(reads.get(exact) <= MAX_BYTES + 1);
});

test('scan-code: invalid UTF-8 and binary data after the prefix are excluded, not safe findings', (t) => {
  const root = fixture(t);
  write(root, 'encoding.py', Buffer.from([0xff, 0xfe, 0x64]));
  write(root, 'late.js', Buffer.concat([Buffer.from(' '.repeat(PREFIX_BYTES)), Buffer.from([0]), Buffer.from(url)]));
  const r = run(root);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).excluded, 2);
  assert.match(JSON.parse(r.stdout).policy, /除外.*安全ではありません/);
});

test('scan-code: no target source execution, writes, network, or external commands', (t) => {
  const root = fixture(t);
  write(root, 'evil.js', `require('node:fs').writeFileSync('MUST_NOT_EXIST', 'executed'); throw Error('${marker}');\nconst x = "${url}";`);
  write(root, 'evil.py', 'open("MUST_NOT_EXIST", "w").write("executed")\n');
  assert.equal(run(root).status, 1);
  const patches = {};
  for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'renameSync', 'rmSync']) {
    patches[name] = () => assert.fail('scanner must not mutate files');
  }
  const child = require('node:child_process'), http = require('node:http'), https = require('node:https'), net = require('node:net');
  const hooks = [[child, 'spawnSync'], [child, 'execSync'], [child, 'spawn'], [child, 'execFileSync'],
    [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'], [net, 'connect']];
  const originals = hooks.map(([obj, name]) => obj[name]);
  try {
    hooks.forEach(([obj, name]) => { obj[name] = () => assert.fail('no execution or network'); });
    assert.equal(inProcess(t, ['scan-code', root], patches).status, 1);
  } finally { hooks.forEach(([obj, name], index) => { obj[name] = originals[index]; }); }
});

test('scan-code: argument/root errors always exit 2 and never echo raw values or exceptions', (t) => {
  const root = fixture(t);
  write(root, 'file.py', url);
  for (const args of [['scan-code', '--bad-DUMMY_MARKER_ONLY'], ['scan-code', '--json', '--json'],
    ['scan-code', root, root, '--json'], ['scan-code', path.join(root, marker), '--json'],
    ['scan-code', path.join(root, 'file.py')], ['scan-code', '']]) {
    const r = run(root, args);
    assert.equal(r.status, 2);
    if (args.includes('--json')) assert.equal(JSON.parse(r.stdout).complete, false);
  }
});

test('scan-code: omitted directory means cwd and help advertises explicit opt-in/JSON', (t) => {
  const root = fixture(t);
  write(root, 'demo.py', 'debuglevel=1');
  assert.equal(run(root, ['scan-code', '--json']).status, 1);
  const help = run(root, ['--help']);
  assert.match(help.stdout, /scan-code.*明示的opt-in/);
  assert.match(help.stdout, /--json.*scan-code/);
});

test('scan-code: file and directory links, linked roots and parents never open targets', (t) => {
  const root = fixture(t), external = fixture(t);
  write(external, 'outside.py', url);
  try {
    fs.symlinkSync(path.join(external, 'outside.py'), path.join(root, 'link.py'), 'file');
    fs.symlinkSync(external, path.join(root, 'directory'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('links unavailable in this context'); return; }
    throw error;
  }
  const before = snapshot(external);
  for (const [target, status] of [[root, 0], [path.join(root, 'directory'), 2], [path.join(root, 'directory', 'sub'), 2], [path.join(root, 'link.py'), 2]]) {
    assert.equal(inProcess(t, ['scan-code', target, '--json'], { openSync() { assert.fail('linked target must never open'); } }).status, status);
  }
  assert.deepEqual(snapshot(external), before);
});

test('scan-code: directory links are independently checked even when file-link creation is unavailable', (t) => {
  const root = fixture(t), external = fixture(t);
  write(external, 'outside.py', url);
  fs.mkdirSync(path.join(external, 'nested'));
  const link = path.join(root, 'linked-directory');
  try { fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('directory links unavailable'); return; }
    throw error;
  }
  const before = snapshot(external);
  for (const [target, status] of [[root, 0], [link, 2], [path.join(link, 'nested'), 2]]) {
    const r = inProcess(t, ['scan-code', target, '--json'], {
      openSync() { assert.fail('link destinations must not open'); },
      readdirSync(original, file, ...args) {
        assert.equal(file, root, 'must not enumerate link destinations');
        return original(file, ...args);
      },
    });
    assert.equal(r.status, status);
  }
  assert.deepEqual(snapshot(external), before);
});

test('scan-code: source read errors do not disclose raw exceptions in either output mode', (t) => {
  const root = fixture(t);
  write(root, 'demo.py', url);
  for (const args of [['scan-code', root], ['scan-code', root, '--json']]) {
    const r = inProcess(t, args, { readSync() { throw Error(`${marker} ${url}`); } });
    assert.equal(r.status, 2);
    assert.ok(!(r.stdout + r.stderr).includes(url));
    if (args.includes('--json')) assert.equal(JSON.parse(r.stdout).complete, false);
  }
});

test('scan-code: existing scan never automatically reads or detects source contents', (t) => {
  const root = fixture(t);
  write(root, 'demo.py', `debuglevel=1\n${url}`);
  // Set up only dummy config files within this fixture.
  write(root, '.claude/settings.json', '{}');
  write(root, '.codex/config.toml', '');
  const originalHome = process.env.HOME, originalCodex = process.env.CODEX_HOME, originalClaude = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.HOME = root;
    process.env.CODEX_HOME = path.join(root, '.codex');
    process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
    for (const args of [['scan', root], ['scan', root, '--json']]) {
      const r = inProcess(t, args, {
        readFileSync(original, file, ...rest) {
          assert.notEqual(file, path.join(root, 'demo.py'), 'scan must remain filename-only');
          return original(file, ...rest);
        },
      });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stdout + r.stderr, /python_debuglevel_1|url_query_api_key/);
      if (args.includes('--json')) assert.equal(JSON.parse(r.stdout).findings, undefined);
    }
  } finally {
    for (const [name, value] of [['HOME', originalHome], ['CODEX_HOME', originalCodex], ['CLAUDE_CONFIG_DIR', originalClaude]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('scan-code: unreadable source plus finding is incomplete with fixed error and exit 2', (t) => {
  const root = fixture(t);
  const unreadable = write(root, 'bad.py', url);
  write(root, 'good.py', 'debuglevel=1');
  for (const args of [['scan-code', root], ['scan-code', root, '--json']]) {
    const r = inProcess(t, args, {
      openSync(original, file, ...rest) { if (file === unreadable) throw Error(`${marker} ${url}`); return original(file, ...rest); },
    });
    assert.equal(r.status, 2);
    assert.ok(!(r.stdout + r.stderr).includes(url));
    if (args.includes('--json')) {
      const output = JSON.parse(r.stdout);
      assert.equal(output.complete, false);
      assert.equal(output.findings.length, 1);
    } else assert.match(r.stderr, /検査未完了/);
  }
});

test('scan-code: unreadable directory prevents a complete result without exposing error details', (t) => {
  const root = fixture(t);
  write(root, 'child/demo.py', url);
  const r = inProcess(t, ['scan-code', root, '--json'], {
    readdirSync(original, file, ...args) { if (file.endsWith(`${path.sep}child`)) throw Error(marker); return original(file, ...args); },
  });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).complete, false);
});

test('scan-code: replaced file identity fails before reading content', (t) => {
  const root = fixture(t);
  write(root, 'demo.py', url);
  let reads = 0;
  const r = inProcess(t, ['scan-code', root, '--json'], {
    fstatSync(original, fd, ...args) { const stat = original(fd, ...args); stat.ino += 1n; return stat; },
    readSync() { reads += 1; assert.fail('replaced descriptor must not be read'); },
  });
  assert.equal(r.status, 2);
  assert.equal(reads, 0);
});

test('scan-code: linked parent swapped between discovery and open fails before content read', (t) => {
  const root = fixture(t);
  const file = write(root, 'sub/demo.py', url);
  let opened = false;
  const r = inProcess(t, ['scan-code', root, '--json'], {
    openSync(original, target, ...args) { const fd = original(target, ...args); opened = target === file; return fd; },
    lstatSync(original, target, ...args) {
      const stat = original(target, ...args);
      if (opened && target === path.dirname(file)) stat.isSymbolicLink = () => true;
      return stat;
    },
    readSync() { assert.fail('changed parent must not be read through'); },
  });
  assert.equal(r.status, 2);
});

test('scan-code: growth past cap or modification while reading exits 2 with bounded read requests', (t) => {
  const root = fixture(t);
  write(root, 'demo.py', 'debuglevel=1');
  let requested = 0;
  const r = inProcess(t, ['scan-code', root, '--json'], {
    readSync(original, fd, buffer, offset, length) { requested += length; buffer.fill(32, offset, offset + length); return length; },
  });
  assert.equal(r.status, 2);
  assert.equal(requested, MAX_BYTES + 1);
  let calls = 0;
  const changed = inProcess(t, ['scan-code', root, '--json'], {
    fstatSync(original, fd, ...args) { const stat = original(fd, ...args); if (++calls > 1) stat.mtimeNs += 1n; return stat; },
  });
  assert.equal(changed.status, 2);
});

test('scan-code: explicit excluded roots are rejected without entering them', (t) => {
  const root = fixture(t);
  for (const name of ['.env.backup', 'node_modules', '.aws']) {
    write(root, `${name}/demo.py`, url);
    assert.equal(inProcess(t, ['scan-code', path.join(root, name), '--json'], {
      readdirSync() { assert.fail('excluded root must not be entered'); },
      openSync() { assert.fail('excluded contents must not open'); },
    }).status, 2);
  }
});

test('scan-code: unusual relative filenames cannot inject extra text output lines', (t) => {
  if (process.platform === 'win32') { t.skip('Windows disallows control characters in filenames'); return; }
  const root = fixture(t);
  write(root, 'odd\nname.py', 'debuglevel=1');
  const r = run(root, ['scan-code', root]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /"odd\\nname\.py":1 python_debuglevel_1/);
});
