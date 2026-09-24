'use strict';

/**
 * Laya driver - runs the open-weight Jev-compatible decision model locally
 * via @receptron/laya (ONNX Runtime; no Python needed).
 *
 * NOT a package.json dependency on purpose: the engine is installed on
 * demand with `jev setup laya` (it pulls onnxruntime-node plus ~1.7GB of
 * weights on first use) so the skill core stays zero-dependency.
 *
 * Requires Node 20+ at runtime (the engine package's own requirement).
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SKILL_ROOT = path.join(__dirname, '..');

// checkpoint name -> subfolder inside the HF repo (null = repo root)
const CHECKPOINTS = {
  english: null,
  multilingual: 'multilingual',
  'typed-decisions': 'typed-decisions',
};

function engineDir() {
  return path.join(SKILL_ROOT, 'node_modules', '@receptron', 'laya');
}

function isInstalled() {
  try {
    fs.accessSync(path.join(engineDir(), 'package.json'));
    return true;
  } catch (e) {
    return false;
  }
}

/** Load the engine package: require() first, dynamic import() for ESM-only. */
async function loadEngine() {
  const dir = engineDir();
  if (!isInstalled()) {
    throw new Error(
      'Laya engine not installed. Run: jev setup laya (npm install), or: node <install-path>/index.js setup laya (clone)  ' +
        '(installs @receptron/laya; weights ~1.7GB download from Hugging Face on first use, cached in ~/.cache/receptron-laya or LAYA_CACHE)'
    );
  }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20 && !process.env.JEV_LAYA_SKIP_NODE_CHECK) {
    throw new Error('@receptron/laya requires Node 20+ (current: ' + process.version + ')');
  }
  try {
    return require(dir);
  } catch (e) {
    // ESM-only package: resolve its entry and import it by file URL.
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    let entry = pkg.main || 'index.js';
    if (pkg.exports && pkg.exports['.'] && typeof pkg.exports['.'] === 'object') {
      entry = pkg.exports['.'].require || pkg.exports['.'].default || entry;
    }
    const entryPath = path.resolve(dir, entry);
    return await import(pathToFileURL(entryPath).href);
  }
}

function resolveCheckpoint(opts) {
  const o = opts || {};
  const ck = o.checkpoint || process.env.JEV_LAYA_CHECKPOINT || 'english';
  if (!(ck in CHECKPOINTS)) {
    throw new Error('unknown checkpoint "' + ck + '" (expected english|multilingual|typed-decisions)');
  }
  return ck;
}

/**
 * ask(state, questions, opts) -> { answers, usage, latency_ms, provider }
 * opts: { checkpoint, modelDir, cacheDir }
 */
async function ask(state, questions, opts) {
  const o = opts || {};
  const ck = resolveCheckpoint(o);
  const mod = await loadEngine();
  const Laya = mod.Laya || (mod.default && mod.default.Laya);
  if (!Laya || typeof Laya.load !== 'function') {
    throw new Error('@receptron/laya did not export a Laya object with load()');
  }
  const loadOpts = {};
  const subfolder = CHECKPOINTS[ck];
  if (subfolder) loadOpts.subfolder = subfolder;
  if (o.modelDir || process.env.JEV_LAYA_MODEL_DIR) loadOpts.modelDir = o.modelDir || process.env.JEV_LAYA_MODEL_DIR;
  if (o.cacheDir || process.env.LAYA_CACHE) loadOpts.cacheDir = o.cacheDir || process.env.LAYA_CACHE;

  const t0 = Date.now();
  const inst = await Laya.load(loadOpts);
  let result;
  try {
    result = await inst.systemOne(state, questions);
  } finally {
    try {
      if (typeof inst.close === 'function') await inst.close();
    } catch (e) {
      /* best effort */
    }
  }
  const answers = (result && result.answers) || {};
  const usage = (result && result.usage) || {};
  return { answers, usage, latency_ms: Date.now() - t0, provider: 'laya:' + ck };
}

module.exports = { ask, isInstalled, CHECKPOINTS };
