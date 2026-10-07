'use strict';

const test = require('node:test');
const assert = require('node:assert');
const drivers = require('../lib/drivers');

const ENV_KEYS = ['JEV_MOCK', 'JEV_PROVIDER', 'JEV_BASE_URL', 'JEV_API_KEY', 'JEV_EPM_URL', 'JEV_MODEL', 'PAVE_EPM_URL', 'PAVE_EPM_TOKEN_FILE', 'PAVE_EPM_JWT'];

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
    assert.strictEqual(drivers.resolveProvider('epm').name, 'epm');
  });
});

test('resolveProvider: JEV_MOCK=1 forces mock from auto', () => {
  withEnv({ JEV_MOCK: '1', JEV_BASE_URL: 'http://x.example' }, () => {
    const p = drivers.resolveProvider(null);
    assert.strictEqual(p.name, 'mock');
    assert.ok(/JEV_MOCK/.test(p.note));
  });
});

test('resolveProvider: auto prefers JEV_EPM_URL over JEV_BASE_URL (epm gateway first)', () => {
  withEnv({ JEV_EPM_URL: 'http://epm.example.com', JEV_BASE_URL: 'http://127.0.0.1:8000' }, () => {
    const p = drivers.resolveProvider(null);
    assert.strictEqual(p.name, 'epm');
    assert.ok(/JEV_EPM_URL/.test(p.note));
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
    assert.throws(() => drivers.resolveProvider('nope'), /unknown provider "nope" \(expected mock\|laya\|http\|typesafe\|epm\)/);
  });
});

test('providerStatus: rows list all five providers and select without throwing', () => {
  withEnv({ JEV_MOCK: '1' }, () => {
    const status = drivers.providerStatus();
    assert.strictEqual(status.selected, 'mock');
    const names = status.rows.map((r) => r.provider).sort();
    assert.deepStrictEqual(names, ['epm', 'http', 'laya', 'mock', 'typesafe']);
    assert.ok(status.rows.every((r) => typeof r.available === 'boolean' && typeof r.detail === 'string'));
  });
});

test('epm provider: epmAsk sends {model, state, questions} to /v1/decisions with the EPM JWT from PAVE_EPM_TOKEN_FILE', async () => {
  const http = require('http');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const seen = [];
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ answers: { q1: { type: 'noul', noul: 0.9, confidence: 0.9 } }, usage: { input_tokens: 5 } }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  // Write a fake JWT to a temp file — simulates PAVE_EPM_TOKEN_FILE
  const tokenFile = path.join(os.tmpdir(), 'jev-test-token-' + Date.now() + '.txt');
  fs.writeFileSync(tokenFile, 'jwt-token-from-sidecar');
  const savedEpm = process.env.JEV_EPM_URL;
  const savedPave = process.env.PAVE_EPM_URL;
  const savedToken = process.env.PAVE_EPM_TOKEN_FILE;
  try {
    process.env.JEV_EPM_URL = base;
    process.env.PAVE_EPM_TOKEN_FILE = tokenFile;
    const provider = drivers.resolveProvider(null);
    assert.strictEqual(provider.name, 'epm');
    const result = await provider.ask({ text: 'hello' }, { q1: { type: 'noul' } }, {});
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].method, 'POST');
    assert.strictEqual(seen[0].url, '/v1/decisions', 'epm provider posts to /v1/decisions');
    assert.strictEqual(seen[0].auth, 'Bearer jwt-token-from-sidecar', 'epm provider reads the JWT from PAVE_EPM_TOKEN_FILE');
    assert.strictEqual(seen[0].body.model, 'cnrai/laya-english', 'default model is cnrai/laya-english');
    assert.strictEqual(result.provider, 'epm:' + base);
  } finally {
    if (savedEpm === undefined) delete process.env.JEV_EPM_URL; else process.env.JEV_EPM_URL = savedEpm;
    if (savedPave === undefined) delete process.env.PAVE_EPM_URL; else process.env.PAVE_EPM_URL = savedPave;
    if (savedToken === undefined) delete process.env.PAVE_EPM_TOKEN_FILE; else process.env.PAVE_EPM_TOKEN_FILE = savedToken;
    fs.unlinkSync(tokenFile);
    await new Promise((resolve) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => resolve()); });
  }
});

test('epm provider: falls back to JEV_API_KEY when PAVE_EPM_TOKEN_FILE is not set (standalone use)', async () => {
  const http = require('http');
  const seen = [];
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ answers: { q1: { type: 'noul', noul: 0.9, confidence: 0.9 } }, usage: { input_tokens: 5 } }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const savedEpm = process.env.JEV_EPM_URL;
  const savedKey = process.env.JEV_API_KEY;
  const savedToken = process.env.PAVE_EPM_TOKEN_FILE;
  try {
    process.env.JEV_EPM_URL = base;
    process.env.JEV_API_KEY = 'sk-pave-fallback';
    delete process.env.PAVE_EPM_TOKEN_FILE;
    const provider = drivers.resolveProvider(null);
    assert.strictEqual(provider.name, 'epm');
    await provider.ask({ text: 'hello' }, { q1: { type: 'noul' } }, {});
    assert.strictEqual(seen[0].auth, 'Bearer sk-pave-fallback', 'falls back to JEV_API_KEY when PAVE_EPM_TOKEN_FILE is not set');
  } finally {
    if (savedEpm === undefined) delete process.env.JEV_EPM_URL; else process.env.JEV_EPM_URL = savedEpm;
    if (savedKey === undefined) delete process.env.JEV_API_KEY; else process.env.JEV_API_KEY = savedKey;
    if (savedToken === undefined) delete process.env.PAVE_EPM_TOKEN_FILE; else process.env.PAVE_EPM_TOKEN_FILE = savedToken;
    await new Promise((resolve) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => resolve()); });
  }
});

test('epm provider: strips the sidecar /pave/v1 (or /v1) suffix from the base URL', async () => {
  const http = require('http');
  const seen = [];
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body: JSON.parse(body) });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ answers: { q1: { type: 'noul', noul: 0.9, confidence: 0.9 } }, usage: { input_tokens: 5 } }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const root = 'http://127.0.0.1:' + server.address().port;
  const savedKey = process.env.JEV_API_KEY;
  const savedJwt = process.env.PAVE_EPM_JWT;
  try {
    process.env.JEV_API_KEY = 'sk-pave-fallback';
    delete process.env.PAVE_EPM_JWT;
    for (const base of [root + '/pave/v1', root + '/pave/v1/', root + '/v1', root]) {
      seen.length = 0;
      process.env.PAVE_EPM_URL = base;
      delete process.env.JEV_EPM_URL;
      delete process.env.JEV_MOCK;
      delete process.env.PAVE_EPM_TOKEN_FILE;
      const provider = drivers.resolveProvider(null);
      assert.strictEqual(provider.name, 'epm');
      await provider.ask({ text: 'hello' }, { q1: { type: 'noul' } }, {});
      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0].url, '/v1/decisions', 'base "' + base + '" must resolve to <root>/v1/decisions, not ' + seen[0].url);
      delete process.env.PAVE_EPM_URL;
    }
  } finally {
    delete process.env.PAVE_EPM_URL;
    if (savedKey === undefined) delete process.env.JEV_API_KEY; else process.env.JEV_API_KEY = savedKey;
    if (savedJwt === undefined) delete process.env.PAVE_EPM_JWT; else process.env.PAVE_EPM_JWT = savedJwt;
    await new Promise((resolve) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => resolve()); });
  }
});

test('epm provider: falls back to ~/.pave/epm-token when no token env is set (mirrors the pave server)', async () => {
  const http = require('http');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const seen = [];
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ answers: { q1: { type: 'noul', noul: 0.9, confidence: 0.9 } }, usage: { input_tokens: 5 } }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-home-'));
  fs.mkdirSync(path.join(fakeHome, '.pave'));
  fs.writeFileSync(path.join(fakeHome, '.pave', 'epm-token'), 'jwt-from-home-dir');
  const saved = {};
  for (const k of ['JEV_EPM_URL', 'JEV_API_KEY', 'PAVE_EPM_URL', 'PAVE_EPM_TOKEN_FILE', 'PAVE_EPM_JWT', 'HOME']) saved[k] = process.env[k];
  try {
    process.env.JEV_EPM_URL = base;
    process.env.HOME = fakeHome;
    delete process.env.JEV_API_KEY;
    delete process.env.PAVE_EPM_TOKEN_FILE;
    delete process.env.PAVE_EPM_JWT;
    const provider = drivers.resolveProvider(null);
    assert.strictEqual(provider.name, 'epm');
    await provider.ask({ text: 'hello' }, { q1: { type: 'noul' } }, {});
    assert.strictEqual(seen[0].auth, 'Bearer jwt-from-home-dir', 'falls back to ~/.pave/epm-token like the pave server does');
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    fs.rmSync(fakeHome, { recursive: true, force: true });
    await new Promise((resolve) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => resolve()); });
  }
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

test('epm provider: sandbox-native via authenticatedFetch("epm", ...) with no Authorization header', async () => {
  const seen = [];
  const prevFetch = globalThis.authenticatedFetch;
  const saved = {};
  for (const k of ['JEV_EPM_URL', 'PAVE_EPM_URL', 'PAVE_EPM_TOKEN_FILE', 'PAVE_EPM_JWT', 'JEV_API_KEY', 'JEV_MODEL']) saved[k] = process.env[k];
  try {
    globalThis.authenticatedFetch = function (name, url, opts) {
      seen.push({ name, url, opts });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: function () { return null; } },
        text: function () { return 'not the json'; },
        json: function () {
          return { answers: { q1: { type: 'noul', noul: 0.9, confidence: 0.9 } }, usage: { input_tokens: 5 } };
        },
      };
    };
    process.env.PAVE_EPM_URL = 'https://epm.openpave.ai/pave/v1';
    delete process.env.JEV_EPM_URL;
    delete process.env.PAVE_EPM_TOKEN_FILE;
    delete process.env.PAVE_EPM_JWT;
    delete process.env.JEV_API_KEY;
    delete process.env.JEV_MODEL;
    const provider = drivers.resolveProvider(null);
    assert.strictEqual(provider.name, 'epm');
    const result = await provider.ask({ text: 'hello' }, { q1: { type: 'noul' } }, {});
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].name, 'epm');
    assert.strictEqual(seen[0].url, 'https://epm.openpave.ai/v1/decisions', 'sidecar /pave/v1 suffix stripped');
    assert.strictEqual(seen[0].opts.method, 'POST');
    assert.deepStrictEqual(seen[0].opts.headers, { 'content-type': 'application/json' });
    assert.strictEqual(seen[0].opts.headers.Authorization, undefined, 'host injects the token — no Authorization header');
    const body = JSON.parse(seen[0].opts.body);
    assert.strictEqual(body.model, 'cnrai/laya-english');
    assert.deepStrictEqual(body.state, { text: 'hello' });
    assert.deepStrictEqual(body.questions, { q1: { type: 'noul' } });
    assert.strictEqual(result.answers.q1.noul, 0.9, 'answers come from res.json()');
    assert.strictEqual(result.usage.input_tokens, 5, 'usage comes from res.json()');
    assert.strictEqual(result.provider, 'epm:https://epm.openpave.ai');
  } finally {
    if (prevFetch === undefined) delete globalThis.authenticatedFetch;
    else globalThis.authenticatedFetch = prevFetch;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
