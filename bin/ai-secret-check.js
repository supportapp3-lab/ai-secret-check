#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { version } = require('../package.json');
const { loadCodexSettings, assessCodex } = require('./codex-permissions');
const { runScanHistory } = require('./scan-history');
const { runScanPackage } = require('./scan-package');
const { runScanDist } = require('./scan-dist');
const { runScanShellHistory } = require('./scan-shell-history');

const USAGE = 'Usage: ai-secret-check <scan|scan-history|scan-logs|scan-package|scan-dist|scan-shell-history> [ディレクトリ] [--json] [--out dist]';
const HELP = `${USAGE}

コマンド:
  scan [ディレクトリ]          秘密情報らしいファイル名とエージェントの拒否設定を点検
  scan-history [ディレクトリ]  Git履歴に残った .env 系ファイルのパスを点検
  scan-logs                   Claude Codeの会話ログから既知の鍵形式を件数だけ報告
  scan-shell-history          シェル履歴の秘密情報らしい行を件数だけ報告（JSON出力非対応）
  scan-package [ディレクトリ]  npmパッケージに入る秘密情報らしいパスを点検（JSON出力非対応）
  scan-dist [ディレクトリ] [--out dist]  ビルド出力の.env値を点検（値・JSON出力なし）

オプション:
  --json     scan / scan-history の結果をJSONで表示
  --version  バージョンを表示
  --help     このヘルプを表示`;
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
      if (error.code !== 'ENOENT') {
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
  const claudeIgnoreExists = Boolean(claudeIgnoreStat && claudeIgnoreStat.isFile());
  const codexSettings = loadCodexSettings(root, warnings);

  return files.map((file) => {
    const claudeDeny = claudeDenyPatterns.find(({ pattern }) => globMatches(file.path, pattern));
    const claudeDenied = Boolean(claudeDeny);
    const cursorIgnored = matchesIgnoreFile(file.path, cursorPatterns);
    const codex = assessCodex(file.path, codexSettings, globMatches);
    return {
      ...file,
      agents: {
        claudeCode: claudeDenied
          ? `拒否設定あり（${claudeDeny.source}）`
          : '拒否設定なし → 読める可能性あり',
        cursor: cursorIgnored
          ? '除外設定あり（ただし完全ではない可能性）'
          : '除外設定なし → 読める可能性あり',
        codex: codex.message,
      },
      suggestions: {
        claudeCode: claudeDenied ? null : `"Read(./${file.path})" を permissions.deny に追加`,
        cursor: `./${file.path} を .cursorignore に追加`,
        codex: codex.suggestion,
      },
      warnings: [
        ...codex.warnings,
        ...(claudeIgnoreExists ? ['.claudeignore は公式のアクセス制御設定として確認できません。permissions.deny を確認してください。'] : []),
      ],
    };
  });
}

function renderText(results, warnings) {
  const lines = results.length === 0 ? ['読めそうなファイルは見つかりませんでした。'] : [];
  for (const item of results) {
    lines.push(`${item.path}${item.sample ? '  [サンプル・INFO]' : ''}`);
    lines.push(`  Claude Code: ${item.agents.claudeCode}`);
    lines.push(`  Cursor: ${item.agents.cursor}`);
    lines.push(`  Codex: ${item.agents.codex}`);
    if (item.suggestions.claudeCode) {
      lines.push(`  修正例: Claude Code: ${item.suggestions.claudeCode}`);
    }
    if (item.agents.cursor === '除外設定なし → 読める可能性あり') {
      lines.push(`  修正例: Cursor: ${item.suggestions.cursor}`);
    }
    if (item.suggestions.codex) lines.push(`  修正例: Codex:\n${item.suggestions.codex}`);
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

function scanLogs() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
  const projectsDir = path.join(configDir, 'projects');
  const findings = [];
  const errors = [];
  let filesScanned = 0;
  let rootStat;

  try {
    rootStat = fs.lstatSync(projectsDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('Claude Code のログ保存先 ~/.claude/projects/ がありません（JSONL 0件）。');
      console.log('Codex の会話ログは保存場所を確認していないため対象外です。');
      console.log('既知の鍵形式だけを確認します。見つからない場合も安全を保証するものではありません。');
      return 0;
    }
    console.error('Claude Code のログ保存先を確認できません。');
    return 2;
  }

  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    console.error('Claude Code のログ保存先を安全に確認できません。');
    return 2;
  }

  const patterns = [
    { type: 'Anthropic APIキー形式', regex: /sk-ant-[A-Za-z0-9_-]{10,}/g },
    { type: 'APIキー形式 (sk-)', regex: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
    { type: 'GitHubトークン形式 (ghp_)', regex: /ghp_[A-Za-z0-9]{20,}/g },
    { type: 'GitHubトークン形式 (github_pat_)', regex: /github_pat_[A-Za-z0-9_]{20,}/g },
    { type: 'AWSアクセスキーID形式', regex: /AKIA[A-Z0-9]{16}/g },
    { type: 'Slackトークン形式', regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
    {
      type: 'KEY=値形式',
      regex: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)[ \t]*=[ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,\s}"']+)/g,
    },
  ];

  const visit = (directory, relativeDirectory = '') => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      errors.push(relativeDirectory || '.');
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        let stat;
        try {
          stat = fs.lstatSync(fullPath);
        } catch {
          errors.push(relativePath);
          continue;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
        visit(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

      let contents;
      try {
        const stat = fs.lstatSync(fullPath);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        contents = fs.readFileSync(fullPath, 'utf8');
      } catch {
        errors.push(relativePath);
        continue;
      }
      filesScanned += 1;

      const counts = new Map();
      for (const { type, regex } of patterns) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(contents)) !== null) {
          counts.set(type, (counts.get(type) || 0) + 1);
        }
      }
      for (const [type, count] of counts) findings.push({ path: relativePath, type, count });
    }
  };

  visit(projectsDir);
  for (const finding of findings) {
    console.log(`${finding.path}: ${finding.type} ${finding.count}件`);
  }
  if (findings.length === 0) {
    console.log(`既知形式の一致はありません（JSONL ${filesScanned}件を確認）。`);
  }
  console.log('Codex の会話ログは保存場所を確認していないため対象外です。');
  console.log('Claude Code の ~/.claude/projects/ 配下の JSONL を対象にしました。既知形式以外は検出せず、安全を保証するものではありません。');
  if (errors.length > 0) {
    for (const relativePath of errors) console.error(`${relativePath} を読み取れません。`);
    return 2;
  }
  return findings.length > 0 ? 1 : 0;
}

function main(args) {
  if (args[0] === 'scan-shell-history') {
    if (args.length !== 1) {
      console.error(USAGE);
      return 2;
    }
    return runScanShellHistory();
  }
  if (args[0] === 'scan-dist') return runScanDist(args.slice(1));
  if (args[0] === 'scan-package') {
    if (args.length > 2 || (args[1] && args[1].startsWith('-'))) {
      console.error(USAGE);
      return 2;
    }
    return runScanPackage(args[1] || process.cwd());
  }
  if (args[0] === 'scan-logs') {
    if (args.length !== 1) {
      console.error(USAGE);
      return 2;
    }
    return scanLogs();
  }
  if (args.length === 1 && args[0] === '--version') {
    console.log(version);
    return 0;
  }
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    console.log(HELP);
    return 0;
  }
  if (!['scan', 'scan-history'].includes(args[0])) {
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
  if (positional.length > 1 || (args[0] === 'scan-history' && positional.some((value) => value.startsWith('-')))) {
    console.error(USAGE);
    return 2;
  }
  const run = args[0] === 'scan-history' ? runScanHistory : runScan;
  return run(positional[0] || process.cwd(), jsonOutput);
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, globMatches, matchesIgnoreFile, scanFiles };
