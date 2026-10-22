'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);
const USAGE = 'Usage: ai-secret-check scan-dist [ディレクトリ] [--out dist]';
class ScanError extends Error {}

function parseEnv(text) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/.exec(line);
    if (!match) throw new ScanError('.envの形式を解析できません。キーと値の代入形式を確認してください。');
    let value = match[2];
    const quote = value[0];
    if (['"', "'", '`'].includes(quote)) {
      let end = -1;
      let cursor = 1;
      while (end < 0) {
        for (; cursor < value.length; cursor += 1) {
          if (quote === '"' && value[cursor] === '\\') { cursor += 1; continue; }
          if (value[cursor] === quote) { end = cursor; break; }
        }
        if (end >= 0) break;
        if (++index >= lines.length) throw new ScanError('.envの引用符が閉じられていません。');
        value += '\n' + lines[index];
      }
      if (!/^[ \t]*(?:#.*)?$/.test(value.slice(end + 1))) {
        throw new ScanError('.envの引用符の後にはコメント以外を指定できません。');
      }
      value = value.slice(1, end);
      if (quote === '"') value = value.replace(/\\([nr"\\])/g, (_, char) => ({ n: '\n', r: '\r', '"': '"', '\\': '\\' })[char]);
    } else {
      value = value.split('#', 1)[0].trim();
    }
    if ([...value].length >= 8) entries.push({ key: match[1], value });
  }
  return entries;
}

function scanDist(root, out) {
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
    throw new ScanError('対象ディレクトリを確認できません。通常のディレクトリを指定してください。');
  }
  const output = path.resolve(root, out);
  const relative = path.relative(root, output);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new ScanError('--outには対象ディレクトリ内のビルド出力ディレクトリを指定してください。');
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch { throw new ScanError('ビルド出力ディレクトリがないか、読み取れません。--outを確認してください。'); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ScanError('ビルド出力にはリンクを含まない通常のディレクトリを指定してください。');
    }
  }
  const entries = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (!(name === '.env' || name.startsWith('.env.')) || SAMPLES.has(name)) continue;
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new ScanError('.env系ファイルのリンクは点検できません。');
    if (stat.isFile()) entries.push(...parseEnv(fs.readFileSync(file, 'utf8')));
  }
  if (!entries.length) throw new ScanError('対象の.env系ファイルがないか、8文字以上の空でない値がありません。');
  const values = [...new Set(entries.map(({ value }) => value))].sort((a, b) => b.length - a.length);
  const patterns = new Map(values.map((value) => [value, Buffer.from(value, 'utf8')]));
  // Even a key or filename can contain another key's secret value.
  const display = (text) => JSON.stringify(values.reduce((safe, value) => safe.split(value).join('[REDACTED]'), text));
  const findings = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new ScanError('ビルド出力にリンクまたは通常ファイル以外があり、点検を完了できません。');
      }
      if (stat.isDirectory()) { visit(file); continue; }
      const contents = fs.readFileSync(file);
      const seen = new Set();
      for (const { key, value } of entries) {
        if (!seen.has(key) && contents.includes(patterns.get(value))) {
          seen.add(key);
          findings.push({ key: display(key), file: display(path.relative(root, file).split(path.sep).join('/')), info: key.startsWith('VITE_') });
        }
      }
    }
  }
  visit(output);
  return findings;
}

function runScanDist(args) {
  let directory;
  let out = 'dist';
  let hasOut = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--out' && !hasOut && args[index + 1] && !args[index + 1].startsWith('-')) {
      out = args[++index];
      hasOut = true;
    } else if (!arg.startsWith('-') && directory === undefined) {
      directory = arg;
    } else {
      console.error(USAGE);
      return 2;
    }
  }
  try {
    const findings = scanDist(path.resolve(directory || process.cwd()), out);
    for (const item of findings) console.log(`${item.info ? 'INFO' : 'FINDING'} | ${item.key} | ${item.file}`);
    const detected = findings.some((item) => !item.info);
    if (detected) console.log('修正の目安: defineにloadEnvの結果をまとめて渡していないか確認してください。');
    if (!findings.length) console.log('ビルド出力に対象の.env値の一致はありません。');
    return detected ? 1 : 0;
  } catch (error) {
    // Filesystem and parsing errors must never echo values, contents or raw paths.
    console.error(error instanceof ScanError ? error.message : '対象ディレクトリ・.env・ビルド出力を読み取れません。存在と読み取り権限を確認してください。');
    return 2;
  }
}

module.exports = { runScanDist };
