'use strict';

/**
 * HTTP driver for any Jev-compatible server exposing POST /v1/systemone:
 *  - a self-hosted `laya-serve` instance (set JEV_BASE_URL or --base-url)
 *  - the TypeSafe Jev API (default base when an API key is present)
 *  - the pave-epm Decisions API (POST /v1/decisions; see lib/drivers.js)
 * Request/response shape follows the system_one contract that laya-serve
 * documents as Jev-compatible: { state, questions } -> { answers, usage }.
 *
 * Sandbox-native: inside openpave this module must load without node network
 * builtins (http/https/net/dns are unavailable, and `url` is not shimmed), so
 * http/https are lazy-required inside httpJson and the global `URL` class is
 * used instead of require('url'). When opts.tokenName is set and the host
 * provides globalThis.authenticatedFetch, that transport is used instead of
 * node http — the host injects the token, so no Authorization header is sent.
 */

const { resolveApiKey } = require('./util');

const DEFAULT_TYPESAFE_BASE = 'https://api.typesafe.ai';

function httpJson(method, urlStr, opts) {
  const options = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(new Error('invalid URL: ' + urlStr));
    }
    let http;
    let https;
    try {
      http = require('http');
      https = require('https');
    } catch (e) {
      return reject(
        new Error(
          'network providers are unusable in this environment — use the epm provider or run outside the sandbox'
        )
      );
    }
    const mod = u.protocol === 'https:' ? https : http;
    const payload = options.body === null || options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
    const headers = Object.assign({}, options.headers || {});
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = mod.request(
      u,
      { method, headers, timeout: options.timeoutMs || 30000 },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const snippet = data ? String(data).slice(0, 300) : '';
            return reject(new Error('HTTP ' + res.statusCode + ' from ' + urlStr + (snippet ? ': ' + snippet : '')));
          }
          try {
            resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null });
          } catch (e) {
            reject(new Error('non-JSON response from ' + urlStr + ': ' + String(data).slice(0, 200)));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout after ' + (options.timeoutMs || 30000) + 'ms: ' + urlStr)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function resolveBase(opts) {
  const o = opts || {};
  const base = o.baseUrl || process.env.JEV_BASE_URL || DEFAULT_TYPESAFE_BASE;
  return String(base).replace(/\/+$/, '');
}

/**
 * ask(state, questions, opts) -> { answers, usage, latency_ms, provider, raw }
 * opts: { baseUrl, apiKey, tokenName, timeoutMs, providerName, path, model }
 *
 * When opts.tokenName is set and globalThis.authenticatedFetch exists (the
 * openpave sandbox host), the request goes through authenticatedFetch with no
 * Authorization header — the host injects the declared token. Otherwise it
 * falls back to the node http/https path using opts.apiKey (standalone).
 *
 * When opts.path is set (e.g. '/v1/decisions'), the request goes to that path
 * instead of the default '/v1/systemone'. When opts.model is set, it is
 * included in the request body — required by the EPM Decisions API
 * (pave-epm POST /v1/decisions) but inert for systemone servers.
 */
async function ask(state, questions, opts) {
  const o = opts || {};
  const base = resolveBase(o);
  const timeoutMs = o.timeoutMs || Number(process.env.JEV_HTTP_TIMEOUT || 30000);
  const reqPath = o.path || '/v1/systemone';
  const body = { state, questions };
  if (o.model) body.model = o.model;
  const url = base + reqPath;
  const t0 = Date.now();

  if (o.tokenName && typeof globalThis.authenticatedFetch === 'function') {
    const res = globalThis.authenticatedFetch(o.tokenName, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeout: timeoutMs,
    });
    if (!res.ok) {
      const snippet = res.text ? String(res.text()).slice(0, 300) : '';
      throw new Error('HTTP ' + res.status + ' from ' + url + (snippet ? ': ' + snippet : ''));
    }
    const json = res.json ? res.json() : null;
    const answers = (json && json.answers) || {};
    const usage = (json && json.usage) || { input_tokens: null };
    return { answers, usage, latency_ms: Date.now() - t0, provider: o.providerName || 'http:' + base, raw: json };
  }

  const headers = {};
  const token = o.apiKey || process.env.JEV_API_KEY || resolveApiKey();
  if (token) headers.Authorization = 'Bearer ' + token;

  const res = await httpJson('POST', url, { headers, body, timeoutMs });
  const json = res.json || {};
  const answers = json.answers || {};
  const usage = json.usage || { input_tokens: null };
  const provider = o.providerName || 'http:' + base;
  return { answers, usage, latency_ms: Date.now() - t0, provider, raw: json };
}

module.exports = { ask, httpJson, resolveBase, DEFAULT_TYPESAFE_BASE };
