'use strict';

/**
 * HTTP driver for any Jev-compatible server exposing POST /v1/systemone:
 *  - a self-hosted `laya-serve` instance (set JEV_BASE_URL or --base-url)
 *  - the TypeSafe Jev API (default base when an API key is present)
 * Request/response shape follows the system_one contract that laya-serve
 * documents as Jev-compatible: { state, questions } -> { answers, usage }.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
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
 * opts: { baseUrl, apiKey, timeoutMs, providerName }
 */
async function ask(state, questions, opts) {
  const o = opts || {};
  const base = resolveBase(o);
  const headers = {};
  const token = o.apiKey || process.env.JEV_API_KEY || resolveApiKey();
  if (token) headers.Authorization = 'Bearer ' + token;
  const timeoutMs = o.timeoutMs || Number(process.env.JEV_HTTP_TIMEOUT || 30000);

  const t0 = Date.now();
  const res = await httpJson('POST', base + '/v1/systemone', {
    headers,
    body: { state, questions },
    timeoutMs,
  });
  const json = res.json || {};
  const answers = json.answers || {};
  const usage = json.usage || { input_tokens: null };
  const provider = o.providerName || 'http:' + base;
  return { answers, usage, latency_ms: Date.now() - t0, provider, raw: json };
}

module.exports = { ask, httpJson, resolveBase, DEFAULT_TYPESAFE_BASE };
