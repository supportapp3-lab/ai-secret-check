#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { version } = require('../package.json');

const USAGE = 'Usage: github-qiita-x scan [ディレクトリ] [--json] | github-qiita-x --version';
const SAMPLE_ENV_NAMES = new Set(['.env.example', '.env.sample', '.env.template']);
const KEY_NAMES = new Set(['id_rsa', 'id_ed25519', 'id_ecdsa']);

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globSource(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char);
    }
  }
  return source;
}

function globMatches(candidate, pattern, { basename = false } = {}) {
  let normalized = pattern.trim().replaceAll('\\', '/');
  if (!normalized) return false;
  const directoryOnly = normalized.endsWith('/');
  normalized = normalized.replace(/^\.\//, '').replace(/^\//, '').replace(/\/$/, '');
  const hasSlash = normalized.includes('/');
  const regexSource = globSource(normalized);
  const paths = [candidate];

  if (!hasSlash && basename) {
    paths.splice(0, paths.length, ...candidate.split('/'));
  }

  for (const value of paths) {
    if (hasSlash || normalized.startsWith('**/')) {
      if (new RegExp('^' + regexSource + '$').test(value)) return true;
    } else if (new RegExp('^' + regexSource + '$').test(value)) {
      return true;
    }
  }

  if (directoryOnly) {
    const parts = candidate.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join('/');
      if (globMatches(parent, normalized, { basename })) return true;
    }
  }
  return false;
}

function matchesIgnoreFile(relativePath, patterns) {
  let ignored = false;
  for (const raw of patterns) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = negated ? line.slice(1) : line;
    if (globMatches(relativePath, pattern, { basename: !pattern.includes('/') })) {
      ignored = !negated;
    }
  }
  return ignored;
}

function safeStat(root, relativePath) {
  const fullPath = path.join(root, relativePath);
  const segments = relativePath.split(/[\\/]+/);
  let current = root;
  try {
    for (const segment of segments) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return null;
      if (segment !== segments.at(-1) && !stat.isDirectory()) return null;
    }
    return fs.lstatSync(fullPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function readTextIfPresent(root, relativePath, warnings) {
  const fullPath = path.join(root, relativePath);
  try {
    const stat = safeStat(root, relativePath);
    if (!stat || !stat.isFile()) return null;
    return fs.readFileSync(fullPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    warnings.push(`${relativePath} を確認できません`);
    return null;
  }
}

function loadClaudeDenyPatterns(root, warnings) {
  const patterns = [];
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const homeDir = process.env.HOME || os.homedir();
  const settingsFiles = [
    { fullPath: path.join(root, '.claude/settings.json'), source: '.claude/settings.json' },
    { fullPath: path.join(root, '.claude/settings.local.json'), source: '.claude/settings.local.json' },
    {
      fullPath: path.join(configDir || path.join(homeDir, '.claude'), 'settings.json'),
      source: configDir ? 'CLAUDE_CONFIG_DIR/settings.json' : '~/.claude/settings.json',
      required: true,
    },
  ];

  for (const { fullPath, source, required = false } of settingsFiles) {
    let text;
    try {
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        if (required) warnings.push(`${source} を確認できません`);
        continue;
      }
      text = fs.readFileSync(fullPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (required) warnings.push(`${source} が見つかりません`);
      } else {
        warnings.push(`${source} を確認できません`);
      }
      continue;
    }

    try {
      const settings = JSON.parse(text);
      const deny = settings && settings.permissions && settings.permissions.deny;
      if (Array.isArray(deny)) {
        for (const rule of deny) {
          if (typeof rule !== 'string') continue;
          const match = /^Read\((.*)\)$/.exec(rule.trim());
          if (match) patterns.push({ pattern: match[1], source });
        }
      }
    } catch {
      warnings.push(`${source} はJSONとして読めず、拒否設定を判定できません`);
    }
  }
  return patterns;
}

function isSensitivePath(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pub')) return false;
  if (name === '.env' || (name.startsWith('.env.') && !SAMPLE_ENV_NAMES.has(name))) return true;
  if (SAMPLE_ENV_NAMES.has(name)) return true;
  if (KEY_NAMES.has(name)) return true;
  return ['.pem', '.key', '.p12', '.pfx'].some((suffix) => lower.endsWith(suffix));
}

function isSampleEnv(name) {
  return SAMPLE_ENV_NAMES.has(name);
}

function scanFiles(root, warnings) {
  const found = [];
  const visit = (directory, relativeDirectory = '') => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      warnings.push(`${relativeDirectory || '.'} を走査できません`);
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && ['.git', 'node_modules'].includes(entry.name)) continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile() && isSensitivePath(entry.name)) {
        found.push({ path: relativePath, sample: isSampleEnv(entry.name) });
      }
    }
  };

  visit(root);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function assessFiles(root, files, warnings) {
  const claudeDenyPatterns = loadClaudeDenyPatterns(root, warnings);
  const cursorIgnoreText = readTextIfPresent(root, '.cursorignore', warnings);
  const cursorPatterns = cursorIgnoreText === null ? [] : cursorIgnoreText.split(/\r?\n/);
  const claudeIgnoreStat = safeStat(root, '.claudeignore');
  const codexConfigStat = safeStat(root, '.codex/config.toml');
  const claudeIgnoreExists = Boolean(claudeIgnoreStat && claudeIgnoreStat.isFile());
  const codexConfigExists = Boolean(codexConfigStat && codexConfigStat.isFile());

  return files.map((file) => {
    const claudeDeny = claudeDenyPatterns.find(({ pattern }) => globMatches(file.path, pattern));
    const claudeDenied = Boolean(claudeDeny);
    const cursorIgnored = matchesIgnoreFile(file.path, cursorPatterns);
    return {
      ...file,
      agents: {
        claudeCode: claudeDenied
          ? `拒否設定あり（${claudeDeny.source}）`
          : '拒否設定なし → 読める可能性あり',
        cursor: cursorIgnored
          ? '除外設定あり（ただし完全ではない可能性）'
          : '除外設定なし → 読める可能性あり',
        codex: codexConfigExists
          ? '設定で防ぐ方法が未確認のため、読める可能性あり（.codex/config.toml を検出）'
          : '設定で防ぐ方法が未確認のため、読める可能性あり',
      },
      suggestions: {
        claudeCode: claudeDenied ? null : `"Read(./${file.path})" を permissions.deny に追加`,
        cursor: `./${file.path} を .cursorignore に追加`,
      },
      warnings: [
        ...(claudeIgnoreExists ? ['.claudeignore は公式のアクセス制御設定として確認できません。permissions.deny を確認してください。'] : []),
      ],
    };
  });
}

function renderText(results, warnings) {
  if (results.length === 0) return '読めそうなファイルは見つかりませんでした。';
  const lines = [];
  for (const item of results) {
    lines.push(`${item.path}${item.sample ? '  [サンプル・INFO]' : ''}`);
    lines.push(`  Claude Code: ${item.agents.claudeCode}`);
    lines.push(`  Cursor: ${item.agents.cursor}`);
    lines.push(`  Codex: ${item.agents.codex}`);
    if (item.suggestions.claudeCode) {
      lines.push(`  修正例: Claude Code: ${item.suggestions.claudeCode}`);
    }
    lines.push(`          Cursor: ${item.suggestions.cursor}`);
    for (const warning of item.warnings) lines.push(`  警告: ${warning}`);
  }
  for (const warning of warnings) lines.push(`警告: ${warning}`);
  return lines.join('\n');
}

function runScan(directory, jsonOutput) {
  const root = path.resolve(directory);
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch {
    console.error('指定したディレクトリを確認できません。');
    return 2;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    console.error('scan の対象にはディレクトリを指定してください。');
    return 2;
  }

  const warnings = [];
  const files = scanFiles(root, warnings);
  const results = assessFiles(root, files, warnings);
  if (jsonOutput) {
    console.log(JSON.stringify({ results, warnings }, null, 2));
  } else {
    console.log(renderText(results, warnings));
  }
  return files.some((file) => !file.sample) ? 1 : 0;
}

function main(args) {
  if (args.length === 1 && args[0] === '--version') {
    console.log(version);
    return 0;
  }
  if (args.length === 0) {
    console.log(USAGE);
    return 0;
  }
  if (args[0] !== 'scan') {
    console.error(USAGE);
    return 2;
  }

  const rest = args.slice(1);
  const jsonIndexes = rest.reduce((indexes, value, index) => value === '--json' ? [...indexes, index] : indexes, []);
  if (jsonIndexes.length > 1) {
    console.error(USAGE);
    return 2;
  }
  const jsonOutput = jsonIndexes.length === 1;
  const positional = rest.filter((value) => value !== '--json');
  if (positional.length > 1) {
    console.error(USAGE);
    return 2;
  }
  return runScan(positional[0] || process.cwd(), jsonOutput);
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, globMatches, matchesIgnoreFile, scanFiles };

