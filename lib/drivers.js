'use strict';

/**
 * Driver registry + auto-selection.
 *
 * Priority when --provider / JEV_PROVIDER is not set:
 *   1. JEV_EPM_URL or PAVE_EPM_URL set -> epm (pave-epm Decisions API; uses the
 *                                      user's existing EPM JWT from
 *                                      PAVE_EPM_TOKEN_FILE — no separate key)
 *   2. JEV_BASE_URL set           -> http (self-hosted laya-serve or any
 *                                    Jev-compatible /v1/systemone server)
 *   3. JEV_API_KEY / tokens.yaml  -> http against the TypeSafe Jev API
 *   4. Laya engine installed      -> laya (local ONNX)
 *   5. nothing                    -> hard error with setup guidance
 *   (JEV_MOCK=1 forces mock, for tests and demos)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const mock = require('./mock');
const httpDriver = require('./http');
const layaDriver = require('./laya');
const { resolveApiKey } = require('./util');

const SKILL_ROOT = path.join(__dirname, '..');

function hasToken() {
  return Boolean(process.env.JEV_API_KEY || resolveApiKey());
}

function hasBaseUrl() {
  return Boolean(process.env.JEV_BASE_URL);
}

function hasEpmUrl() {
  return Boolean(process.env.JEV_EPM_URL || process.env.PAVE_EPM_URL);
}

/** Read the EPM JWT, mirroring the pave server's own resolution order:
 *  PAVE_EPM_JWT (direct) → PAVE_EPM_TOKEN_FILE (sidecar path) →
 *  JEV_API_KEY / tokens.yaml (standalone) → ~/.pave/epm-token (the file the
 *  sidecar writes on login; the pave server falls back to it when
 *  PAVE_EPM_TOKEN_FILE is unset, and so do we). */
function readEpmToken() {
  if (process.env.PAVE_EPM_JWT) return process.env.PAVE_EPM_JWT;
  if (process.env.PAVE_EPM_TOKEN_FILE) {
    try {
      return fs.readFileSync(process.env.PAVE_EPM_TOKEN_FILE, 'utf8').trim();
    } catch (e) {
      return null;
    }
  }
  const explicit = process.env.JEV_API_KEY || resolveApiKey();
  if (explicit) return explicit;
  try {
    return fs.readFileSync(path.join(os.homedir(), '.pave', 'epm-token'), 'utf8').trim();
  } catch (e) {
    return null;
  }
}

function layaInstalled() {
  return layaDriver.isInstalled();
}

function httpAsk(providerName) {
  return function (state, questions, opts) {
    return httpDriver.ask(state, questions, Object.assign({ providerName }, opts || {}));
  };
}

function epmAsk() {
  return function (state, questions, opts) {
    var base = process.env.JEV_EPM_URL || process.env.PAVE_EPM_URL;
    if (!base) throw new Error('JEV_EPM_URL (or PAVE_EPM_URL) must be set for the epm provider');
    // The sidecar sets PAVE_EPM_URL to the *chat* gateway base, which ends in
    // /pave/v1 (or /v1); the Decisions API lives at <root>/v1/decisions.
    // Strip the suffix so both shapes resolve to the same URL.
    base = base.replace(/\/+$/, '').replace(/\/(pave\/)?v1$/, '');
    var model = (opts && opts.model) || process.env.JEV_MODEL || 'cnrai/laya-english';
    var token = readEpmToken();
    return httpDriver.ask(state, questions, Object.assign({}, opts || {}, {
      providerName: 'epm:' + base,
      baseUrl: base,
      path: '/v1/decisions',
      model: model,
      apiKey: token,
    }));
  };
}

/**
 * Resolve the provider to use.
 * Returns { name, ask, note? }; throws on an unresolvable auto selection.
 */
function resolveProvider(flag) {
  const name = flag || process.env.JEV_PROVIDER || 'auto';
  if (name === 'mock') return { name: 'mock', ask: mock.ask };
  if (name === 'laya') return { name: 'laya', ask: layaDriver.ask };
  if (name === 'http' || name === 'typesafe') return { name, ask: httpAsk(name) };
  if (name === 'epm') return { name: 'epm', ask: epmAsk(), note: 'JEV_EPM_URL=' + (process.env.JEV_EPM_URL || '') };
  if (name !== 'auto') {
    throw new Error('unknown provider "' + name + '" (expected mock|laya|http|typesafe|epm)');
  }
  if (process.env.JEV_MOCK === '1') return { name: 'mock', ask: mock.ask, note: 'forced by JEV_MOCK=1' };
  if (hasEpmUrl()) {
    var empNote = 'JEV_EPM_URL=' + (process.env.JEV_EPM_URL || process.env.PAVE_EPM_URL || '');
    return { name: 'epm', ask: epmAsk(), note: empNote };
  }
  if (hasBaseUrl()) {
    return { name: 'http', ask: httpAsk('http'), note: 'JEV_BASE_URL=' + process.env.JEV_BASE_URL };
  }
  if (hasToken()) {
    return { name: 'typesafe', ask: httpAsk('typesafe'), note: 'JEV_API_KEY present; base ' + httpDriver.resolveBase({}) };
  }
  if (layaInstalled()) {
    return { name: 'laya', ask: layaDriver.ask, note: 'local engine installed' };
  }
  throw new Error(
    'no decision provider configured. Either:\n' +
      '  jev setup laya            # local open-weights engine (free, Apache-2.0)\n' +
      '  PAVE_EPM_URL + PAVE_EPM_TOKEN_FILE  # pave-studio/openpave login (the EPM JWT\n' +
      '                                  # from the sidecar — no separate key needed;\n' +
      '                                  # falls back to ~/.pave/epm-token)\n' +
      '  export JEV_BASE_URL=...   # self-hosted laya-serve or Jev-compatible server\n' +
      '  export JEV_API_KEY=...    # TypeSafe Jev API (paid, closed)\n' +
      'or pass --provider mock for a deterministic fake.'
  );
}

/** Status of every provider, for `jev providers`. */
function providerStatus() {
  const rows = [
    {
      provider: 'mock',
      available: true,
      detail: 'deterministic fake - tests and demos (--provider mock or JEV_MOCK=1)',
    },
    {
      provider: 'laya',
      available: layaInstalled(),
      detail: layaInstalled()
        ? 'engine installed at node_modules/@receptron/laya (Node ' + process.versions.node + ')'
        : 'not installed - run: jev setup laya (npm install), or: node <install-path>/index.js setup laya (clone)',
    },
    {
      provider: 'http',
      available: hasBaseUrl(),
      detail: hasBaseUrl() ? 'JEV_BASE_URL=' + process.env.JEV_BASE_URL : 'set JEV_BASE_URL to a /v1/systemone server (e.g. laya-serve)',
    },
    {
      provider: 'typesafe',
      available: hasToken(),
      detail: hasToken() ? 'JEV_API_KEY present; base ' + httpDriver.resolveBase({}) : 'set JEV_API_KEY (or ~/.pave/tokens.yaml JEV_API_KEY)',
    },
    {
      provider: 'epm',
      available: hasEpmUrl(),
      detail: hasEpmUrl()
        ? (process.env.JEV_EPM_URL || process.env.PAVE_EPM_URL) + (process.env.JEV_MODEL ? ' (model: ' + process.env.JEV_MODEL + ')' : '') +
            (process.env.PAVE_EPM_TOKEN_FILE ? ' (auth: PAVE_EPM_TOKEN_FILE)' : ' (auth: PAVE_EPM_JWT / JEV_API_KEY / ~/.pave/epm-token)')
        : 'set JEV_EPM_URL or PAVE_EPM_URL (the sidecar sets it; auth: PAVE_EPM_TOKEN_FILE or ~/.pave/epm-token)',
    },
  ];
  let selected = null;
  try {
    selected = resolveProvider(null).name;
  } catch (e) {
    selected = 'none (' + String(e.message).split('\n')[0] + ')';
  }
  return { selected, rows };
}

module.exports = { resolveProvider, providerStatus, hasToken, hasBaseUrl, hasEpmUrl, layaInstalled };
