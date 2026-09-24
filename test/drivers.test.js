'use strict';

const test = require('node:test');
const assert = require('node:assert');
const drivers = require('../lib/drivers');

const ENV_KEYS = ['JEV_MOCK', 'JEV_PROVIDER', 'JEV_BASE_URL', 'JEV_API_KEY'];

/** Run fn with a controlled JEV_* environment; restores everything after. */
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const k of Object.keys(overrides)) process.env[k] = overrides[k];
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('resolveProvider: explicit name wins over the environment', () => {
  withEnv({ JEV_PROVIDER: 'laya' }, () => {
    assert.strictEqual(drivers.resolveProvider('mock').name, 'mock');
    assert.strictEqual(drivers.resolveProvider('typesafe').name, 'typesafe');
    assert.strictEqual(drivers.resolveProvider('http').name, 'http');
    assert.strictEqual(drivers.resolveProvider('laya').name, 'laya');
  });
});

test('resolveProvider: JEV_MOCK=1 forces mock from auto', () => {
  withEnv({ JEV_MOCK: '1', JEV_BASE_URL: 'http://x.example' }, () => {
    const p = drivers.resolveProvider(null);
    assert.strictEqual(p.name, 'mock');
    assert.ok(/JEV_MOCK/.test(p.note));
  });
});

test('resolveProvider: auto prefers JEV_BASE_URL over a token (self-host before paid API)', () => {
  withEnv({ JEV_BASE_URL: 'http://127.0.0.1:8000', JEV_API_KEY: 'k' }, () => {
    const p = drivers.resolveProvider(null);
    assert.strictEqual(p.name, 'http');
    assert.ok(/JEV_BASE_URL/.test(p.note));
  });
});

test('resolveProvider: explicit JEV_PROVIDER env is honored', () => {
  withEnv({ JEV_PROVIDER: 'mock' }, () => {
    assert.strictEqual(drivers.resolveProvider(null).name, 'mock');
  });
});

test('resolveProvider: unknown provider throws with the legal set', () => {
  withEnv({}, () => {
    assert.throws(() => drivers.resolveProvider('nope'), /unknown provider "nope" \(expected mock\|laya\|http\|typesafe\)/);
  });
});

test('providerStatus: rows list all four providers and select without throwing', () => {
  withEnv({ JEV_MOCK: '1' }, () => {
    const status = drivers.providerStatus();
    assert.strictEqual(status.selected, 'mock');
    const names = status.rows.map((r) => r.provider).sort();
    assert.deepStrictEqual(names, ['http', 'laya', 'mock', 'typesafe']);
    assert.ok(status.rows.every((r) => typeof r.available === 'boolean' && typeof r.detail === 'string'));
  });
});

test('providerStatus: not-installed laya detail gives both PATH and clone command forms (#2)', () => {
  withEnv({}, () => {
    const status = drivers.providerStatus();
    const laya = status.rows.find((r) => r.provider === 'laya');
    if (laya.available) return; // engine installed on this machine; detail is the installed form
    assert.match(laya.detail, /jev setup laya/, 'PATH/npm install form');
    assert.match(laya.detail, /index\.js setup laya/, 'clone install form');
  });
});
