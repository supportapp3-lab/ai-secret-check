'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const MAX_BYTES = 1024 * 1024;
const PREFIX_BYTES = 8192;
const TOKEN_ONLY_USERINFO = /^(?:ghp_|github_pat_|gho_|glpat-)[a-zA-Z0-9_-]{10,}$/;
const EXTENSIONS = new Set(['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const EXCLUDED_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', '.venv', 'venv', 'dist', 'build',
  '.ssh', '.aws', '.azure', '.gnupg', '.config', '.codex', '.claude']);
const POLICY = '明示的opt-in: 許可拡張子のUTF-8ソース、対象直下の .git/config / .mcp.json / .codex/config.toml のみ。その他のVCS・秘密・認証ファイル、依存・生成物、リンク、バイナリ、1 MiB超は除外。見つからない＝安全ではありません。';
const INCOMPLETE = '検査未完了: 引数・対象・読取りを確認できません。除外や未読を安全とは判定しません。';
const PYTEST_CONFIGS = [
  { name: 'pytest.ini', section: 'pytest', format: 'ini' },
  { name: 'pyproject.toml', section: 'tool.pytest.ini_options', format: 'toml' },
  { name: 'setup.cfg', section: 'tool:pytest', format: 'ini' },
  { name: 'tox.ini', section: 'pytest', format: 'ini' },
];

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

function hasAuthMarkerString(line) {
  const marker = /(?:authorization\s*:|bearer\s+)/i;
  return [
    /"(?:\\.|[^"\\])*"/g,
    /'(?:\\.|[^'\\])*'/g,
    /`(?:\\.|[^`\\])*`/g,
  ].some((pattern) => [...line.matchAll(pattern)].some(([value]) => marker.test(value)));
}

function usesStdinHeader(line) {
  return /\binput\s*[:=]/.test(line)
    || /["'`]-H["'`]\s*,\s*["'`]@-["'`]/i.test(line)
    || /(?:^|[\s,])(?:-H|--header)[ \t]+["'`]?@-["'`]?/i.test(line);
}

function hasSubprocessAuthArg(line, relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  const invocation = extension === '.py'
    ? /\bsubprocess\s*\.\s*(?:run|call|check_call|check_output|Popen)\s*\(/i
    : /(?<![\w$])(?:execSync|execFileSync|exec|execFile|spawn|spawnSync)[ \t]*\(/;
  return (extension === '.py' || EXTENSIONS.has(extension))
    && invocation.test(line)
    && hasAuthMarkerString(line)
    && !usesStdinHeader(line);
}

function hasPythonParamsApiKey(line) {
  // A same-line lexical check for a params keyword argument, not a standalone
  // variable assignment. Values and call semantics are deliberately ignored.
  const parameters = /(?:\(|,)[ \t]*params\b[ \t]*=[ \t]*/g;
  for (const match of line.matchAll(parameters)) {
    const value = line.slice(match.index + match[0].length);
    if (/^\{[^}]*?(?:(['"])api_key\1)[ \t]*:/.test(value)
        || /^dict[ \t]*\([ \t]*api_key[ \t]*=/.test(value)) return true;
  }
  return false;
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

function jsonNode(contents, cursor) {
  while (/\s/.test(contents[cursor.index] || '')) cursor.index += 1;
  const start = cursor.index;
  const line = contents.slice(0, start).split(/\r\n?|\n/).length;
  const char = contents[cursor.index];
  if (char === '"') {
    cursor.index += 1;
    let escaped = false;
    while (cursor.index < contents.length) {
      const next = contents[cursor.index++];
      if (escaped) { escaped = false; continue; }
      if (next === '\\') { escaped = true; continue; }
      if (next === '"') break;
    }
    return { type: 'string', value: JSON.parse(contents.slice(start, cursor.index)), line };
  }
  if (char === '{') {
    cursor.index += 1;
    const properties = new Map();
    while (true) {
      while (/[\s,]/.test(contents[cursor.index] || '')) cursor.index += 1;
      if (contents[cursor.index] === '}') { cursor.index += 1; break; }
      const key = jsonNode(contents, cursor);
      while (/\s/.test(contents[cursor.index] || '')) cursor.index += 1;
      if (contents[cursor.index++] !== ':') throw new Error();
      properties.set(key.value, jsonNode(contents, cursor));
    }
    return { type: 'object', properties, line };
  }
  if (char === '[') {
    cursor.index += 1;
    const items = [];
    while (true) {
      while (/[\s,]/.test(contents[cursor.index] || '')) cursor.index += 1;
      if (contents[cursor.index] === ']') { cursor.index += 1; break; }
      items.push(jsonNode(contents, cursor));
    }
    return { type: 'array', items, line };
  }
  const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(contents.slice(cursor.index));
  if (!match) throw new Error();
  cursor.index += match[0].length;
  return { type: 'primitive', line };
}

function jsonLocations(contents) {
  // JSON.parse provides the authoritative syntax check; the small second pass only records lines.
  JSON.parse(contents);
  const cursor = { index: 0 };
  const root = jsonNode(contents, cursor);
  while (/\s/.test(contents[cursor.index] || '')) cursor.index += 1;
  if (cursor.index !== contents.length) throw new Error();
  return root;
}

function isTemplateReference(value) {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/.test(value);
}

function scanMcpJson(root, parents, result) {
  const file = path.join(root, '.mcp.json');
  let stat;
  try { stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false }); }
  catch { result.complete = false; return; }
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) { result.excluded += 1; return; }
  try {
    const contents = readSource(file, stat, parents);
    if (contents === null) { result.excluded += 1; return; }
    const document = jsonLocations(contents);
    const servers = document.type === 'object' ? document.properties.get('mcpServers') : null;
    if (servers?.type !== 'object') return;
    for (const server of servers.properties.values()) {
      if (server.type !== 'object') continue;
      for (const sectionName of ['env', 'headers']) {
        const section = server.properties.get(sectionName);
        if (section?.type !== 'object') continue;
        for (const [key, value] of section.properties) {
          if (value.type !== 'string' || !value.value.trim()) continue;
          const hasReference = /\$\{[^}]+\}/.test(value.value);
          if (sectionName === 'env' ? isTemplateReference(value.value) : hasReference) continue;
          result.findings.push({ path: '.mcp.json', line: value.line, type: `mcp_${sectionName}_value`, key });
        }
      }
    }
  } catch { result.complete = false; }
}

function scanMcpToml(root, parents, result) {
  const directory = path.join(root, '.codex');
  let directoryStat;
  try { directoryStat = fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false }); }
  catch { result.complete = false; return; }
  if (!directoryStat) return;
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) { result.excluded += 1; return; }
  const directories = [...parents, { file: directory, stat: directoryStat }];
  const file = path.join(directory, 'config.toml');
  let stat;
  try { stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false }); }
  catch { result.complete = false; return; }
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) { result.excluded += 1; return; }
  try {
    const contents = readSource(file, stat, directories);
    if (contents === null) { result.excluded += 1; return; }
    let inMcpEnv = false;
    contents.split(/\r\n?|\n/).forEach((line, index) => {
      const withoutComment = stripConfigComment(line);
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(withoutComment);
      if (header) { inMcpEnv = /^mcp_servers\.(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)\.env$/.test(header[1].trim()); return; }
      if (!inMcpEnv) return;
      const assignment = /^\s*([A-Za-z0-9_-]+)\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*$/.exec(withoutComment);
      if (!assignment) return;
      let value;
      try { value = assignment[2][0] === '"' ? JSON.parse(assignment[2]) : assignment[2].slice(1, -1); }
      catch { return; }
      if (value.trim()) result.findings.push({ path: '.codex/config.toml', line: index + 1, type: 'mcp_env_value', key: assignment[1] });
    });
  } catch { result.complete = false; }
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
    // Same-line lexical check only: flag output calls that reference requests' sent headers.
    if (path.extname(relativePath).toLowerCase() === '.py'
        && /(?:\bprint[ \t]*\(|\.(?:debug|info|warning|error|exception|critical|log)[ \t]*\()/.test(line)
        && /\.request\.headers\b/.test(line)) {
      findings.push({ path: relativePath, line: index + 1, type: 'python_request_headers_output' });
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
    if (path.extname(relativePath).toLowerCase() === '.py' && hasPythonParamsApiKey(line)) {
      findings.push({ path: relativePath, line: index + 1, type: 'python_params_api_key' });
    }
    // Explicitly name-based, not catch-scope analysis. Require exactly one bare
    // argument; property references, interpolation and additional arguments do not match.
    if (path.extname(relativePath).toLowerCase() !== '.py'
        && /(?<![\w$.])(?:console[ \t]*\.[ \t]*(?:log|error|warn|info|debug)|JSON[ \t]*\.[ \t]*stringify)[ \t]*\([ \t]*(?:err|error|e)[ \t]*\)/.test(line)) {
      findings.push({ path: relativePath, line: index + 1, type: 'js_error_object_output' });
    }
    if (hasSubprocessAuthArg(line, relativePath)) {
      findings.push({ path: relativePath, line: index + 1, type: 'subprocess_auth_arg' });
    }
    if (['.sh', '.bash'].includes(path.extname(relativePath).toLowerCase())
        || /^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/i.test(relativePath)) {
      if (hasCurlVerboseAuth(line)) findings.push({ path: relativePath, line: index + 1, type: 'curl_verbose_auth' });
    }
  });
  return findings;
}

function hasCurlVerboseAuth(line) {
  const tokens = shellTokens(line);
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== 'curl') continue;
    let verbose = false;
    let authenticated = false;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if ([';', '|', '||', '&&'].includes(token)) break;
      if (token === '--') break;
      if (token === '--verbose' || token === '--trace' || token === '--trace-ascii') {
        verbose = true;
        if (token !== '--verbose') cursor += 1;
        continue;
      }
      if (token === '--header' || token === '-H') {
        const value = tokens[cursor + 1] || '';
        if (/^Authorization\s*:/i.test(value)) authenticated = true;
        cursor += 1;
        continue;
      }
      if (token.startsWith('--header=')) {
        if (/^Authorization\s*:/i.test(token.slice('--header='.length))) authenticated = true;
        continue;
      }
      if (token === '--user' || token === '-u') {
        authenticated = true;
        cursor += 1;
        continue;
      }
      if (token.startsWith('--user=')) { authenticated = true; continue; }
      if (/^-[^-]/.test(token)) {
        const bundle = token.slice(1);
        if (bundle.includes('v')) verbose = true;
        const headerIndex = bundle.indexOf('H');
        if (headerIndex >= 0) {
          const attached = bundle.slice(headerIndex + 1);
          const value = attached || tokens[cursor + 1] || '';
          if (/^Authorization\s*:/i.test(value)) authenticated = true;
          if (!attached) cursor += 1;
        }
        const userIndex = bundle.indexOf('u');
        if (userIndex >= 0) authenticated = true;
        continue;
      }
      if (!token.startsWith('-')) continue;
    }
    if (verbose && authenticated) return true;
  }
  return false;
}

function stripConfigComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}

function shellTokens(value) {
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  for (const char of value) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; else token += char; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) {
      if (token) { tokens.push(token); token = ''; }
    } else token += char;
  }
  if (escaped) token += '\\';
  if (token) tokens.push(token);
  return tokens;
}

function tomlStrings(value) {
  const strings = [];
  let index = value.trimStart().startsWith('[') ? 1 : 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index += 1;
    if (value[index] === ']') break;
    const quote = value[index];
    if (quote !== '"' && quote !== "'") { index += 1; continue; }
    const start = index++;
    let escaped = false;
    while (index < value.length) {
      const char = value[index++];
      if (escaped) { escaped = false; continue; }
      if (quote === '"' && char === '\\') { escaped = true; continue; }
      if (char === quote) break;
    }
    const literal = value.slice(start, index);
    if (quote === '"') {
      try { strings.push(JSON.parse(literal)); } catch { /* Invalid TOML is not interpreted as an option. */ }
    } else if (literal.endsWith("'")) strings.push(literal.slice(1, -1));
  }
  return strings;
}

function addoptsTokens(value, format) {
  if (format === 'toml' && value.trimStart().startsWith('[')) {
    return tomlStrings(value).flatMap(shellTokens);
  }
  if (format === 'toml') {
    const strings = tomlStrings(value);
    return strings.length ? shellTokens(strings[0]) : [];
  }
  return shellTokens(value);
}

function findPytestAddopts(contents, config) {
  const lines = contents.replace(/^\uFEFF/, '').split(/\r\n?|\n/);
  let section = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripConfigComment(lines[index]);
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) { section = header[1].trim(); continue; }
    if (section.toLowerCase() !== config.section.toLowerCase()) continue;
    const assignment = config.format === 'toml'
      ? /^\s*addopts\s*=\s*(.*)$/i.exec(line)
      : /^\s*addopts\s*(?:=|:)\s*(.*)$/i.exec(line);
    if (!assignment) continue;
    const startLine = index + 1;
    const parts = [assignment[1]];
    if (config.format === 'ini') {
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])
          && !/^\s*\[/.test(lines[index + 1])) {
        index += 1;
        parts.push(stripConfigComment(lines[index]).trim());
      }
    } else if (parts[0].trimStart().startsWith('[') && !parts[0].includes(']')) {
      while (index + 1 < lines.length && !parts.join('\n').includes(']')) {
        index += 1;
        parts.push(stripConfigComment(lines[index]));
      }
    }
    return { value: parts.join(' '), line: startLine };
  }
  return null;
}

function enablesShowlocals(tokens) {
  let enabled = false;
  for (const token of tokens) {
    if (token === '-l' || token === '--showlocals') enabled = true;
    else if (token === '--no-showlocals') enabled = false;
  }
  return enabled;
}

function scanPytestShowlocals(root, parents, result) {
  for (const config of PYTEST_CONFIGS) {
    const file = path.join(root, config.name);
    let stat;
    try { stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false }); }
    catch { result.complete = false; continue; }
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) {
      result.excluded += 1;
      continue;
    }
    try {
      const contents = readSource(file, stat, parents);
      if (contents === null) { result.excluded += 1; continue; }
      const addopts = findPytestAddopts(contents, config);
      if (addopts && enablesShowlocals(addoptsTokens(addopts.value, config.format))) {
        result.findings.push({ path: config.name, line: addopts.line, type: 'pytest_showlocals' });
      }
    } catch { result.complete = false; }
  }
}

function detectRemoteCredentials(contents) {
  const findings = [];
  let remote = null;
  // Git joins lines ending in an unescaped backslash before parsing values.
  const lines = contents.replace(/(^|[^\\])((?:\\\\)*)\\\r?\n/g, '$1$2').split(/\r\n?|\n/);
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      const section = /^\s*\[remote[ \t]+"((?:[^"\\]|\\["\\])+)"[ \t]*\][ \t]*(?:[#;].*)?$/i.exec(line);
      remote = section ? section[1].replace(/\\(["\\])/g, '$1') : null;
      continue;
    }
    if (!remote) continue;
    const entry = /^\s*(url|pushurl)[ \t]*=[ \t]*(?:"((?:[^"\\]|\\["\\])*)"|([^\s"#;]+))[ \t]*(?:[#;].*)?$/i.exec(line);
    if (!entry) continue;
    const value = (entry[2] ?? entry[3]).replace(/\\(["\\])/g, '$1');
    const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#\s\\]+)/i.exec(value)?.[1];
    if (!authority) continue;
    const at = authority.lastIndexOf('@');
    if (at < 0) continue;
    const userinfo = authority.slice(0, at);
    if (!userinfo.includes(':') && !TOKEN_ONLY_USERINFO.test(userinfo)) continue;
    const hostAndPort = authority.slice(at + 1);
    if (!/^(?:[a-z\d.-]+|\[[a-f\d:.]+\])(?::\d+)?$/i.test(hostAndPort)) continue;
    try {
      const { hostname } = new URL('https://' + hostAndPort);
      findings.push({ type: 'git_remote_credentials', remote, key: entry[1].toLowerCase(), host: hostname });
    } catch { /* An invalid authority has no reportable hostname. */ }
  }
  return findings;
}

function scanRootGitConfig(root, parents, result) {
  try {
    verifyDirectories(parents);
    const directory = path.join(root, '.git');
    const directoryStat = fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
    if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) return;
    const directories = [...parents, { file: directory, stat: directoryStat }];
    verifyDirectories(directories);
    const config = path.join(directory, 'config');
    const stat = fs.lstatSync(config, { bigint: true, throwIfNoEntry: false });
    if (!stat) return;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) {
      result.excluded += 1;
      return;
    }
    const contents = readSource(config, stat, directories);
    if (contents === null) result.excluded += 1;
    else result.findings.push(...detectRemoteCredentials(contents));
  } catch { result.complete = false; }
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
        else if (!stat.isFile() || !supportedSource(relativePath) || stat.size > MAX_BYTES) result.excluded += 1;
        else {
          const contents = readSource(file, stat, parents);
          if (contents === null) result.excluded += 1;
          else result.findings.push(...detect(contents, relativePath));
        }
      } catch { result.complete = false; }
    }
  }
  scanRootGitConfig(root, directories, result);
  scanPytestShowlocals(root, directories, result);
  scanMcpJson(root, directories, result);
  scanMcpToml(root, directories, result);
  visit(root, '', directories);
  if (!result.complete) result.message = INCOMPLETE;
  return result;
}

function supportedSource(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  return EXTENSIONS.has(extension) || extension === '.sh' || extension === '.bash'
    || /^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/i.test(relativePath);
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
    let hasRemoteCredentials = false;
    for (const finding of result.findings) {
      if (finding.type === 'git_remote_credentials') {
        hasRemoteCredentials = true;
        console.log(`remote ${JSON.stringify(finding.remote)} の ${finding.key} に認証情報が含まれています（${finding.host}）`);
      } else console.log(`${JSON.stringify(finding.path)}:${finding.line} ${finding.key ? `${JSON.stringify(finding.key)} ` : ''}${finding.type}`);
    }
    if (hasRemoteCredentials) {
      console.log('git remote set-url [--push] <remote> <clean-url>');
      console.log('git config --global transfer.credentialsInUrl warn');
    }
    console.log(POLICY);
    console.log(`意図的除外: ${result.excluded} 件（未読を含みます）。`);
    if (!result.complete) console.error(INCOMPLETE);
    else if (!result.findings.length) console.log('対応範囲内の候補は見つかりませんでした。');
  }
  return !result.complete ? 2 : result.findings.length ? 1 : 0;
}

module.exports = { runScanCode, scanCode, detect, MAX_BYTES, PREFIX_BYTES };
