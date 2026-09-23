'use strict';

const test = require('node:test');
const assert = require('node:assert');
const evalLib = require('../lib/eval');

const approx = (a, b, tol) => Math.abs(a - b) <= (tol || 1e-9);

test('scoreOne: noul correct and incorrect cases', () => {
  const q = { type: 'noul' };
  const hit = evalLib.scoreOne({ type: 'noul', noul: 0.9, confidence: 0.9 }, q, true);
  assert.strictEqual(hit.correct, true);
  assert.ok(approx(hit.confidence, 0.9));
  assert.ok(approx(hit.soft, 0.9));
  assert.ok(approx(hit.brier, 0.01));

  const miss = evalLib.scoreOne({ type: 'noul', noul: 0.9, confidence: 0.9 }, q, false);
  assert.strictEqual(miss.correct, false);
  assert.ok(approx(miss.soft, 0.1));
  assert.ok(approx(miss.brier, 0.81));
});

test('scoreOne: choice argmax vs label', () => {
  const q = { type: 'choice', criteria: { a: 'x', b: 'y', c: 'z' } };
  const answer = { type: 'choice', choice: 'a', probabilities: { a: 0.6, b: 0.2, c: 0.2 }, confidence: 0.6 };
  const hit = evalLib.scoreOne(answer, q, 'a');
  assert.strictEqual(hit.correct, true);
  assert.ok(approx(hit.confidence, 0.6));
  assert.ok(approx(hit.soft, 0.6));
  assert.ok(approx(hit.brier, 0.24)); // (0.6-1)^2 + 0.2^2 + 0.2^2

  const miss = evalLib.scoreOne(answer, q, 'b');
  assert.strictEqual(miss.correct, false);
  assert.ok(approx(miss.soft, 0.2));
  assert.ok(approx(miss.brier, 1.04)); // 0.6^2 + (0.2-1)^2 + 0.2^2
});

test('scoreOne: score uses level index as label', () => {
  const q = { type: 'score', criteria: ['lo', 'mid', 'hi'] };
  const answer = { type: 'score', score: 1.5, probabilities: { lo: 0.1, mid: 0.3, hi: 0.6 }, confidence: 0.6 };
  const hit = evalLib.scoreOne(answer, q, 2);
  assert.strictEqual(hit.correct, true);
  assert.ok(approx(hit.soft, 0.6));
  assert.ok(approx(hit.brier, 0.26));
  assert.ok(approx(hit.scoreAbsErr, 0.5));

  const miss = evalLib.scoreOne(answer, q, 0);
  assert.strictEqual(miss.correct, false);
  assert.ok(approx(miss.soft, 0.1));
  assert.ok(approx(miss.scoreAbsErr, 1.5));
});

test('eceFromParts: hand-computed 15-bin value', () => {
  const parts = [
    { confidence: 0.9, correct: true },
    { confidence: 0.9, correct: false },
  ];
  // Both land in bin 13: acc 0.5 vs conf 0.9 -> ECE 0.4.
  assert.ok(approx(evalLib.eceFromParts(parts), 0.4, 1e-6));
  assert.strictEqual(evalLib.eceFromParts([]), 0);
});

/**
 * The full harness on a stubbed askFn, hand-computed:
 * two noul samples p=0.9, labels true then false ->
 * accuracy 0.5, soft 0.5, brier 0.41, ece 0.4, scoreMAE null.
 */
test('runEval: overall metrics for two noul samples', async () => {
  const questions = { q: { type: 'noul', instructions: 'x' } };
  const dataset = [
    { state: { document: 'one' }, questions, expected: { q: true } },
    { state: { document: 'two' }, questions, expected: { q: false } },
  ];
  const askFn = async () => ({ answers: { q: { type: 'noul', noul: 0.9, confidence: 0.9 } } });
  const report = await evalLib.runEval(dataset, askFn, { maxErrors: 0 });

  assert.strictEqual(report.overall.n, 2);
  assert.strictEqual(report.overall.accuracy, 0.5);
  assert.strictEqual(report.overall.softAccuracy, 0.5);
  assert.strictEqual(report.overall.brier, 0.41);
  assert.strictEqual(report.overall.ece, 0.4);
  assert.strictEqual(report.overall.scoreMAE, null);
  assert.strictEqual(report.byType.noul.n, 2);
  assert.strictEqual(report.byQuestion.q.n, 2);
});

test('runEval: choice accuracy/soft/brier and error collection', async () => {
  const questions = { pick: { type: 'choice', criteria: { a: 'x', b: 'y', c: 'z' }, instructions: 'pick' } };
  const answer = { type: 'choice', choice: 'a', probabilities: { a: 0.6, b: 0.2, c: 0.2 }, confidence: 0.6 };
  const dataset = [
    { state: { document: 'one' }, questions, expected: { pick: 'a' } },
    { state: { document: 'two' }, questions, expected: { pick: 'b' } },
  ];
  const askFn = async () => ({ answers: { pick: answer } });
  const report = await evalLib.runEval(dataset, askFn, { maxErrors: 10 });

  assert.strictEqual(report.overall.accuracy, 0.5);
  assert.strictEqual(report.overall.softAccuracy, 0.4);
  assert.strictEqual(report.overall.brier, 0.64); // (0.24 + 1.04) / 2
  assert.ok(approx(report.overall.ece, 0.1, 1e-6)); // bin 9: acc 0.5 vs conf 0.6
  assert.strictEqual(report.errors.length, 1);
  assert.strictEqual(report.errors[0].name, 'pick');
  assert.strictEqual(report.errors[0].got, 'a');
  assert.strictEqual(report.errors[0].expected, 'b');
});

test('runEval: score scoreMAE across two samples', async () => {
  const questions = { sev: { type: 'score', criteria: ['lo', 'mid', 'hi'], instructions: 'sev' } };
  const answer = { type: 'score', score: 1.5, choice: 'hi', probabilities: { lo: 0.1, mid: 0.3, hi: 0.6 }, confidence: 0.6 };
  const dataset = [
    { state: { document: 'one' }, questions, expected: { sev: 2 } },
    { state: { document: 'two' }, questions, expected: { sev: 0 } },
  ];
  const askFn = async () => ({ answers: { sev: answer } });
  const report = await evalLib.runEval(dataset, askFn, { maxErrors: 0 });

  assert.strictEqual(report.overall.accuracy, 0.5);
  assert.ok(approx(report.overall.scoreMAE, 1.0, 1e-6)); // (0.5 + 1.5) / 2
});

test('runEval: expected===undefined questions are skipped', async () => {
  const questions = {
    q1: { type: 'noul' },
    q2: { type: 'noul' },
  };
  const dataset = [{ state: {}, questions, expected: { q1: true } }];
  const askFn = async () => ({ answers: { q1: { type: 'noul', noul: 0.9, confidence: 0.9 }, q2: { type: 'noul', noul: 0.9, confidence: 0.9 } } });
  const report = await evalLib.runEval(dataset, askFn, { maxErrors: 0 });
  assert.strictEqual(report.overall.n, 1, 'only the labeled question counts');
  assert.ok(!report.byQuestion.q2);
});
