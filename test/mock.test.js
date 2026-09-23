'use strict';

const test = require('node:test');
const assert = require('node:assert');
const mock = require('../lib/mock');

test('hash32 matches FNV-1a reference values', () => {
  assert.strictEqual(mock.hash32(''), 2166136261);
  assert.strictEqual(mock.hash32('a'), 0xe40c292c);
});

test('mulberry32 is deterministic for a fixed seed', () => {
  const a = mock.mulberry32(42);
  const b = mock.mulberry32(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepStrictEqual(seqA, seqB);
  for (const v of seqA) assert.ok(v >= 0 && v < 1, 'in [0,1)');
});

test('softmax normalizes and is numerically stable', () => {
  const flat = mock.softmax([0, 0]);
  assert.strictEqual(flat[0], 0.5);
  assert.strictEqual(flat[1], 0.5);
  const extreme = mock.softmax([1000, 0]);
  assert.ok(extreme[0] > 0.999);
  assert.ok(extreme[1] < 0.001);
  const sum = mock.softmax([1, 2, 3]).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
});

test('mock.ask is deterministic for identical input', async () => {
  const questions = {
    route: { type: 'choice', criteria: { billing: 'payments', support: 'help', sales: 'buy' }, instructions: 'route it' },
    sev: { type: 'score', criteria: ['low', 'mid', 'high'], instructions: 'severity' },
    yes: { type: 'noul', instructions: 'is it?' },
  };
  const r1 = await mock.ask({ document: 'refund not received' }, questions);
  const r2 = await mock.ask({ document: 'refund not received' }, questions);
  assert.deepStrictEqual(r1.answers, r2.answers);
});

test('mock.ask answer shapes for all three question types', async () => {
  const questions = {
    route: { type: 'choice', criteria: { billing: 'payments', support: 'help', sales: 'buy' }, instructions: 'route it' },
    sev: { type: 'score', criteria: ['low', 'mid', 'high'], instructions: 'severity' },
    yes: { type: 'noul', instructions: 'is it?' },
  };
  const r = await mock.ask({ document: 'refund not received' }, questions);
  assert.strictEqual(r.provider, 'mock');
  assert.ok(Number.isFinite(r.latency_ms));

  const route = r.answers.route;
  const keys = Object.keys(questions.route.criteria);
  assert.ok(keys.indexOf(route.choice) !== -1, 'choice is one of the criteria keys');
  const probSum = keys.map((k) => route.probabilities[k]).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(probSum - 1) < 0.01, 'probabilities sum to ~1, got ' + probSum);
  assert.ok(Math.abs(route.confidence - route.probabilities[route.choice]) < 1e-9);

  const sev = r.answers.sev;
  assert.ok(sev.score >= 0 && sev.score <= 2, 'score within level index range');
  assert.ok(keys.every(() => true));
  const sevLevels = questions.sev.criteria;
  const sevSum = sevLevels.map((lv) => sev.probabilities[lv]).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sevSum - 1) < 0.01);

  const yes = r.answers.yes;
  assert.ok(yes.noul >= 0.05 && yes.noul <= 0.95, 'noul in generated range');
  assert.ok(Math.abs(yes.confidence - Math.max(yes.noul, 1 - yes.noul)) < 1e-9);
});

test('mock.ask usage counts whitespace tokens of the serialized state', async () => {
  const r = await mock.ask({ document: 'refund not received' }, { q: { type: 'noul' } });
  // '{"document":"refund not received"}' -> 3 whitespace-separated tokens + 13
  assert.strictEqual(r.usage.input_tokens, 16);
});

test('mock.ask rejects unknown question types', async () => {
  await assert.rejects(() => mock.ask({}, { bad: { type: 'wat' } }), /unknown type/);
});

test('mock.ask rejects choice/score questions without criteria', async () => {
  await assert.rejects(() => mock.ask({}, { c: { type: 'choice' } }), /no criteria/);
  await assert.rejects(() => mock.ask({}, { s: { type: 'score', criteria: [] } }), /no criteria/);
});
