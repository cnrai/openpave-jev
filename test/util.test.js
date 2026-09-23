'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('../lib/util');

test('parseArgs: long flags with space, =, and boolean forms', () => {
  const r = util.parseArgs(['--state', 'hello world', '--min-confidence=0.9', '--quiet']);
  assert.strictEqual(r.flags.state, 'hello world');
  assert.strictEqual(r.flags['min-confidence'], '0.9');
  assert.strictEqual(r.flags.quiet, true);
  assert.deepStrictEqual(r._, []);
});

test('parseArgs: single-dash short flags take values', () => {
  const r = util.parseArgs(['-s', 'hi', '-c', 'a,b,c', '-i', 'pick one', '-n', 'q1', '-p', 'mock']);
  assert.strictEqual(r.flags.s, 'hi');
  assert.strictEqual(r.flags.c, 'a,b,c');
  assert.strictEqual(r.flags.i, 'pick one');
  assert.strictEqual(r.flags.n, 'q1');
  assert.strictEqual(r.flags.p, 'mock');
});

test('parseArgs: bare short flag is boolean true; a following flag is not eaten as a value', () => {
  const r = util.parseArgs(['-q', '--provider', 'mock']);
  assert.strictEqual(r.flags.q, true);
  assert.strictEqual(r.flags.provider, 'mock');
  const r2 = util.parseArgs(['--quiet', '-s', 'x']);
  assert.strictEqual(r2.flags.quiet, true);
  assert.strictEqual(r2.flags.s, 'x');
});

test('parseArgs: "-" is a value (stdin marker), negative numbers are values', () => {
  const r = util.parseArgs(['--state', '-', '--min-confidence', '-0.5', '-s', '-']);
  assert.strictEqual(r.flags.state, '-');
  assert.strictEqual(r.flags['min-confidence'], '-0.5');
  assert.strictEqual(r.flags.s, '-');
});

test('parseArgs: "--" makes everything after it positional', () => {
  const r = util.parseArgs(['--quiet', '--', '-s', 'not-a-flag']);
  assert.strictEqual(r.flags.quiet, true);
  assert.deepStrictEqual(r._, ['-s', 'not-a-flag']);
});

test('buildState: --state, -s alias and --state-json', async () => {
  assert.deepStrictEqual(await util.buildState({ state: 'hello' }), { document: 'hello' });
  assert.deepStrictEqual(await util.buildState({ s: 'via short' }), { document: 'via short' });
  assert.deepStrictEqual(await util.buildState({ state: 'long wins', s: 'short' }), { document: 'long wins' });
  assert.deepStrictEqual(await util.buildState({ 'state-json': '{"a":1,"b":"x"}' }), { a: 1, b: 'x' });
  assert.deepStrictEqual(await util.buildState({ 'state-json': '[1,2]' }).catch((e) => e.message), '--state-json must be a JSON object');
  // No-state refusal: fake a TTY so buildState does not block reading stdin
  // (under the test runner stdin is an open pipe).
  const savedTty = process.stdin.isTTY;
  process.stdin.isTTY = true;
  try {
    await assert.rejects(() => util.buildState({}), /no state provided/);
  } finally {
    process.stdin.isTTY = savedTty;
  }
});

test('parseChoiceCriteria: comma list, key:desc pairs, JSON object', () => {
  assert.deepStrictEqual(util.parseChoiceCriteria('a,b,c'), { a: 'a', b: 'b', c: 'c' });
  assert.deepStrictEqual(util.parseChoiceCriteria('billing: payments, sales: buying'), { billing: 'payments', sales: 'buying' });
  assert.deepStrictEqual(util.parseChoiceCriteria('{"a":"x","b":"y"}'), { a: 'x', b: 'y' });
  assert.throws(() => util.parseChoiceCriteria('only-one'), /at least 2 options/);
  assert.throws(() => util.parseChoiceCriteria(null), /requires --choices/);
});

test('parseLevels: comma list, JSON array, bounds', () => {
  assert.deepStrictEqual(util.parseLevels('lo,mid,hi'), ['lo', 'mid', 'hi']);
  assert.deepStrictEqual(util.parseLevels('["1","2"]'), ['1', '2']);
  assert.throws(() => util.parseLevels('solo'), /at least 2 levels/);
  assert.throws(() => util.parseLevels(Array(21).fill('x').join(',')), /at most 20 levels/);
});

test('readJsonInput: literal JSON, @file, and bare path all work', async () => {
  assert.deepStrictEqual(await util.readJsonInput('{"k":1}', 'x'), { k: 1 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-util-'));
  try {
    const p = path.join(tmp, 'req.json');
    fs.writeFileSync(p, JSON.stringify({ state: {}, questions: {} }));
    assert.deepStrictEqual(await util.readJsonInput('@' + p, 'x'), { state: {}, questions: {} });
    assert.deepStrictEqual(await util.readJsonInput(p, 'x'), { state: {}, questions: {} }, 'bare path (help form)');
    await assert.rejects(() => util.readJsonInput('not json', 'x'), /is not valid JSON/);
    await assert.rejects(() => util.readJsonInput(undefined, 'x'), /missing x/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('jevHome/calibrationPath honor JEV_HOME; loadCalibration returns null when absent', () => {
  const saved = process.env.JEV_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-home-'));
  try {
    process.env.JEV_HOME = tmp;
    assert.strictEqual(util.jevHome(), tmp);
    assert.strictEqual(util.calibrationPath(), path.join(tmp, 'calibration.json'));
    assert.strictEqual(util.loadCalibration(), null);

    util.saveCalibration({ version: 1, buckets: { 'noul:2': { T: 1.5, n: 8 } } });
    const loaded = util.loadCalibration();
    assert.strictEqual(loaded.buckets['noul:2'].T, 1.5);
    assert.strictEqual(util.loadCalibration.name, 'loadCalibration');

    fs.writeFileSync(util.calibrationPath(), '{corrupt');
    assert.strictEqual(util.loadCalibration(), null, 'corrupt file treated as no calibration');
  } finally {
    if (saved === undefined) delete process.env.JEV_HOME;
    else process.env.JEV_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveApiKey: env wins over tokens.yaml', () => {
  const saved = process.env.JEV_API_KEY;
  try {
    process.env.JEV_API_KEY = 'env-key';
    assert.strictEqual(util.resolveApiKey(), 'env-key');
    delete process.env.JEV_API_KEY;
    // No assertion on the file path result: ~/.pave/tokens.yaml is user state.
    const fromFile = util.resolveApiKey();
    assert.ok(fromFile === null || typeof fromFile === 'string');
  } finally {
    if (saved === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = saved;
  }
});
