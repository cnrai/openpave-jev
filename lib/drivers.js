'use strict';

/**
 * Driver registry + auto-selection.
 *
 * Priority when --provider / JEV_PROVIDER is not set:
 *   1. JEV_BASE_URL set           -> http (self-hosted laya-serve or any
 *                                    Jev-compatible /v1/systemone server)
 *   2. JEV_API_KEY / tokens.yaml  -> http against the TypeSafe Jev API
 *   3. Laya engine installed      -> laya (local ONNX)
 *   4. nothing                    -> hard error with setup guidance
 *   (JEV_MOCK=1 forces mock, for tests and demos)
 */

const fs = require('fs');
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

function layaInstalled() {
  return layaDriver.isInstalled();
}

function httpAsk(providerName) {
  return function (state, questions, opts) {
    return httpDriver.ask(state, questions, Object.assign({ providerName }, opts || {}));
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
  if (name !== 'auto') {
    throw new Error('unknown provider "' + name + '" (expected mock|laya|http|typesafe)');
  }
  if (process.env.JEV_MOCK === '1') return { name: 'mock', ask: mock.ask, note: 'forced by JEV_MOCK=1' };
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
  ];
  let selected = null;
  try {
    selected = resolveProvider(null).name;
  } catch (e) {
    selected = 'none (' + String(e.message).split('\n')[0] + ')';
  }
  return { selected, rows };
}

module.exports = { resolveProvider, providerStatus, hasToken, hasBaseUrl, layaInstalled };
