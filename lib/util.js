'use strict';

/**
 * Shared utilities for the jev skill.
 * Zero-dependency, Node 16 compatible.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** True when `next` should be consumed as the value of the preceding flag:
 *  plain text, the '-' stdin marker, or a negative number. */
function isValueLike(next) {
  return next !== undefined && (next === '-' || !next.startsWith('-') || /^-\d/.test(next));
}

/** Parse argv into { _: [positionals], flags: { key: value|true } }. */
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      for (let j = i + 1; j < argv.length; j++) out._.push(argv[j]);
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key;
      let val;
      if (eq >= 0) {
        key = a.slice(2, eq);
        val = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        if (isValueLike(argv[i + 1])) {
          val = argv[i + 1];
          i++;
        } else {
          val = true;
        }
      }
      out.flags[key] = val;
    } else if (/^-[a-zA-Z0-9]+$/.test(a)) {
      // Single-dash short flag: -s, -c, -i, -q ...
      if (isValueLike(argv[i + 1])) {
        out.flags[a.slice(1)] = argv[i + 1];
        i++;
      } else {
        out.flags[a.slice(1)] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** Read all of stdin as a string (empty string when TTY). */
function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/** Read a value that may be literal text, "@path", or "-" (stdin). */
async function readMaybeFile(v) {
  if (v === undefined || v === null) return null;
  if (v === '-') return (await readStdin()).trim();
  if (typeof v === 'string' && v.startsWith('@')) {
    return fs.readFileSync(v.slice(1), 'utf8');
  }
  return v;
}

/**
 * Resolve the request state.
 * --state text     -> { document: text }
 * --state-json x   -> parsed JSON object, used as-is
 * stdin (no flags) -> { document: stdin }
 */
async function buildState(flags) {
  if (flags['state-json'] !== undefined) {
    const raw = await readMaybeFile(flags['state-json']);
    let obj;
    try {
      obj = JSON.parse(String(raw).trim());
    } catch (e) {
      throw new Error('--state-json is not valid JSON: ' + e.message);
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      throw new Error('--state-json must be a JSON object');
    }
    return obj;
  }
  const raw = await readMaybeFile(flags.state !== undefined ? flags.state : flags.s);
  if (raw === null || raw === '') {
    if (!process.stdin.isTTY) {
      const piped = (await readStdin()).trim();
      if (piped) return { document: piped };
    }
    throw new Error('no state provided - use --state <text>, --state @file, --state -, or --state-json');
  }
  return { document: String(raw) };
}

/**
 * Parse choice criteria:
 *  - JSON object  {"billing":"payments, refunds"}
 *  - "a,b,c"      -> each label is its own description
 *  - "key: desc, key2: desc2"
 */
function parseChoiceCriteria(spec) {
  if (!spec) throw new Error('choice question requires --choices or --criteria');
  const trimmed = String(spec).trim();
  let obj;
  if (trimmed.startsWith('{')) {
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      throw new Error('--criteria JSON is invalid: ' + e.message);
    }
  } else {
    obj = {};
    for (const part of trimmed.split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const colon = seg.indexOf(':');
      if (colon > 0) obj[seg.slice(0, colon).trim()] = seg.slice(colon + 1).trim();
      else obj[seg] = seg;
    }
  }
  const keys = Object.keys(obj);
  if (keys.length < 2) throw new Error('choice question needs at least 2 options');
  for (const k of keys) {
    if (typeof obj[k] !== 'string' || !obj[k]) obj[k] = k;
  }
  return obj;
}

/** Parse score levels: JSON array or "lo,mid,hi". Returns string[]. */
function parseLevels(spec) {
  if (!spec) throw new Error('score question requires --levels');
  const trimmed = String(spec).trim();
  let arr;
  if (trimmed.startsWith('[')) {
    try {
      arr = JSON.parse(trimmed);
    } catch (e) {
      throw new Error('--levels JSON is invalid: ' + e.message);
    }
  } else {
    arr = trimmed.split(',').map((s) => s.trim());
  }
  arr = arr.map((s) => String(s));
  if (arr.length < 2) throw new Error('score question needs at least 2 levels');
  if (arr.length > 20) throw new Error('score question supports at most 20 levels');
  return arr;
}

/** Read a JSON payload from a literal, "@file", "-", or a bare "path/to/file"
 *  (the form the help examples use: `jev ask -f request.json`). */
async function readJsonInput(v, what) {
  const raw = await readMaybeFile(v);
  if (raw === null) throw new Error('missing ' + what);
  try {
    return JSON.parse(String(raw).trim());
  } catch (firstErr) {
    if (typeof v === 'string' && v !== '-' && !v.startsWith('@')) {
      try {
        if (fs.existsSync(v) && fs.statSync(v).isFile()) {
          return JSON.parse(fs.readFileSync(v, 'utf8').trim());
        }
      } catch (_e) {
        /* fall through to the original error */
      }
    }
    throw new Error(what + ' is not valid JSON: ' + firstErr.message);
  }
}

/** Resolve the TypeSafe Jev API key: env first, then ~/.pave/tokens.yaml. */
function resolveApiKey() {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  const tokensPath = path.join(os.homedir(), '.pave', 'tokens.yaml');
  let text;
  try {
    text = fs.readFileSync(tokensPath, 'utf8');
  } catch (e) {
    return null;
  }
  const m = text.match(/^\s*JEV_API_KEY\s*:\s*["']?([^"'\n#]+)["']?\s*$/m);
  return m ? m[1].trim() : null;
}

/** Skill data dir (calibration, reports). Override with JEV_HOME. */
function jevHome() {
  return process.env.JEV_HOME || path.join(os.homedir(), '.pave', 'jev');
}

function calibrationPath() {
  return path.join(jevHome(), 'calibration.json');
}

function loadCalibration() {
  try {
    const cal = JSON.parse(fs.readFileSync(calibrationPath(), 'utf8'));
    if (cal && cal.buckets && typeof cal.buckets === 'object') return cal;
  } catch (e) {
    /* absent or corrupt - treat as none */
  }
  return null;
}

function saveCalibration(cal) {
  const dir = jevHome();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(calibrationPath(), JSON.stringify(cal, null, 2) + '\n');
  return calibrationPath();
}

function round(x, digits) {
  const f = Math.pow(10, digits);
  return Math.round(x * f) / f;
}

module.exports = {
  parseArgs,
  readStdin,
  readMaybeFile,
  buildState,
  parseChoiceCriteria,
  parseLevels,
  readJsonInput,
  resolveApiKey,
  jevHome,
  calibrationPath,
  loadCalibration,
  saveCalibration,
  round,
};
