'use strict';

const test = require('node:test');
const assert = require('node:assert');
const calibrate = require('../lib/calibrate');
const evalLib = require('../lib/eval');

const approx = (a, b, tol) => Math.abs(a - b) <= (tol || 1e-9);

test('temperProbs: T=1 identity, T=2 flattens, sums to 1', () => {
  const probs = { a: 0.7, b: 0.3 };
  const t1 = calibrate.temperProbs(probs, 1);
  assert.ok(approx(t1.a, 0.7) && approx(t1.b, 0.3));

  const t2 = calibrate.temperProbs(probs, 2);
  assert.ok(approx(t2.a, 0.6044, 1e-3), 'a=' + t2.a);
  assert.ok(approx(t2.b, 0.3956, 1e-3), 'b=' + t2.b);
  assert.ok(approx(t2.a + t2.b, 1, 1e-9));

  // Large T approaches uniform.
  const tBig = calibrate.temperProbs(probs, 1000);
  assert.ok(approx(tBig.a, 0.5, 1e-3));
});

test('temperBinary: T=1 identity, logit scaling, p=0.5 fixed point', () => {
  assert.ok(approx(calibrate.temperBinary(0.9, 1), 0.9));
  // logit(0.9)=ln(9); /2 = ln(3); sigmoid(ln3)=3/4 exactly.
  assert.ok(approx(calibrate.temperBinary(0.9, 2), 0.75), 'got ' + calibrate.temperBinary(0.9, 2));
  assert.ok(approx(calibrate.temperBinary(0.5, 7), 0.5));
});

test('bucketKey maps (type, option count)', () => {
  assert.strictEqual(calibrate.bucketKey({ type: 'choice', criteria: { a: 'x', b: 'y', c: 'z' } }), 'choice:3');
  assert.strictEqual(calibrate.bucketKey({ type: 'score', criteria: ['lo', 'mid', 'hi', 'x'] }), 'score:4');
  assert.strictEqual(calibrate.bucketKey({ type: 'noul' }), 'noul:2');
});

test('applyToAnswer re-derives choice/confidence and never mutates the input', () => {
  const raw = { type: 'choice', choice: 'a', probabilities: { a: 0.7, b: 0.3 }, confidence: 0.7 };
  const out = calibrate.applyToAnswer(raw, { type: 'choice', criteria: { a: 'x', b: 'y' } }, 2);
  assert.strictEqual(out.choice, 'a');
  assert.ok(approx(out.probabilities.a, 0.6044, 1e-3));
  assert.ok(approx(out.confidence, 0.6044, 1e-3));
  // input untouched
  assert.ok(approx(raw.probabilities.a, 0.7));
  // T<=0 is a no-op
  assert.deepStrictEqual(calibrate.applyToAnswer(raw, { type: 'choice', criteria: { a: 'x', b: 'y' } }, 0), raw);
});

test('applyToAnswer recomputes score expectation from tempered level probabilities', () => {
  const raw = { type: 'score', score: 2.6, choice: 'hi', probabilities: { lo: 0.1, mid: 0.2, hi: 0.7 }, confidence: 0.7 };
  const q = { type: 'score', criteria: ['lo', 'mid', 'hi'] };
  const out = calibrate.applyToAnswer(raw, q, 2);
  // sqrt probs: 0.3162/0.4472/0.8367 -> normalized 0.1976/0.2795/0.5229
  assert.ok(approx(out.score, 1.3253, 1e-3), 'score=' + out.score);
  assert.ok(approx(out.confidence, 0.5229, 1e-3));
});

test('applyToAnswer tempers noul and its confidence', () => {
  const raw = { type: 'noul', noul: 0.9, confidence: 0.9 };
  const out = calibrate.applyToAnswer(raw, { type: 'noul' }, 2);
  assert.ok(approx(out.noul, 0.75));
  assert.ok(approx(out.confidence, 0.75));
});

test('nllOf: noul, choice and score lookups', () => {
  assert.ok(approx(calibrate.nllOf(true, { noul: 0.75 }, { type: 'noul' }), -Math.log(0.75)));
  assert.ok(approx(calibrate.nllOf(false, { noul: 0.75 }, { type: 'noul' }), -Math.log(0.25)));
  assert.ok(approx(calibrate.nllOf('a', { probabilities: { a: 0.5, b: 0.5 } }, { type: 'choice', criteria: { a: 'x', b: 'y' } }), Math.LN2));
  const sq = { type: 'score', criteria: ['lo', 'mid', 'hi'] };
  assert.ok(approx(calibrate.nllOf(2, { probabilities: { lo: 0.1, mid: 0.2, hi: 0.7 } }, sq), -Math.log(0.7)));
});

test('fitTemperature sharpens an under-confident all-true noul bucket', () => {
  const q = { type: 'noul' };
  const samples = [];
  for (let i = 0; i < 20; i++) samples.push({ expected: true, rawAnswer: { type: 'noul', noul: 0.6, confidence: 0.6 }, question: q });
  const fit = calibrate.fitTemperature(samples);
  assert.ok(fit.T < 0.5, 'T=' + fit.T + ' should sharpen p=0.6 toward 1');
  assert.strictEqual(fit.n, 20);
  assert.ok(Number.isFinite(fit.nll));
});

/**
 * The headline synthetic story: a model that always says p=0.9 on a 50/50
 * question is badly over-confident. Fitting must push T high (flatten toward
 * 0.5), and on the held-out half ECE and Brier must both improve.
 */
test('fitCalibration repairs an over-confident noul model on held-out data', async () => {
  const q = { type: 'noul', instructions: 'is it true?' };
  const dataset = [];
  for (let i = 0; i < 100; i++) {
    const label = (i * 37) % 100 < 50; // 50/50, unaligned with the even/odd split
    dataset.push({
      state: { document: 'case ' + i },
      questions: { q },
      expected: { q: label },
      raw: { answers: { q: { type: 'noul', noul: 0.9, confidence: 0.9 } }, usage: { input_tokens: 1 } },
    });
  }

  const { calibration } = calibrate.fitCalibration(dataset);
  const bucket = calibration.buckets['noul:2'];
  assert.ok(bucket, 'noul:2 bucket fitted');
  assert.strictEqual(bucket.n, 50, 'fit half has 50 samples');
  assert.ok(bucket.T > 3, 'T=' + bucket.T + ' should flatten toward 0.5 (grid-capped near 5)');

  // Held-out evaluation (odd indices) with a stored-answer askFn.
  const half = dataset.filter((_, i) => i % 2 === 1);
  const items = half.map((x) => ({ state: x.state, questions: x.questions, expected: x.expected }));
  let i = 0;
  const askStored = async () => half[(i++) % half.length].raw;

  const before = await evalLib.runEval(items, askStored, { maxErrors: 0 });
  const after = await evalLib.runEval(items, askStored, { calibration, maxErrors: 0 });

  assert.ok(approx(before.overall.ece, 0.4, 1e-3), 'pre ECE=' + before.overall.ece);
  assert.ok(after.overall.ece < 0.2, 'post ECE=' + after.overall.ece + ' should be far below 0.4');
  assert.ok(after.overall.brier < before.overall.brier, 'brier ' + before.overall.brier + ' -> ' + after.overall.brier);
});
