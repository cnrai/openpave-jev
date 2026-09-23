'use strict';

/**
 * Eval harness: run a labeled dataset through a driver and measure
 *   accuracy      - argmax answer == label (noul: p>0.5 side == label)
 *   softAccuracy  - mean probability assigned to the truth
 *   brier         - mean (p - y)^2 over the full distribution
 *   ece           - 15-bin expected calibration error on max-prob confidence
 *   scoreMAE      - score questions: |expected level - true level|
 * Nothing here trusts the model's own confidence: everything is computed
 * against labels.
 */

const { applyToAnswer, bucketKey } = require('./calibrate');
const { round } = require('./util');

const ECE_BINS = 15;

/** Score one (answer, question, expected) triple into flat metrics parts. */
function scoreOne(answer, question, expected) {
  const type = question.type;
  if (type === 'noul') {
    const y = expected ? 1 : 0;
    const p = typeof answer.noul === 'number' ? answer.noul : 0.5;
    return {
      correct: p > 0.5 === !!expected,
      confidence: Math.max(p, 1 - p),
      soft: y ? p : 1 - p,
      brier: (p - y) * (p - y),
    };
  }
  const probs = answer.probabilities || {};
  if (type === 'choice') {
    const keys = Object.keys(question.criteria || {});
    let best = null;
    let conf = -1;
    let soft = 0;
    let brier = 0;
    for (const k of keys) {
      const p = probs[k] !== undefined ? probs[k] : 0;
      const y = String(expected) === String(k) ? 1 : 0;
      brier += (p - y) * (p - y);
      if (p > conf) {
        conf = p;
        best = k;
      }
      if (y) soft = p;
    }
    return { correct: String(best) === String(expected), confidence: conf, soft, brier };
  }
  if (type === 'score') {
    const levels = question.criteria || [];
    let bestIdx = 0;
    let conf = -1;
    let soft = 0;
    let brier = 0;
    for (let i = 0; i < levels.length; i++) {
      const p = probs[levels[i]] !== undefined ? probs[levels[i]] : 0;
      const y = Number(expected) === i ? 1 : 0;
      brier += (p - y) * (p - y);
      if (p > conf) {
        conf = p;
        bestIdx = i;
      }
      if (y) soft = p;
    }
    const predicted = typeof answer.score === 'number' ? answer.score : bestIdx;
    return {
      correct: bestIdx === Number(expected),
      confidence: conf,
      soft,
      brier,
      scoreAbsErr: Math.abs(predicted - Number(expected)),
    };
  }
  return null;
}

function emptyMetrics() {
  return { n: 0, accuracy: 0, softAccuracy: 0, brier: 0, ece: 0, scoreMAE: null };
}

function finalizeMetrics(m) {
  const n = m.n || 0;
  return {
    n,
    accuracy: n ? round(m.correct / n, 4) : 0,
    softAccuracy: n ? round(m.softSum / n, 4) : 0,
    brier: n ? round(m.brierSum / n, 4) : 0,
    ece: n ? round(m.ece, 4) : 0,
    scoreMAE: m.scoreErrCount ? round(m.scoreErrSum / m.scoreErrCount, 4) : null,
  };
}

function accumulate(bucket, parts) {
  bucket.n++;
  if (parts.correct) bucket.correct++;
  bucket.softSum += parts.soft;
  bucket.brierSum += parts.brier;
  if (parts.scoreAbsErr !== undefined) {
    bucket.scoreErrSum += parts.scoreAbsErr;
    bucket.scoreErrCount++;
  }
}

function eceFromParts(partsList) {
  if (!partsList.length) return 0;
  const bins = [];
  for (let i = 0; i < ECE_BINS; i++) bins.push({ n: 0, correct: 0, confSum: 0 });
  for (const parts of partsList) {
    const conf = Math.min(0.9999, Math.max(0, parts.confidence));
    const idx = Math.min(ECE_BINS - 1, Math.floor(conf * ECE_BINS));
    bins[idx].n++;
    bins[idx].confSum += parts.confidence;
    if (parts.correct) bins[idx].correct++;
  }
  let ece = 0;
  for (const b of bins) {
    if (!b.n) continue;
    const acc = b.correct / b.n;
    const conf = b.confSum / b.n;
    ece += (b.n / partsList.length) * Math.abs(acc - conf);
  }
  return ece;
}

/**
 * Evaluate a dataset through askFn(state, questions).
 * dataset: [{ state, questions, expected: { name: label } }]
 * opts: { calibration, maxErrors }
 */
async function runEval(dataset, askFn, opts) {
  const o = opts || {};
  const overall = { n: 0, correct: 0, softSum: 0, brierSum: 0, ece: 0, scoreErrSum: 0, scoreErrCount: 0 };
  const byType = {};
  const byQuestion = {};
  const allParts = [];
  const errors = [];
  const maxErrors = o.maxErrors === undefined ? 10 : o.maxErrors;

  for (const item of dataset) {
    const result = await askFn(item.state, item.questions);
    const answers = (result && result.answers) || {};
    for (const name of Object.keys(item.questions)) {
      const question = item.questions[name];
      const expected = item.expected && item.expected[name];
      if (expected === undefined) continue;
      let answer = answers[name];
      if (!answer) continue;
      if (o.calibration && o.calibration.buckets) {
        const key = bucketKey(question);
        const T = o.calibration.buckets[key] ? o.calibration.buckets[key].T : null;
        if (T) answer = applyToAnswer(answer, question, T);
      }
      const parts = scoreOne(answer, question, expected);
      if (!parts) continue;
      const type = question.type;
      if (!byType[type]) byType[type] = { n: 0, correct: 0, softSum: 0, brierSum: 0, ece: 0, scoreErrSum: 0, scoreErrCount: 0, parts: [] };
      if (!byQuestion[name]) byQuestion[name] = { n: 0, correct: 0, softSum: 0, brierSum: 0, ece: 0, scoreErrSum: 0, scoreErrCount: 0, parts: [] };
      accumulate(overall, parts);
      accumulate(byType[type], parts);
      accumulate(byQuestion[name], parts);
      byType[type].parts.push(parts);
      byQuestion[name].parts.push(parts);
      allParts.push(parts);
      if (!parts.correct && errors.length < maxErrors) {
        errors.push({
          name,
          type,
          expected,
          got: answer.choice !== undefined ? answer.choice : answer.score !== undefined ? answer.score : answer.noul,
          confidence: answer.confidence,
        });
      }
    }
  }

  overall.ece = eceFromParts(allParts);
  const out = {
    overall: finalizeMetrics(overall),
    byType: {},
    byQuestion: {},
    errors,
  };
  for (const t of Object.keys(byType)) {
    byType[t].ece = eceFromParts(byType[t].parts);
    out.byType[t] = finalizeMetrics(byType[t]);
  }
  for (const q of Object.keys(byQuestion)) {
    byQuestion[q].ece = eceFromParts(byQuestion[q].parts);
    out.byQuestion[q] = finalizeMetrics(byQuestion[q]);
  }
  return out;
}

module.exports = { runEval, scoreOne, eceFromParts, ECE_BINS };
