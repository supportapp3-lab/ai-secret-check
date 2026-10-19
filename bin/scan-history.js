'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PATHS = [':(top,glob)**/.env', ':(top,glob)**/.env.*'];
const SAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);
const GUIDE = [
  '最初に、その .env に入っていた鍵やトークンを再発行（ローテーション）してください。履歴を消しても、漏れた鍵は無効になりません。',
  'そのうえで必要なら、新しく取ったクローンで git-filter-repo 2.47以上の git filter-repo --sensitive-data-removal --invert-paths --path <パス> を実行し、force push します。このツールは実行しません。',
  '書き換え前のクローン、フォーク、GitHub 上のキャッシュには残ることがあります。',
  'GitHub公式手順: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository',
];

function git(root, args) {
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
  // Directory selection comes only from the requested target, not a parent shell.
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE']) delete env[name];
  const result = spawnSync('git', ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false',
    '-C', root, ...args], { encoding: 'utf8', shell: false, windowsHide: true,
    maxBuffer: 16 * 1024 * 1024, timeout: 60000, env });
  if (result.error?.code === 'ENOENT') throw new Error('git コマンドが見つかりません。git をインストールしてください。');
  if (result.error || result.signal) throw new Error('git の履歴を確認できません（時間・出力量の上限または実行失敗）。');
  return result;
}

function checkedGit(root, args) {
  const result = git(root, args);
  if (result.status !== 0) throw new Error('git の実行に失敗したため、履歴を確認できません。');
  return result.stdout;
}

function isEnv(filePath) {
  const name = filePath.split('/').at(-1);
  return name === '.env' || name.startsWith('.env.');
}

function hasGitMarker(directory) {
  let current = directory;
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))
        || (fs.existsSync(path.join(current, 'HEAD')) && fs.existsSync(path.join(current, 'objects')))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function scanHistory(root) {
  const probe = git(root, ['rev-parse', '--git-dir']);
  if (probe.status !== 0) {
    if (probe.status === 128 && /not a git repository/.test(probe.stderr) && !hasGitMarker(root)) {
      return { results: [], guidance: [], message: 'gitリポジトリではないため履歴は確認できません' };
    }
    throw new Error('git の実行に失敗したため、履歴を確認できません。');
  }
  const output = checkedGit(root, ['log', '--all', '--full-history', '--root', '-m',
    '--no-renames', '--diff-filter=A', '--name-only', '-z', '--format=%x00%H',
    '--no-color', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--no-notes', '--', ...PATHS]);
  const found = new Map();
  let commit;
  let firstPath = false;
  for (const token of output.split('\0')) {
    if (!token) continue;
    if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(token)) {
      commit = token;
      firstPath = true;
      continue;
    }
    // Git separates the first name from the commit header with one newline.
    const filePath = firstPath && token.startsWith('\n') ? token.slice(1) : token;
    firstPath = false;
    if (!commit || !isEnv(filePath)) throw new Error('git の履歴出力を安全に解析できません。');
    if (!found.has(filePath)) found.set(filePath, new Set());
    found.get(filePath).add(commit);
  }
  const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (![0, 1].includes(head.status)) throw new Error('HEAD を確認できません。');
  const headPaths = new Set(head.status === 0
    ? checkedGit(root, ['ls-tree', '--full-tree', '-r', '--name-only', '-z', 'HEAD', '--', '.']).split('\0') : []);
  const results = [...found].sort(([a], [b]) => a.localeCompare(b)).map(([filePath, commits]) => ({
    path: filePath,
    commits: [...commits].map((hash) => hash.slice(0, 12)),
    commitCount: commits.size,
    inHead: headPaths.has(filePath),
    sample: SAMPLES.has(filePath.split('/').at(-1)),
  }));
  return { results, guidance: results.length ? GUIDE : [],
    message: results.length ? `履歴に .env 系のファイルが ${results.length}件あります。` : '履歴に .env 系のファイルは見つかりませんでした。' };
}

function runScanHistory(directory, jsonOutput) {
  try {
    const root = path.resolve(directory);
    let stat;
    try { stat = fs.lstatSync(root); } catch { throw new Error('指定したディレクトリを確認できません。'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('scan-history の対象にはディレクトリを指定してください。');
    const output = scanHistory(root);
    if (jsonOutput) console.log(JSON.stringify(output, null, 2));
    else {
      console.log(output.message);
      for (const entry of output.results) {
        // Quote paths so newlines/control characters cannot spoof report rows.
        console.log(`${JSON.stringify(entry.path)}${entry.sample ? ' [サンプル・INFO]' : ''}`);
        console.log(`  追加コミット: ${entry.commits.join(', ')}（計${entry.commitCount}件）`);
        console.log(`  ${entry.inHead ? 'HEAD にある' : 'HEAD にはない'}`);
      }
      for (const [index, line] of output.guidance.entries()) console.log(`${index + 1}. ${line}`);
    }
    return output.results.some((entry) => !entry.sample) ? 1 : 0;
  } catch (error) {
    if (jsonOutput) console.log(JSON.stringify({ results: [], error: error.message }));
    else console.error(error.message);
    return 2;
  }
}

module.exports = { runScanHistory, scanHistory };
