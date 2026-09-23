#!/usr/bin/env node

'use strict';

/**
 * jev - typed decisions from non-autoregressive decision models.
 *
 * One CLI over three interchangeable drivers:
 *   laya      local open-weights engine (@receptron/laya, Apache-2.0, ~33ms/q)
 *   http      any Jev-compatible POST /v1/systemone server (laya-serve, ...)
 *   typesafe  the TypeSafe Jev API (http + JEV_API_KEY)
 *   mock      deterministic fake for tests
 *
 * Question types (the "typed decisions" primitive):
 *   choice  pick one option          -> { choice, probabilities }
 *   score   level on an ordered rubric -> { score, probabilities }
 *   noul    calibrated yes/no        -> { noul: P(true) }
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const drivers = require('./lib/drivers');
const mockDriver = require('./lib/mock');
const calibrateLib = require('./lib/calibrate');
const evalLib = require('./lib/eval');
const util = require('./lib/util');

const SKILL_ROOT = path.join(__dirname);

const HELP = `jev - typed decisions from non-autoregressive decision models

Usage:
  jev decide  -s <state> -c "a,b,c"            Choice + probability distribution
  jev score   -s <state> -l "low,mid,high"     Expected level on a rubric
  jev noul    -s <state> -i "Is this spam?"    Calibrated P(true)
  jev ask     -f request.json                  Full {state, questions} request
  jev eval    -f labeled.json                  Accuracy / soft acc / Brier / ECE
  jev calibrate -f labeled.json                Fit temperatures, save calibration
  jev providers                               Driver status
  jev setup laya                              Install the local Laya engine

State input:
  --state <text | @file | ->        plain text -> { document: text }
  --state-json <json | @file | ->   JSON object used as-is
  (also reads stdin when no state flag is given)

Providers:
  --provider mock|laya|http|typesafe   or JEV_PROVIDER env; auto order:
  JEV_MOCK=1 > JEV_BASE_URL > JEV_API_KEY > installed laya > error

Config:
  JEV_API_KEY          TypeSafe Jev API key (or JEV_API_KEY in ~/.pave/tokens.yaml)
  JEV_BASE_URL         base URL of a /v1/systemone server (e.g. http://127.0.0.1:8000)
  JEV_PROVIDER         default provider
  JEV_HOME             data dir (default ~/.pave/jev; holds calibration.json)
  JEV_LAYA_CHECKPOINT  english (default) | multilingual | typed-decisions
  LAYA_CACHE           engine weight cache override

Exit codes: 0 ok, 1 error, 2 usage, 3 confidence below --min-confidence
Docs: docs/research.md, docs/calibration.md, docs/integrations.md`;

function usageError(msg) {
  process.stderr.write('error: ' + msg + '\n\n' + HELP + '\n');
  process.exit(2);
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

/** Shared option extraction for the single-question commands. */
function commonOpts(flags) {
  return {
    provider: flags.provider || flags.p,
    checkpoint: flags.checkpoint,
    baseUrl: flags['base-url'],
  };
}

/** Build the questions object for decide/score/noul. */
function buildSingleQuestion(flags, type) {
  const name = flags.name || flags.n || 'answer';
  const q = { type };
  const instructions =
    flags.instructions || flags.i || (type === 'choice' ? 'Choose the best option for this input.' : type === 'score' ? 'Rate this input on the rubric.' : 'Answer the question about this input.');
  q.instructions = instructions;
  if (type === 'choice') {
    const spec = flags.choices || flags.c || flags.criteria;
    q.criteria = util.parseChoiceCriteria(spec);
  } else if (type === 'score') {
    q.criteria = util.parseLevels(flags.levels || flags.l);
  }
  return { name, q };
}

/** Run provider.ask + optional calibration; returns enriched result. */
async function askWithPipeline(provider, state, questions, flags, opts) {
  const o = opts || {};
  const result = await provider.ask(state, questions, {
    checkpoint: o.checkpoint,
    baseUrl: o.baseUrl,
  });
  const useCal = !flags['no-calibrate'] && !o.skipCalibration;
  const calibration = useCal ? util.loadCalibration() : null;
  let answers = result.answers || {};
  const applied = {};
  if (calibration) {
    for (const name of Object.keys(questions)) {
      const key = calibrateLib.bucketKey(questions[name]);
      const entry = calibration.buckets[key];
      if (entry && result.answers && result.answers[name]) {
        answers[name] = calibrateLib.applyToAnswer(result.answers[name], questions[name], entry.T);
        applied[name] = entry.T;
      }
    }
  }
  return { result, answers, calibration, applied };
}

function confidenceGate(flags, answers) {
  const min = Number(flags['min-confidence']);
  if (!isFinite(min) || min <= 0) return null;
  for (const name of Object.keys(answers)) {
    const conf = answers[name].confidence;
    if (typeof conf === 'number' && conf < min) {
      return { name, confidence: conf };
    }
  }
  return null;
}

async function cmdSingle(type, flags) {
  const qType = type === 'decide' ? 'choice' : type; // the decide command asks a choice question
  const state = await util.buildState(flags);
  const { name, q } = buildSingleQuestion(flags, qType);
  const questions = {};
  questions[name] = q;
  const provider = drivers.resolveProvider(commonOpts(flags).provider);
  const { answers, calibration, applied } = await askWithPipeline(provider, state, questions, flags, commonOpts(flags));
  const gate = confidenceGate(flags, answers);
  const payload = {
    provider: provider.name,
    answer: answers[name] || null,
    usage: null,
    latency_ms: null,
  };
  if (flags.quiet || flags.q) {
    const a = answers[name] || {};
    const val = qType === 'choice' ? a.choice : qType === 'score' ? a.score : a.noul;
    process.stdout.write(String(val) + '\n');
  } else {
    out(payload);
  }
  if (gate) {
    process.stderr.write(
      JSON.stringify({ error: 'confidence gate', question: gate.name, confidence: gate.confidence, min: Number(flags['min-confidence']) }) + '\n'
    );
    process.exit(3);
  }
}

async function cmdAsk(flags) {
  if (!flags.file && !flags.f) usageError('ask requires --file (JSON: {state, questions}, or @path, or - for stdin)');
  const req = await util.readJsonInput(flags.file || flags.f, '--file');
  if (!req || typeof req !== 'object') usageError('--file must be a JSON object');
  const state = req.state;
  const questions = req.questions;
  if (!state || typeof state !== 'object') usageError('request.state must be an object');
  if (!questions || typeof questions !== 'object' || !Object.keys(questions).length) usageError('request.questions must be a non-empty object');
  for (const name of Object.keys(questions)) {
    const q = questions[name];
    if (!q.type) usageError('question "' + name + '" is missing "type" (choice|score|noul)');
    if (q.type === 'choice' && !q.criteria) usageError('choice question "' + name + '" is missing "criteria"');
    if (q.type === 'score' && !q.criteria) usageError('score question "' + name + '" is missing "criteria" (ordered levels)');
  }
  const provider = drivers.resolveProvider(commonOpts(flags).provider);
  const t0 = Date.now();
  const { answers, applied } = await askWithPipeline(provider, state, questions, flags, commonOpts(flags));
  out({ provider: provider.name, answers, calibrated: Object.keys(applied).length ? applied : undefined, wall_ms: Date.now() - t0 });
}

function fmtMetricsRow(label, m) {
  const mae = m.scoreMAE === null ? '-' : m.scoreMAE.toFixed(3);
  return (
    label.padEnd(28) +
    String(m.n).padStart(5) +
    m.accuracy.toFixed(4).padStart(9) +
    m.softAccuracy.toFixed(4).padStart(9) +
    m.brier.toFixed(4).padStart(9) +
    m.ece.toFixed(4).padStart(9) +
    mae.padStart(9)
  );
}

function printEvalTable(report, title) {
  const header = ''.padEnd(28) + '    n' + '  acc'.padStart(9) + '  soft'.padStart(9) + ' brier'.padStart(9) + '   ece'.padStart(9) + '  mae'.padStart(9);
  process.stdout.write(title + '\n' + header + '\n');
  process.stdout.write(fmtMetricsRow('overall', report.overall) + '\n');
  for (const t of Object.keys(report.byType)) {
    process.stdout.write(fmtMetricsRow('  type: ' + t, report.byType[t]) + '\n');
  }
  for (const q of Object.keys(report.byQuestion)) {
    process.stdout.write(fmtMetricsRow('  q: ' + q, report.byQuestion[q]) + '\n');
  }
  if (report.errors && report.errors.length) {
    process.stdout.write('\nfirst errors (max 10):\n');
    for (const e of report.errors) {
      process.stdout.write('  ' + e.name + ': expected ' + JSON.stringify(e.expected) + ', got ' + JSON.stringify(e.got) + ' (conf ' + e.confidence + ')\n');
    }
  }
}

/** Load a labeled dataset: [{state, questions, expected}] */
async function loadDataset(flags) {
  if (!flags.file && !flags.f) usageError('this command requires --file (labeled dataset JSON, or @path)');
  const dataset = await util.readJsonInput(flags.file || flags.f, '--file');
  if (!Array.isArray(dataset) || !dataset.length) usageError('dataset must be a non-empty JSON array');
  for (let i = 0; i < dataset.length; i++) {
    const item = dataset[i];
    if (!item.state || !item.questions || !item.expected) {
      usageError('dataset[' + i + '] must have state, questions and expected');
    }
  }
  return dataset;
}

async function cmdEval(flags) {
  const dataset = await loadDataset(flags);
  const provider = drivers.resolveProvider(commonOpts(flags).provider);
  const calibration = flags['no-calibrate'] ? null : util.loadCalibration();
  const askFn = provider.ask;
  const report = await evalLib.runEval(dataset, askFn, { calibration, maxErrors: 10 });
  if (flags.json) out(report);
  else printEvalTable(report, 'eval: ' + dataset.length + ' cases via ' + provider.name + (calibration ? ' (calibrated)' : ' (uncalibrated)'));
}

async function cmdCalibrate(flags) {
  const dataset = await loadDataset(flags);
  const provider = drivers.resolveProvider(commonOpts(flags).provider);

  // 1. Fetch raw answers for every case (they carry probabilities we fit on).
  const withRaw = [];
  for (const item of dataset) {
    const result = await provider.ask(item.state, item.questions, commonOpts(flags));
    withRaw.push(Object.assign({}, item, { raw: result }));
  }

  // 2. Fit temperatures per (type, optionCount) on even indices.
  // Re-scores the stored raw answers (no new model calls): the metric function
  // evaluates the odd-index half both uncalibrated and calibrated so the
  // before/after lines below have real numbers to print.
  const metricOn = async (half, calibration) => {
    const items = half.map((x) => ({ state: x.state, questions: x.questions, expected: x.expected }));
    let i = 0;
    const askStored = async () => half[(i++) % half.length].raw;
    const uncalibrated = await evalLib.runEval(items, askStored, { maxErrors: 0 });
    const calibrated = await evalLib.runEval(items, askStored, { calibration, maxErrors: 0 });
    return { uncalibrated, calibrated };
  };

  const fitted = calibrateLib.fitCalibration(withRaw, metricOn);
  const { calibration } = fitted;
  const report = await Promise.resolve(fitted.report);

  // 3. Persist.
  const outPath = flags.out || flags.o ? flags.out || flags.o : util.calibrationPath();
  calibration.path = outPath;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(calibration, null, 2) + '\n');

  process.stdout.write('calibration saved: ' + outPath + '\n\n');
  const bucketKeys = Object.keys(calibration.buckets);
  if (!bucketKeys.length) {
    process.stdout.write('no bucket had >= 4 usable labeled samples - nothing fitted\n');
    return;
  }
  process.stdout.write('fitted temperatures (T>1 = model was over-confident):\n');
  for (const k of bucketKeys) {
    const b = calibration.buckets[k];
    process.stdout.write('  ' + k.padEnd(14) + ' T=' + b.T.toFixed(4) + '  (n=' + b.n + ')\n');
  }
  if (report) {
    process.stdout.write('\neval half (odd indices), before vs after:\n');
    const before = report.uncalibrated ? report.uncalibrated.overall : null;
    const after = report.calibrated ? report.calibrated.overall : null;
    if (before && after) {
      process.stdout.write('  accuracy ' + before.accuracy + ' -> ' + after.accuracy + '\n');
      process.stdout.write('  brier    ' + before.brier + ' -> ' + after.brier + '\n');
      process.stdout.write('  ece      ' + before.ece + ' -> ' + after.ece + '\n');
    } else {
      process.stdout.write('  (report unavailable - check dataset size)\n');
    }
  }
}

function cmdProviders() {
  const status = drivers.providerStatus();
  process.stdout.write('selected provider: ' + status.selected + '\n\n');
  for (const row of status.rows) {
    const mark = row.available ? '[x]' : '[ ]';
    process.stdout.write(mark + ' ' + row.provider.padEnd(10) + ' ' + row.detail + '\n');
  }
}

function cmdSetup(flags) {
  const engine = flags.engine || flags.e || 'laya';
  if (engine !== 'laya') usageError('setup currently supports only: laya');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20 && !flags['skip-check']) {
    process.stderr.write(
      'error: @receptron/laya requires Node 20+ (current ' + process.version + ').\n' +
        'Install a newer Node side-by-side, or re-run with --skip-check to try anyway.\n'
    );
    process.exit(1);
  }
  process.stdout.write('installing @receptron/laya into ' + SKILL_ROOT + ' (weights ~1.7GB download on first use)\n');
  const res = spawnSync('npm', ['install', '--no-save', '@receptron/laya'], { cwd: SKILL_ROOT, stdio: 'inherit' });
  if (res.error) {
    process.stderr.write('failed to run npm: ' + res.error.message + '\n');
    process.exit(1);
  }
  if (res.status !== 0) process.exit(res.status || 1);
  process.stdout.write('\ndone. try: jev decide --provider laya -s "refund not received" -c "billing,support,sales"\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === 'help' || argv[0] === '--help') {
    process.stdout.write(HELP + '\n');
    return;
  }
  const command = argv[0].startsWith('-') ? null : argv[0];
  const { flags } = util.parseArgs(argv.slice(1));
  switch (command) {
    case 'decide':
    case 'score':
    case 'noul':
      await cmdSingle(command, flags);
      break;
    case 'ask':
      await cmdAsk(flags);
      break;
    case 'eval':
      await cmdEval(flags);
      break;
    case 'calibrate':
      await cmdCalibrate(flags);
      break;
    case 'providers':
      cmdProviders();
      break;
    case 'setup':
      cmdSetup(flags);
      break;
    default:
      usageError('unknown command: ' + String(command));
  }
}

process.on('unhandledRejection', (err) => {
  process.stderr.write('error: ' + (err && err.stack ? err.stack : String(err)) + '\n');
  process.exit(1);
});

main().catch((err) => {
  process.stderr.write('error: ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exit(1);
});
