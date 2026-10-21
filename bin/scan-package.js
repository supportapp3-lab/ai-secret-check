'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);
const PACK_ARGS = ['pack', '.', '--dry-run', '--json', '--ignore-scripts', '--offline',
  '--workspaces=false', '--global=false', '--audit=false', '--fund=false',
  '--update-notifier=false', '--logs-max=0'];

function npmCommand() {
  // Run npm's JS entry point directly on Windows; never interpolate a shell command.
  for (const entry of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    if (process.platform === 'win32') {
      const cli = path.join(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (fs.existsSync(path.join(entry, 'npm.cmd')) && fs.existsSync(cli)) {
        return { command: process.execPath, args: [cli, ...PACK_ARGS] };
      }
    } else {
      const executable = path.join(entry, 'npm');
      try {
        fs.accessSync(executable, fs.constants.X_OK);
        return { command: executable, args: PACK_ARGS };
      } catch { /* Continue looking for npm on PATH. */ }
    }
  }
  throw new Error('npm コマンドが見つかりません。Node.jsとnpmをインストールし、PATHを確認してください。');
}

function packPaths(output) {
  let data;
  try { data = JSON.parse(output); } catch { throw new Error('npmのファイル一覧を解析できません。'); }
  if (!Array.isArray(data) || data.length !== 1 || !Array.isArray(data[0]?.files)) {
    throw new Error('npmのファイル一覧を解析できません。');
  }
  return data[0].files.map((file) => {
    if (typeof file?.path !== 'string' || !file.path || path.posix.isAbsolute(file.path)
        || path.win32.isAbsolute(file.path) || file.path.includes('\0')
        || file.path.split(/[\\/]/).includes('..')) {
      throw new Error('npmのファイル一覧を解析できません。');
    }
    return file.path;
  });
}

function isSensitive(filePath) {
  const name = filePath.split('/').at(-1);
  if (SAMPLES.has(name)) return false;
  return name === '.env' || name.startsWith('.env.')
    || name.endsWith('.pem') || name.endsWith('.key') || name.startsWith('id_rsa');
}

function scanPackage(root) {
  let manifest;
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    const manifestPath = path.join(root, 'package.json');
    const manifestStat = fs.lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error();
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error();
  } catch {
    throw new Error('対象ディレクトリと通常ファイルのpackage.jsonを確認してください（存在・読み取り権限・JSON形式）。');
  }
  const npm = npmCommand();
  const result = spawnSync(npm.command, npm.args, { cwd: root, encoding: 'utf8',
    shell: false, windowsHide: true, env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
    timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error?.code === 'ENOENT') throw new Error('npm コマンドが見つかりません。PATHを確認してください。');
  if (result.error || result.signal || result.status !== 0) {
    // npm errors may include configuration/manifest values. Never echo its raw output.
    throw new Error('npm pack --dry-runを実行できません（npm設定・時間/出力量上限・実行権限を確認してください）。');
  }
  const findings = [...new Set(packPaths(result.stdout).filter(isSensitive))].sort();
  const guidance = [];
  if (findings.length) {
    if (fs.existsSync(path.join(root, '.npmignore'))) {
      guidance.push('原因の目安: ルートに.npmignoreがあります。.gitignoreの除外は代用されないため、.npmignoreの除外漏れを確認してください。');
    }
    if (Array.isArray(manifest.files)) {
      guidance.push('原因の目安: package.jsonのfilesに指定したディレクトリやパターンが、検出パスを含めている可能性があります。');
    }
    if (!guidance.length) guidance.push('原因の目安: .npmignore/.gitignoreでの除外や、package.jsonのfilesの指定範囲を確認してください。');
    guidance.push('修正例: .npmignoreに .env* / *.pem / *.key / id_rsa* を1行ずつ追加するか、filesを配布に必要な範囲へ絞って再点検してください。filesによる明示的な指定はルートの.npmignoreより優先される場合があります。');
  }
  return { findings, guidance };
}

function runScanPackage(directory) {
  try {
    const output = scanPackage(path.resolve(directory));
    console.log(`npmパッケージに含まれる秘密情報らしいパス: ${output.findings.length}件`);
    for (const filePath of output.findings) console.log(JSON.stringify(filePath));
    for (const line of output.guidance) console.log(line);
    return output.findings.length ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}

module.exports = { runScanPackage, scanPackage, packPaths };
