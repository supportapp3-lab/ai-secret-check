'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXAMPLE = `# ~/.codex/config.toml（または $CODEX_HOME/config.toml）
default_permissions = "no-env"

[permissions.no-env]
extends = ":workspace"

[permissions.no-env.filesystem]
glob_scan_max_depth = 6  # リポジトリの深さに合わせて調整

[permissions.no-env.filesystem.":workspace_roots"]
"**/.env" = "deny"
"**/.env.*" = "deny"
"**/*.env" = "deny"

# sandbox_mode と一緒に書かないでください。
# "**/.env.*" は .env.example も拒否します。
# 設定後、codex sandbox -- cat .env が Permission denied になるか自分で確かめてください。`;

// A deliberately small TOML subset. Never include input text in errors/output.
// Unsupported syntax makes the whole configuration uncertain, not protected.
function stringToken(text) {
  const match = /^("(?:[^"\\\r\n]|\\(?:["\\btnfr]|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}))*"|'[^'\r\n]*')/.exec(text);
  if (!match) throw new Error('unsupported TOML');
  const raw = match[0];
  let value;
  if (raw[0] === "'") value = raw.slice(1, -1);
  else {
    value = raw.slice(1, -1).replace(/\\(U[0-9a-fA-F]{8}|u[0-9a-fA-F]{4}|["\\btnfr])/g, (_, code) => {
      if (code[0] === 'u' || code[0] === 'U') {
        const point = parseInt(code.slice(1), 16);
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Error('unsupported TOML');
        return String.fromCodePoint(point);
      }
      return ({ b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' })[code];
    });
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('unsupported TOML');
  return { value, rest: text.slice(raw.length).trimStart() };
}

function dottedKey(text) {
  const parts = [];
  let rest = text.trimStart();
  while (true) {
    if (/^["']/.test(rest)) {
      const token = stringToken(rest);
      parts.push(token.value);
      rest = token.rest;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(rest);
      if (!match) throw new Error('unsupported TOML');
      parts.push(match[0]);
      rest = rest.slice(match[0].length).trimStart();
    }
    if (!rest.startsWith('.')) return { parts, rest };
    rest = rest.slice(1).trimStart();
  }
}

function scalar(text) {
  if (/^["']/.test(text)) return stringToken(text);
  const match = /^(true|false|[+-]?(?:0|[1-9][0-9]*(?:_[0-9]+)*))(?=\s|#|$)/.exec(text);
  if (!match) throw new Error('unsupported TOML');
  const value = match[0] === 'true' ? true : match[0] === 'false' ? false : Number(match[0].replaceAll('_', ''));
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('unsupported TOML');
  return { value, rest: text.slice(match[0].length).trimStart() };
}

function parseConfig(text, source) {
  const values = new Map();
  const tables = new Set();
  let table = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const key = dottedKey(line.slice(1));
      if (!/^\]\s*(?:#.*)?$/.test(key.rest)) throw new Error('unsupported TOML');
      table = key.parts;
      const id = JSON.stringify(table);
      if (tables.has(id) || values.has(id)) throw new Error('duplicate TOML table');
      for (let i = 1; i < table.length; i += 1) {
        if (values.has(JSON.stringify(table.slice(0, i)))) throw new Error('conflicting TOML table');
      }
      tables.add(id);
      continue;
    }
    const key = dottedKey(line);
    if (key.parts.length !== 1) throw new Error('unsupported dotted assignment');
    if (!key.rest.startsWith('=')) throw new Error('unsupported TOML');
    const parsed = scalar(key.rest.slice(1).trimStart());
    if (parsed.rest && !parsed.rest.startsWith('#')) throw new Error('unsupported TOML');
    const parts = [...table, ...key.parts];
    const id = JSON.stringify(parts);
    if (values.has(id) || tables.has(id)) throw new Error('duplicate TOML key');
    for (const existing of tables) {
      const tableParts = JSON.parse(existing);
      if (tableParts.length > parts.length && parts.every((p, i) => tableParts[i] === p)) throw new Error('conflicting TOML table');
    }
    for (let i = 1; i < parts.length; i += 1) {
      if (values.has(JSON.stringify(parts.slice(0, i)))) throw new Error('conflicting TOML key');
    }
    for (const entry of values.values()) {
      if (entry.parts.length > parts.length && parts.every((p, i) => entry.parts[i] === p)) throw new Error('conflicting TOML key');
    }
    values.set(id, { parts, value: parsed.value, source });
  }
  return values;
}

function loadCodexSettings(root, warnings) {
  const home = process.env.HOME || os.homedir();
  const files = [
    { location: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
      source: process.env.CODEX_HOME ? 'CODEX_HOME/config.toml' : '~/.codex/config.toml' },
    { location: path.join(root, '.codex/config.toml'), source: '.codex/config.toml', project: true },
  ];
  const merged = new Map();
  let uncertain = false;
  let legacy = false;
  for (const { location, source, project } of files) {
    try {
      // Refuse symlinked configuration directories as well as symlinked files.
      if (fs.lstatSync(path.dirname(location)).isSymbolicLink()) throw new Error('symlink');
      const stat = fs.lstatSync(location);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
      if (project) warnings.push('Codex: プロジェクト設定は信頼済みプロジェクトでのみ有効です。信頼状態は判定していません。');
      let parsed;
      try {
        parsed = parseConfig(fs.readFileSync(location, 'utf8'), source);
      } catch {
        uncertain = true;
        warnings.push(`Codex: ${source} は対応するTOML構文として解析できず、拒否設定を判定できません。`);
        continue;
      }
      if (parsed.has(JSON.stringify(['sandbox_mode']))) legacy = true;
      for (const [key, value] of parsed) merged.set(key, value);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      uncertain = true;
      warnings.push(`Codex: ${source} を確認できず、拒否設定を判定できません。`);
    }
  }
  const get = (...parts) => merged.get(JSON.stringify(parts));
  if (legacy) {
    const message = '古いサンドボックス設定（sandbox_mode）が優先されるため、deny 設定は使われない可能性あり → 読める可能性あり';
    warnings.push(`Codex: ${message}`);
    return { reason: message };
  }
  if (uncertain) return { reason: '拒否設定を判定できません → 読める可能性あり' };
  const selected = get('default_permissions');
  if (!selected) return { rules: [] };
  try {
    for (const entry of merged.values()) {
      if (entry.parts[0] !== 'permissions') continue;
      for (let i = 1; i < entry.parts.length; i += 1) {
        if (merged.has(JSON.stringify(entry.parts.slice(0, i)))) throw new Error('conflicting config layers');
      }
    }
    const resolve = (name, seen = new Set()) => {
      if (typeof name !== 'string') throw new Error('invalid profile');
      if ([':workspace', ':read-only', ':danger-full-access'].includes(name)) return { rules: new Map() };
      if (name.startsWith(':') || seen.has(name)) throw new Error('invalid profile');
      const entries = [...merged.values()].filter(({ parts }) => parts[0] === 'permissions' && parts[1] === name);
      if (!entries.length) throw new Error('unknown profile');
      seen.add(name);
      const parent = get('permissions', name, 'extends');
      if (parent?.value === ':danger-full-access') throw new Error('invalid parent');
      const result = parent ? resolve(parent.value, seen) : { rules: new Map() };
      const depth = get('permissions', name, 'filesystem', 'glob_scan_max_depth');
      if (depth) {
        if (!Number.isSafeInteger(depth.value) || depth.value < 1) throw new Error('invalid depth');
        result.depth = depth.value;
      }
      for (const entry of entries) {
        const { parts, value } = entry;
        if (parts.length !== 5 || parts[2] !== 'filesystem' || parts[3] !== ':workspace_roots') continue;
        const pattern = parts[4];
        if (!['deny', 'read', 'write'].includes(value) || /[\[\]{}\\\x00-\x1f\x7f]/.test(pattern)
            || pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern) || pattern.split('/').includes('..')) {
          throw new Error('unsupported workspace rule');
        }
        result.rules.set(pattern, entry);
      }
      return result;
    };
    const resolved = resolve(selected.value);
    return { depth: resolved.depth, rules: [...resolved.rules].filter(([, entry]) => entry.value === 'deny')
      .map(([pattern, entry]) => ({ pattern, source: entry.source })) };
  } catch {
    warnings.push('Codex: 選択されたプロファイル・継承・ルールを判定できません。');
    return { reason: '拒否設定を判定できません → 読める可能性あり' };
  }
}

function assessCodex(filePath, settings, globMatches) {
  if (settings.reason) return { message: settings.reason, suggestion: EXAMPLE, warnings: [] };
  const matches = settings.rules.filter(({ pattern }) => globMatches(filePath, pattern));
  const directoryDepth = filePath.split('/').length - 1;
  const reliable = matches.find(({ pattern }) => !pattern.includes('**')
    || (settings.depth !== undefined && directoryDepth <= settings.depth));
  const match = reliable || matches[0];
  if (!match) return { message: '拒否設定なし → 読める可能性あり', suggestion: EXAMPLE, warnings: [] };
  const warnings = reliable ? [] : [settings.depth === undefined
    ? 'glob_scan_max_depth が未指定のため、Linux・WSL・Windows では拒否されない可能性あり。'
    : 'glob_scan_max_depth より深いため、Linux・WSL・Windows では拒否されない可能性あり。'];
  return { message: `拒否設定あり（${match.source}）${warnings.length ? '。ただし深さの制限を確認してください' : ''}`,
    suggestion: warnings.length ? EXAMPLE : null, warnings };
}

module.exports = { loadCodexSettings, assessCodex };
