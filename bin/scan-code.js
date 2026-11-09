'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const MAX_BYTES = 1024 * 1024;
const PREFIX_BYTES = 8192;
const EXTENSIONS = new Set(['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const EXCLUDED_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', '.venv', 'venv', 'dist', 'build',
  '.ssh', '.aws', '.azure', '.gnupg', '.config', '.codex', '.claude']);
const POLICY = '明示的opt-in: 許可拡張子のUTF-8ソースのみ。秘密・認証ファイル、VCS・依存・生成物、リンク、バイナリ、1 MiB超は除外。見つからない＝安全ではありません。';
const INCOMPLETE = '検査未完了: 引数・対象・読取りを確認できません。除外や未読を安全とは判定しません。';

function excludedName(name, isSensitivePath) {
  const lower = name.toLowerCase();
  // Keep the existing secret-file predicate first, then cover source-suffixed backups too.
  return isSensitivePath(name) || lower.startsWith('.env') || /\.env(?:$|[.~_-])/.test(lower)
    || /(?:^|[._-])(?:credentials?|secrets?|tokens?|id_rsa|id_ed25519|id_ecdsa)(?:$|[._-])/.test(lower)
    || /\.(?:pem|key|p12|pfx)(?:$|[.~_-])/.test(lower);
}

function same(a, b) { return a.dev === b.dev && a.ino === b.ino; }

function initialDirectories(root) {
  const directories = [];
  let current = path.parse(root).root;
  for (const segment of ['', ...root.slice(current.length).split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    const stat = fs.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error();
    directories.push({ file: current, stat });
  }
  return directories;
}

function verifyDirectories(directories) {
  for (const { file, stat } of directories) {
    const latest = fs.lstatSync(file, { bigint: true });
    if (latest.isSymbolicLink() || !latest.isDirectory() || !same(stat, latest)) throw new Error();
  }
}

function binary(buffer) {
  // NUL/control bytes and non-UTF-8 input are outside this text-only scanner.
  return buffer.some((byte) => byte === 0 || (byte < 32 && ![9, 10, 12, 13].includes(byte)) || byte === 127);
}

function readSource(file, stat, directories) {
  verifyDirectories(directories);
  const latest = fs.lstatSync(file, { bigint: true });
  if (!latest.isFile() || latest.isSymbolicLink() || !same(stat, latest) || latest.size > MAX_BYTES) throw new Error();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    verifyDirectories(directories);
    const current = fs.lstatSync(file, { bigint: true });
    if (!opened.isFile() || opened.size > MAX_BYTES || !same(stat, opened)
        || !current.isFile() || current.isSymbolicLink() || !same(opened, current)) throw new Error();
    // One extra byte detects growth. Never use an unbounded readFile on source files.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = fs.readSync(fd, buffer, 0, PREFIX_BYTES, 0);
    if (binary(buffer.subarray(0, length))) return null;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, Math.min(65536, buffer.length - length), length);
      if (!count) break;
      length += count;
    }
    if (length > MAX_BYTES) throw new Error();
    verifyDirectories(directories);
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    if (!same(after, opened) || !named.isFile() || named.isSymbolicLink() || !same(named, after)
        || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
        || BigInt(length) !== after.size) throw new Error();
    const bytes = buffer.subarray(0, length);
    if (binary(bytes)) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return null; }
  } finally { fs.closeSync(fd); }
}

function detect(contents, relativePath) {
  const findings = [];
  contents.split(/\r\n?|\n/).forEach((line, index) => {
    // Deliberately lexical: comments and examples can match. Exclude ==, 10,
    // numeric suffixes and expressions instead of evaluating Python.
    if (path.extname(relativePath).toLowerCase() === '.py'
        && /\bdebuglevel[ \t]*=(?!=)[ \t]*1(?=[ \t]*(?:$|[,);#]))/.test(line)) {
      findings.push({ path: relativePath, line: index + 1, type: 'python_debuglevel_1' });
    }
    // Only same-line, literal HTTP(S) URLs. No decoding/interpolation/concatenation.
    const urls = line.match(/https?:\/\/[^\s"'`<>\\]+/gi) || [];
    if (urls.some((url) => {
      const beforeFragment = url.replace(/[),;\]]+$/, '').split('#', 1)[0];
      const question = beforeFragment.indexOf('?');
      if (question < 0 || !/^https?:\/\/[^/?#]+(?:\/[^?#]*)?\?/i.test(beforeFragment)) return false;
      return beforeFragment.slice(question + 1).split('&').some((part) => {
        const match = /^api_key=([^&]+)$/.exec(part);
        // Placeholders are dynamic, not a static nonempty query value.
        return match && !/[{}$]/.test(match[1]);
      });
    })) findings.push({ path: relativePath, line: index + 1, type: 'url_query_api_key' });
    // Explicitly name-based, not catch-scope analysis. Require exactly one bare
    // argument; property references, interpolation and additional arguments do not match.
    if (path.extname(relativePath).toLowerCase() !== '.py'
        && /(?<![\w$.])(?:console[ \t]*\.[ \t]*(?:log|error|warn|info|debug)|JSON[ \t]*\.[ \t]*stringify)[ \t]*\([ \t]*(?:err|error|e)[ \t]*\)/.test(line)) {
      findings.push({ path: relativePath, line: index + 1, type: 'js_error_object_output' });
    }
  });
  return findings;
}

function scanCode(directory, isSensitivePath) {
  const root = path.resolve(directory);
  const result = { findings: [], complete: true, excluded: 0, policy: POLICY };
  let directories;
  try {
    directories = initialDirectories(root);
    // Explicitly selecting an excluded directory must not enter it either.
    if (root.slice(path.parse(root).root.length).split(path.sep)
      .some((name) => EXCLUDED_DIRS.has(name.toLowerCase()) || excludedName(name, isSensitivePath))) throw new Error();
  } catch { return { ...result, complete: false, message: INCOMPLETE }; }
  function visit(current, relative, parents) {
    let entries;
    try {
      verifyDirectories(parents);
      entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
      verifyDirectories(parents);
    } catch { result.complete = false; return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || excludedName(entry.name, isSensitivePath)
          || EXCLUDED_DIRS.has(entry.name.toLowerCase())) { result.excluded += 1; continue; }
      const file = path.join(current, entry.name);
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      try {
        verifyDirectories(parents);
        const stat = fs.lstatSync(file, { bigint: true });
        if (stat.isSymbolicLink()) { result.excluded += 1; continue; }
        if (stat.isDirectory()) visit(file, relativePath, [...parents, { file, stat }]);
        else if (!stat.isFile() || !EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || stat.size > MAX_BYTES) result.excluded += 1;
        else {
          const contents = readSource(file, stat, parents);
          if (contents === null) result.excluded += 1;
          else result.findings.push(...detect(contents, relativePath));
        }
      } catch { result.complete = false; }
    }
  }
  visit(root, '', directories);
  if (!result.complete) result.message = INCOMPLETE;
  return result;
}

function runScanCode(args, isSensitivePath) {
  const jsonOutput = args.includes('--json');
  const positional = args.filter((arg) => arg !== '--json');
  let result;
  if (args.filter((arg) => arg === '--json').length > 1 || positional.length > 1
      || positional.some((arg) => !arg || arg.startsWith('-'))) {
    result = { findings: [], complete: false, excluded: 0, policy: POLICY, message: INCOMPLETE };
  } else {
    try { result = scanCode(positional[0] || process.cwd(), isSensitivePath); }
    catch { result = { findings: [], complete: false, excluded: 0, policy: POLICY, message: INCOMPLETE }; }
  }
  if (jsonOutput) console.log(JSON.stringify(result, null, 2));
  else {
    for (const finding of result.findings) console.log(`${JSON.stringify(finding.path)}:${finding.line} ${finding.type}`);
    console.log(POLICY);
    console.log(`意図的除外: ${result.excluded} 件（未読を含みます）。`);
    if (!result.complete) console.error(INCOMPLETE);
    else if (!result.findings.length) console.log('対応範囲内の候補は見つかりませんでした。');
  }
  return !result.complete ? 2 : result.findings.length ? 1 : 0;
}

module.exports = { runScanCode, scanCode, detect, MAX_BYTES, PREFIX_BYTES };
