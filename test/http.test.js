'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const httpDriver = require('../lib/http');

function startFixture(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

function closeFixture(server) {
  return new Promise((resolve) => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => resolve());
  });
}

test('http.ask posts {state, questions} to /v1/systemone with bearer auth', async () => {
  const seen = [];
  const { server, base } = await startFixture((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ answers: { q1: { type: 'choice', choice: 'a', probabilities: { a: 0.6, b: 0.4 }, confidence: 0.6 } }, usage: { input_tokens: 5 } }));
    });
  });
  try {
    const state = { document: 'hello' };
    const questions = { q1: { type: 'choice', criteria: { a: 'x', b: 'y' }, instructions: 'pick' } };
    const result = await httpDriver.ask(state, questions, { baseUrl: base, apiKey: 'secret' });

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].method, 'POST');
    assert.strictEqual(seen[0].url, '/v1/systemone');
    assert.strictEqual(seen[0].auth, 'Bearer secret');
    assert.deepStrictEqual(seen[0].body.state, state);
    assert.deepStrictEqual(seen[0].body.questions, questions);

    assert.strictEqual(result.answers.q1.choice, 'a');
    assert.strictEqual(result.usage.input_tokens, 5);
    assert.ok(Number.isFinite(result.latency_ms));
    assert.strictEqual(result.provider, 'http:' + base, 'default provider name carries the base');
  } finally {
    await closeFixture(server);
  }
});

test('http.ask honors providerName override (typesafe driver reuses it)', async () => {
  const { server, base } = await startFixture((req, res) => {
    res.end(JSON.stringify({ answers: {}, usage: {} }));
  });
  try {
    const result = await httpDriver.ask({}, { q: { type: 'noul' } }, { baseUrl: base, providerName: 'typesafe' });
    assert.strictEqual(result.provider, 'typesafe');
  } finally {
    await closeFixture(server);
  }
});

test('http.ask rejects on HTTP error status with body snippet', async () => {
  const { server, base } = await startFixture((req, res) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'boom' }));
  });
  try {
    await assert.rejects(
      () => httpDriver.ask({}, { q: { type: 'noul' } }, { baseUrl: base }),
      (err) => /HTTP 500/.test(err.message) && /boom/.test(err.message)
    );
  } finally {
    await closeFixture(server);
  }
});

test('http.ask rejects on non-JSON response', async () => {
  const { server, base } = await startFixture((req, res) => {
    res.statusCode = 200;
    res.end('<html>not json</html>');
  });
  try {
    await assert.rejects(() => httpDriver.ask({}, { q: { type: 'noul' } }, { baseUrl: base }), /non-JSON/);
  } finally {
    await closeFixture(server);
  }
});

test('http.ask sends opts.path and opts.model when provided (epm/decisions shape)', async () => {
  const seen = [];
  const state = { document: 'hello' };
  const { server, base } = await startFixture((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ answers: {}, usage: { input_tokens: 0 } }));
    });
  });
  try {
    const result = await httpDriver.ask(state, { q: { type: 'noul' } }, {
      baseUrl: base,
      path: '/v1/decisions',
      model: 'cnrai/laya-english',
      apiKey: 'sk-test',
    });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].method, 'POST');
    assert.strictEqual(seen[0].url, '/v1/decisions', 'path override replaces /v1/systemone');
    assert.strictEqual(seen[0].body.model, 'cnrai/laya-english', 'model field is included in the body');
    assert.deepStrictEqual(seen[0].body.state, state);
    assert.strictEqual(seen[0].auth, 'Bearer sk-test');
    assert.ok(Number.isFinite(result.latency_ms));
  } finally {
    await closeFixture(server);
  }
});

test('http.ask omits model and uses /v1/systemone when opts.path/model are absent (backward compat)', async () => {
  const seen = [];
  const { server, base } = await startFixture((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ answers: {}, usage: {} }));
    });
  });
  try {
    await httpDriver.ask({}, { q: { type: 'noul' } }, { baseUrl: base, apiKey: 'sk-test' });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].url, '/v1/systemone', 'default path is /v1/systemone');
    assert.ok(!('model' in seen[0].body), 'no model field when opts.model is absent');
  } finally {
    await closeFixture(server);
  }
});

test('resolveBase: opts override env, trailing slashes stripped', () => {  const saved = process.env.JEV_BASE_URL;
  try {
    process.env.JEV_BASE_URL = 'http://env.example/';
    assert.strictEqual(httpDriver.resolveBase({}), 'http://env.example');
    assert.strictEqual(httpDriver.resolveBase({ baseUrl: 'http://opt.example///' }), 'http://opt.example');
    delete process.env.JEV_BASE_URL;
    assert.strictEqual(httpDriver.resolveBase({}), httpDriver.DEFAULT_TYPESAFE_BASE);
  } finally {
    if (saved === undefined) delete process.env.JEV_BASE_URL;
    else process.env.JEV_BASE_URL = saved;
  }
});

test('lib/http.js lazy-loads node network builtins (no top-level require)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'http.js'), 'utf8');
  const bad = src.split('\n').filter((line) => /^(const|var|let).*require\('(https?|url)'\)/.test(line));
  assert.deepStrictEqual(bad, [], 'http/https/url must be required inside functions, not at module top level');
});

test('ask uses authenticatedFetch when tokenName is set and the global exists (sandbox-native)', async () => {
  const seen = [];
  const prev = globalThis.authenticatedFetch;
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
    const result = await httpDriver.ask({ document: 'hello' }, { q1: { type: 'noul' } }, {
      baseUrl: 'https://epm.openpave.ai',
      path: '/v1/decisions',
      model: 'cnrai/laya-english',
      tokenName: 'epm',
      providerName: 'epm:https://epm.openpave.ai',
    });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].name, 'epm');
    assert.strictEqual(seen[0].url, 'https://epm.openpave.ai/v1/decisions');
    assert.strictEqual(seen[0].opts.method, 'POST');
    assert.deepStrictEqual(seen[0].opts.headers, { 'content-type': 'application/json' });
    assert.strictEqual(seen[0].opts.headers.Authorization, undefined, 'host injects the token — no Authorization header');
    const body = JSON.parse(seen[0].opts.body);
    assert.strictEqual(body.model, 'cnrai/laya-english');
    assert.deepStrictEqual(body.state, { document: 'hello' });
    assert.deepStrictEqual(body.questions, { q1: { type: 'noul' } });
    assert.strictEqual(result.answers.q1.noul, 0.9, 'answers come from res.json()');
    assert.strictEqual(result.usage.input_tokens, 5, 'usage comes from res.json()');
    assert.strictEqual(result.provider, 'epm:https://epm.openpave.ai');
  } finally {
    if (prev === undefined) delete globalThis.authenticatedFetch;
    else globalThis.authenticatedFetch = prev;
  }
});

test('ask maps non-ok authenticatedFetch status to the node error shape', async () => {
  const prev = globalThis.authenticatedFetch;
  try {
    globalThis.authenticatedFetch = function () {
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: { get: function () { return null; } },
        text: function () { return JSON.stringify({ error: 'boom' }); },
        json: function () { return { error: 'boom' }; },
      };
    };
    await assert.rejects(
      () => httpDriver.ask({}, { q: { type: 'noul' } }, { baseUrl: 'https://epm.openpave.ai', path: '/v1/decisions', tokenName: 'epm' }),
      (err) => /HTTP 500/.test(err.message) && /boom/.test(err.message)
    );
  } finally {
    if (prev === undefined) delete globalThis.authenticatedFetch;
    else globalThis.authenticatedFetch = prev;
  }
});

test('ask throws a clear error when node http is unavailable (sandbox without authenticatedFetch)', async () => {
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'http' || request === 'https') {
      throw new Error('Network module not available in sandbox. Use fetch() instead.');
    }
    return origLoad.apply(this, arguments);
  };
  try {
    await assert.rejects(
      () => httpDriver.ask({}, { q: { type: 'noul' } }, { baseUrl: 'http://127.0.0.1:1' }),
      /network providers are unusable/
    );
  } finally {
    Module._load = origLoad;
  }
});
