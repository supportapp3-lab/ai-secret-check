'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keep the prefix conditions identical to scan-logs. No matched text is returned.
const KEY_PATTERNS = [
  { type: 'Anthropic APIキー形式', regex: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { type: 'APIキー形式 (sk-)', regex: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/ },
  { type: 'GitHubトークン形式 (ghp_)', regex: /ghp_[A-Za-z0-9]{20,}/ },
  { type: 'GitHubトークン形式 (github_pat_)', regex: /github_pat_[A-Za-z0-9_]{20,}/ },
  { type: 'AWSアクセスキーID形式', regex: /AKIA[A-Z0-9]{16}/ },
  { type: 'Slackトークン形式', regex: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
];

function hasAssignmentValue(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (!quote && /[\s;|&<>()]/.test(char)) return false;
    if (char === quote) { quote = null; continue; }
    if (!quote && (char === '"' || char === "'")) { quote = char; continue; }
    // Quoting alone is empty; all other token characters are nonempty. Never evaluate.
    return true;
  }
  return false;
}

function lineTypes(raw) {
  const line = raw.replace(/^: [0-9]+:[0-9]+;/, '');
  const types = new Set();
  const assignments = /\b([A-Za-z_][A-Za-z0-9_]*)=/g;
  let match;
  while ((match = assignments.exec(line)) !== null) {
    if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD)/i.test(match[1])
        && hasAssignmentValue(line.slice(assignments.lastIndex))) types.add('KEY=値形式');
  }
  if (/\bAuthorization:[ \t]*Bearer[ \t]+[^\s"'`;]+/i.test(line)) types.add('Authorization: Bearer形式');
  for (const { type, regex } of KEY_PATTERNS) if (regex.test(line)) types.add(type);
  return types;
}

function readHistory(file) {
  // Inspect ancestors too, so HISTFILE cannot reach a file through a directory link.
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep).filter(Boolean);
  let stat;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw new Error();
  }
  if (!stat?.isFile()) throw new Error();
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    const latest = fs.lstatSync(absolute);
    if (!opened.isFile() || latest.isSymbolicLink() || opened.ino !== stat.ino
        || opened.dev !== stat.dev || latest.ino !== opened.ino || latest.dev !== opened.dev) throw new Error();
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function runScanShellHistory() {
  const home = process.env.HOME || os.homedir();
  const targets = [
    ['~/.bash_history', path.join(home, '.bash_history')],
    ['~/.zsh_history', path.join(home, '.zsh_history')],
  ];
  if (process.env.HISTFILE) targets.push(['HISTFILE', process.env.HISTFILE]);
  const seen = new Set();
  let checked = 0;
  let total = 0;
  let failed = false;
  for (const [label, file] of targets) {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    let contents;
    try {
      contents = readHistory(resolved);
    } catch (error) {
      if (error.code === 'ENOENT') console.log(`${label}: なし`);
      else { console.log(`${label}: 確認できません`); failed = true; }
      continue;
    }
    checked += 1;
    let lines = 0;
    const counts = new Map();
    for (const line of contents.split(/\r\n?|\n/)) {
      const types = lineTypes(line);
      if (types.size) lines += 1;
      for (const type of types) counts.set(type, (counts.get(type) || 0) + 1);
    }
    total += lines;
    const details = [...counts].map(([type, count]) => `${type} ${count}件`).join('、');
    console.log(`${label}: 秘密情報らしい行 ${lines}件${details ? `（${details}）` : ''}`);
  }
  if (!total && !failed) console.log(`一致なし（確認したファイル ${checked}件）`);
  if (total) {
    console.log('対応の目安: 該当する鍵やトークンを再発行（ローテーション）してください。');
    console.log('すべての端末を閉じてから履歴ファイルを自分で編集してください。開いたままのシェルは終了時に履歴を書き直すことがあります。');
    console.log('今後は read -rs で入力し、bash の HISTCONTROL に ignorespace または ignoreboth を設定してください。');
    console.log('AIエージェントの拒否設定に履歴ファイルを追加してください（例: Claude Code の Read(~/.bash_history)）。');
  }
  console.log('既知の形式だけを確認します。見つからなくても安全の保証にはなりません。fish など他のシェルの履歴は対象外です。');
  return failed ? 2 : total ? 1 : 0;
}

module.exports = { runScanShellHistory };
