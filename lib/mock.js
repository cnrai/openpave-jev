'use strict';

/**
 * Deterministic mock decision driver.
 * Same (state, question) input always yields the same answer, so tests and
 * demos are reproducible without any model installed.
 */

function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function softmax(logits) {
  const max = Math.max.apply(null, logits);
  const exps = logits.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

/**
 * ask(state, questions, opts) -> { answers, usage, latency_ms, provider }
 * Same driver interface as lib/laya.js and lib/http.js.
 */
async function ask(state, questions) {
  const t0 = Date.now();
  const stateText = JSON.stringify(state);
  const answers = {};
  for (const name of Object.keys(questions)) {
    const q = questions[name] || {};
    const rnd = mulberry32(hash32(stateText + '|' + name + '|' + JSON.stringify(q.criteria || null) + '|' + (q.instructions || '')));
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria || {});
      if (!keys.length) throw new Error('question "' + name + '" (choice) has no criteria');
      const logits = keys.map(() => (rnd() - 0.5) * 8);
      const probs = softmax(logits);
      const probabilities = {};
      keys.forEach((k, i) => (probabilities[k] = round4(probs[i])));
      let best = keys[0];
      for (const k of keys) if (probabilities[k] > probabilities[best]) best = k;
      answers[name] = { type: 'choice', choice: best, probabilities, confidence: probabilities[best] };
    } else if (q.type === 'score') {
      const levels = q.criteria || [];
      if (!levels.length) throw new Error('question "' + name + '" (score) has no criteria');
      const logits = levels.map(() => (rnd() - 0.5) * 8);
      const probs = softmax(logits);
      const probabilities = {};
      let expected = 0;
      levels.forEach((lv, i) => {
        probabilities[lv] = round4(probs[i]);
        expected += i * probs[i];
      });
      let best = levels[0];
      for (const lv of levels) if (probabilities[lv] > probabilities[best]) best = lv;
      answers[name] = { type: 'score', score: round4(expected), choice: best, probabilities, confidence: probabilities[best] };
    } else if (q.type === 'noul') {
      const p = round4(0.05 + rnd() * 0.9);
      answers[name] = { type: 'noul', noul: p, confidence: Math.max(p, 1 - p) };
    } else {
      throw new Error('question "' + name + '" has unknown type: ' + q.type);
    }
  }
  const inputTokens = String(stateText)
    .split(/\s+/)
    .filter(Boolean).length;
  return {
    answers,
    usage: { input_tokens: inputTokens + 13 },
    latency_ms: Date.now() - t0,
    provider: 'mock',
  };
}

module.exports = { ask, hash32, mulberry32, softmax };
