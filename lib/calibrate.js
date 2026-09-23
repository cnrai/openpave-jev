'use strict';

/**
 * Calibration: temperature scaling fitted per bucket.
 *
 * Decision models ship over-confident (Laya's model card reports mean ECE
 * 0.466 out of the box vs 0.081 after refitting one temperature per
 * (question type, option count)). We fit exactly that scheme on labeled
 * data: q_i(T) ~ p_i^(1/T), minimizing negative log-likelihood of the
 * true label on a fit split, then report ECE before/after on the eval
 * split so you can see whether it helped.
 */

const { round } = require('./util');

function clampP(p) {
  return Math.min(1 - 1e-9, Math.max(1e-9, p));
}

/** Temper a discrete distribution (object of probabilities). */
function temperProbs(probs, T) {
  const keys = Object.keys(probs);
  const powed = keys.map((k) => Math.pow(clampP(probs[k]), 1 / T));
  const sum = powed.reduce((a, b) => a + b, 0);
  const out = {};
  // Guard against all-zero (shouldn't happen after clampP).
  const denom = sum > 0 ? sum : keys.length;
  keys.forEach((k, i) => (out[k] = powed[i] / denom));
  return out;
}

/** Temper a single probability (noul) via logit scaling. */
function temperBinary(p, T) {
  const pc = clampP(p);
  const logit = Math.log(pc / (1 - pc)) / T;
  return 1 / (1 + Math.exp(-logit));
}

/** Bucket key: "<type>:<optionCount>" (noul is always 2). */
function bucketKey(question) {
  let n = 2;
  if (question.type === 'choice') n = Object.keys(question.criteria || {}).length;
  else if (question.type === 'score') n = (question.criteria || []).length;
  return question.type + ':' + n;
}

/**
 * Apply temperature T to a raw answer, re-deriving choice/score/confidence.
 * Mutates nothing; returns a new answer object.
 */
function applyToAnswer(answer, question, T) {
  if (!T || !isFinite(T) || T <= 0) return answer;
  const out = Object.assign({}, answer);
  if (answer.probabilities && typeof answer.probabilities === 'object') {
    out.probabilities = temperProbs(answer.probabilities, T);
    const keys = Object.keys(out.probabilities);
    let best = keys[0];
    for (const k of keys) if (out.probabilities[k] > out.probabilities[best]) best = k;
    out.confidence = out.probabilities[best];
    if (answer.type === 'choice') out.choice = best;
    if (answer.type === 'score') {
      // Recompute expected level: probabilities keyed by level label.
      const levels = question.criteria || [];
      let expected = 0;
      let covered = 0;
      for (let i = 0; i < levels.length; i++) {
        const p = out.probabilities[levels[i]];
        if (p !== undefined) {
          expected += i * p;
          covered += p;
        }
      }
      if (covered > 0) out.score = round(expected, 4);
    }
  }
  if (typeof answer.noul === 'number') {
    out.noul = temperBinary(answer.noul, T);
    out.confidence = Math.max(out.noul, 1 - out.noul);
  }
  return out;
}

/** NLL of one labeled example after temperature T (lower = better). */
function nllOf(expected, tempered, question) {
  if (question.type === 'noul') {
    const y = expected ? 1 : 0;
    const p = clampP(tempered.noul);
    return -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  const probs = tempered.probabilities || {};
  let key = null;
  if (question.type === 'choice') key = String(expected);
  else if (question.type === 'score') key = question.criteria ? String(question.criteria[Number(expected)]) : null;
  let p = key !== null ? probs[key] : undefined;
  if (p === undefined && question.type === 'score') {
    // fallback: index-ordered keys
    const keys = Object.keys(probs);
    p = keys[Number(expected)];
  }
  return -Math.log(clampP(p === undefined ? 1e-9 : p));
}

/** Fit one temperature for one bucket via grid + ternary refine. */
function fitTemperature(samples, lo, hi) {
  const l = lo || 0.05;
  const h = hi || 5;
  const totalNll = (T) =>
    samples.reduce((acc, s) => acc + nllOf(s.expected, applyToAnswer(s.rawAnswer, s.question, T), s.question), 0);

  let bestT = 1;
  let bestNll = Infinity;
  for (let t = l; t <= h + 1e-9; t += 0.05) {
    const nll = totalNll(round(t, 3));
    if (nll < bestNll - 1e-12) {
      bestNll = nll;
      bestT = round(t, 3);
    }
  }
  let left = Math.max(l, bestT - 0.05);
  let right = Math.min(h, bestT + 0.05);
  for (let i = 0; i < 40; i++) {
    const m1 = left + (right - left) / 3;
    const m2 = right - (right - left) / 3;
    if (totalNll(m1) < totalNll(m2)) right = m2;
    else left = m1;
  }
  const T = round((left + right) / 2, 4);
  return { T, nll: round(totalNll(T), 4), n: samples.length };
}

/**
 * Fit calibration on a labeled dataset (see docs/calibration.md for format).
 * Deterministic split: even indices fit, odd indices evaluate.
 * Returns { calibration, report } where calibration is the JSON to persist.
 */
function fitCalibration(dataset, metricFn) {
  const buckets = {};
  for (let i = 0; i < dataset.length; i += 2) {
    const item = dataset[i];
    for (const name of Object.keys(item.questions || {})) {
      if (!item.expected || item.expected[name] === undefined) continue;
      const key = bucketKey(item.questions[name]);
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push({
        expected: item.expected[name],
        rawAnswer: item.raw && item.raw.answers ? item.raw.answers[name] : null,
        question: item.questions[name],
      });
    }
  }
  // Buckets need raw answers on the fit half; drop samples without them.
  const fitted = {};
  for (const key of Object.keys(buckets)) {
    const usable = buckets[key].filter((s) => s.rawAnswer && (s.rawAnswer.probabilities || typeof s.rawAnswer.noul === 'number'));
    if (usable.length >= 4) fitted[key] = fitTemperature(usable);
  }
  const calibration = {
    version: 1,
    fitted_at: new Date().toISOString(),
    note: 'Temperature per (question type, option count). Fit on even indices, reported on odd indices.',
    buckets: fitted,
  };
  let report = null;
  if (typeof metricFn === 'function') {
    const evalHalf = dataset.filter((_, i) => i % 2 === 1);
    report = metricFn(evalHalf, calibration);
  }
  return { calibration, report };
}

module.exports = {
  clampP,
  temperProbs,
  temperBinary,
  bucketKey,
  applyToAnswer,
  nllOf,
  fitTemperature,
  fitCalibration,
};
