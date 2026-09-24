'use strict';

// Bin entry + adaptive engine-error message (npm and clone install shapes).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

test('package.json declares bin.jev -> index.js', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.bin, 'package.json must declare a bin field');
  assert.strictEqual(pkg.bin.jev, 'index.js');
});

test('index.js starts with a node shebang', () => {
  const firstLine = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8').split('\n')[0];
  assert.strictEqual(firstLine, '#!/usr/bin/env node');
});

test('engine-not-installed error names both install shapes', async () => {
  const laya = require(path.join(ROOT, 'lib', 'laya.js'));
  // Precondition: this test exercises the not-installed path. If the engine
  // were installed, ask() would attempt a real weights load instead of
  // throwing, so fail fast rather than download ~1.7GB.
  assert.strictEqual(laya.isInstalled(), false, 'precondition: @receptron/laya not installed');
  await assert.rejects(
    laya.ask({}, [], { checkpoint: 'english' }),
    (err) => {
      assert.ok(err instanceof Error, 'ask() rejects with an Error');
      assert.match(err.message, /jev setup laya/, 'PATH/npm install form');
      assert.match(err.message, /index\.js setup laya/, 'clone install form');
      assert.match(err.message, /receptron-laya/, 'weights cache hint');
      return true;
    }
  );
});
