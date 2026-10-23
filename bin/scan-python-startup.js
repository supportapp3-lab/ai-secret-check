'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Check every component before discovery or reading; never follow directory links.
function statWithoutLinks(file) {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep).filter(Boolean);
  let stat = fs.lstatSync(current);
  for (let index = 0; index < parts.length; index += 1) {
    if (!stat.isDirectory()) return null;
    current = path.join(current, parts[index]);
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) return null;
  }
  return stat;
}

function inspectFile(file, stat, readContents) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    const latest = statWithoutLinks(file);
    if (!opened.isFile() || !latest?.isFile() || opened.ino !== stat.ino
        || opened.dev !== stat.dev || latest.ino !== opened.ino || latest.dev !== opened.dev) throw new Error();
    return readContents ? fs.readFileSync(fd, 'utf8') : '';
  } finally {
    fs.closeSync(fd);
  }
}

function runScanPythonStartup() {
  const home = process.env.HOME || os.homedir();
  const targets = [];
  if (process.env.VIRTUAL_ENV) targets.push(['$VIRTUAL_ENV', process.env.VIRTUAL_ENV]);
  targets.push(['./.venv', path.join(process.cwd(), '.venv')],
    ['./venv', path.join(process.cwd(), 'venv')], ['~/.local', path.join(home, '.local')]);
  const seen = new Set();
  let checked = 0;
  let total = 0;
  let failed = false;
  for (const [label, base] of targets) {
    try {
      const lib = path.resolve(base, 'lib');
      if (!statWithoutLinks(lib)?.isDirectory()) continue;
      for (const version of fs.readdirSync(lib).sort()) {
        if (!version.startsWith('python3')) continue;
        const directory = path.join(lib, version, 'site-packages');
        const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
        if (seen.has(key)) continue;
        if (!statWithoutLinks(directory)?.isDirectory()) continue;
        seen.add(key);
        const names = fs.readdirSync(directory).sort();
        checked += 1;
        for (const name of names) {
          const isPth = name.endsWith('.pth');
          const kind = isPth ? 'import 行' : name.endsWith('.start') ? '.start ファイル'
            : ['sitecustomize.py', 'usercustomize.py'].includes(name) ? 'customize ファイル' : null;
          if (!kind) continue;
          try {
            const file = path.join(directory, name);
            const stat = statWithoutLinks(file);
            if (!stat?.isFile()) continue;
            const contents = inspectFile(file, stat, isPth);
            const count = isPth ? contents.split(/\r\n?|\n/).filter((line) => /^import[ \t]/.test(line)).length : 1;
            if (count) {
              // Quote unusual filename characters to keep output on one safe line.
              const displayName = JSON.stringify(name).slice(1, -1);
              console.log(`${label}: ${displayName}（${kind} ${count}件）`);
              total += count;
            }
          } catch {
            console.log(`${label}: 確認できません`);
            failed = true;
          }
        }
      }
    } catch {
      console.log(`${label}: 確認できません`);
      failed = true;
    }
  }
  if (!total && !failed) console.log(`起動時に実行されるものはありません（確認した場所 ${checked} か所）`);
  if (total) {
    console.log('対応の目安: *.dist-info/RECORD で、どのパッケージのファイルか確かめてください。');
    console.log('中身を自分の目で確認してください。setuptools の distutils-precedence.pth など正規のものも多くあります。');
    console.log('心当たりがなければ pip uninstall し、その環境で使えたキーを再発行してください（このツールは実行しません）。');
  }
  console.log('正規のパッケージでも該当します。怪しいかどうかは判定しません。見つからなくても安全の保証にはなりません。');
  return failed ? 2 : total ? 1 : 0;
}

module.exports = { runScanPythonStartup };
