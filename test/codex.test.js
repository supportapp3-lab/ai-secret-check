'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { assessCodex } = require('../bin/codex-permissions');
const { globMatches } = require('../bin/github-qiita-x');

const CLI = path.join(__dirname, '../bin/github-qiita-x.js');
const SECRET = 'CODEX_CONFIG_SECRET';
const FILES = ['.env', 'app/.env', '.env.local', 'a/b/c/d/.env', '.env.example'];

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-test-'));
  t.after(() => {
    assert.ok(base.startsWith(path.join(os.tmpdir(), 'codex-settings-test-')));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const locations = { base, root: path.join(base, 'project'), home: path.join(base, 'home'), config: path.join(base, 'config') };
  for (const dir of Object.values(locations)) fs.mkdirSync(dir, { recursive: true });
  return locations;
}

function write(root, name, text = 'DUMMY_ENV_VALUE') {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}

function profile(patterns = ['**/*.env'], depth = 3, name = 'no-env') {
  return `default_permissions = "${name}"\ntoken = "${SECRET}"\n
[permissions.${name}]
extends = ":workspace"
[permissions.${name}.filesystem]
${depth === null ? '' : `glob_scan_max_depth = ${depth}`}
[permissions.${name}.filesystem.":workspace_roots"]
${patterns.map((p) => `"${p}" = "deny"`).join('\n')}
`;
}

function snapshot(f) {
  const rows = [];
  function visit(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) visit(full);
      else rows.push([full, fs.readFileSync(full).toString('hex'), fs.statSync(full).mtimeMs]);
    }
  }
  visit(f.base);
  return rows;
}

function run(f, json, overrides = {}) {
  const result = spawnSync(process.execPath, [CLI, 'scan', f.root, ...(json ? ['--json'] : [])], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, HOME: f.home, CODEX_HOME: f.config, CLAUDE_CONFIG_DIR: '', ...overrides },
  });
  assert.ifError(result.error);
  assert.doesNotMatch(result.stdout + result.stderr, /CODEX_CONFIG_SECRET|DUMMY_ENV_VALUE/);
  assert.equal(result.stderr, '');
  return result;
}

function both(f, check, overrides = {}) {
  const before = snapshot(f);
  for (const json of [false, true]) {
    const result = run(f, json, overrides);
    assert.equal(result.status, FILES.some((n) => n !== '.env.example' && fs.existsSync(path.join(f.root, n))) ? 1 : 0);
    check(result.stdout, json ? JSON.parse(result.stdout) : null);
  }
  assert.deepEqual(snapshot(f), before, 'scan never writes configuration or fixture files');
}

test('absent Codex settings and built-in profiles have no deny or warnings', (t) => {
  const f = fixture(t);
  write(f.root, '.env');
  for (const setting of [null, ':workspace', ':read-only', ':danger-full-access']) {
    if (setting) write(f.config, 'config.toml', `default_permissions = '${setting}'\n`);
    both(f, (text, data) => {
      if (data) {
        assert.match(data.results[0].agents.codex, /拒否設定なし/);
        assert.deepEqual(data.warnings, []);
        assert.match(data.results[0].suggestions.codex, /extends = ":workspace"/);
      } else {
        assert.match(text, /修正例: Codex:/);
        assert.doesNotMatch(text, /警告:/);
      }
    });
  }
});

test('official env glob distinguishes suffixes and warns on deeper files', (t) => {
  const f = fixture(t);
  FILES.forEach((name) => write(f.root, name));
  write(f.config, 'config.toml', profile());
  both(f, (text, data) => {
    if (!data) { assert.match(text, /glob_scan_max_depth より深い/); return; }
    const byPath = Object.fromEntries(data.results.map((row) => [row.path, row]));
    for (const name of ['.env', 'app/.env']) {
      assert.equal(byPath[name].agents.codex, '拒否設定あり（CODEX_HOME/config.toml）');
      assert.equal(byPath[name].suggestions.codex, null);
    }
    assert.match(byPath['.env.local'].agents.codex, /拒否設定なし/);
    assert.match(byPath['a/b/c/d/.env'].agents.codex, /拒否設定あり/);
    assert.match(byPath['a/b/c/d/.env'].warnings.join(' '), /glob_scan_max_depth より深い/);
    assert.match(byPath['a/b/c/d/.env'].suggestions.codex, /Permission denied/);
  });
});

test('three patterns with sufficient depth cover detected env names and omit correction', (t) => {
  const f = fixture(t);
  FILES.forEach((name) => write(f.root, name));
  write(f.root, 'app/prod.env'); // Discovery stays unchanged by issue owner's clarification.
  write(f.config, 'config.toml', profile(['**/.env', '**/.env.*', '**/*.env'], 6));
  both(f, (text, data) => {
    if (data) {
      assert.equal(data.results.length, FILES.length);
      for (const row of data.results) {
        assert.match(row.agents.codex, /拒否設定あり/);
        assert.equal(row.suggestions.codex, null);
        assert.deepEqual(row.warnings, []);
      }
      assert.deepEqual(data.warnings, []);
    } else assert.doesNotMatch(text, /修正例: Codex:|警告:/);
  });
});

test('prod.env is covered by Codex matching only, not expanded file discovery', () => {
  const settings = (pattern) => ({ depth: 6, rules: [{ pattern, source: 'test config' }] });
  assert.match(assessCodex('app/prod.env', settings('**/*.env'), globMatches).message, /拒否設定あり/);
  assert.match(assessCodex('app/prod.env', settings('**/.env.*'), globMatches).message, /拒否設定なし/);
});

test('exact rules cover only root and require no wildcard depth', (t) => {
  const f = fixture(t);
  write(f.root, '.env');
  write(f.root, 'app/.env');
  write(f.config, 'config.toml', profile(['.env'], null));
  both(f, (_, data) => {
    if (!data) return;
    assert.equal(data.results.find((r) => r.path === '.env').suggestions.codex, null);
    assert.match(data.results.find((r) => r.path === 'app/.env').agents.codex, /拒否設定なし/);
  });
});

test('missing glob depth warns and provides static correction', (t) => {
  const f = fixture(t);
  write(f.root, '.env');
  write(f.config, 'config.toml', profile(['**/*.env'], null));
  both(f, (text, data) => {
    if (data) {
      assert.match(data.results[0].agents.codex, /拒否設定あり/);
      assert.match(data.results[0].warnings.join(' '), /glob_scan_max_depth が未指定/);
      assert.match(data.results[0].suggestions.codex, /sandbox_mode と一緒に書かない/);
    } else assert.match(text, /未指定/);
  });
});

test('sandbox_mode in either config takes precedence over named denies', (t) => {
  for (const project of [false, true]) {
    const f = fixture(t);
    write(f.root, '.env');
    write(f.config, 'config.toml', profile() + (project ? '' : '\nsandbox_mode_unused = true\n'));
    if (project) write(f.root, '.codex/config.toml', 'sandbox_mode = "workspace-write"\n');
    else write(f.config, 'config.toml', 'sandbox_mode = "workspace-write"\n' + profile());
    both(f, (text, data) => {
      if (data) {
        assert.match(data.results[0].agents.codex, /sandbox_mode.*優先される/);
        assert.doesNotMatch(data.results[0].agents.codex, /拒否設定あり/);
        assert.match(data.warnings.join(' '), /sandbox_mode/);
      } else assert.match(text, /sandbox_mode.*優先される/);
    });
  }
});

test('project config provides source and trust note and overrides user selection', (t) => {
  const f = fixture(t);
  write(f.root, '.env');
  write(f.config, 'config.toml', 'default_permissions = ":workspace"\n');
  write(f.root, '.codex/config.toml', profile());
  both(f, (text, data) => {
    if (data) {
      assert.equal(data.results[0].agents.codex, '拒否設定あり（.codex/config.toml）');
      assert.equal(data.results[0].suggestions.codex, null);
      assert.match(data.warnings.join(' '), /信頼済みプロジェクトでのみ有効/);
    } else assert.match(text, /信頼済みプロジェクトでのみ有効/);
  });
});

test('CODEX_HOME overrides HOME and fallback user config works', (t) => {
  const f = fixture(t);
  write(f.root, '.env');
  write(f.home, '.codex/config.toml', profile());
  write(f.config, 'config.toml', 'default_permissions = ":workspace"\n');
  both(f, (_, data) => { if (data) assert.match(data.results[0].agents.codex, /拒否設定なし/); });
  both(f, (_, data) => { if (data) assert.equal(data.results[0].agents.codex, '拒否設定あり（~/.codex/config.toml）'); }, { CODEX_HOME: '' });
});

test('named inheritance merges sources, depth, and overrides', (t) => {
  const f = fixture(t);
  write(f.root, '.env');
  write(f.root, '.env.local');
  write(f.config, 'config.toml', profile(['**/.env', '**/.env.*'], 6, 'parent'));
  write(f.root, '.codex/config.toml', `default_permissions = 'child'
[permissions.child]
extends = 'parent'
[permissions.child.filesystem.":workspace_roots"]
'**/.env.*' = 'read'
`);
  both(f, (_, data) => {
    if (!data) return;
    assert.equal(data.results.find((r) => r.path === '.env').agents.codex, '拒否設定あり（CODEX_HOME/config.toml）');
    assert.match(data.results.find((r) => r.path === '.env.local').agents.codex, /拒否設定なし/);
  });
});

test('quoted tables and comments containing # or escaped characters parse safely', (t) => {
  const f = fixture(t);
  write(f.root, '.env');
  write(f.config, 'config.toml', `default_permissions = 'no.env#1' # selection
token = "${SECRET}#not-a-comment"
[permissions."no.env#1"]
extends = ':workspace'
[permissions."no.env#1".filesystem]
glob_scan_max_depth = 6
[permissions."no.env#1".filesystem.':workspace_roots']
"**/\\u002eenv" = 'deny' # suffix
`);
  both(f, (_, data) => { if (data) assert.match(data.results[0].agents.codex, /拒否設定あり/); });
});

test('malformed, unsupported and ambiguous TOML never claims protection or echoes values', (t) => {
  for (const config of [
    'token = "' + SECRET,
    profile() + '\nargs = ["unsupported"]',
    'default_permissions = "no-env"\ndefault_permissions = "no-env"\n',
    'default_permissions = "no-env"\npermissions = "value"\n[permissions.no-env]\nextends = ":workspace"',
    'default_permissions = "no-env"\n[permissions.no-env]\nextends = "no-env"',
    'default_permissions = "missing"',
    profile(['**/*.env'], 0),
    profile(['[ab]/*.env']),
    profile() + '\n"**/*.env" = "deny"',
    'default_permissions = "no-env"\n[permissions.no-env.filesystem.\":workspace_roots\"]\n"**/.env" = "deny"\n[permissions]\nno-env = "invalid"',
    'default_permissions = "no-env"\npermissions.no-env.extends = ":workspace"',
  ]) {
    const f = fixture(t);
    write(f.root, '.env');
    write(f.config, 'config.toml', config);
    both(f, (text, data) => {
      if (data) {
        assert.match(data.results[0].agents.codex, /判定できません/);
        assert.doesNotMatch(data.results[0].agents.codex, /拒否設定あり/);
        assert.match(data.warnings.join(' '), /判定できません/);
      } else assert.match(text, /警告: Codex:/);
    });
  }
});

test('unreadable config warns even with zero findings and exit zero', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.config, 'config.toml'));
  both(f, (text, data) => {
    if (data) assert.match(data.warnings.join(' '), /確認できず/);
    else assert.match(text, /警告: Codex:.*確認できず/);
  });
});

test('Claude and Cursor results stay unchanged when Codex settings change', (t) => {
  const f = fixture(t);
  FILES.forEach((name) => write(f.root, name));
  write(f.root, '.claude/settings.json', '{"permissions":{"deny":["Read(./.env)"]}}');
  write(f.root, '.cursorignore', '.env\n');
  const before = JSON.parse(run(f, true).stdout).results;
  write(f.config, 'config.toml', profile(['**/.env', '**/.env.*'], 6));
  const after = JSON.parse(run(f, true).stdout).results;
  const otherAgents = (rows) => rows.map((r) => ({ path: r.path, sample: r.sample,
    claudeCode: r.agents.claudeCode, cursor: r.agents.cursor,
    claudeSuggestion: r.suggestions.claudeCode, cursorSuggestion: r.suggestions.cursor }));
  assert.deepEqual(otherAgents(after), otherAgents(before));
});
