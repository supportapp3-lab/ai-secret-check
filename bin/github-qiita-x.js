#!/usr/bin/env node
'use strict';

const { version } = require('../package.json');
const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--version') {
  console.log(version);
} else if (args.length === 0) {
  console.log('Usage: github-qiita-x --version');
} else {
  console.error('Usage: github-qiita-x --version');
  process.exitCode = 1;
}
