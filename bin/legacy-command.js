#!/usr/bin/env node
'use strict';

// Deprecated alias wrapper; keep stdout and exit codes identical to the new CLI.
const cli = require('./ai-secret-check');

if (require.main === module) {
  console.error('github-qiita-x は非推奨です。ai-secret-check を使ってください');
  process.exitCode = cli.main(process.argv.slice(2));
}

module.exports = cli;
