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

test('resolveBase: opts override env, trailing slashes stripped', () => {
  const saved = process.env.JEV_BASE_URL;
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
