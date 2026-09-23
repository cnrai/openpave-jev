'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INDEX = path.join(__dirname, '..', 'index.js');

/** Spawn `node index.js ...` with an isolated JEV_HOME and no ambient JEV_* env. */
function jev(args, extraEnv) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (!k.startsWith('JEV_')) env[k] = process.env[k];
  }
  env.JEV_HOME = path.join(os.tmpdir(), 'jev-cli-test-' + process.pid);
  Object.assign(env, extraEnv || {});
  return spawnSync(process.execPath, [INDEX].concat(args), { encoding: 'utf8', env, timeout: 60000 });
}

test('decide --provider mock -q prints exactly one of the options, exit 0', () => {
  const r = jev(['decide', '--provider', 'mock', '-s', 'hello world', '-c', 'a,b,c', '-q']);
  assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  const line = r.stdout.trim();
  assert.ok(line === 'a' || line === 'b' || line === 'c', 'got: ' + JSON.stringify(line));
});

test('decide without -q prints a JSON envelope with the answer', () => {
  const r = jev(['decide', '--provider', 'mock', '-s', 'hello', '-c', 'a,b', '--no-calibrate']);
  assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.provider, 'mock');
  assert.ok(parsed.answer && (parsed.answer.choice === 'a' || parsed.answer.choice === 'b'));
  assert.ok(parsed.answer.probabilities.a + parsed.answer.probabilities.b > 0.99);
});

test('noul --min-confidence above any mock confidence exits 3 with gate JSON', () => {
  const r = jev(['noul', '--provider', 'mock', '-s', 'x', '-i', 'is it?', '--min-confidence', '0.99']);
  assert.strictEqual(r.status, 3);
  assert.ok(/confidence gate/.test(r.stderr), r.stderr);
  const gate = JSON.parse(r.stderr.trim());
  assert.strictEqual(gate.min, 0.99);
  assert.ok(gate.confidence < 0.99);
});

test('unknown command exits 2 (usage)', () => {
  const r = jev(['frobnicate']);
  assert.strictEqual(r.status, 2);
  assert.ok(/unknown command/.test(r.stderr));
});

test('providers exits 0 and lists every driver', () => {
  const r = jev(['providers']);
  assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  assert.ok(/selected provider/.test(r.stdout));
  for (const name of ['mock', 'laya', 'http', 'typesafe']) {
    assert.ok(r.stdout.indexOf(name) !== -1, 'missing row: ' + name);
  }
});

test('setup with an unsupported engine exits 2', () => {
  const r = jev(['setup', '--engine', 'bogus']);
  assert.strictEqual(r.status, 2);
  assert.ok(/setup currently supports only/.test(r.stderr));
});

test('help (no args) exits 0 with the usage banner', () => {
  const r = jev([]);
  assert.strictEqual(r.status, 0);
  assert.ok(/jev - typed decisions/.test(r.stdout));
});

/** 12 mock-decided choice cases with rotating labels: enough for the choice:3 bucket. */
function sampleDataset() {
  const dataset = [];
  const labels = ['a', 'b', 'c'];
  for (let i = 0; i < 12; i++) {
    dataset.push({
      state: { document: 'case ' + i },
      questions: { pick: { type: 'choice', criteria: { a: 'x', b: 'y', c: 'z' }, instructions: 'pick one' } },
      expected: { pick: labels[i % 3] },
    });
  }
  return dataset;
}

test('calibrate saves a bucketed temperature file under JEV_HOME; eval then reports calibrated', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cal-'));
  try {
    const dsPath = path.join(tmp, 'ds.json');
    fs.writeFileSync(dsPath, JSON.stringify(sampleDataset()));

    const cal = jev(['calibrate', '--provider', 'mock', '--file', dsPath], { JEV_HOME: tmp });
    assert.strictEqual(cal.status, 0, 'stderr: ' + cal.stderr);
    assert.ok(/calibration saved/.test(cal.stdout));

    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'calibration.json'), 'utf8'));
    assert.strictEqual(saved.version, 1);
    const bucket = saved.buckets['choice:3'];
    assert.ok(bucket, 'choice:3 bucket present: ' + Object.keys(saved.buckets));
    assert.ok(typeof bucket.T === 'number' && bucket.T > 0);
    assert.ok(bucket.n >= 4);

    const ev = jev(['eval', '--provider', 'mock', '--file', dsPath], { JEV_HOME: tmp });
    assert.strictEqual(ev.status, 0, 'stderr: ' + ev.stderr);
    assert.ok(/\(calibrated\)/.test(ev.stdout), 'should mark the run calibrated');

    const raw = jev(['eval', '--provider', 'mock', '--file', dsPath, '--no-calibrate'], { JEV_HOME: tmp });
    assert.strictEqual(raw.status, 0, 'stderr: ' + raw.stderr);
    assert.ok(/\(uncalibrated\)/.test(raw.stdout));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
