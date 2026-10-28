'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INSTRUCTION_FILES = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.claude/CLAUDE.md',
  'AGENTS.md',
  'AGENTS.override.md',
];

function git(root, args) {
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE']) delete env[name];
  const result = spawnSync('git', ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false',
    '-C', root, ...args], { encoding: 'utf8', shell: false, windowsHide: true,
    maxBuffer: 1024 * 1024, timeout: 10000, env });
  if (result.error?.code === 'ENOENT') throw new Error('git コマンドが見つかりません。git をインストールしてください。');
  if (result.error || result.signal) throw new Error('Git ルートを確認できません。');
  return result;
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

function findGitRoot(directory) {
  const result = git(directory, ['rev-parse', '--show-toplevel']);
  if (result.status === 0) {
    const root = result.stdout.replace(/\r?\n$/, '');
    if (!root) throw new Error('Git ルートを確認できません。');
    return path.resolve(root);
  }
  if (result.status === 128 && /not a git repository/.test(result.stderr) && !hasGitMarker(directory)) return null;
  throw new Error('Git ルートを確認できません。');
}

function isWithinGitRoot(gitRoot, filePath) {
  const relative = path.relative(gitRoot, filePath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isWithin(directory, filePath) {
  const relative = path.relative(directory, filePath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isHomeConfigPath(filePath) {
  const homes = new Set([os.homedir(), process.env.HOME, process.env.USERPROFILE].filter(Boolean).map((home) => path.resolve(home)));
  return [...homes].some((home) => [path.join(home, '.claude'), path.join(home, '.codex')]
    .some((directory) => isWithin(directory, filePath)));
}

function inspectCandidate(directory, relativePath) {
  const segments = relativePath.split('/');
  const fullPath = path.resolve(directory, ...segments);
  if (isHomeConfigPath(fullPath)) return null;

  let candidateDirectory = directory;
  if (segments.length > 1) {
    candidateDirectory = path.join(directory, ...segments.slice(0, -1));
    let stat;
    try {
      stat = fs.lstatSync(candidateDirectory);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  }

  const candidatePath = path.join(candidateDirectory, segments.at(-1));
  let stat;
  try {
    stat = fs.lstatSync(candidatePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  return { fullPath: candidatePath, sizeBytes: stat.size };
}

function scanInstructions(targetDirectory) {
  const target = path.resolve(targetDirectory);
  const gitRoot = findGitRoot(target);
  const results = [];
  let directory = target;
  let aboveTarget = false;

  while (true) {
    for (const relativePath of INSTRUCTION_FILES) {
      const file = inspectCandidate(directory, relativePath);
      if (!file) continue;
      results.push({
        path: file.fullPath,
        fileName: path.basename(relativePath),
        sizeBytes: file.sizeBytes,
        aboveTarget,
        outsideGitRoot: gitRoot === null ? 'Git管理外' : !isWithinGitRoot(gitRoot, file.fullPath),
      });
    }

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
    aboveTarget = true;
  }

  return {
    results,
    gitRoot: gitRoot || 'Git管理外',
    message: results.length ? `指示ファイルが ${results.length}件あります。` : '指示ファイルは見つかりませんでした。',
  };
}

function runScanInstructions(directory, jsonOutput) {
  try {
    const target = path.resolve(directory);
    let stat;
    try { stat = fs.lstatSync(target); } catch { throw new Error('指定したディレクトリを確認できません。'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('scan-instructions の対象にはディレクトリを指定してください。');
    const output = scanInstructions(target);
    if (jsonOutput) console.log(JSON.stringify(output, null, 2));
    else {
      console.log(output.message);
      for (const entry of output.results) {
        console.log(`${JSON.stringify(entry.path)} (${entry.fileName})`);
        console.log(`  サイズ: ${entry.sizeBytes} バイト`);
        console.log(`  対象ディレクトリより上の階層: ${entry.aboveTarget ? 'はい' : 'いいえ'}`);
        const outsideGitRoot = entry.outsideGitRoot === 'Git管理外'
          ? 'Git管理外' : entry.outsideGitRoot ? 'はい' : 'いいえ';
        console.log(`  Git ルートの外: ${outsideGitRoot}`);
      }
      console.log('この出力はファイルの場所とサイズだけです。各ツールが実際に読み込むかは、各ツールの設定と公式ドキュメントを確認してください。');
    }
    return 0;
  } catch (error) {
    if (jsonOutput) console.log(JSON.stringify({ results: [], error: error.message }));
    else console.error(error.message);
    return 2;
  }
}

module.exports = { runScanInstructions, scanInstructions };
