'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SKILL_MD = path.join(ROOT, 'SKILL.md');
const SKILL_YAML = path.join(ROOT, 'skill.yaml');

/**
 * Extract the YAML front-matter block of a markdown file with a regex.
 * Repo policy is zero dependencies (no js-yaml), so the block is returned
 * raw and callers match individual keys with anchored line regexes.
 */
function frontMatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, 'SKILL.md must open with a --- delimited front-matter block');
  return m[1];
}

test('SKILL.md exists at the repo root', () => {
  assert.ok(fs.existsSync(SKILL_MD), 'SKILL.md must exist at the repo root');
  fs.accessSync(SKILL_MD, fs.constants.R_OK);
});

test('front matter has name: jev and a non-empty description', () => {
  const fm = frontMatter(SKILL_MD);
  assert.match(fm, /^name:\s*jev\s*$/m, 'front matter must declare name: jev');
  const desc = fm.match(/^description:\s*(.+)$/m);
  assert.ok(desc, 'front matter must contain a description key');
  assert.ok(desc[1].trim().length > 0, 'description must be non-empty');
});

test('description is non-vacuous (mentions real jev capabilities)', () => {
  const fm = frontMatter(SKILL_MD);
  const desc = fm.match(/^description:\s*(.+)$/m);
  assert.ok(desc, 'front matter must contain a description key');
  assert.match(
    desc[1],
    /classif|route|score|probabilit|calibrat/i,
    'description must mention classify/route/score/probability/calibrate work'
  );
});

test('smoke: node index.js noul -s smoke -p mock exits 0 with a numeric answer.noul', () => {
  // Isolate from ambient JEV_* config (JEV_MOCK/JEV_BASE_URL/...) like test/cli.test.js.
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (!k.startsWith('JEV_')) env[k] = process.env[k];
  }
  env.JEV_HOME = path.join(os.tmpdir(), 'jev-skill-md-test-' + process.pid);
  const r = spawnSync(process.execPath, ['index.js', 'noul', '-s', 'smoke', '-p', 'mock'], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    timeout: 60000,
  });
  assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed && typeof parsed === 'object', 'stdout must parse as a JSON object');
  assert.ok(parsed.answer && typeof parsed.answer === 'object', 'envelope must carry answer');
  assert.strictEqual(typeof parsed.answer.noul, 'number', 'answer.noul must be a number');
});

test('skill.yaml declares version 0.2.0', () => {
  const yaml = fs.readFileSync(SKILL_YAML, 'utf8');
  assert.match(yaml, /^version:\s*0\.2\.0\s*$/m, 'skill.yaml version must be 0.2.0');
});
