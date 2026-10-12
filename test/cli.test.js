'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { version } = require('../package.json');

test('--version prints the package version and exits successfully', () => {
  const cliPath = path.join(__dirname, '..', 'bin', 'github-qiita-x.js');
  const result = spawnSync(process.execPath, [cliPath, '--version'], {
    encoding: 'utf8',
    cwd: tmpdir(),
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${version}\n`);
});
